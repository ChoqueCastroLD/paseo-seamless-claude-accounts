import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomic } from "./store.ts";

export interface State {
  order: string[];
  // Absent or empty means the account is shared by every project.
  projects: Record<string, string[]>;
  seats: Record<string, string | null>;
  agents: Record<string, string>;
}

const EMPTY: State = { order: [], projects: {}, seats: {}, agents: {} };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record<T>(value: unknown, item: (entry: unknown) => T | undefined): Record<string, T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = item(entry);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

export function parseState(raw: string): State {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      order: strings(value.order),
      projects: record(value.projects, (entry) => strings(entry)),
      seats: record(value.seats, (entry) => (typeof entry === "string" || entry === null ? entry : undefined)),
      agents: record(value.agents, (entry) => (typeof entry === "string" ? entry : undefined)),
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export class StateStore {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<State> {
    return parseState(await readFile(this.#file, "utf8").catch(() => "{}"));
  }

  update(change: (state: State) => void): Promise<State> {
    const run = this.#queue.then(async () => {
      const state = await this.read();
      change(state);
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      await writeAtomic(this.#file, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

export function renameIn(state: State, from: string, to: string): void {
  state.order = state.order.map((id) => (id === from ? to : id));
  state.projects = Object.fromEntries(
    Object.entries(state.projects).map(([id, projects]) => [id === from ? to : id, projects]),
  );
  for (const [project, id] of Object.entries(state.seats)) if (id === from) state.seats[project] = to;
}

export function forget(state: State, id: string): void {
  state.order = state.order.filter((entry) => entry !== id);
  state.projects = Object.fromEntries(Object.entries(state.projects).filter(([entry]) => entry !== id));
  for (const [project, owner] of Object.entries(state.seats)) if (owner === id) state.seats[project] = null;
}
