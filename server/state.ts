import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Rules } from "./policy.ts";
import { writeAtomic } from "./store.ts";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function lists(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, strings(entry)] as const)
      .filter(([, entry]) => entry.length > 0),
  );
}

export function parseRules(raw: string): Rules {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    // 1.2 stored the same lists as "projects".
    return { order: strings(value.order), allowed: lists(value.allowed ?? value.projects) };
  } catch {
    return { order: [], allowed: {} };
  }
}

export class RulesStore {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<Rules> {
    return parseRules(await readFile(this.#file, "utf8").catch(() => "{}"));
  }

  update(change: (rules: Rules) => void): Promise<Rules> {
    const run = this.#queue.then(async () => {
      const rules = await this.read();
      change(rules);
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      await writeAtomic(this.#file, `${JSON.stringify(rules, null, 2)}\n`);
      return rules;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

export function renameIn(rules: Rules, from: string, to: string): void {
  rules.order = rules.order.map((id) => (id === from ? to : id));
  rules.allowed = Object.fromEntries(Object.entries(rules.allowed).map(([id, list]) => [id === from ? to : id, list]));
}

export function forget(rules: Rules, id: string): void {
  rules.order = rules.order.filter((entry) => entry !== id);
  rules.allowed = Object.fromEntries(Object.entries(rules.allowed).filter(([entry]) => entry !== id));
}
