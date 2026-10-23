export interface Candidate {
  id: string;
  ready: boolean;
  available: boolean;
}

export interface Rules {
  order: string[];
  // Project id to the accounts it may not use. Absent or empty means every account.
  excluded: Record<string, string[]>;
  // Workspace id to the accounts it may use. Absent means the same as its project.
  workspaces: Record<string, string[]>;
  // Workspace id to its project, kept so the rules hold while Paseo cannot be asked.
  projectOf: Record<string, string>;
  // 1.2 and 1.3 limits, per account, honored until they are converted.
  legacyAllowed?: Record<string, string[]>;
}

export interface Placement {
  default: string | null;
  // Workspace id (or, for chats opened by 1.3, project id) to the account its chats use.
  scopes: Record<string, string>;
}

export function prioritized(ids: string[], order: string[]): string[] {
  const known = order.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id)).sort()];
}

export function projectOf(rules: Rules, scope: string): string {
  return rules.projectOf[scope] ?? scope;
}

// Outside any project only accounts excluded from nowhere qualify, so an account kept for some
// projects never becomes the login of the terminal and of chats outside projects.
export function allows(rules: Rules, id: string, scope: string | null): boolean {
  const legacy = rules.legacyAllowed?.[id];
  if (scope === null) {
    return legacy === undefined && !Object.values(rules.excluded).some((list) => list.includes(id));
  }
  const chosen = rules.workspaces[scope];
  if (chosen !== undefined) return chosen.includes(id);
  const project = projectOf(rules, scope);
  if (legacy !== undefined) return legacy.includes(project);
  return !(rules.excluded[project] ?? []).includes(id);
}

// With nothing available the current account stays, so a scope never churns between used-up
// accounts. Only rules that permit no account at all are ignored; permitted accounts that need a new
// sign-in never hand the scope to an account the user excluded.
export function resolve(
  scope: string | null,
  candidates: Candidate[],
  rules: Rules,
  current: string | null,
  sticky = false,
): string | null {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ids = prioritized(
    candidates.map((candidate) => candidate.id),
    rules.order,
  );
  const ready = ids.filter((id) => byId.get(id)?.ready);
  const permitted = ids.filter((id) => allows(rules, id, scope));
  const pool = permitted.length > 0 ? permitted.filter((id) => byId.get(id)?.ready) : ready;
  const usable = (id: string | null): id is string => id !== null && pool.includes(id);
  if (sticky && usable(current) && byId.get(current)?.available) return current;
  return pool.find((id) => byId.get(id)?.available) ?? (usable(current) ? current : (pool[0] ?? null));
}

// `sticky` can be decided per scope (null for the chats outside workspaces).
export function plan(
  scopes: string[],
  candidates: Candidate[],
  rules: Rules,
  current: Placement,
  sticky: boolean | ((scope: string | null) => boolean) = false,
): Placement {
  const keep = (scope: string | null) => (typeof sticky === "function" ? sticky(scope) : sticky);
  const next: Placement = { default: resolve(null, candidates, rules, current.default, keep(null)), scopes: {} };
  for (const scope of scopes) {
    const id = resolve(scope, candidates, rules, current.scopes[scope] ?? null, keep(scope));
    if (id !== null) next.scopes[scope] = id;
  }
  return next;
}

export function promote(order: string[], ids: string[], id: string): string[] {
  return [id, ...prioritized(ids, order).filter((entry) => entry !== id)];
}

export function projectsOf(rules: Rules, id: string, projects: string[]): string[] {
  return projects.filter((project) => !(rules.excluded[project] ?? []).includes(id));
}

/**
 * Rewrites the exclusions so an account serves exactly `allowed` out of `projects`, the projects
 * the person deciding could see. Projects they did not see keep every account.
 */
export function setProjects(rules: Rules, id: string, allowed: string[], projects: string[]): void {
  for (const project of projects) {
    const others = (rules.excluded[project] ?? []).filter((entry) => entry !== id);
    const next = allowed.includes(project) ? others : [...others, id].sort();
    rules.excluded = next.length === 0 ? without(rules.excluded, project) : { ...rules.excluded, [project]: next };
  }
}

export function allowEverywhere(rules: Rules, id: string): void {
  rules.excluded = Object.fromEntries(
    Object.entries(rules.excluded)
      .map(([project, list]) => [project, list.filter((entry) => entry !== id)] as const)
      .filter(([, list]) => list.length > 0),
  );
}

export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
}
