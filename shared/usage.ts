interface Reading {
  fiveHour: { percent: number } | null;
  week: { percent: number } | null;
}

/** The fuller of the two windows: whichever runs out first stops the account. */
export function peak(usage: Reading | null): number | null {
  if (usage === null) return null;
  const values = [usage.fiveHour?.percent, usage.week?.percent].filter((value): value is number => value !== undefined);
  return values.length === 0 ? null : Math.max(...values);
}
