/**
 * A person's profile on the phone (CHA-258, CHA-259): how they work is the person's on
 * every device, kept by the server (apps/server/src/profile.ts). The phone keeps copies of
 * language, appearance and the agent for new conversations so it starts right before it
 * has asked; the rest (time zone, working hours, how they like answers, their mail
 * signature) is held only while the app is open. This file is the part that can be tested
 * without a phone.
 */
export interface Ways {
  locale: "en" | "zh" | null;
  theme: "system" | "light" | "dark" | null;
  defaultAgent: string | null;
  timezone: string | null;
  workDays: number[] | null;
  workStart: string | null;
  workEnd: string | null;
  answerStyle: string | null;
  signature: string | null;
}
export interface Profile {
  identity: { department: string | null };
  ways: Ways;
  /** The time zone in use: the one fixed, or the device's. */
  zone: string;
  limits: { answerStyle: number; signature: number };
}
export interface Kept {
  locale: string | null;
  appearance: string | null;
  agent: string | null;
}

/** What this phone had chosen for itself, for the one time it is sent up. Only real choices. */
export function carried(kept: Kept): Partial<Ways> {
  return {
    ...(kept.locale === "en" || kept.locale === "zh" ? { locale: kept.locale } : {}),
    ...(kept.appearance === "light" || kept.appearance === "dark"
      ? { theme: kept.appearance }
      : {}),
    ...(kept.agent ? { defaultAgent: kept.agent } : {}),
  };
}

/**
 * What the phone should now use, given what the server holds. A field the person never
 * chose anywhere is left out: the phone keeps what it has.
 */
export function taken(ways: Partial<Ways> | null | undefined): Partial<Kept> {
  return {
    ...(ways?.locale ? { locale: ways.locale } : {}),
    ...(ways?.theme ? { appearance: ways.theme } : {}),
    ...(ways?.defaultAgent ? { agent: ways.defaultAgent } : {}),
  };
}

/**
 * A time of day as the person typed it, as the server keeps it: "9" and "9:5" are not
 * times, "9:30", "0930" and "9.30" are 09:30. Null when it is not a time.
 */
export function clock(typed: string): string | null {
  const found = /^(\d{1,2})\s*[:.：]?\s*(\d{2})$/.exec(typed.trim());
  if (!found) return null;
  const hour = Number(found[1]);
  const minute = Number(found[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Working hours to send, from what was typed. Null when either is not a time or the day
 * would start and end at the same minute. An end before the start is a night shift.
 */
export function hours(start: string, end: string): { workStart: string; workEnd: string } | null {
  const workStart = clock(start);
  const workEnd = clock(end);
  return workStart && workEnd && workStart !== workEnd ? { workStart, workEnd } : null;
}

/** Working days with one day switched; the last day cannot be switched off. */
export function daysWith(days: number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((one) => one !== day) : [...days, day];
  return next.length ? next.sort() : days;
}

/** Time zones offered on the phone: a short list of where people work, not every zone there is. */
const ZONES = [
  "Pacific/Honolulu",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Cairo",
  "Europe/Istanbul",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];
/** The zones to choose from: the list, with the one already fixed and the device's own in it. */
export function zones(fixed: string | null, device: string): string[] {
  return [...new Set([...(fixed ? [fixed] : []), ...(device ? [device] : []), ...ZONES])];
}

/** A mail's body with the person's signature under it, unless it already ends with it. */
export const signed = (body: string, signature: string | null | undefined) =>
  !signature || body.trimEnd().endsWith(signature) ? body : `${body.trimEnd()}\n\n${signature}`;
