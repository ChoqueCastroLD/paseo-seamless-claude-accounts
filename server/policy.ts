import { DEFAULT_SEAT } from "./store.ts";

export interface Candidate {
  id: string;
  ready: boolean;
  available: boolean;
}

export interface Placement {
  order: string[];
  projects: Record<string, string[]>;
  live: Record<string, string | null>;
}

export function prioritized(ids: string[], order: string[]): string[] {
  const known = order.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id)).sort()];
}

export function dedicated(placement: Placement, id: string): boolean {
  return (placement.projects[id]?.length ?? 0) > 0;
}

export function laneProjects(placement: Placement): string[] {
  return [...new Set(Object.values(placement.projects).flat())].sort();
}

export function eligible(seat: string, ids: string[], placement: Placement): string[] {
  const ranked = prioritized(ids, placement.order);
  const shared = ranked.filter((id) => !dedicated(placement, id));
  if (seat === DEFAULT_SEAT) return shared;
  const own = ranked.filter((id) => placement.projects[id]?.includes(seat));
  return [...own, ...shared];
}

export function seatOf(placement: Placement, id: string): string | null {
  return Object.entries(placement.live).find(([, owner]) => owner === id)?.[0] ?? null;
}

// One login live in two seats would have each copy retire the other's refresh token.
export function choose(seat: string, candidates: Candidate[], placement: Placement): string | null {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of eligible(
    seat,
    candidates.map((candidate) => candidate.id),
    placement,
  )) {
    const candidate = byId.get(id);
    const elsewhere = seatOf(placement, id);
    if (candidate?.ready && candidate.available && (elsewhere === null || elsewhere === seat)) return id;
  }
  return null;
}

export function outranks(seat: string, next: string, current: string | null, ids: string[], placement: Placement) {
  if (current === null) return true;
  const ranking = eligible(seat, ids, placement);
  const at = (id: string) => {
    const index = ranking.indexOf(id);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return at(next) < at(current);
}
