/**
 * What a person has already met in the workspace, so that a capability can appear when the
 * work needs it and be taught once, in place (docs/design/quiet-start.md). All of it is a
 * convenience kept in this browser: when the browser keeps nothing, the workspace shows what
 * it would show a new person, and nothing breaks.
 */

const read = (key: string, store: Storage = localStorage): string | null => {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null, store: Storage = localStorage) => {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Not kept: the next visit shows it again, which is harmless.
  }
};
const list = (key: string): string[] => {
  try {
    const kept = JSON.parse(read(key) ?? "null");
    return Array.isArray(kept) ? kept.filter((one) => typeof one === "string") : [];
  } catch {
    return [];
  }
};

// --- Places in the sidebar that appear when there is something in them (Q-6) ---

const SEEN = "muster.places.seen";

/**
 * The places the person has already been shown. The first time this is asked, every place
 * on view counts as seen: someone who had the workspace before this change is not shown a
 * dot on everything at once.
 */
export function seenPlaces(visible: string[]): Set<string> {
  if (read(SEEN) === null) write(SEEN, JSON.stringify(visible));
  return new Set(list(SEEN));
}
export const markSeen = (place: string) => {
  const seen = new Set(list(SEEN));
  if (seen.has(place)) return;
  seen.add(place);
  write(SEEN, JSON.stringify([...seen]));
};

// --- A schedule started from a suggestion on the start page (Q-1) ---

const SCHEDULE_SEED = "muster.schedule.seed";
/** What a new schedule is to do and how often, as a suggestion on the start page says it. */
export interface ScheduleSeed {
  text: string;
  /** Every week falls on Monday at the form's own time, nine o'clock. */
  kind?: "daily" | "weekly";
}
/** The next new schedule: the schedules page opens the form with this in it. */
export const seedSchedule = (seed: ScheduleSeed) =>
  write(SCHEDULE_SEED, JSON.stringify(seed), sessionStorage);
/** Taken once. */
export const takeScheduleSeed = (): ScheduleSeed | null => {
  const kept = read(SCHEDULE_SEED, sessionStorage);
  write(SCHEDULE_SEED, null, sessionStorage);
  try {
    const seed = JSON.parse(kept ?? "null");
    return typeof seed?.text === "string"
      ? {
          text: seed.text,
          ...(seed.kind === "daily" || seed.kind === "weekly" ? { kind: seed.kind } : {}),
        }
      : null;
  } catch {
    return null;
  }
};

// --- Allowing the same kind of action again and again (Q-3) ---

const ALLOWED = "muster.allowed";
/** How many times the person has allowed this tool's calls in this browser. */
export const timesAllowed = (tool: string): number => {
  try {
    const kept = JSON.parse(read(ALLOWED) ?? "{}") as Record<string, unknown>;
    const n = kept[tool];
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
};
export const countAllowed = (tool: string) => {
  let kept: Record<string, unknown> = {};
  try {
    kept = JSON.parse(read(ALLOWED) ?? "{}");
  } catch {
    kept = {};
  }
  write(ALLOWED, JSON.stringify({ ...kept, [tool]: timesAllowed(tool) + 1 }));
};

// --- Calling an agent by name, taught after it did a step (Q-2) ---

const TAUGHT = "muster.taught.call";
/** Whether the person was already told they can call this agent with "@". */
export const taughtCall = (agent: string) => list(TAUGHT).includes(agent);
export const teachCall = (agent: string) => {
  const taught = list(TAUGHT);
  if (!taught.includes(agent)) write(TAUGHT, JSON.stringify([...taught, agent]));
};

// --- A skill offered while the person types (Q-2) ---

/** Words of a name worth matching on: Latin words of four letters or more. */
const longWords = (name: string) =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && /^[\p{Script=Latin}\p{N}]+$/u.test(word));

/**
 * The skill whose name what the person is writing plainly speaks of, if one does: the
 * whole name is in the text, or, for a name of Latin words, two of its longer words are
 * (one, when it has only one). A loose match is no suggestion: none is better than a wrong one.
 */
export function skillFor<T extends { name: string }>(text: string, skills: readonly T[]): T | null {
  const said = text.toLowerCase();
  if (said.trim().length < 4) return null;
  for (const skill of skills) {
    const name = skill.name.trim().toLowerCase();
    if (name.length >= 2 && said.includes(name)) return skill;
    const words = longWords(name);
    if (words.length === 0) continue;
    const found = words.filter((word) => said.includes(word)).length;
    if (found >= Math.min(2, words.length)) return skill;
  }
  return null;
}
