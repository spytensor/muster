import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
  RotateCwIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  desktop,
  type FolderNote,
  type JobNote,
  type RepoChanges,
  type TaskNote,
} from "@/lib/desktop";
import { cn } from "@/lib/utils";
import type { ConversationContext } from "./api";
import { ContextSection } from "./context";

/**
 * The work pane (CHA-274): beside a conversation in a project, in the desktop app, what the
 * work is being done on. Four views: what has changed in the repositories, line by line;
 * the repositories' files; a page a dev server serves, shown here; and the commands that
 * are going. All of it is read from the person's computer by the desktop app and shown to
 * the person; none of it is sent to the server by this.
 */

/** What compacting a conversation needs from the conversation (context.tsx). */
export interface Compacting {
  conversationId: string;
  running: boolean;
  messages: number;
  /** Messages since the last compaction. */
  fresh: number;
  summarisedAt: string | null;
  onCompacted(): void;
}

/** A path on this computer as the person reads it: the home folder as ~. */
const homeShort = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/** One line of a difference, with its number in the old file and in the new. */
interface Row {
  kind: "add" | "del" | "same" | "skip";
  old: number | null;
  now: number | null;
  text: string;
}
/** A difference as git writes it, as rows. What git says about the file itself is left out. */
export function rowsOf(
  diff: string,
  /** The whole of a new file, given as added lines with no header. */
  fresh = false,
): { rows: Row[]; added: number; removed: number } {
  const rows: Row[] = [];
  let old = 0;
  let now = 0;
  let added = 0;
  let removed = 0;
  const lines = diff.split("\n");
  // A difference with no piece in it (a file that is not text, a change of mode only) has
  // no lines to show: what git says about the file itself is not its content.
  if (!fresh && !lines.some((line) => line.startsWith("@@")))
    return { rows: [], added: 0, removed: 0 };
  if (fresh) now = 1;
  let inside = fresh;
  for (const [at, line] of lines.entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      now = Number(hunk[2]);
      // Between two pieces of a difference lies what did not change.
      if (inside) rows.push({ kind: "skip", old: null, now: null, text: (hunk[3] ?? "").trim() });
      inside = true;
      continue;
    }
    if (!inside || line.startsWith("\\")) continue;
    // The last line of what git wrote is an empty one after the final line break.
    if (!fresh && at === lines.length - 1 && line === "") continue;
    // A second difference in the same text (a file that became a link) is not part of the first.
    if (!fresh && line.startsWith("diff --git ")) break;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", old: null, now: now++, text: line.slice(1) });
      added += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", old: old++, now: null, text: line.slice(1) });
      removed += 1;
    } else rows.push({ kind: "same", old: old++, now: now++, text: line.slice(1) });
  }
  return { rows, added, removed };
}

const STATE: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", "?": "N" };

/** One changed file: its name, how much changed, and the lines, which fold away. Drawn again only when it changed. */
const Changed = memo(function Changed({
  repo,
  path,
  state,
  diff,
  agent,
}: {
  repo: string;
  path: string;
  state: string;
  diff: string;
  agent: boolean;
}) {
  const file = { path, state, diff, agent };
  const { t } = useI18n();
  const c = t.app.code;
  const [open, setOpen] = useState(true);
  const fresh = file.state === "?";
  const { rows, added, removed } = useMemo(
    () => (file.diff ? rowsOf(file.diff, fresh) : { rows: [], added: 0, removed: 0 }),
    [file.diff, fresh],
  );
  const slash = file.path.lastIndexOf("/");
  return (
    <div className="min-w-0 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="sticky top-0 z-10 flex h-8 w-full min-w-0 items-center gap-2 bg-background/95 px-2 text-left text-xs backdrop-blur hover:bg-accent"
        title={`${repo}/${file.path}`}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate font-mono">
          <span className="font-medium">{file.path.slice(slash + 1)}</span>
          {slash >= 0 && (
            <span className="ml-2 text-muted-foreground">{file.path.slice(0, slash)}</span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px]">
          {file.agent && <span className="font-sans text-muted-foreground">{c.byAgent}</span>}
          {added > 0 && <span className="text-ok">+{added}</span>}
          {removed > 0 && <span className="text-destructive">−{removed}</span>}
          {added === 0 && removed === 0 && (
            <span className="text-muted-foreground">{STATE[file.state] ?? file.state}</span>
          )}
        </span>
      </button>
      {open &&
        (rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{c.noDiff}</p>
        ) : (
          <div className="overflow-x-auto pb-1 font-mono text-xs leading-5">
            <div className="min-w-max">
              {rows.map((row, at) =>
                row.kind === "skip" ? (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a text have no other name
                    key={at}
                    className="my-1 flex h-6 items-center gap-2 bg-muted/60 px-3 font-sans text-[11px] text-muted-foreground"
                  >
                    <span>{c.unchanged}</span>
                    {row.text && <span className="truncate font-mono">{row.text}</span>}
                  </div>
                ) : (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a text have no other name
                    key={at}
                    className={cn(
                      "flex border-l-[3px] border-transparent",
                      row.kind === "add" && "border-ok bg-ok/15",
                      row.kind === "del" && "border-destructive bg-destructive/15",
                    )}
                  >
                    <span className="num w-10 shrink-0 pr-2 text-right text-muted-foreground select-none">
                      {row.old ?? ""}
                    </span>
                    <span className="num w-10 shrink-0 pr-3 text-right text-muted-foreground select-none">
                      {row.now ?? ""}
                    </span>
                    <span className="pr-4 whitespace-pre">{row.text || " "}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
    </div>
  );
});

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-3 py-3 text-xs text-muted-foreground">{children}</p>
);

function Changes({ repos }: { repos: RepoChanges[] }) {
  const { t } = useI18n();
  const c = t.app.code;
  if (repos.length === 0) return <Empty>{c.noRepos}</Empty>;
  return (
    <div className="grid min-w-0">
      {repos.map((repo) => (
        <section key={repo.name} className="min-w-0">
          <h3 className="flex h-8 items-center gap-2 border-b bg-muted/40 px-3 text-xs">
            <span className="font-medium">{repo.name}</span>
            {repo.branch && (
              <span className="truncate font-mono text-muted-foreground">{repo.branch}</span>
            )}
            <span className="num ml-auto text-muted-foreground">
              {repo.files.length + repo.more || ""}
            </span>
          </h3>
          {repo.files.length === 0 && <Empty>{c.clean}</Empty>}
          {repo.files.map((file) => (
            <Changed
              key={file.path}
              repo={repo.name}
              path={file.path}
              state={file.state}
              diff={file.diff}
              agent={file.agent === true}
            />
          ))}
          {repo.more > 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">{c.more(repo.more)}</p>
          )}
        </section>
      ))}
    </div>
  );
}

/** Paths as folders within folders. */
interface Node {
  folders: Map<string, Node>;
  files: string[];
}
const nest = (paths: string[]): Node => {
  const root: Node = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push(parts.at(-1) as string);
  }
  return root;
};

function Folder({
  node,
  path,
  depth,
  open,
  toggle,
  pick,
  picked,
}: {
  node: Node;
  path: string;
  depth: number;
  open: Set<string>;
  toggle(path: string): void;
  pick(path: string): void;
  picked: string | null;
}) {
  return (
    <>
      {[...node.folders].map(([name, child]) => {
        const here = `${path}/${name}`;
        return (
          <div key={here}>
            <button
              type="button"
              onClick={() => toggle(here)}
              aria-expanded={open.has(here)}
              className="flex h-6 w-full items-center gap-1.5 rounded text-left text-xs hover:bg-accent"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {open.has(here) ? (
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
              )}
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </button>
            {open.has(here) && (
              <Folder
                node={child}
                path={here}
                depth={depth + 1}
                open={open}
                toggle={toggle}
                pick={pick}
                picked={picked}
              />
            )}
          </div>
        );
      })}
      {node.files.map((name) => {
        const here = `${path}/${name}`;
        return (
          <button
            type="button"
            key={here}
            onClick={() => pick(here)}
            aria-current={picked === here ? "true" : undefined}
            className={cn(
              "flex h-6 w-full items-center gap-1.5 rounded text-left text-xs hover:bg-accent",
              picked === here && "bg-accent font-medium",
            )}
            style={{ paddingLeft: 23 + depth * 12 }}
          >
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </button>
        );
      })}
    </>
  );
}

function Files({ projectId, conversationId }: { projectId: string; conversationId?: string }) {
  const { t } = useI18n();
  const c = t.app.code;
  const [roots, setRoots] = useState<{ name: string; files: string[]; more: boolean }[] | null>(
    null,
  );
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const wanted = useRef<string | null>(null);
  useEffect(() => {
    // A desktop app older than this page has no such thing to ask.
    if (!desktop?.tree) {
      setRoots([]);
      return;
    }
    void desktop.tree(projectId, conversationId).then(
      (found) => {
        setRoots(found);
        // A single folder is shown open.
        if (found.length === 1 && found[0]) setOpen(new Set([found[0].name]));
      },
      () => setRoots([]),
    );
  }, [projectId, conversationId]);
  const pick = (path: string) => {
    setPicked(path);
    setText(null);
    wanted.current = path;
    // The answer for a file pressed earlier does not stand under the name of the one pressed since.
    const show = (found: { ok: boolean; text: string }) => {
      if (wanted.current === path) setText(found);
    };
    if (!desktop?.view) show({ ok: false, text: c.unreadable });
    else
      void desktop
        .view(projectId, path, conversationId)
        .then(show, () => show({ ok: false, text: c.unreadable }));
  };
  const toggle = (path: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const needle = filter.trim().toLowerCase();
  if (roots === null) return <Empty>{c.reading}</Empty>;
  if (roots.length === 0) return <Empty>{c.noFolders}</Empty>;
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="min-h-0 overflow-y-auto border-b p-1">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={c.filter}
          aria-label={c.filter}
          className="mb-1 h-7 w-full rounded-md bg-foreground/5 px-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        {roots.map((root) => {
          const shown = needle
            ? root.files.filter((path) => path.toLowerCase().includes(needle)).slice(0, 300)
            : root.files;
          const unfolded = open.has(root.name) || Boolean(needle);
          return (
            <div key={root.name}>
              <button
                type="button"
                onClick={() => toggle(root.name)}
                aria-expanded={unfolded}
                className="flex h-6 w-full items-center gap-1.5 rounded px-2 text-left text-xs font-medium hover:bg-accent"
              >
                {unfolded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{root.name}</span>
              </button>
              {needle
                ? shown.map((path) => (
                    <button
                      type="button"
                      key={path}
                      onClick={() => pick(`${root.name}/${path}`)}
                      className={cn(
                        "flex h-6 w-full items-center gap-1.5 rounded pl-6 text-left font-mono text-[11px] hover:bg-accent",
                        picked === `${root.name}/${path}` && "bg-accent",
                      )}
                    >
                      <span className="truncate">{path}</span>
                    </button>
                  ))
                : open.has(root.name) && (
                    <Folder
                      node={nest(root.files)}
                      path={root.name}
                      depth={1}
                      open={open}
                      toggle={toggle}
                      pick={pick}
                      picked={picked}
                    />
                  )}
              {root.more && <Empty>{c.treeCut}</Empty>}
            </div>
          );
        })}
      </div>
      <div className="min-h-0 overflow-auto">
        {!picked ? (
          <Empty>{c.pickFile}</Empty>
        ) : !text ? (
          <Empty>{c.reading}</Empty>
        ) : !text.ok ? (
          <Empty>{text.text}</Empty>
        ) : (
          <>
            <p className="sticky top-0 flex h-7 items-center bg-background/95 px-3 font-mono text-[11px] text-muted-foreground backdrop-blur">
              {picked}
            </p>
            <div className="min-w-max pb-2 font-mono text-xs leading-5">
              {text.text.split("\n").map((line, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a text have no other name
                <div key={at} className="flex">
                  <span className="num w-10 shrink-0 pr-3 text-right text-muted-foreground select-none">
                    {at + 1}
                  </span>
                  <span className="pr-4 whitespace-pre">{line || " "}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** An address on this computer, and nothing else: what a dev server here serves. */
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:[/?#][^\s]*)?$/;
const sameOrigin = (address: string) => {
  try {
    return new URL(address).origin === window.location.origin;
  } catch {
    return true;
  }
};
/** The address a command says it serves, when it says one. */
export const served = (printed: string): string | null => {
  const found = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/.exec(
    printed,
  )?.[0];
  return found && LOCAL.test(found) ? found : null;
};

function Preview({
  jobs,
  ask,
  seen,
}: {
  jobs: JobNote[];
  /** An address asked for elsewhere in the pane, and a count that changes each time it is asked. */
  ask: { address: string; n: number } | null;
  /** The person has looked at this view: until then nothing is loaded by itself. */
  seen: boolean;
}) {
  const { t } = useI18n();
  const c = t.app.code;
  const offered = useMemo(
    () => [...new Set(jobs.flatMap((job) => served(job.tail) ?? []))],
    [jobs],
  );
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const go = useCallback((address: string) => {
    const wanted = /^https?:\/\//.test(address.trim())
      ? address.trim()
      : `http://${address.trim()}`;
    // Only what is served on this computer is shown here, and never Muster's own page
    // inside itself: a page of the same origin would be this page's equal.
    if (!LOCAL.test(wanted) || sameOrigin(wanted)) return;
    setShown(wanted);
    setTyped(wanted);
    setTurn((n) => n + 1);
  }, []);
  // The first address a job serves is shown by itself, once; one asked for elsewhere is shown when asked.
  const first = offered[0];
  useEffect(() => {
    if (ask) go(ask.address);
  }, [ask, go]);
  useEffect(() => {
    // Not before the person has opened this view: what a command printed is not a reason
    // to load a page behind their back.
    if (!seen || !first || sameOrigin(first)) return;
    setShown((now) => now ?? first);
    setTyped((now) => now || first);
  }, [first, seen]);
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <form
        className="flex items-center gap-1 border-b p-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          go(typed);
        }}
      >
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="localhost:3000"
          aria-label={c.address}
          className="h-7 min-w-0 flex-1 rounded-md bg-foreground/5 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          title={c.reload}
          aria-label={c.reload}
          onClick={() => setTurn((n) => n + 1)}
        >
          <RotateCwIcon className="size-3.5" />
        </Button>
        {shown && (
          <a
            href={shown}
            target="_blank"
            rel="noreferrer"
            title={c.openOutside}
            aria-label={c.openOutside}
            className="grid size-7 place-items-center rounded-md hover:bg-accent"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        )}
      </form>
      {shown ? (
        <iframe
          key={`${shown}:${turn}`}
          src={shown}
          title={c.preview}
          // What is shown is the person's own dev server, which is still somebody's code. It
          // is kept in its own frame: it cannot reach this page or the app's own functions,
          // cannot open windows or the person's browser, and its requests to the Muster
          // server do not carry the person's session (the desktop app and the server both
          // see to that).
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="no-referrer"
          className="size-full bg-white"
        />
      ) : (
        <Empty>{c.previewLead}</Empty>
      )}
    </div>
  );
}

function Running({
  jobs,
  projectId,
  again,
  show,
}: {
  jobs: JobNote[];
  projectId: string;
  again(): void;
  show(address: string): void;
}) {
  const { t } = useI18n();
  const c = t.app.code;
  if (jobs.length === 0) return <Empty>{c.noJobs}</Empty>;
  return (
    <div className="grid min-w-0">
      {jobs.map((job) => {
        const address = served(job.tail);
        return (
          <section key={job.id} className="min-w-0 border-b last:border-b-0">
            <div className="flex h-8 min-w-0 items-center gap-2 px-3 text-xs">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  job.running ? "animate-pulse bg-brand" : "bg-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono" title={job.command}>
                {job.command}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{job.where}</span>
              <span className="num shrink-0 text-[11px] text-muted-foreground">
                {job.running ? c.seconds(job.seconds) : c.ended(job.code)}
              </span>
              {job.running && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  title={c.stop}
                  aria-label={c.stop}
                  onClick={() => void desktop?.stopJob?.(projectId, job.id).then(again)}
                >
                  <SquareIcon className="size-3" />
                </Button>
              )}
            </div>
            {address && (
              <button
                type="button"
                className="mx-3 mb-1 block truncate font-mono text-[11px] text-brand-text hover:underline"
                onClick={() => show(address)}
              >
                {address}
              </button>
            )}
            <pre className="max-h-64 overflow-auto bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
              {job.tail.trim() || c.nothingPrinted}
            </pre>
          </section>
        );
      })}
    </div>
  );
}

/** The narrowest the side pane goes, and what is always left to the conversation. */
export const PANE_MIN = 240;
export const PANE_LEFT = 420;
/** A width the person gave the pane, held to what the row it shares with the conversation allows now. */
export function paneWidth(asked: number, room: number): number {
  return Math.round(Math.max(PANE_MIN, Math.min(asked, room - PANE_LEFT)));
}

/** How many lines a file's difference adds and takes away. */
export function tally(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/**
 * Where this conversation works and how it stands, at a look: the computer and the
 * folders with their branch, how full the model's window is, what changed and what
 * runs. The first view of the pane; the rows lead to the views that show the whole.
 */
/**
 * What stands under a repository in the overview once the conversation has work in it:
 * its branch and where it was cut from, and its pull request. One button at most: to open
 * the request, or, when its checks failed or reviewers wrote, to have the agent see to it.
 * Either is said to the agent as a message of the person's, and what leaves the computer
 * is asked about there, as always.
 */
export function TaskLines({
  task,
  ask,
}: {
  task: TaskNote;
  /** Says something to the agent as the person. Absent while a reply is being written. */
  ask?: (text: string) => void;
}) {
  const { t } = useI18n();
  const k = t.app.code.task;
  const line = "flex min-w-0 items-center gap-2 px-2 py-1 text-[13px] text-muted-foreground";
  const pr = task.pr;
  const needs = pr?.state === "OPEN" && (pr.checks === "failing" || pr.comments > 0);
  return (
    <>
      <p className={line}>
        <GitBranchIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={task.copy ? k.copyHint : undefined}>
          <span className="text-foreground">{task.branch}</span> · {k.from(task.base)}
          {task.copy && ` · ${k.copy}`}
        </span>
        {!pr && (task.ahead ?? 0) > 0 && (
          <span className="num shrink-0 text-xs">{k.ahead(task.ahead ?? 0)}</span>
        )}
        {!pr && (task.ahead ?? 0) > 0 && task.remote && ask && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0"
            onClick={() => ask(k.openAsk)}
          >
            {k.open}
          </Button>
        )}
      </p>
      {pr && (
        <p className={line}>
          <GitPullRequestIcon
            className={cn(
              "size-4 shrink-0",
              pr.state === "MERGED" && "text-ok",
              pr.checks === "failing" && pr.state === "OPEN" && "text-destructive",
            )}
          />
          {/* In the person's browser: the app sends an address that is not its own there. */}
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
          >
            {k.pr(pr.number)}
          </a>
          <span className="min-w-0 flex-1 truncate text-xs">
            {[
              k.state[pr.state],
              pr.state === "OPEN" ? k.checks[pr.checks] : "",
              pr.state === "OPEN" && pr.comments > 0 ? k.comments(pr.comments) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {needs && ask && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0"
              onClick={() => ask(k.fixAsk(pr.checks === "failing", pr.comments))}
            >
              {k.fix}
            </Button>
          )}
        </p>
      )}
    </>
  );
}

function Overview({
  projectId,
  conversationId,
  ask,
  beat,
  repos,
  going,
  mode,
  context,
  compacting,
  show,
}: {
  projectId: string;
  conversationId?: string;
  ask?: (text: string) => void;
  beat: string;
  repos: RepoChanges[];
  going: number;
  mode: string;
  context?: ConversationContext;
  compacting?: Compacting;
  show(view: string): void;
}) {
  const { t } = useI18n();
  const c = t.app.code;
  const [folders, setFolders] = useState<FolderNote[]>([]);
  /** Where each attached folder is on this computer: shown here, never sent anywhere. */
  const [paths, setPaths] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when something was done
  useEffect(() => {
    let live = true;
    void desktop?.describe?.(projectId, conversationId).then(
      (found) => live && setFolders(found),
      () => undefined,
    );
    void desktop?.folders(projectId).then(
      (found) =>
        live &&
        setPaths(Object.fromEntries(found.map((folder) => [folder.name, homeShort(folder.path)]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId, beat]);
  // The conversation's work in each repository: its branch and its pull request. Read
  // when something was done and once a minute; the desktop app asks the service about a
  // pull request no more often than that, however often it is asked here.
  const [tasks, setTasks] = useState<TaskNote[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when something was done
  useEffect(() => {
    if (!conversationId || !desktop?.task) return;
    let live = true;
    const read = () => {
      if (document.hidden) return;
      void desktop?.task?.(projectId, conversationId).then(
        (found) => live && setTasks(found),
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId, conversationId, beat]);
  const head = "px-2 pb-1 text-[13px] font-medium";
  const line = "flex min-w-0 items-center gap-2 px-2 py-1 text-[13px]";
  return (
    <>
      <section className="border-b py-2.5">
        <h3 className={head}>{c.environment}</h3>
        <p className={line}>
          <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{c.thisComputer}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{mode}</span>
        </p>
        {folders.length === 0 && <p className={cn(line, "text-muted-foreground")}>{c.noFolders}</p>}
        {folders.map((folder) => (
          <div key={folder.name}>
            <button type="button" className="row w-full" onClick={() => show("files")}>
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">
                {folder.name}
                {paths[folder.name] && (
                  <span className="text-muted-foreground"> · {paths[folder.name]}</span>
                )}
              </span>
            </button>
            {tasks.some((task) => task.name === folder.name) ? (
              // The conversation has work of its own here: its branch, and its pull request.
              tasks
                .filter((task) => task.name === folder.name)
                .map((task) => <TaskLines key={task.branch} task={task} ask={ask} />)
            ) : (
              <p className={cn(line, "text-muted-foreground")}>
                <GitBranchIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {folder.repository ? folder.branch : c.notRepository}
                </span>
                {folder.repository && folder.changed !== null && folder.changed > 0 && (
                  <span className="num shrink-0 text-xs">{c.uncommitted(folder.changed)}</span>
                )}
              </p>
            )}
          </div>
        ))}
      </section>
      {context && compacting && (
        <ContextSection
          context={context}
          conversationId={compacting.conversationId}
          running={compacting.running}
          messages={compacting.messages}
          fresh={compacting.fresh}
          summarisedAt={compacting.summarisedAt}
          onCompacted={compacting.onCompacted}
        />
      )}
      {(repos.length > 0 || going > 0) && (
        <section className="border-b py-2.5">
          <h3 className={head}>{c.changes}</h3>
          {repos.map((repo) => {
            const sum = repo.files.reduce(
              (total, file) => {
                const one = tally(file.diff);
                return { added: total.added + one.added, removed: total.removed + one.removed };
              },
              { added: 0, removed: 0 },
            );
            const files = repo.files.length + repo.more;
            return (
              <button
                type="button"
                key={repo.name}
                className="row w-full"
                onClick={() => show("changes")}
              >
                <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-left">{repo.name}</span>
                {files === 0 ? (
                  <span className="text-xs text-muted-foreground">{c.noChanges}</span>
                ) : (
                  <span className="num flex gap-1.5 text-xs">
                    <span className="text-ok">+{sum.added}</span>
                    <span className="text-destructive">−{sum.removed}</span>
                  </span>
                )}
                <span className="flex-1" />
                {files > 0 && <span className="num text-xs text-muted-foreground">{files}</span>}
              </button>
            );
          })}
          {going > 0 && (
            <button type="button" className="row w-full" onClick={() => show("running")}>
              <SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{c.commands(going)}</span>
            </button>
          )}
        </section>
      )}
    </>
  );
}

const VIEWS = ["changes", "files", "preview", "running", "work"] as const;
type View = (typeof VIEWS)[number];

export function WorkPane({
  view: wanted,
  projectId,
  conversationId,
  ask,
  beat,
  work,
  show,
  mode,
  context,
  compacting,
  counted,
  close,
}: {
  /** Puts the pane away: every view can be closed where it is, not only by its button. */
  close(): void;
  /** Told how many files changed and how many commands run: the bar's buttons say it. */
  counted?(counts: { changes: number; running: number }): void;
  /** How much agents may do here without asking, in words. */
  mode: string;
  /** How full the model's window was at its last step here. */
  context?: ConversationContext;
  /** What compacting the conversation needs to know, from the conversation. */
  compacting?: Compacting;
  /** The view in front: chosen by its button in the conversation's bar. */
  view: string;
  projectId: string;
  /** The conversation: its work may be in copies of the repositories of its own. */
  conversationId?: string;
  /** Says something to the agent as the person. Absent while a reply is being written. */
  ask?: (text: string) => void;
  /** Changes when the agent has done something: what is shown is read again. */
  beat: string;
  /** What the conversation made, sent and read: the panel there was before this one. */
  work: ReactNode;
  /** Brings another view to the front. */
  show(view: string): void;
}) {
  const { t } = useI18n();
  const c = t.app.code;
  const view: View = VIEWS.includes(wanted as View) ? (wanted as View) : "changes";
  const [repos, setRepos] = useState<RepoChanges[]>([]);
  const [jobs, setJobs] = useState<JobNote[]>([]);
  const [asked, setAsked] = useState<{ address: string; n: number } | null>(null);
  const [opened, setOpened] = useState<Set<View>>(new Set([view]));
  // A view once looked at is kept as it was left.
  useEffect(() => {
    setOpened((now) => (now.has(view) ? now : new Set([...now, view])));
  }, [view]);
  const last = useRef({ repos: "", jobs: "" });
  const read = useCallback(() => {
    // Not while nobody can see it: asking git for every difference is work.
    if (document.hidden) return;
    // What has not changed is not drawn again.
    void desktop?.changes?.(projectId, conversationId).then(
      (found) => {
        const now = JSON.stringify(found);
        if (now === last.current.repos) return;
        last.current.repos = now;
        setRepos(found);
      },
      () => undefined,
    );
    void desktop?.jobs?.(projectId).then(
      (found) => {
        const now = JSON.stringify(found.map((job) => ({ ...job, seconds: 0 })));
        if (now === last.current.jobs && !found.some((job) => job.running)) return;
        last.current.jobs = now;
        setJobs(found);
      },
      () => undefined,
    );
  }, [projectId, conversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when something was done
  useEffect(() => {
    read();
    const timer = setInterval(read, 4000);
    return () => clearInterval(timer);
  }, [read, beat]);
  const changed = repos.reduce((total, repo) => total + repo.files.length + repo.more, 0);
  const going = jobs.filter((job) => job.running).length;
  useEffect(() => {
    counted?.({ changes: changed, running: going });
  }, [counted, changed, going]);
  const titles: Record<View, string> = {
    changes: c.changes,
    files: c.files,
    preview: c.preview,
    running: c.running,
    work: c.work,
  };
  const count = view === "changes" ? changed : view === "running" ? going : 0;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      {/* Which view this is. The views are chosen by their buttons in the conversation's bar. */}
      <div className="flex h-10 items-center gap-2 border-b px-3 text-[13px] font-medium">
        {titles[view]}
        {count > 0 && <span className="num text-[11px] text-muted-foreground">{count}</span>}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 size-7 text-muted-foreground"
          title={t.common.close}
          aria-label={t.common.close}
          onClick={close}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div
        className={cn("min-h-0", view === "files" || view === "preview" ? "" : "overflow-y-auto")}
      >
        {view === "changes" &&
          (desktop?.changes ? <Changes repos={repos} /> : <Empty>{c.oldApp}</Empty>)}
        {/* Kept once opened: the file being read, and a page, are still there after a look elsewhere. */}
        {opened.has("files") && (
          <div className={cn("h-full", view !== "files" && "hidden")}>
            <Files projectId={projectId} conversationId={conversationId} />
          </div>
        )}
        <div className={cn("h-full", view !== "preview" && "hidden")}>
          <Preview jobs={jobs} ask={asked} seen={opened.has("preview")} />
        </div>
        {view === "running" && (
          <Running
            jobs={jobs}
            projectId={projectId}
            again={read}
            show={(address) => {
              setAsked((now) => ({ address, n: (now?.n ?? 0) + 1 }));
              show("preview");
            }}
          />
        )}
        {view === "work" && (
          <div className="px-1.5">
            <Overview
              projectId={projectId}
              conversationId={conversationId}
              ask={ask}
              beat={beat}
              repos={repos}
              going={going}
              mode={mode}
              context={context}
              compacting={compacting}
              show={show}
            />
            {work}
          </div>
        )}
      </div>
    </div>
  );
}
