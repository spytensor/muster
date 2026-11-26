import { existsSync, promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { rootNames } from "./local.js";
import { git, oneAtATime, said, short } from "./task.js";

/**
 * The way back from what a reply changed in a repository (MUS-19).
 *
 * Around every call of a reply that may change something, the repository is written
 * down twice, as it stands before and as it stands after: each a commit made with an
 * index of the app's own, which touches nothing of the person's. What differs between
 * the two is what that call changed, and is added to the reply's list: for each path,
 * what it held before the reply first changed it and what the reply last left in it.
 * Undoing puts back exactly those paths, and of those only the ones that still hold what
 * the reply left. A path the person, or another conversation, changed before, between or
 * after the reply's calls is not the reply's to put back, and is left alone and named.
 *
 * The list is a file in the repository's own `.git` (`muster-undo/<reply>.json`), and
 * what it needs of the before-states is kept alive by one ref for the reply
 * (`refs/muster/undo/<reply>`). Both are in the repository, so they outlive the app.
 */

const REPLY = /^[0-9A-Za-z-]{1,64}$/;
const refOf = (reply: string) => `refs/muster/undo/${reply}`;
/** How many replies' changes a repository keeps the way back for. */
const KEPT_REPLIES = 40;
/** An untracked file larger than this is not written down: a build's output, a dump, a video. */
export const BIG_BYTES = 5 * 1024 * 1024;

interface Entry {
  /** The blob the path held before the reply first changed it; null: it was not there. */
  was: string | null;
  /** The blob the reply last left in it; null: the reply removed it. */
  became: string | null;
  /** How the file was (an ordinary file, one that can be run, a link), to put it back as it was. */
  mode: string;
  /** Someone else changed it between two of the reply's own changes: not the reply's to put back. */
  mixed?: true;
}
interface Ledger {
  /** The top of the folder the changes were made in: the repository, or a copy of it. */
  top: string;
  paths: Record<string, Entry>;
}

/** Where a folder is in its repository. Null when it is in none. */
async function placeOf(dir: string) {
  const top = await said(dir, ["rev-parse", "--show-toplevel"]);
  const gitDir = await said(dir, ["rev-parse", "--absolute-git-dir"]);
  const common = await said(dir, ["rev-parse", "--git-common-dir"]);
  if (!top || !gitDir || !common) return null;
  return {
    top,
    gitDir,
    common: resolve(dir, common),
    prefix: (await said(dir, ["rev-parse", "--show-prefix"])) ?? "",
  };
}
const ledgerAt = (common: string, reply: string) => join(common, "muster-undo", `${reply}.json`);
async function readLedger(common: string, reply: string): Promise<Ledger | null> {
  try {
    const saved = JSON.parse(await fs.readFile(ledgerAt(common, reply), "utf8")) as Ledger;
    return saved && typeof saved.top === "string" && saved.paths ? saved : null;
  } catch {
    return null;
  }
}
async function forget(dir: string, common: string, reply: string) {
  await fs.rm(ledgerAt(common, reply), { force: true });
  await git(dir, ["update-ref", "-d", refOf(reply)]);
}

/** A repository written down at a moment. */
export interface Mark {
  top: string;
  gitDir: string;
  common: string;
  commit: string;
  /** Untracked files too large to write down: what a call does to them cannot be put back. */
  skipped: string[];
}

/**
 * The whole repository as it stands, as a commit nothing points at: every file git knows
 * of or would add. What is ignored is not written down, nor an untracked file over
 * 5 MB. Null when it could not be made: the work goes on without a way back for that
 * call, and is never held up for it.
 */
export async function mark(dir: string): Promise<Mark | null> {
  const place = await placeOf(dir);
  if (!place) return null;
  const { top, gitDir, common } = place;
  // One at a time for the repository's index of ours, whichever attached folder asks.
  return oneAtATime(`mark:${gitDir}`, async () => {
    // An index of the app's own, begun as a copy of the person's so that only what changed is read again.
    const index = join(gitDir, "muster-index");
    if (!existsSync(index)) {
      const theirs = await said(top, ["rev-parse", "--git-path", "index"]);
      if (theirs && existsSync(resolve(top, theirs)))
        await fs.copyFile(resolve(top, theirs), index).catch(() => undefined);
    }
    const env = { GIT_INDEX_FILE: index };
    const skipped: string[] = [];
    const others = await git(top, ["ls-files", "--others", "--exclude-standard", "-z"], env);
    for (const path of others.out.split("\0").filter(Boolean)) {
      const stat = await fs.lstat(join(top, path)).catch(() => null);
      if (stat?.isFile() && stat.size > BIG_BYTES) skipped.push(path);
    }
    const added = await git(
      top,
      ["add", "-A", "--", ".", ...skipped.map((path) => `:(exclude,literal)${path}`)],
      env,
    );
    if (added.code !== 0) return null;
    const tree = await said(top, ["write-tree"], env);
    // Its message says nothing of where it was taken: a ref can be published by mistake.
    const commit = tree ? await said(top, ["commit-tree", tree, "-m", "Muster checkpoint"]) : null;
    return commit ? { top, gitDir, common, commit, skipped } : null;
  });
}

const NONE = /^0+$/;
interface Change {
  path: string;
  was: string | null;
  became: string | null;
  mode: string;
}
async function between(top: string, from: string, to: string): Promise<Change[]> {
  const raw = await git(top, ["diff-tree", "-r", "--no-renames", "-z", "--raw", from, to]);
  if (raw.code !== 0) return [];
  const parts = raw.out.split("\0");
  const out: Change[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const [old, now, was, became] = (parts[at] as string).replace(/^:/, "").split(" ");
    // Another repository inside this one is its own to put back.
    if (!old || !now || !was || !became || old === "160000" || now === "160000") continue;
    out.push({
      path: parts[at + 1] as string,
      // How it was; for a new file, how it is.
      mode: NONE.test(old) ? now : old,
      was: NONE.test(was) ? null : was,
      became: NONE.test(became) ? null : became,
    });
  }
  return out;
}

/**
 * A call of a reply is over: what changed in the repository since `before` is the reply's,
 * and is added to its list. `only` names the one path a file tool wrote: nothing else that
 * moved meanwhile is taken for the reply's. Returns the paths taken.
 */
export async function record(
  dir: string,
  reply: string,
  before: Mark,
  only?: string,
): Promise<string[]> {
  if (!REPLY.test(reply)) return [];
  const after = await mark(dir);
  if (!after) return [];
  const { top, common } = before;
  const wanted = only === undefined ? null : relative(top, only);
  const changed = (await between(top, before.commit, after.commit)).filter(
    (one) => wanted === null || one.path === wanted,
  );
  if (changed.length === 0) return [];
  return oneAtATime(`ledger:${common}`, async () => {
    const ledger = (await readLedger(common, reply)) ?? { top, paths: {} };
    for (const one of changed) {
      const entry = ledger.paths[one.path];
      if (!entry) {
        ledger.paths[one.path] = { was: one.was, became: one.became, mode: one.mode };
        continue;
      }
      // Not what the reply left there: somebody else changed it in between.
      if (entry.became !== one.was) entry.mixed = true;
      entry.became = one.became;
      // Put back by the reply itself: nothing of it is left to undo.
      if (!entry.mixed && entry.was === entry.became) delete ledger.paths[one.path];
    }
    await fs.mkdir(join(common, "muster-undo"), { recursive: true });
    await fs.writeFile(ledgerAt(common, reply), JSON.stringify(ledger));
    // What the paths held before is kept alive: this state, after the ones kept already.
    const earlier = await said(top, ["rev-parse", "-q", "--verify", refOf(reply)]);
    const kept = await said(top, [
      "commit-tree",
      `${before.commit}^{tree}`,
      ...(earlier ? ["-p", earlier] : []),
      "-m",
      "Muster checkpoint",
    ]);
    if (kept) await git(top, ["update-ref", refOf(reply), kept]);
    await prune(top, common);
    return changed.map((one) => one.path);
  });
}
const relative = (top: string, file: string) =>
  (file.startsWith(top + sep) ? file.slice(top.length + 1) : file).split(sep).join("/");

/** The oldest go: a way back is kept for the last replies, not for ever. */
async function prune(top: string, common: string) {
  const dir = join(common, "muster-undo");
  const files = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
  if (files.length <= KEPT_REPLIES) return;
  const aged = await Promise.all(
    files.map(async (name) => ({
      name,
      at: (await fs.stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  aged.sort((a, b) => b.at - a.at);
  for (const old of aged.slice(KEPT_REPLIES)) await forget(top, common, old.name.slice(0, -5));
}

/**
 * Whether a file an agent is about to write is one the repository's way back covers. Not
 * a file git ignores, and not one inside another repository within this one (a
 * submodule, a nested clone): for those the file tools' own copy is the way back.
 */
export async function covers(dir: string, file: string): Promise<boolean> {
  const top = await said(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return false;
  // The nearest folder that is there: a new file's folder may not be yet.
  let near = dirname(file);
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  if ((await said(near, ["rev-parse", "--show-toplevel"])) !== top) return false;
  return (await git(top, ["check-ignore", "-q", "--", relative(top, file)])).code !== 0;
}

/** The replies whose changes to these folders' repositories can be put back, and the files each changed. */
export async function undoableIn(roots: string[]): Promise<{ reply: string; files: string[] }[]> {
  const out = new Map<string, string[]>();
  const looked = new Set<string>();
  for (const [name, root] of rootNames(roots)) {
    const place = await placeOf(root);
    if (!place) continue;
    const dir = join(place.common, "muster-undo");
    for (const file of await fs.readdir(dir).catch(() => [])) {
      const reply = file.endsWith(".json") ? file.slice(0, -5) : "";
      // Once for a repository, however many of its folders are attached.
      if (!REPLY.test(reply) || looked.has(`${place.common}\0${reply}`)) continue;
      looked.add(`${place.common}\0${reply}`);
      const ledger = await readLedger(place.common, reply);
      const files = Object.keys(ledger?.paths ?? {}).map((path) => shown(name, place.prefix, path));
      if (files.length) out.set(reply, [...(out.get(reply) ?? []), ...files]);
    }
  }
  return [...out].map(([reply, files]) => ({ reply, files }));
}
/** A path in the repository as the person knows it: under the attached folder's name where it is in it. */
const shown = (name: string, prefix: string, path: string) =>
  path.startsWith(prefix) ? `${name}/${path.slice(prefix.length)}` : path;

/** What a path holds now, as git would name it. Null: it is not there. */
async function holds(top: string, path: string): Promise<string | null> {
  const file = join(top, path);
  const stat = await fs.lstat(file).catch(() => null);
  // A link is what it points at, as text: never followed.
  if (stat?.isSymbolicLink())
    return (await git(top, ["hash-object", "--stdin"], {}, await fs.readlink(file))).out.trim();
  return stat?.isFile() ? said(top, ["hash-object", "--", path]) : null;
}

/**
 * Puts back what a reply changed, and only that. Returns what became of each file, the
 * files written, and how many are still the reply's to put back (so the line stays).
 */
export async function undoIn(
  roots: string[],
  reply: string,
): Promise<{ said: string[]; touched: string[]; left: number }> {
  const out: string[] = [];
  const touched: string[] = [];
  let left = 0;
  if (!REPLY.test(reply)) return { said: out, touched, left };
  const done = new Set<string>();
  for (const [name, root] of rootNames(roots)) {
    const place = await placeOf(root);
    if (!place || done.has(place.common)) continue;
    done.add(place.common);
    const ledger = await readLedger(place.common, reply);
    if (!ledger) continue;
    // Where the changes were made: the folder, or the copy the work was in.
    if (!existsSync(ledger.top)) {
      out.push(`${name}: the copy of the repository these changes were made in is gone.`);
      left += Object.keys(ledger.paths).length;
      continue;
    }
    const top = ledger.top;
    const name_ = (path: string) => shown(name, place.prefix, path);
    const back: [string, Entry][] = [];
    for (const [path, entry] of Object.entries(ledger.paths)) {
      if (entry.mixed) {
        out.push(`${name_(path)}: left as it is, someone else changed it while the reply worked.`);
        continue;
      }
      if ((await holds(top, path)) !== entry.became) {
        out.push(`${name_(path)}: left as it is, it was changed again since.`);
        continue;
      }
      back.push([path, entry]);
    }
    const again = back.filter(([, entry]) => entry.was !== null);
    const ok = new Set<string>();
    if (again.length) {
      // Written from an index made for this alone, holding just these files as they were.
      const index = join(place.gitDir, `muster-undo-${short(reply)}`);
      const env = { GIT_INDEX_FILE: index };
      await fs.rm(index, { force: true });
      const set = await git(
        top,
        ["update-index", "-z", "--index-info"],
        env,
        again.map(([path, entry]) => `${entry.mode} ${entry.was}\t${path}\0`).join(""),
      );
      for (const [path] of again) {
        const wrote =
          set.code === 0 && (await git(top, ["checkout-index", "-f", "--", path], env)).code === 0;
        if (wrote) ok.add(path);
        out.push(wrote ? `${name_(path)}: put back.` : `${name_(path)}: could not be put back.`);
      }
      await fs.rm(index, { force: true });
    }
    for (const [path, entry] of back) {
      if (entry.was !== null) continue;
      const removed = await fs.unlink(join(top, path)).then(
        () => true,
        () => false,
      );
      if (removed) ok.add(path);
      out.push(
        removed
          ? `${name_(path)}: removed, it was not there before.`
          : `${name_(path)}: could not be removed.`,
      );
    }
    for (const path of ok) {
      touched.push(join(top, path));
      delete ledger.paths[path];
    }
    // Forgotten only once everything is put back: what was not is still there to try again.
    const rest = Object.keys(ledger.paths).length;
    left += rest;
    if (rest === 0) await forget(top, place.common, reply);
    else await fs.writeFile(ledgerAt(place.common, reply), JSON.stringify(ledger));
  }
  return { said: out, touched, left };
}
