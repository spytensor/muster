import { type Bench, runCode, undo, undoable } from "./bench.js";
import { LocalError, locate } from "./local.js";
import {
  isRepository,
  lookAtPr,
  openPr,
  prepare,
  rootOfCall,
  rootsFor,
  type TaskStore,
  unprepare,
} from "./task.js";
import { covers, type Mark, mark, record, undoableIn, undoIn } from "./undo.js";

/**
 * One call an agent made, done as part of its conversation's work (task.ts, undo.ts):
 * what may change a repository is given a branch first, the repository is written down
 * before the call and after it so that what the call changed can be put back, and the
 * call itself is done in the folder the conversation works in, which may be its own copy.
 */
export interface Work {
  store: TaskStore;
  /** Where copies of repositories are kept. */
  home: string;
  server: string;
  conversation: string | null;
  /** The conversation's title, for the name of its branch. */
  title: string;
  /** The folders attached to the project, as the person attached them. */
  folders: string[];
  bench: Bench;
  /** What programs started here are given: the person's own environment. */
  env: NodeJS.ProcessEnv;
}
export interface Call {
  tool: string;
  args: Record<string, unknown>;
  /** The reply the call belongs to. */
  reply?: string;
  /** Whether the server read the call as one that may change something. Not said: it may. */
  changes?: boolean;
}

/** The files too large to write down that an agent was already told of, since the app started. */
const toldOf = new Set<string>();

export async function doCall(work: Work, call: Call): Promise<string> {
  const { store, server, conversation, folders } = work;
  if (folders.length === 0)
    throw new LocalError("No folder on this computer is attached to this project.");
  if (call.tool === "pr") {
    if (!conversation) throw new LocalError("A pull request belongs to a conversation's work.");
    const ctx = { store, server, conversation, roots: folders, env: work.env };
    const what = String(call.args.do ?? "look");
    if (what === "open") return openPr(ctx, call.args);
    if (what === "look") return lookAtPr(ctx, call.args);
    throw new LocalError('"do" is "open" or "look".');
  }
  const command = call.tool === "exec";
  const changing =
    call.tool === "edit" || call.tool === "write" || (command && call.changes !== false);
  const root = rootOfCall(folders, call.tool, call.args);
  const at = { server, conversation: conversation ?? "", root };
  let told: string | null = null;
  let made = false;
  if (changing && conversation && (await isRepository(root))) {
    // The work gets a branch of its own before its first change. A file the agent changes
    // itself moves the work to a copy where the person's own work is in the folder; a
    // command never does, since "run my tests" is run where their work is, not in a copy
    // that has neither their changes nor what they installed. A change that cannot be
    // given its place is refused here (task.ts, NO_COPY): nothing is run.
    const arranged = await prepare(
      store,
      work.home,
      { ...at, conversation, title: work.title },
      command ? { copy: false } : {},
    );
    told = arranged.told;
    made = arranged.made === true;
  }
  const roots = rootsFor(store, server, conversation, folders);
  // Where the conversation works in that folder now: the folder, or its copy of it.
  const dir = rootsFor(store, server, conversation, [root])[0] as string;
  let before: Mark | null = null;
  let only: string | undefined;
  if (changing && call.reply && (await isRepository(dir))) {
    if (command) before = await mark(dir);
    else {
      // The one file a file tool writes. What git ignores, and what is inside another
      // repository in this one, the repository's way back does not cover: for those the
      // file tools' own copy is kept, as it is outside a repository.
      const file = await locate(roots, String(call.args.path ?? ""), true).catch(() => null);
      if (file && (await covers(dir, file))) {
        only = file;
        before = await mark(dir);
      }
    }
  }
  let text = "";
  let failed: unknown = null;
  try {
    text = await runCode(
      roots,
      call.tool,
      call.args,
      work.bench,
      before && !command ? undefined : call.reply,
    );
  } catch (error) {
    failed = error;
  }
  // Also when it failed: a command that ended badly may have changed things first.
  const changed =
    before && call.reply ? await record(dir, call.reply, before, only).catch(() => []) : [];
  // A branch made for a command that then changed nothing is taken back: a test run
  // leaves the person's folder on the branch it was on.
  if (made && command && changed.length === 0 && conversation && (await unprepare(store, at)))
    told = null;
  const large = (before?.skipped ?? []).filter((path) => !toldOf.has(`${before?.gitDir}\0${path}`));
  for (const path of large) toldOf.add(`${before?.gitDir}\0${path}`);
  const notes = [
    told ? `[From Muster, about where this work is done] ${told}` : "",
    large.length
      ? `[From Muster] Not covered by undo, being over 5 MB and not committed: ${large.slice(0, 8).join(", ")}${large.length > 8 ? ` and ${large.length - 8} more` : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (failed) {
    // Refused, perhaps in the place the work has just been moved to (a file not read there
    // yet): the agent is told where that is, or the refusal would make no sense to it.
    if (notes && failed instanceof LocalError)
      throw new LocalError(`${failed.message}\n\n${notes}`);
    throw failed;
  }
  return notes ? `${text}\n\n${notes}` : text;
}

/** The replies whose changes can be put back: in repositories from git, elsewhere from what was put by. */
export async function undoableFor(
  folders: string[],
  bench: Bench,
): Promise<{ reply: string; files: string[] }[]> {
  const all = new Map<string, string[]>();
  for (const one of [...(await undoableIn(folders)), ...undoable(bench)])
    all.set(one.reply, [...(all.get(one.reply) ?? []), ...one.files]);
  return [...all].map(([reply, files]) => ({ reply, files }));
}
/** Puts a reply's changes back, wherever they were made. */
export async function undoFor(
  folders: string[],
  bench: Bench,
  reply: string,
  /** The copies of those folders that conversations work in: a change may have been made there. */
  copies: string[] = [],
): Promise<string[]> {
  const { said, touched } = await undoIn(folders, reply);
  // What was put back must be read again before it is changed.
  for (const file of touched) bench.seen.delete(file);
  return [...said, ...(await undo(bench, reply, [...folders, ...copies]))];
}
