import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  filesUnder,
  gitEnv,
  isProtected,
  LocalError,
  locate,
  looksBinary,
  PART,
  put,
  QUIET_GIT,
  rootNames,
  runLocal,
  type Seen,
  stamp,
  unchanged,
} from "./local.js";

/**
 * Working on code in the folders a person attached to a project (CHA-273): running
 * commands, keeping the ones that go on (a dev server, a long test run) as jobs, and
 * changing a file by replacing an exact piece of it.
 *
 * This runs on the person's computer, as the person. A command can do whatever they can
 * do in a terminal: what keeps it in bounds is that it starts in an attached folder and
 * that the server's gateway decided, before it got here, whether it needed the person's
 * word. Nothing here decides that.
 */

/** A command that is going, or has ended and not yet been read. */
interface Job {
  id: string;
  command: string;
  /** Where it runs, as the agent named it. */
  where: string;
  child: ChildProcess;
  started: number;
  ended: number | null;
  code: number | null;
  /** Everything it printed, cut in the middle when it is long. */
  all: string;
  /** What it printed since it was last read. */
  fresh: string;
  /** Still the call that started it: stopped with the run. Once it is a job it goes on. */
  attached: boolean;
  done: Promise<void>;
}

/** What one project's work on this computer holds between calls. */
export interface Bench {
  seen: Seen;
  jobs: Map<string, Job>;
  count: number;
  /**
   * What each reply changed with the file tools, by the reply: for every file, what it
   * held before that reply first touched it (null: it was not there) and how it stood when
   * the reply last left it. This is what "undo" puts back (CHA-274).
   */
  sets: Map<string, Map<string, Kept>>;
  /** Files an agent has changed here since the app started, by their real path. */
  agents: Set<string>;
  /** How many bytes are kept for undoing, over all replies. */
  kept: number;
}
interface Kept {
  shown: string;
  /** What the file held before the reply first changed it. Null: it was not there. */
  before: Buffer | null;
  /** What the file held after the reply's last change, as a digest: how undoing tells it was not changed again. */
  after: string | null;
  /** What it held before could not be kept (too large, or unreadable): it cannot be put back. */
  lost?: boolean;
}
export const newBench = (): Bench => ({
  seen: new Map(),
  jobs: new Map(),
  count: 0,
  sets: new Map(),
  agents: new Set(),
  kept: 0,
});
/** How many replies' changes are kept to be undone, and the largest file kept. */
const SETS = 40;
const KEPT_BYTES = 4 * 1024 * 1024;
const KEPT_IN_ALL = 96 * 1024 * 1024;
/** What a file holds now, as a digest. Null: it is not there, or cannot be read. */
const digest = async (file: string): Promise<string | null> => {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const bytes = await fs.readFile(file).catch(() => null);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
};

/** Forgets what was kept for a reply. */
function forget(bench: Bench, reply: string) {
  for (const kept of bench.sets.get(reply)?.values() ?? []) bench.kept -= kept.before?.length ?? 0;
  bench.sets.delete(reply);
}
/**
 * A reply has changed a file: what the file held before that reply first touched it is put
 * by (null: it was not there; "lost": it could not be kept), with what it holds now.
 */
async function changed(
  bench: Bench,
  reply: string | undefined,
  file: string,
  shown: string,
  before: Buffer | null | "lost",
) {
  bench.agents.add(file);
  if (!reply) return;
  let set = bench.sets.get(reply);
  if (!set) {
    set = new Map();
    bench.sets.set(reply, set);
    // The oldest go first.
    for (const old of [...bench.sets.keys()].slice(0, Math.max(0, bench.sets.size - SETS)))
      forget(bench, old);
  }
  const after = await digest(file);
  const kept = set.get(file);
  if (kept) {
    kept.after = after;
    return;
  }
  // The first change decides what "before" is, also when it could not be kept: a later
  // change in the same reply must not pass off a state in between as the beginning.
  const lost =
    before === "lost" ||
    (before !== null && (before.length > KEPT_BYTES || bench.kept + before.length > KEPT_IN_ALL));
  const held = lost ? null : (before as Buffer | null);
  bench.kept += held?.length ?? 0;
  set.set(file, { shown, before: held, after, ...(lost ? { lost: true } : {}) });
}

/** The replies whose file changes can still be put back, and which files. */
export const undoable = (bench: Bench): { reply: string; files: string[] }[] =>
  [...bench.sets].map(([reply, set]) => ({
    reply,
    files: [...set.values()].map((one) => one.shown),
  }));

/**
 * Puts back what a reply changed with the file tools. A file that was changed again
 * since, by the person or by a later reply, is left as it is and said so: undoing never
 * writes over work it does not know. What a command changed is not known and not undone.
 */
export async function undo(bench: Bench, reply: string, roots: string[]): Promise<string[]> {
  const set = bench.sets.get(reply);
  if (!set) return [];
  // Only in the folders attached now, as they really are.
  const inside: string[] = [];
  for (const root of roots) {
    const real = await fs.realpath(root).catch(() => null);
    if (real) inside.push(real);
  }
  const said: string[] = [];
  for (const [file, kept] of set) {
    if (kept.lost) {
      said.push(`${kept.shown}: cannot be put back, what it held was too large to keep.`);
      continue;
    }
    const parent = await fs.realpath(join(file, "..")).catch(() => null);
    if (!parent || !inside.some((root) => parent === root || parent.startsWith(root + sep))) {
      said.push(`${kept.shown}: left as it is, its folder is no longer attached.`);
      continue;
    }
    if ((await digest(file)) !== kept.after) {
      said.push(`${kept.shown}: left as it is, it was changed again since.`);
      continue;
    }
    try {
      if (kept.before === null) {
        await fs.unlink(file);
        said.push(`${kept.shown}: removed, it was not there before.`);
      } else {
        await put(file, kept.before);
        said.push(`${kept.shown}: put back.`);
      }
      bench.seen.delete(file);
    } catch {
      said.push(`${kept.shown}: could not be put back.`);
    }
  }
  forget(bench, reply);
  return said;
}

const COMMAND_CHARS = 8000;
/** How long a call waits for its command before the command becomes a job, in seconds. */
const WAIT = 60;
const WAIT_MOST = 110;
/** How much of what a command printed is kept, and how much of it one answer holds. */
const KEPT = 400_000;
const SHOWN = 30_000;
const JOBS = 8;
/** How long a job that ended is kept for its last output to be read. */
const ENDED_KEPT_MS = 10 * 60_000;
const EDIT_BYTES = 4 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The beginning and the end of something long: where a command says what it is and how it ended. */
export function clip(text: string, most = SHOWN): string {
  if (text.length <= most) return text;
  const head = Math.floor(most / 4);
  return `${text.slice(0, head)}\n[… ${text.length - most} characters left out …]\n${text.slice(-(most - head))}`;
}

/** The person's own shell, as a terminal would start it, with what a terminal would find. */
function shell(command: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Nothing is there to answer a prompt or page through output.
    TERM: "dumb",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  // What makes this app's own process what it is must not reach a tool started from it.
  for (const name of Object.keys(env))
    if (name.startsWith("ELECTRON_") || name === "NODE_OPTIONS") delete env[name];
  if (process.platform === "win32")
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command], env };
  // An app started from the Dock has a shorter PATH than a terminal: the usual places are added.
  const home = homedir();
  env.PATH = [
    env.PATH ?? "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
  ]
    .filter(Boolean)
    .join(":");
  return { file: process.env.SHELL || "/bin/sh", args: ["-lc", command], env };
}

/** What a program the app starts for the person is given: their own environment, as a terminal has it. */
export const toolEnv = (): NodeJS.ProcessEnv => shell("").env;

/** Ends a command and everything it started. */
function end(job: Job): void {
  const pid = job.child.pid;
  if (!pid) return;
  // The shell may be gone and what it started still going, in the same group.
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      // Its own group: the shell and what the shell ran.
      process.kill(-pid, name);
    } catch {
      try {
        job.child.kill(name);
      } catch {}
    }
  };
  const wasGoing = job.ended === null;
  signal("SIGTERM");
  setTimeout(() => {
    if (wasGoing ? job.ended === null : true) signal("SIGKILL");
  }, 3000).unref();
}

const took = (job: Job) => Math.round(((job.ended ?? Date.now()) - job.started) / 1000);
const state = (job: Job) =>
  job.ended === null
    ? `Job ${job.id} is running (${took(job)} s): ${job.command.slice(0, 200)}`
    : `Job ${job.id} ended with exit code ${job.code ?? "unknown"} after ${took(job)} s: ${job.command.slice(0, 200)}`;

async function exec(
  roots: string[],
  args: { command?: unknown; in?: unknown; wait?: unknown; background?: unknown },
  bench: Bench,
): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) throw new LocalError("Give the command to run.");
  if (command.length > COMMAND_CHARS)
    throw new LocalError("That command is too long. Put it in a script file and run that.");
  const where = String(args.in ?? "").trim() || ([...rootNames(roots).keys()][0] as string);
  const cwd = await locate(roots, where);
  if (!(await fs.stat(cwd)).isDirectory())
    throw new LocalError('"in" is the folder the command runs in, not a file.');
  for (const [id, job] of bench.jobs)
    if (job.ended !== null && (!job.fresh || Date.now() - job.ended > ENDED_KEPT_MS))
      bench.jobs.delete(id);
  if ([...bench.jobs.values()].filter((job) => job.ended === null).length >= JOBS)
    throw new LocalError(
      `${JOBS} commands are already running here. Stop one with local.job before starting another.`,
    );
  const { file, args: shellArgs, env } = shell(command);
  const child = spawn(file, shellArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  bench.count += 1;
  const job: Job = {
    id: `j${bench.count}`,
    command,
    where,
    child,
    started: Date.now(),
    ended: null,
    code: null,
    all: "",
    fresh: "",
    attached: true,
    done: Promise.resolve(),
  };
  // A character can arrive in two pieces: each stream keeps its own half until the rest comes.
  const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
  const take = (from: "out" | "err") => (chunk: Buffer) => {
    const text = decoders[from].write(chunk);
    job.all += text;
    if (job.all.length > KEPT) job.all = clip(job.all, KEPT / 2);
    job.fresh = (job.fresh + text).slice(-KEPT / 2);
  };
  child.stdout?.on("data", take("out"));
  child.stderr?.on("data", take("err"));
  job.done = new Promise<void>((done) => {
    child.once("error", (error) => {
      job.all += `\n[It could not be started: ${error.message}]`;
      job.ended = Date.now();
      done();
    });
    child.once("close", (code) => {
      job.code = code;
      job.ended = Date.now();
      done();
    });
  });
  bench.jobs.set(job.id, job);
  const background = args.background === true;
  const wait = background
    ? 2
    : Math.min(WAIT_MOST, Math.max(1, Math.floor(Number(args.wait) || WAIT)));
  await Promise.race([job.done, sleep(wait * 1000)]);
  if (job.ended !== null) {
    bench.jobs.delete(job.id);
    return `Exit code ${job.code ?? "unknown"} after ${took(job)} s, in ${where}.\n${clip(job.all).trimEnd() || "(It printed nothing.)"}`;
  }
  // It goes on by itself from here: a dev server, a long build. The run's end does not end it.
  job.attached = false;
  job.fresh = "";
  return `${background ? "Started" : `Still running after ${wait} s`} as job ${job.id}, in ${where}. What it has printed so far:\n${clip(job.all).trimEnd() || "(Nothing yet.)"}\n[Use local.job with id "${job.id}" to read what it prints next, to wait for it to end, or to stop it.]`;
}

async function jobTool(
  args: { id?: unknown; do?: unknown; wait?: unknown },
  bench: Bench,
): Promise<string> {
  const running = [...bench.jobs.values()];
  if (!args.id)
    return running.length ? running.map(state).join("\n") : "No command is running here.";
  const job = bench.jobs.get(String(args.id));
  if (!job)
    throw new LocalError(
      `There is no job "${String(args.id)}". ${running.length ? `There ${running.length === 1 ? "is" : "are"}: ${running.map((one) => one.id).join(", ")}.` : "None is running."}`,
    );
  const what = String(args.do ?? "read");
  if (what === "stop") {
    end(job);
    await Promise.race([job.done, sleep(5000)]);
  } else if (what === "wait")
    await Promise.race([
      job.done,
      sleep(Math.min(WAIT_MOST, Math.max(1, Math.floor(Number(args.wait) || WAIT))) * 1000),
    ]);
  else if (what !== "read") throw new LocalError('"do" is "read", "wait" or "stop".');
  const printed = clip(job.fresh).trimEnd();
  job.fresh = "";
  const said = `${state(job)}\n${printed || "(Nothing new was printed.)"}`;
  if (job.ended !== null) bench.jobs.delete(job.id);
  return said;
}

/** The same lines with what stands before and after each taken off: how a piece is found when only its spacing differs. */
const loose = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

async function edit(
  roots: string[],
  args: { path?: unknown; old?: unknown; new?: unknown; all?: unknown },
  bench: Bench,
  reply?: string,
): Promise<string> {
  const seen = bench.seen;
  const shown = String(args.path ?? "");
  const old = String(args.old ?? "");
  const next = String(args.new ?? "");
  if (!old)
    throw new LocalError('Give the piece to replace in "old", exactly as it stands in the file.');
  if (old === next) throw new LocalError('"old" and "new" are the same: nothing would change.');
  const file = await locate(roots, shown, true);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) throw new LocalError(`${shown} does not exist. Create it with local.write.`);
  if (stat.isSymbolicLink())
    throw new LocalError("That is a link to somewhere else. Change the file itself.");
  if (!stat.isFile()) throw new LocalError("That is not an ordinary file.");
  if (stat.size > EDIT_BYTES) throw new LocalError("That file is too large to change this way.");
  await unchanged(file, shown, seen);
  const bytes = await fs.readFile(file);
  if (looksBinary(bytes)) throw new LocalError("That file is not text.");
  const text = bytes.toString("utf8");
  // The file's own line endings are kept, whichever the piece was given with.
  const crlf = text.includes("\r\n");
  const own = (given: string) => (crlf ? given.replace(/\r?\n/g, "\r\n") : given);
  let piece = own(old);
  const put_ = own(next);
  let found = text.split(piece).length - 1;
  let loosely = false;
  if (found === 0) {
    // The words are right and the spacing is not: a piece that matches line for line once
    // its indentation is set aside, and only one such, is the piece that was meant.
    const want = loose(old);
    const lines = text.split(crlf ? "\r\n" : "\n");
    const span = old.split("\n").length;
    const places: number[] = [];
    for (let at = 0; at + span <= lines.length; at++)
      if (loose(lines.slice(at, at + span).join("\n")) === want) places.push(at);
    if (places.length === 1) {
      piece = lines
        .slice(places[0] as number, (places[0] as number) + span)
        .join(crlf ? "\r\n" : "\n");
      found = 1;
      loosely = true;
    }
  }
  if (found === 0)
    throw new LocalError(
      `That piece is not in ${shown} as you gave it. Read the file again and copy the piece exactly, with its spaces and line breaks.`,
    );
  // A piece found only by setting its spacing aside is one place: "all" needs the exact piece.
  if (loosely && args.all === true)
    throw new LocalError(
      `That piece is in ${shown} only with other spacing than you gave. Copy it exactly to replace every place it is.`,
    );
  if (found > 1 && args.all !== true)
    throw new LocalError(
      `That piece is in ${shown} ${found} times. Give more of the lines around it so that it is there once, or set "all" to replace every one.`,
    );
  const after_ = args.all === true ? text.split(piece).join(put_) : text.replace(piece, () => put_);
  // Nothing is written over what changed while this was worked out.
  await unchanged(file, shown, seen);
  const partly = seen.get(file)?.startsWith(PART) ?? false;
  await put(file, after_);
  await changed(bench, reply, file, shown, bytes);
  // Having read a part and changed a piece is still not having read the whole.
  seen.set(file, `${partly ? PART : ""}${await stamp(file)}`);
  const was = piece.split("\n").length;
  const now = next.split("\n").length;
  return `Changed ${shown}: ${found > 1 ? `${found} places` : "1 place"}, ${was} line${was === 1 ? "" : "s"} replaced by ${now}.`;
}

/** What an attached folder is, for the agent and for the page: a repository, its branch and state, its own instructions. */
export interface FolderNote {
  name: string;
  repository: boolean;
  branch: string | null;
  /** How many files have changes that are not committed. Null when git did not say in time. */
  changed: number | null;
  /** What the repository's own instruction files say, cut short. */
  instructions: { file: string; text: string }[];
  /** The commands the repository says check it (`muster.json`, "checks"). */
  checks: string[];
}
/** What a repository says checks it: `{"checks": ["pnpm typecheck", "pnpm test"]}` in muster.json at its root. */
async function checksOf(root: string): Promise<string[]> {
  const text = await beginning(join(root, "muster.json"), 16_000);
  if (!text) return [];
  try {
    const checks = (JSON.parse(text) as { checks?: unknown }).checks;
    return Array.isArray(checks)
      ? checks
          .filter((one): one is string => typeof one === "string" && one.trim().length > 0)
          .map((one) => one.trim().slice(0, 300))
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const INSTRUCTION_CHARS = 6000;
/** Asks git something about a folder. It only reads: nothing a repository configures to run beside git is run. */
const git = (cwd: string, args: string[]) =>
  new Promise<string | null>((done) => {
    execFile(
      "git",
      [...QUIET_GIT, ...args],
      { cwd, timeout: 6000, maxBuffer: 16 * 1024 * 1024, env: gitEnv() },
      (error, out) => done(error ? null : String(out)),
    );
  });
/** The beginning of a file that is itself there: never what a link points at. */
async function beginning(file: string, chars: number): Promise<string | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, chars * 4));
    await handle.read(buffer, 0, buffer.length, 0);
    return looksBinary(buffer) ? null : buffer.toString("utf8").slice(0, chars);
  } finally {
    await handle.close();
  }
}
export async function describe(roots: string[]): Promise<FolderNote[]> {
  const notes: FolderNote[] = [];
  for (const [name, root] of rootNames(roots)) {
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? null;
    const status = branch === null ? null : await git(root, ["status", "--porcelain"]);
    const instructions: FolderNote["instructions"] = [];
    for (const file of INSTRUCTION_FILES) {
      const text = await beginning(join(root, file), INSTRUCTION_CHARS);
      if (text?.trim()) instructions.push({ file: `${name}/${file}`, text });
    }
    notes.push({
      name,
      repository: branch !== null,
      branch,
      // Not known is not the same as none: an agent told "no changes" may think nothing can be lost.
      changed:
        branch === null ? 0 : status === null ? null : status.split("\n").filter(Boolean).length,
      instructions,
      checks: await checksOf(root),
    });
  }
  return notes;
}

/** What has changed in a repository and is not committed, for the person to look at (CHA-274). */
export interface RepoChanges {
  name: string;
  branch: string | null;
  files: {
    path: string;
    /** As git says it: "M" changed, "A" added, "D" deleted, "R" renamed, "?" new and not yet added. */
    state: string;
    /** The difference from what is committed; the whole of a new file. Empty when it is not text or too long. */
    diff: string;
    /** An agent changed it here since the app started. The rest is the person's own work. */
    agent: boolean;
  }[];
  /** How many more files changed than are listed. */
  more: number;
}
const CHANGED_FILES = 80;
const DIFF_CHARS = 60_000;
export async function changes(roots: string[], bench?: Bench): Promise<RepoChanges[]> {
  const out: RepoChanges[] = [];
  for (const [name, root] of rootNames(roots)) {
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? null;
    if (branch === null) continue;
    const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = (status ?? "").split("\0").filter(Boolean);
    const listed: { path: string; state: string }[] = [];
    for (let at = 0; at < entries.length; at++) {
      const entry = entries[at] as string;
      const code = entry.slice(0, 2);
      // A rename is followed by the name it had: not a file of its own.
      if (code.includes("R") || code.includes("C")) at += 1;
      listed.push({ path: entry.slice(3), state: code === "??" ? "?" : code.trim().charAt(0) });
    }
    const files: RepoChanges["files"] = [];
    for (const one of listed.slice(0, CHANGED_FILES)) {
      let diff = "";
      // What holds secrets is named and never shown.
      if (!isProtected(one.path)) {
        if (one.state === "?") {
          // Only a file that is itself there: a new link to somewhere else is named, not read.
          const stat = await fs.lstat(join(root, one.path)).catch(() => null);
          const bytes = stat?.isFile()
            ? await fs.readFile(join(root, one.path)).catch(() => null)
            : null;
          if (bytes && bytes.length <= DIFF_CHARS && !looksBinary(bytes))
            diff = bytes
              .toString("utf8")
              // The line break that ends the file is not a line of its own.
              .replace(/\r?\n$/, "")
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n");
        } else {
          const text = await git(root, [
            "diff",
            "HEAD",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            one.path,
          ]);
          if (text && text.length <= DIFF_CHARS) diff = text;
        }
      }
      const real = await fs.realpath(join(root, one.path)).catch(() => join(root, one.path));
      files.push({ ...one, diff, agent: bench?.agents.has(real) ?? false });
    }
    out.push({ name, branch, files, more: Math.max(0, listed.length - CHANGED_FILES) });
  }
  return out;
}

/**
 * The files of the attached folders, for the person to look through beside a conversation
 * (CHA-274): what a repository knows of and does not ignore, never what holds secrets,
 * never a link. Names only; a file is read when it is opened.
 */
const TREE_FILES = 6000;
export async function tree(
  roots: string[],
): Promise<{ name: string; files: string[]; more: boolean }[]> {
  const out: { name: string; files: string[]; more: boolean }[] = [];
  for (const [name, root] of rootNames(roots)) {
    const { files, cut } = await filesUnder(name, root, TREE_FILES);
    out.push({
      name,
      files: files.map((file) => file.label.slice(name.length + 1)).sort(),
      more: cut,
    });
  }
  return out;
}
/** A file's text, for the person to read. What an agent has seen is not touched by this. */
export const view = async (roots: string[], path: string): Promise<string> =>
  // What is said of a long file is said to the person here, not to an agent.
  (await runLocal(roots, "read", { path })).replace(
    /\n\n\[The file continues;[^\]]*\]$/,
    "\n\n[The file is longer; only its first 256 KB are shown.]",
  );

/** The commands going on in a project, for the person to see and stop. */
export interface JobNote {
  id: string;
  command: string;
  where: string;
  running: boolean;
  seconds: number;
  code: number | null;
  /** The last of what it printed. */
  tail: string;
}
export const jobsOf = (bench: Bench): JobNote[] =>
  [...bench.jobs.values()]
    .filter((job) => !job.attached)
    .map((job) => ({
      id: job.id,
      command: job.command,
      where: job.where,
      running: job.ended === null,
      seconds: took(job),
      code: job.code,
      tail: job.all.slice(-4000),
    }));
/** The person stops a job themselves. */
export function stopJob(bench: Bench, id: string): void {
  const job = bench.jobs.get(id);
  if (job) end(job);
}

/** Ends the commands that belong to a run that was stopped. Jobs go on. */
export function halt(bench: Bench): void {
  for (const job of bench.jobs.values()) if (job.attached) end(job);
}
/** Ends everything, when the app closes. */
export function endAll(bench: Bench): void {
  for (const job of bench.jobs.values()) end(job);
}

/** Runs one call of any kind. Throws LocalError with words the agent can act on. */
export async function runCode(
  roots: string[],
  tool: string,
  args: Record<string, unknown>,
  bench: Bench,
  /** The reply this call belongs to, so that what it changes can be undone as that reply's. */
  reply?: string,
): Promise<string> {
  if (roots.length === 0)
    throw new LocalError("No folder on this computer is attached to this project.");
  if (tool === "exec") return exec(roots, args, bench);
  if (tool === "job") return jobTool(args, bench);
  if (tool === "edit") return edit(roots, args, bench, reply);
  if (tool === "write") {
    // What the file held is read first and put by only once the writing has been done.
    const file = await locate(roots, String(args.path ?? ""), true).catch(() => null);
    const stat = file ? await fs.lstat(file).catch(() => null) : null;
    // Not there: null. There and small enough: what it holds. Otherwise it cannot be kept,
    // which is not the same as not having been there.
    const before: Buffer | null | "lost" = !(file && stat?.isFile())
      ? null
      : stat.size > KEPT_BYTES
        ? "lost"
        : await fs.readFile(file).catch(() => "lost" as const);
    const said = await runLocal(roots, tool, args, bench.seen);
    if (file) await changed(bench, reply, file, String(args.path), before);
    return said;
  }
  return runLocal(roots, tool, args, bench.seen);
}
