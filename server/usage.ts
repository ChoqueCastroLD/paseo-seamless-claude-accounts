import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomic, type Login } from "./store.ts";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8_000;
const FRESH_MS = 60_000;
const BACKOFF_MS = 10 * 60_000;

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  week: UsageWindow | null;
  fetchedAt: string;
}

export function parseUsage(body: unknown, now: number): Usage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const fiveHour = parseWindow(record.five_hour);
  const week = parseWindow(record.seven_day);
  if (fiveHour === null && week === null) return null;
  return { fiveHour, week, fetchedAt: new Date(now).toISOString() };
}

function parseWindow(value: unknown): UsageWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const { utilization, resets_at: resetsAt } = value as Record<string, unknown>;
  const percent = typeof utilization === "string" ? Number(utilization) : utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt:
      typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null,
  };
}

export function fullUntil(usage: Usage | null): string | null {
  if (usage === null) return null;
  const resets = [usage.fiveHour, usage.week]
    .flatMap((window) =>
      window !== null && window.percent >= 100 && window.resetsAt !== null ? [window.resetsAt] : [],
    )
    .sort();
  return resets.at(-1) ?? null;
}

export function claudeVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      resolve(error === null ? (/\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? "2.1.0") : "2.1.0");
    });
  });
}

interface Entry {
  usage: Usage | null;
  askedAt: number;
  failedAt: number | null;
}

export class UsageReader {
  #entries = new Map<string, Entry>();
  #loaded: Promise<void> | null = null;
  #version: Promise<string>;
  readonly #cacheFile: string;
  readonly #fetch: typeof fetch;

  constructor(options: { cacheFile: string; version: Promise<string>; fetch?: typeof fetch }) {
    this.#cacheFile = options.cacheFile;
    this.#version = options.version;
    this.#fetch = options.fetch ?? fetch;
  }

  #load(): Promise<void> {
    this.#loaded ??= readFile(this.#cacheFile, "utf8")
      .then((raw) => {
        for (const [key, usage] of Object.entries(JSON.parse(raw) as Record<string, Usage>)) {
          if (!this.#entries.has(key))
            this.#entries.set(key, { usage, askedAt: Number.NEGATIVE_INFINITY, failedAt: null });
        }
      })
      .catch(() => undefined);
    return this.#loaded;
  }

  async #save(): Promise<void> {
    const out: Record<string, Usage> = {};
    for (const [key, entry] of this.#entries) if (entry.usage !== null) out[key] = entry.usage;
    try {
      await mkdir(dirname(this.#cacheFile), { recursive: true, mode: 0o700 });
      await writeAtomic(this.#cacheFile, `${JSON.stringify(out)}\n`);
    } catch {
      // Losing the cache only costs one request after a restart.
    }
  }

  async known(key: string): Promise<Usage | null> {
    await this.#load();
    return this.#entries.get(key)?.usage ?? null;
  }

  invalidate(key: string): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) entry.askedAt = Number.NEGATIVE_INFINITY;
  }

  async read(key: string, login: Login, options: { now?: number; force?: boolean } = {}): Promise<Usage | null> {
    await this.#load();
    const now = options.now ?? Date.now();
    const entry = this.#entries.get(key) ?? { usage: null, askedAt: Number.NEGATIVE_INFINITY, failedAt: null };
    this.#entries.set(key, entry);

    if (entry.failedAt !== null && now - entry.failedAt < BACKOFF_MS) return entry.usage;
    if (!options.force && now - entry.askedAt < FRESH_MS) return entry.usage;
    // An expired token only earns a 401; Claude Code renews it once the account is live.
    if (login.expiresAt !== null && login.expiresAt <= now) return entry.usage;

    entry.askedAt = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = controller.signal;
    try {
      const response = await this.#fetch(ENDPOINT, {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          // The endpoint only answers Claude Code.
          "User-Agent": `claude-code/${await this.#version}`,
        },
        signal,
      });
      if (!response.ok) {
        entry.failedAt = now;
        return entry.usage;
      }
      const usage = parseUsage(await response.json(), now);
      if (usage === null) {
        entry.failedAt = now;
        return entry.usage;
      }
      entry.usage = usage;
      entry.failedAt = null;
      await this.#save();
      return usage;
    } catch {
      entry.failedAt = now;
      return entry.usage;
    } finally {
      clearTimeout(timer);
    }
  }
}
