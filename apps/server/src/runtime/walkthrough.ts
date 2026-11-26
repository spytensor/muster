import { walkthroughIn } from "@muster/ui-schema";

/**
 * Whether a reply that changed the person's code ends the way the person can judge it by
 * (C1, `docs/design/coding-people-choose.md`), held against what the reply's own steps did.
 * The steps are the record; the Walkthrough is checked against them, not believed:
 *
 * - it is there, with a summary, and names every file the steps changed;
 * - every check it lists is a command that was really run in this reply; one marked passed
 *   passed in a run after the last change (a pass before it checked something else), one
 *   marked failed did fail in some run (a test that failed before the fix is the record);
 * - every check the project names that Muster ran after the last change is listed;
 * - when commands were run after the last change, it lists checks; when none were, it says
 *   under left that the work was not checked.
 */

/** One thing the reply did, in order. */
export type Done =
  /** A file changed with the file tools, its path as the step names it. */
  | { change: string }
  /**
   * A command run: as the step names it, its exit code (null while it goes on as a job),
   * and whether it is one of the project's own checks that Muster ran itself.
   */
  | { run: string; code: number | null; project?: boolean };

/** What does not hold. Every list is empty and every flag unset when everything does. */
export interface Gap {
  /** There is no Walkthrough at all. */
  missing?: boolean;
  /** It has no summary. */
  noSummary?: boolean;
  /** Files the steps changed that it does not name. */
  unnamed: string[];
  /** Checks it lists that are no command run in this reply. */
  notRun: string[];
  /** Checks it lists that ran only before the last change. */
  stale: string[];
  /** Checks whose passed or failed is not what the command's exit code says. */
  wrong: { what: string; code: number; ok: boolean }[];
  /**
   * Checks marked passed whose only runs after the last change ended in another command
   * (`npm test | tail`, `npm test; echo`): the exit code was that command's, not the check's.
   */
  piped: string[];
  /** The project's checks Muster ran after the last change that it does not list. */
  unlisted: string[];
  /** "ran": commands ran after the last change and it lists none; "none": nothing ran and it says nothing is left. */
  noChecks?: "ran" | "none";
}

export function walkthroughGap(content: string, done: readonly Done[]): Gap | null {
  const changes = done.flatMap((item, at) => ("change" in item ? [{ path: item.change, at }] : []));
  if (changes.length === 0) return null;
  const gap: Gap = { unnamed: [], notRun: [], stale: [], wrong: [], unlisted: [], piped: [] };
  const said = walkthroughIn(content);
  if (!said) return { ...gap, missing: true };
  if (!said.summary.trim()) gap.noSummary = true;

  const named = said.changes.map((change) => bare(change.file)).filter(Boolean);
  gap.unnamed = [...new Set(changes.map((change) => bare(change.path)))].filter(
    (path) => path && !named.some((name) => samePath(name, path)),
  );

  const last = Math.max(...changes.map((change) => change.at));
  const runs = done.flatMap((item, at) => ("run" in item ? [{ ...item, at }] : []));
  const after = runs.filter((run) => run.at > last);
  // Only a check that is a command is held to what ran: one in words ("opened the page")
  // is what the agent says it looked at, and the steps show what it opened.
  const listed = said.checks.filter((check) => isCommand(check.what));
  for (const check of listed) {
    const matching = runs.filter((run) => sameCommand(check.what, run.run));
    if (matching.length === 0) {
      gap.notRun.push(check.what.trim());
      continue;
    }
    const since = matching.filter((run) => run.at > last);
    // Passed: its latest run after the last change passed (a job still going counts). A
    // pass before the change checked something else; a failure after it is the outcome.
    if (check.ok) {
      // Only a run whose exit code is the check's own speaks for it.
      const own = since.filter((run) => ownCode(run.run, check.what));
      const latest = own.at(-1);
      if (!latest) {
        if (since.length > 0) gap.piped.push(check.what.trim());
        else gap.stale.push(check.what.trim());
      } else if (latest.code !== null && latest.code !== 0)
        // -1: it ended and its code is not known (killed, or it could not start): no pass.
        gap.wrong.push({ what: check.what.trim(), code: latest.code, ok: true });
      continue;
    }
    // Failed: some run of it failed, before the change or after. Saying the test failed
    // before the fix is the record, and claims nothing about the work.
    if (matching.some((run) => run.code !== null && run.code !== 0)) continue;
    const latest = matching.filter((run) => run.code !== null).at(-1);
    if (latest && latest.code !== null)
      gap.wrong.push({ what: check.what.trim(), code: latest.code, ok: false });
  }
  // The project's checks Muster ran after the agent wrote its reply: the agent never saw a
  // passing one, so only one that failed is its to report.
  gap.unlisted = [
    ...new Set(
      after
        .filter(
          (run) =>
            run.project &&
            run.code !== null &&
            run.code !== 0 &&
            !listed.some((check) => sameCommand(check.what, run.run)),
        )
        .map((run) => run.run),
    ),
  ];
  // No check listed is fine when it says under left what was not checked.
  if (listed.length === 0 && said.left.length === 0)
    gap.noChecks = after.some((run) => !run.project) ? "ran" : "none";
  const holds =
    !gap.noSummary &&
    !gap.noChecks &&
    gap.unnamed.length +
      gap.notRun.length +
      gap.stale.length +
      gap.wrong.length +
      gap.unlisted.length +
      gap.piped.length ===
      0;
  return holds ? null : gap;
}

/** What is wrong, said to the agent: each point with what to do about it. */
export function toldOf(gap: Gap): string {
  if (gap.missing) return "Your reply changed files but does not end with a Walkthrough.";
  const list = (items: string[]) => items.map((item) => `"${item}"`).join(", ");
  return [
    gap.noSummary && "The Walkthrough has no summary.",
    gap.unnamed.length > 0 &&
      `It does not name ${gap.unnamed.length === 1 ? "this file you changed" : "these files you changed"}: ${list(gap.unnamed)}.`,
    gap.notRun.length > 0 &&
      `It lists ${list(gap.notRun)} as ${gap.notRun.length === 1 ? "a check, but no such command was" : "checks, but no such commands were"} run in this reply. List only commands you ran; run them now if they check the work, or say under left that they were not run.`,
    gap.stale.length > 0 &&
      `${list(gap.stale)} ran only before your last change, so ${gap.stale.length === 1 ? "it does" : "they do"} not check what you changed. Run ${gap.stale.length === 1 ? "it" : "them"} again, or say under left that the change was not checked.`,
    ...gap.wrong.map(
      (wrong) =>
        `"${wrong.what}" exited with code ${wrong.code}, so it ${wrong.code === 0 ? "passed" : "failed"}: it is marked ${wrong.ok ? "passed" : "failed"}.`,
    ),
    gap.piped.length > 0 &&
      `${list(gap.piped)} ran with another command after it (a \`|\` or a \`;\`), so the exit code was that command's, not the check's. Run each check as a command of its own and report its exit code.`,
    gap.unlisted.length > 0 &&
      `The project's own checks ran after your changes and are not listed: ${list(gap.unlisted)}. List each with what came of it.`,
    gap.noChecks === "ran" &&
      "It lists no checks, though you ran commands after your changes: list the ones that check the work and what came of each.",
    gap.noChecks === "none" &&
      "Nothing was run after your changes to check them, and it says nothing is left: run what checks the work, or say under left that it was not checked.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A path as it can be compared: no leading `./` or slashes, forward slashes, and no line,
 * range or note after it (`:4`, `:4-9`, `:4:2`, `#L4-L9`, ` (new)`).
 */
const bare = (path: string) =>
  path
    .trim()
    .replace(/`/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .replace(/\s*[(（][^()（）]*[)）]$/, "")
    .replace(/#L\d+.*$/, "")
    .replace(/(:\d+(-\d+)?)+$/, "");

/**
 * Whether the Walkthrough's name stands for the changed path. The agent may leave the
 * attached folder's name off the front, so a name that is the path's tail, at a `/`, counts.
 */
const samePath = (name: string, path: string) =>
  name === path || path.endsWith(`/${name}`) || name.endsWith(`/${path}`);

/** What a check says, without what the agent said of it in brackets at the end ("npm test (after)"). */
const withoutNote = (text: string) =>
  text
    .replace(/`/g, "")
    .replace(/\s*[(（][^()（）]*[)）]\s*$/, "")
    .trim();

/** A command's words: no quotes, one space between, and no `NAME=value` set before it. */
const wordsOf = (text: string) => {
  const words = text.replace(/["'`]/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  return words;
};

/**
 * Whether a check is a command, not words about what was looked at: its first word (after
 * any `NAME=value`) is written as a program is, `npm`, `./run.sh`, `pnpm`, never "Opened".
 */
export function isCommand(what: string): boolean {
  const first = wordsOf(withoutNote(what))[0] ?? "";
  return /^(\.{0,2}\/)?[a-z0-9_][\w./+-]*$/.test(first);
}

/** The commands a line holds, split at `&&`, `||`, `;`, `|`, a line break, and a spaced `/` or `+`. */
const partsOf = (text: string) =>
  withoutNote(text)
    .split(/&&|\|\||;|⏎|\n|(?<!\|)\|(?!\|)|\s\/\s|\s\+\s|、/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Whether two single commands are the same: the same program, and the other words of the
 * one that says less found in the other, in order, flags (`-s`, `--watch`) aside. So
 * `curl "…"` is `curl -s "…"` and "npm test" is "npm test -- --watch", but "vitest" is not
 * "cat vitest.config.ts" and "npm test" is not "pnpm test:e2e".
 */
function sameOne(a: string, b: string): boolean {
  const plain = (words: string[]) => words.filter((word) => !word.startsWith("-"));
  const one = plain(wordsOf(a));
  const other = plain(wordsOf(b));
  if (one.length === 0 || other.length === 0 || one[0] !== other[0]) return false;
  const [fewer, more] = one.length <= other.length ? [one, other] : [other, one];
  let at = 0;
  for (const word of more) if (word === fewer[at]) at++;
  return at === fewer.length;
}

/**
 * Whether a listed check names this run. The agent may sum up a run of several ("git status
 * / git diff" for "git status --short && git diff"): every command the check names must be
 * one the run holds.
 */
function sameCommand(what: string, ran: string): boolean {
  const named = partsOf(what);
  const held = partsOf(ran);
  if (named.length === 0 || held.length === 0) return false;
  return named.every((one) => held.some((other) => sameOne(one, other)));
}

/**
 * A line's commands in the order they run, split where one's exit code is lost to the next:
 * a line break, `;`, `|` and `||` (a failure before `||` is not the line's). Within `&&` a
 * failure stops the line, so its code stays. What is in quotes is not split.
 */
const stagesOf = (line: string) =>
  line
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "q")
    .split(/⏎|\n|;|\|\|?/)
    .map((stage) => stage.trim())
    .filter(Boolean);

/**
 * Whether the run's exit code is the check's own: the command the check is about (its first
 * that is not `cd` or the like) is the run's last stage. `npm test | tail` and
 * `npm test; echo …` end in another command, whose code it was.
 */
function ownCode(ran: string, what: string): boolean {
  const stages = stagesOf(ran);
  if (stages.length <= 1) return true;
  const named =
    stagesOf(withoutNote(what)).find((stage) => !/^(cd|pushd|export|set|source)\b/.test(stage)) ??
    "";
  return sameOne(named.split("&&").at(-1) ?? named, stages.at(-1) ?? "");
}
