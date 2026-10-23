import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setProjects, without, type Rules } from "./policy.ts";
import { writeAtomic } from "./store.ts";

export interface Stored extends Rules {
  // Agent id to the workspace link its session opened through. Chats missing here opened without one.
  opened: Record<string, string>;
  // 1.2 and 1.3 kept, per account, the projects it was limited to. Converted once projects are known.
  legacyAllowed: Record<string, string[]>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function lists(value: unknown, keepEmpty = false): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, strings(entry)] as const)
      .filter(([, entry]) => keepEmpty || entry.length > 0),
  );
}

function names(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function parseRules(raw: string): Stored {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      order: strings(value.order),
      excluded: lists(value.excluded),
      workspaces: lists(value.workspaces, true),
      projectOf: names(value.projectOf),
      opened: names(value.opened),
      legacyAllowed: lists(value.legacyAllowed ?? value.allowed ?? value.projects),
    };
  } catch {
    return { order: [], excluded: {}, workspaces: {}, projectOf: {}, opened: {}, legacyAllowed: {} };
  }
}

/** Turns the old per-account project lists into per-project exclusions over the known projects. */
export function migrate(rules: Stored, projects: string[]): boolean {
  // Without the project list the old limits cannot be expressed; converting now would drop them.
  if (Object.keys(rules.legacyAllowed).length === 0 || projects.length === 0) return false;
  for (const [id, allowed] of Object.entries(rules.legacyAllowed)) setProjects(rules, id, allowed, projects);
  rules.legacyAllowed = {};
  return true;
}

export class RulesStore {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<Stored> {
    return parseRules(await readFile(this.#file, "utf8").catch(() => "{}"));
  }

  update(change: (rules: Stored) => void): Promise<Stored> {
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

function rename(list: string[], from: string, to: string): string[] {
  return list.map((id) => (id === from ? to : id));
}

export function renameIn(rules: Stored, from: string, to: string): void {
  rules.order = rename(rules.order, from, to);
  for (const field of ["excluded", "workspaces"] as const) {
    rules[field] = Object.fromEntries(Object.entries(rules[field]).map(([key, list]) => [key, rename(list, from, to)]));
  }
  if (rules.legacyAllowed[from] !== undefined) {
    rules.legacyAllowed = { ...without(rules.legacyAllowed, from), [to]: rules.legacyAllowed[from] };
  }
}

export function forget(rules: Stored, id: string): void {
  const drop = (list: string[]) => list.filter((entry) => entry !== id);
  rules.order = drop(rules.order);
  rules.excluded = Object.fromEntries(
    Object.entries(rules.excluded)
      .map(([key, list]) => [key, drop(list)] as const)
      .filter(([, list]) => list.length > 0),
  );
  rules.workspaces = Object.fromEntries(
    Object.entries(rules.workspaces)
      .map(([key, list]) => [key, drop(list)] as const)
      .filter(([, list]) => list.length > 0),
  );
  rules.legacyAllowed = without(rules.legacyAllowed, id);
}
