import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprint, writeAtomic, type Login, type WhoIs } from "./store.ts";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8_000;
const FRESH_MS = 60_000;
const BACKOFF_MS = 10 * 60_000;

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

export interface ModelWindow extends UsageWindow {
  // The model the weekly allowance is for, as Anthropic names it ("Fable").
  model: string;
}

export interface Usage {
  // Null when the plan has no 5-hour window (Ultra with a verified account).
  fiveHour: UsageWindow | null;
  week: UsageWindow | null;
  // Weekly allowances of single models, on top of the weekly one.
  models: ModelWindow[];
  fetchedAt: string;
}

// Older endpoints named the model windows as fields instead of `limits` rows.
const LEGACY_MODELS: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

export function parseUsage(body: unknown, now: number): Usage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record.limits) ? record.limits.filter(isRecord) : [];
  // `limits` is the newer listing; the named fields stay the source while they are sent.
  const row = (kind: string) => rows.find((candidate) => candidate.kind === kind && candidate.scope == null);
  const fiveHour = parseWindow(record.five_hour) ?? (record.five_hour === undefined ? parseRow(row("session")) : null);
  const week = parseWindow(record.seven_day) ?? (record.seven_day === undefined ? parseRow(row("weekly_all")) : null);
  if (fiveHour === null && week === null) return null;

  const models: ModelWindow[] = [];
  for (const candidate of rows) {
    const model = modelOf(candidate);
    const window = parseRow(candidate);
    if (model !== null && window !== null && !models.some((known) => known.model === model)) {
      models.push({ model, ...window });
    }
  }
  for (const [field, model] of Object.entries(LEGACY_MODELS)) {
    const window = parseWindow(record[field]);
    if (window !== null && !models.some((known) => known.model === model)) models.push({ model, ...window });
  }
  return { fiveHour, week, models, fetchedAt: new Date(now).toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function modelOf(row: Record<string, unknown>): string | null {
  if (row.kind !== "weekly_scoped" || !isRecord(row.scope) || !isRecord(row.scope.model)) return null;
  const name = row.scope.model.display_name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

function parseRow(row: Record<string, unknown> | undefined): UsageWindow | null {
  return row === undefined ? null : parseWindow({ utilization: row.percent, resets_at: row.resets_at });
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null;
  const { utilization, resets_at: resetsAt } = value;
  const percent = typeof utilization === "string" ? Number(utilization) : utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt:
      typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null,
  };
}

// A chat that ran out on a model's allowance keeps running out until that window resets, so a full
// model window counts here too.
export function fullUntil(usage: Usage | null): string | null {
  if (usage === null) return null;
  const resets = [usage.fiveHour, usage.week, ...usage.models]
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
          // Readings cached before 1.7 have no model windows.
          if (!this.#entries.has(key))
            this.#entries.set(key, {
              usage: { ...usage, models: usage.models ?? [] },
              askedAt: Number.NEGATIVE_INFINITY,
              failedAt: null,
            });
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

const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_FRESH_MS = 5 * 60_000;
const FAILURE_FRESH_MS = 60_000;
const PROFILE_TIMEOUT_MS = 5_000;

/**
 * Asks Anthropic which account and organization a token belongs to. The reliable answer when the
 * login in a config dir has changed. Failures are remembered for a minute, so an outage does not
 * stall every sync on the network timeout.
 */
export class IdentityReader {
  readonly #fetch: typeof fetch;
  readonly #version: Promise<string>;
  #cache = new Map<string, { at: number; answer: WhoIs | null }>();

  constructor(options: { version: Promise<string>; fetch?: typeof fetch }) {
    this.#version = options.version;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Whose the token is, or null when that cannot be known right now. */
  async whoIs(accessToken: string, now = Date.now()): Promise<WhoIs | null> {
    const id = fingerprint(accessToken);
    for (const [entry, value] of this.#cache) if (now - value.at >= PROFILE_FRESH_MS) this.#cache.delete(entry);
    const cached = this.#cache.get(id);
    if (cached !== undefined && now - cached.at < (cached.answer === null ? FAILURE_FRESH_MS : PROFILE_FRESH_MS)) {
      return cached.answer;
    }
    const answer = await this.#ask(accessToken);
    this.#cache.set(id, { at: now, answer });
    return answer;
  }

  async #ask(accessToken: string): Promise<WhoIs | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
    try {
      const response = await this.#fetch(PROFILE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-code/${await this.#version}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        account?: { uuid?: unknown; email?: unknown };
        organization?: { uuid?: unknown };
      };
      const user = body.account?.uuid;
      const organization = body.organization?.uuid;
      if (typeof user !== "string" || typeof organization !== "string") return null;
      return {
        key: `${user}/${organization}`,
        email: typeof body.account?.email === "string" ? body.account.email : "",
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
