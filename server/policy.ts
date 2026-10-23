export interface Candidate {
  id: string;
  ready: boolean;
  available: boolean;
}

export interface Rules {
  order: string[];
  // Absent or empty means every project.
  allowed: Record<string, string[]>;
}

export interface Placement {
  default: string | null;
  projects: Record<string, string>;
}

export function prioritized(ids: string[], order: string[]): string[] {
  const known = order.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id)).sort()];
}

export function restricted(rules: Rules, id: string): boolean {
  return (rules.allowed[id]?.length ?? 0) > 0;
}

export function allows(rules: Rules, id: string, project: string | null): boolean {
  if (!restricted(rules, id)) return true;
  return project !== null && (rules.allowed[id]?.includes(project) ?? false);
}

// With nothing available the current account stays, so a project never churns between used-up
// accounts.
export function resolve(
  project: string | null,
  candidates: Candidate[],
  rules: Rules,
  current: string | null,
  sticky = false,
): string | null {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const usable = (id: string | null): id is string => {
    const candidate = id === null ? undefined : byId.get(id);
    return candidate !== undefined && candidate.ready && allows(rules, candidate.id, project);
  };
  if (sticky && usable(current) && byId.get(current)?.available) return current;
  const ranked = prioritized(
    candidates.map((candidate) => candidate.id),
    rules.order,
  ).filter(usable);
  return ranked.find((id) => byId.get(id)?.available) ?? (usable(current) ? current : (ranked[0] ?? null));
}

export function plan(
  projects: string[],
  candidates: Candidate[],
  rules: Rules,
  current: Placement,
  sticky = false,
): Placement {
  const next: Placement = { default: resolve(null, candidates, rules, current.default, sticky), projects: {} };
  for (const project of projects) {
    const id = resolve(project, candidates, rules, current.projects[project] ?? current.default, sticky);
    if (id !== null) next.projects[project] = id;
  }
  return next;
}

export function promote(order: string[], ids: string[], id: string): string[] {
  return [id, ...prioritized(ids, order).filter((entry) => entry !== id)];
}
