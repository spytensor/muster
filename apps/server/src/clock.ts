/**
 * Clocks: what a moment is on a person's own clock, and the moment their clock shows a
 * given day and time. Used by schedules and follow-ups, which are both set in the
 * person's time zone and kept as instants.
 */

export const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** The wall-clock date and time of an instant in a time zone. */
export function wall(at: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}
/** The instant at which a time zone's clock shows this date and time. */
export function instant(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  zone: string,
): Date {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let guess = want;
  // Twice, so a guess that lands on the other side of a clock change is corrected.
  for (let i = 0; i < 2; i++) {
    const shown = wall(new Date(guess), zone);
    const as = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    guess += want - as;
  }
  return new Date(guess);
}
