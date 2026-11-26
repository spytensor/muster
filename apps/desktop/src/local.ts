import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * What an agent may do in the folders a person attached to a project: look, read, search
 * and write, and only inside those folders. This runs on the person's computer. Nothing
 * here talks to the network: what is read goes back to the page that asked, which sends
 * it on as the answer to the agent's call.
 */
export type LocalTool = "list" | "read" | "search" | "write";
/**
 * What each file looked like when the agent last read or wrote it, by its real path. A
 * change is made only to a file that is still as the agent saw it: the person works in
 * the same folders, in their own editor, at the same time (CHA-273).
 */
export type Seen = Map<string, string>;
/** Before the stamp of a file that was read only in part. */
export const PART = "part:";
/** A file as it stands now, well enough to tell that it changed. */
export const stamp = async (file: string): Promise<string> => {
  const stat = await fs.stat(file);
  return `${stat.mtimeMs}:${stat.size}`;
};
export class LocalError extends Error {}

const READ_BYTES = 256 * 1024;
/** The largest file read by lines, and how many lines are given when none are asked for. */
const READ_WHOLE = 4 * 1024 * 1024;
const READ_LINES = 2000;
const WRITE_BYTES = 1024 * 1024;
const LIST_ENTRIES = 500;
/** For each attached folder on its own: one large folder does not use up another's share. */
const SEARCH_FILES = 8000;
const SEARCH_HITS = 60;
const FIND_FILES = 200;
const SEARCH_FILE_BYTES = 512 * 1024;

/** Folders that are never entered and files that are never opened, wherever they are. */
export const SKIPPED = new Set(["node_modules", ".git", ".svn", ".hg", ".DS_Store", "__pycache__"]);
/** Names that hold secrets. They are not read or written, and searches do not look inside them. */
const PROTECTED = [
  /^\.env(\..*)?$/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.kube$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
  /^\.(npmrc|pypirc|git-credentials)$/i,
  /^\.(docker|config)$/i,
  /\.(kdbx|ovpn)$/i,
  /^\.(bash|zsh|sh|python|node_repl|psql|mysql)_history$/i,
];
/** Places where a file is run by a tool the person uses. Nothing is written there. */
const RUNS = [/^\.vscode$/i, /^\.idea$/i, /^\.github$/i, /^\.husky$/i];
const parts = (path: string) => path.split(/[\\/]/).filter(Boolean);
export const isProtected = (path: string) =>
  parts(path).some((part) => PROTECTED.some((rule) => rule.test(part)));
const isSkipped = (path: string) => parts(path).some((part) => SKIPPED.has(part));
const isRun = (path: string) => parts(path).some((part) => RUNS.some((rule) => rule.test(part)));
/** Refuses a path, written or real, that names something agents stay out of. */
function allow(path: string, forWriting: boolean): void {
  if (isProtected(path))
    throw new LocalError("That file is protected: it looks like it holds keys or passwords.");
  if (isSkipped(path))
    throw new LocalError(
      "That is inside a folder agents stay out of (.git, node_modules and the like).",
    );
  if (forWriting && isRun(path))
    throw new LocalError(
      "Nothing is written there: tools on this computer run what is in that folder.",
    );
}

/** The names the agent uses for the attached folders: the folder's own name, made unique. */
export function rootNames(roots: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const root of roots) {
    const base = basename(root) || root;
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
    names.set(name, root);
  }
  return names;
}

/**
 * Whether a folder may be attached at all. Not the whole disk, not the home folder or
 * anything above it, and not anything that holds, or is inside, where this app keeps
 * its own records (which is also where the system keeps keychains and browser profiles).
 */
export function attachable(path: string, home: string, appData: string): boolean {
  const within = (inner: string, outer: string) =>
    inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  const folder = resolve(path);
  const library = dirname(dirname(resolve(appData)));
  return !(
    within(resolve(home), folder) ||
    within(resolve(appData), folder) ||
    within(folder, library)
  );
}

/**
 * Turns "Folder/some/file.txt" into a real path, and refuses anything that is not inside
 * one of the attached folders once links are followed, or that holds secrets.
 */
export async function locate(roots: string[], asked: string, forWriting = false): Promise<string> {
  const cleaned = String(asked ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const [name, ...rest] = cleaned.split("/");
  const root = rootNames(roots).get(name ?? "");
  if (!root)
    throw new LocalError(
      `There is no attached folder named "${name}". The attached folders are: ${[...rootNames(roots).keys()].join(", ") || "none"}.`,
    );
  if (rest.some((part) => part === ".."))
    throw new LocalError("A path cannot step out of its folder.");
  const target = resolve(root, ...rest);
  allow(relative(root, target), forWriting);
  const realRoot = await fs.realpath(root);
  // A new file does not exist yet: its folder is what must be inside.
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    if (!forWriting) throw new LocalError(`"${cleaned}" does not exist.`);
    let parent: string;
    try {
      parent = await fs.realpath(dirname(target));
    } catch {
      throw new LocalError(`The folder for "${cleaned}" does not exist.`);
    }
    real = join(parent, basename(target));
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new LocalError("That path leads outside the attached folder.");
  // A link can give a protected file an innocent name: what it really is decides.
  allow(relative(realRoot, real), forWriting);
  return real;
}

export const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

async function list(roots: string[], args: { path?: unknown }): Promise<string> {
  const names = rootNames(roots);
  if (!args.path || String(args.path).trim() === "" || String(args.path).trim() === "/")
    return names.size
      ? `Attached folders:\n${[...names.keys()].map((name) => `${name}/`).join("\n")}`
      : "No folder is attached to this project.";
  const folder = await locate(roots, String(args.path));
  const stat = await fs.stat(folder);
  if (!stat.isDirectory()) throw new LocalError("That is a file, not a folder.");
  const entries = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((entry) => !SKIPPED.has(entry.name))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
  const lines: string[] = [];
  for (const entry of entries.slice(0, LIST_ENTRIES)) {
    if (entry.isDirectory()) lines.push(`${entry.name}/`);
    else {
      const size = await fs.stat(join(folder, entry.name)).then(
        (s) => s.size,
        () => 0,
      );
      lines.push(`${entry.name}  (${size} bytes)`);
    }
  }
  if (entries.length > LIST_ENTRIES)
    lines.push(`[${entries.length - LIST_ENTRIES} more are not shown.]`);
  return lines.length ? lines.join("\n") : "The folder is empty.";
}

async function read(
  roots: string[],
  args: { path?: unknown; from?: unknown; lines?: unknown },
  seen?: Seen,
): Promise<string> {
  const file = await locate(roots, String(args.path ?? ""));
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new LocalError("That is a folder. Use list to see what is in it.");
  if (!stat.isFile()) throw new LocalError("That is not an ordinary file.");
  const ranged = args.from !== undefined || args.lines !== undefined;
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, ranged ? READ_WHOLE : READ_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    if (looksBinary(buffer))
      throw new LocalError(
        "That file is not text (a Word, Excel, PowerPoint, PDF or image file, for example). Ask the person to attach it to the conversation so it can be read.",
      );
    // Read in part: enough to change a piece of it, not to replace the whole.
    seen?.set(file, `${ranged || stat.size > READ_BYTES ? PART : ""}${stat.mtimeMs}:${stat.size}`);
    const text = buffer.toString("utf8");
    if (!ranged)
      return stat.size > READ_BYTES
        ? `${text}\n\n[The file continues; only the first ${READ_BYTES} bytes are shown. Read further with "from" (a line number) and "lines".]`
        : text;
    // A part of a long file, by lines: where a search or an error pointed.
    const all = text.split("\n");
    const from = Math.max(1, Math.floor(Number(args.from) || 1));
    const count = Math.min(READ_LINES, Math.max(1, Math.floor(Number(args.lines) || READ_LINES)));
    const part = all.slice(from - 1, from - 1 + count);
    if (part.length === 0) throw new LocalError(`The file has ${all.length} lines.`);
    const more = stat.size > READ_WHOLE ? " The file is longer than can be read by lines." : "";
    return `[Lines ${from} to ${from + part.length - 1} of ${all.length}.${more}]\n${part.join("\n")}`;
  } finally {
    await handle.close();
  }
}

/** How git is asked something here: no monitor, no pager, no lock taken on the person's repository. */
export const QUIET_GIT = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "--no-optional-locks",
];
export const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
});
/** The most of a line a pattern is tried on, and the longest pattern taken. */
const LINE_TRIED = 2000;
const PATTERN_CHARS = 300;
/** A repeat of something that itself repeats: the kind of pattern that can take for ever on one line. */
const RUNAWAY = /\([^()]*[+*|{][^()]*\)[+*{]|\)[+*{?]*\)[+*{]/;
/** A file name pattern as people write them: a star for part of a name, two stars for any folders, braces for a choice. */
export function globToRegExp(glob: string): RegExp {
  if (glob.length > 200 || (glob.match(/\*/g)?.length ?? 0) > 8)
    throw new LocalError("That name pattern is too long. Use a shorter one.");
  let out = "";
  for (let at = 0; at < glob.length; at++) {
    const ch = glob[at] as string;
    if (ch === "*") {
      if (glob[at + 1] === "*") {
        at += 1;
        if (glob[at + 1] === "/") {
          at += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", at);
      if (end < 0) out += "\\{";
      else {
        out += `(?:${glob
          .slice(at + 1, end)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        at = end;
      }
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * The files under a folder that an agent may look in, each with the path it is shown by.
 * In a repository these are the files git knows of and the new ones it does not ignore,
 * so what a build left behind is not gone through; elsewhere the folder is walked.
 */
export async function filesUnder(
  shown: string,
  folder: string,
  budget: number,
): Promise<{ files: { label: string; path: string }[]; cut: boolean }> {
  const usable = (rel: string) =>
    !rel.split("/").some((part) => SKIPPED.has(part) || isProtected(part));
  const listed = await new Promise<string[] | null>((done) => {
    execFile(
      "git",
      // Only asked what it knows: nothing a repository configures to run beside git is run.
      [...QUIET_GIT, "ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: folder, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (error, out) => done(error ? null : String(out).split("\0").filter(Boolean)),
    );
  });
  if (listed) {
    const kept = listed.filter(usable);
    const files: { label: string; path: string }[] = [];
    for (const rel of kept.slice(0, budget)) {
      const path = join(folder, rel);
      // A repository can hold a link to anywhere on the disk under an innocent name: only
      // files that are themselves there are gone through, as when a folder is walked.
      const stat = await fs.lstat(path).catch(() => null);
      if (stat?.isFile()) files.push({ label: `${shown}/${rel}`, path });
    }
    return { files, cut: kept.length > budget };
  }
  const files: { label: string; path: string }[] = [];
  let cut = false;
  const walk = async (label: string, at: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= budget) {
        cut = true;
        return;
      }
      if (SKIPPED.has(entry.name) || isProtected(entry.name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(`${label}/${entry.name}`, join(at, entry.name));
      else files.push({ label: `${label}/${entry.name}`, path: join(at, entry.name) });
    }
  };
  await walk(shown, folder);
  return { files, cut };
}

/** Where a search or a listing by name begins: one folder the agent named, or every attached one. */
async function starts(roots: string[], path: unknown): Promise<[string, string][]> {
  if (path && String(path).trim() && String(path).trim() !== "/") {
    const folder = await locate(roots, String(path));
    if (!(await fs.stat(folder)).isDirectory())
      throw new LocalError("That is a file. Give a folder to look in, or read the file.");
    return [
      [
        String(path)
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, ""),
        folder,
      ],
    ];
  }
  return [...rootNames(roots).entries()];
}

async function search(
  roots: string[],
  args: { query?: unknown; path?: unknown; glob?: unknown; regex?: unknown },
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (query.length < 2) throw new LocalError("A search needs at least two characters.");
  const needle = query.toLowerCase();
  let pattern: RegExp | null = null;
  if (args.regex === true) {
    // This runs where the whole app runs: a pattern that could take for ever on one line
    // is not tried at all.
    if (query.length > PATTERN_CHARS || RUNAWAY.test(query))
      throw new LocalError(
        "That pattern repeats something that itself repeats, or is too long, and could take for ever. Search for plain words, or a simpler pattern.",
      );
    try {
      pattern = new RegExp(query, "i");
    } catch {
      throw new LocalError(
        "That is not a pattern that can be searched for. Search for plain words, or correct it.",
      );
    }
  }
  const matches = (line: string) =>
    pattern ? pattern.test(line.slice(0, LINE_TRIED)) : line.toLowerCase().includes(needle);
  const only = args.glob ? globToRegExp(String(args.glob)) : null;
  const hits: string[] = [];
  // What was gone through, folder by folder: a search that finds nothing has only looked
  // where it says it looked.
  const covered: string[] = [];
  for (const [shown, folder] of await starts(roots, args.path)) {
    const { files, cut } = await filesUnder(shown, folder, SEARCH_FILES);
    let found = 0;
    let looked = 0;
    for (const file of files) {
      if (found >= SEARCH_HITS) break;
      const rel = file.label.slice(shown.length + 1);
      if (only && !only.test(rel) && !only.test(basename(rel))) continue;
      looked += 1;
      if (!pattern && basename(file.label).toLowerCase().includes(needle)) {
        hits.push(`${file.label}  (name)`);
        found += 1;
      }
      try {
        const stat = await fs.stat(file.path);
        if (stat.size > SEARCH_FILE_BYTES) continue;
        const bytes = await fs.readFile(file.path);
        if (looksBinary(bytes)) continue;
        const lines = bytes.toString("utf8").split("\n");
        for (let n = 0; n < lines.length && found < SEARCH_HITS; n++)
          if (matches(lines[n] as string)) {
            hits.push(`${file.label}:${n + 1}: ${(lines[n] as string).trim().slice(0, 200)}`);
            found += 1;
          }
      } catch {}
    }
    covered.push(
      `${shown}: ${looked} file${looked === 1 ? "" : "s"} looked through, ${found} found${
        found >= SEARCH_HITS
          ? "; there are more, narrow the search"
          : cut
            ? `; it holds more than ${SEARCH_FILES} files and the rest were not looked through, so give a folder inside it`
            : ""
      }`,
    );
  }
  const where = `[${covered.join(". ")}.]`;
  return hits.length === 0
    ? `Nothing matches "${query}".\n${where}`
    : `${hits.join("\n")}\n${where}`;
}

/** Files by a name pattern. Newest first, so what is being worked on comes first. */
async function find(roots: string[], args: { pattern?: unknown; path?: unknown }): Promise<string> {
  const asked = String(args.pattern ?? "").trim();
  if (!asked) throw new LocalError('Give a name pattern, such as "*.ts" or "src/**/*.md".');
  const pattern = globToRegExp(asked);
  const found: { label: string; at: number }[] = [];
  const notes: string[] = [];
  for (const [shown, folder] of await starts(roots, args.path)) {
    const { files, cut } = await filesUnder(shown, folder, SEARCH_FILES * 4);
    if (cut)
      notes.push(`${shown} holds more files than were gone through; give a folder inside it`);
    for (const file of files) {
      const rel = file.label.slice(shown.length + 1);
      if (!pattern.test(rel) && !pattern.test(basename(rel))) continue;
      found.push({
        label: file.label,
        at: await fs.stat(file.path).then(
          (stat) => stat.mtimeMs,
          () => 0,
        ),
      });
      if (found.length >= FIND_FILES * 10) break;
    }
  }
  if (found.length === 0) return `No file is named like "${asked}".`;
  found.sort((a, b) => b.at - a.at);
  return [
    ...found.slice(0, FIND_FILES).map((file) => file.label),
    ...(found.length > FIND_FILES ? [`[${found.length - FIND_FILES} more are not shown.]`] : []),
    ...notes.map((note) => `[${note}.]`),
  ].join("\n");
}

/** Refuses to change a file the agent has not read, or that changed since it did. */
export async function unchanged(
  file: string,
  shown: string,
  seen: Seen,
  /** The whole file is about to be replaced: having read a part of it is not enough. */
  whole = false,
): Promise<void> {
  const was = seen.get(file);
  if (!was)
    throw new LocalError(
      `Read ${shown} first: a file is changed only by someone who has seen what it holds now.`,
    );
  if (whole && was.startsWith(PART))
    throw new LocalError(
      `You have read only a part of ${shown}. Change the piece you mean with local.edit; a whole file is replaced only by someone who has read all of it.`,
    );
  if (was.replace(PART, "") !== (await stamp(file)))
    throw new LocalError(
      `${shown} has changed since you read it, perhaps by the person in their own editor. Read it again, then make the change to what it holds now.`,
    );
}

/** Puts text in a file that is there, without following a link. */
export async function put(file: string, content: string | Buffer): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
  } finally {
    await handle.close();
  }
}

async function write(
  roots: string[],
  args: { path?: unknown; content?: unknown },
  seen?: Seen,
): Promise<string> {
  const content = String(args.content ?? "");
  if (Buffer.byteLength(content) > WRITE_BYTES)
    throw new LocalError("That is too much for one file (1 MB at most).");
  const file = await locate(roots, String(args.path ?? ""), true);
  // The name itself must not be a link: a link to a file that does not exist yet passes
  // every check above and would put the new file wherever it points.
  const existed = await fs.lstat(file).then(
    (stat) => {
      if (stat.isSymbolicLink())
        throw new LocalError("That is a link to somewhere else. Write to the file itself.");
      if (stat.isDirectory()) throw new LocalError("That is a folder, not a file.");
      if (!stat.isFile()) throw new LocalError("That is not an ordinary file.");
      return true;
    },
    (error: unknown) => {
      if (error instanceof LocalError) throw error;
      return false;
    },
  );
  // A whole file is replaced only as the agent last saw it: what the person saved in the
  // meantime is not written over unread.
  if (existed && seen) await unchanged(file, String(args.path), seen, true);
  let handle: import("node:fs").promises.FileHandle;
  try {
    handle = await fs.open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new LocalError("That is a link to somewhere else. Write to the file itself.");
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  seen?.set(file, await stamp(file));
  return `${existed ? "Replaced" : "Created"} ${String(args.path)} (${Buffer.byteLength(content)} bytes).`;
}

/** Runs one call. Throws LocalError with words the agent, and through it the person, can act on. */
export async function runLocal(
  roots: string[],
  tool: string,
  args: Record<string, unknown>,
  /** What the agent has seen, kept by whoever calls. Without it a file is replaced unread, as before 2026-11-18. */
  seen?: Seen,
): Promise<string> {
  if (roots.length === 0)
    throw new LocalError("No folder on this computer is attached to this project.");
  if (tool === "list") return list(roots, args);
  if (tool === "read") return read(roots, args, seen);
  if (tool === "search") return search(roots, args);
  if (tool === "find") return find(roots, args);
  if (tool === "write") return write(roots, args, seen);
  throw new LocalError(`"${tool}" is not something that can be done in a folder.`);
}
