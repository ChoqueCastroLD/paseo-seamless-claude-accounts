interface Window {
  percent: number;
  resetsAt?: string | null;
}

interface Reading {
  fiveHour: Window | null;
  week: Window | null;
  models?: (Window & { model: string })[];
}

// Model windows are left out: a full one only stops chats on that model, and the chat that runs
// into it says so.
export function peak(usage: Reading | null): number | null {
  if (usage === null) return null;
  const values = [usage.fiveHour?.percent, usage.week?.percent].filter((value): value is number => value !== undefined);
  return values.length === 0 ? null : Math.max(...values);
}

// An idle account's last reading can predate a reset; a window that has reset is empty again.
export function settle<T extends Reading | null>(usage: T, now: number): T {
  if (usage === null) return usage;
  const reset = <W extends Window | null>(value: W): W =>
    value !== null && value.resetsAt != null && Date.parse(value.resetsAt) <= now
      ? ({ ...value, percent: 0, resetsAt: null } as W)
      : value;
  return {
    ...usage,
    fiveHour: reset(usage.fiveHour),
    week: reset(usage.week),
    ...(usage.models === undefined ? {} : { models: usage.models.map(reset) }),
  };
}

// Some plans (Ultra with a verified account) have no 5-hour window: the endpoint answers
// `five_hour: null` next to a weekly window, and a reading is only kept when one window is present.
export function noSessionLimit(usage: Reading | null): boolean {
  return usage !== null && usage.fiveHour === null;
}
