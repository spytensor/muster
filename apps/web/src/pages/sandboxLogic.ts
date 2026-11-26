/** What the Sandbox page works out for itself: nothing here asks the server anything. */

const DAY = 24 * 3600 * 1000;
export const GB = 1024 * 1024 * 1024;

export interface Workspace {
  conversation: string;
  title: string;
  person: { name: string; email: string };
  files: number;
  bytes: number;
  usedAt: string;
  busy: boolean;
  repository: string | null;
  proposal: boolean;
}

/** Why a workspace is not released whatever its age, or null when it is. */
export const keptFor = (
  one: Pick<Workspace, "busy" | "proposal">,
): "running" | "proposal" | null => (one.busy ? "running" : one.proposal ? "proposal" : null);

/** In how many days a workspace is released if nobody uses it: 0 when it is already due. */
export function releasedIn(usedAt: string, idleDays: number, now = Date.now()): number {
  const left = new Date(usedAt).getTime() + idleDays * DAY - now;
  return left <= 0 ? 0 : Math.ceil(left / DAY);
}

/** The workspaces "Release all idle" would release: not used for so many days, and not kept. */
export function idleOnes<T extends Pick<Workspace, "usedAt" | "busy" | "proposal" | "bytes">>(
  all: T[],
  days: number,
  now = Date.now(),
): { ones: T[]; bytes: number } {
  const ones = all.filter(
    (one) => !keptFor(one) && new Date(one.usedAt).getTime() <= now - days * DAY,
  );
  return { ones, bytes: ones.reduce((sum, one) => sum + one.bytes, 0) };
}

/** Largest first, or longest idle first. */
export function sorted<T extends Pick<Workspace, "usedAt" | "bytes">>(
  all: T[],
  by: "size" | "used",
): T[] {
  return [...all].sort((a, b) =>
    by === "size" ? b.bytes - a.bytes : new Date(a.usedAt).getTime() - new Date(b.usedAt).getTime(),
  );
}

/** A whole number from 0 up to `most`, as typed; null for anything else. */
export function whole(text: string, most: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= most ? value : null;
}

/**
 * A cap on all workspaces as typed in gigabytes: empty is no cap (null), a number is that
 * many bytes, and anything else, or less than the server takes, is not a cap (undefined).
 */
export function capOf(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const bytes = Math.round(Number(trimmed) * GB);
  return bytes >= 64 * 1024 * 1024 ? bytes : undefined;
}

/** A cap in bytes as it is typed back: gigabytes, with no more decimals than it needs. */
export const capText = (bytes: number | null): string =>
  bytes === null ? "" : String(Math.round((bytes / GB) * 100) / 100);

/** How long a run has been going, in whole seconds; 0 before it started. */
export const runningFor = (startedAt: string | null, now = Date.now()): number =>
  startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : 0;

/** Processor time as a person reads it: seconds, then minutes, then hours. */
export const cpuTime = (seconds: number, t: { s: string; min: string; h: string }) =>
  seconds < 90
    ? `${Math.round(seconds)} ${t.s}`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} ${t.min}`
      : `${(seconds / 3600).toFixed(1)} ${t.h}`;
