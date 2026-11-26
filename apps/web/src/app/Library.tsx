import {
  ArrowDownUpIcon,
  CheckIcon,
  DownloadIcon,
  FolderIcon,
  LayoutGridIcon,
  ListFilterIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { goApp } from "@/App";
import { useConfirm } from "@/components/confirm";
import { Guide } from "@/components/guide";
import { Loading, Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { downloadFile } from "@/lib/files";
import { cn } from "@/lib/utils";
import type { DocumentSummary, FileItem, FileKind, FileLimits, Project } from "./api";
import { AttachmentTray, useAttachments } from "./attach";
import { FileTypeIcon } from "./FileTypeIcon";
import { useOpenFile } from "./FileViewer";
import { type Doc, DocumentEditor } from "./Pages";

type Show = "all" | "made" | "uploaded" | "notes";
type Sort = "recent" | "name" | "size";
type View = "list" | "grid";
/** One thing in the library, as the server hands it over: a file or a note. */
export interface Row {
  type: "file" | "note";
  id: string;
  name: string;
  kind: FileKind | "note";
  mime: string;
  size: number;
  source: "upload" | "agent" | "note";
  at: string;
  version: number;
  mine: boolean;
  sharedBy: { name: string; email: string } | null;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  found: string | null;
}
interface Page {
  rows: Row[];
  total: number;
  counts: Record<Show, number>;
  usedBytes: number;
  next: number | null;
}
const SHOWS: Show[] = ["all", "made", "uploaded", "notes"];
const KINDS = ["document", "spreadsheet", "slides", "pdf", "image", "page", "text", "data"];
const VIEW_KEY = "muster.library.view";
export const asFile = (row: Row): FileItem => ({
  id: row.id,
  name: row.name,
  kind: row.kind as FileKind,
  size: row.size,
  version: row.version,
  mime: row.mime,
  source: row.source === "agent" ? "agent" : "upload",
  conversationId: row.conversationId,
  createdAt: row.at,
  mine: row.mine,
  sharedBy: row.sharedBy,
});

/** A small button that opens a list to choose one of: what to show, how to sort. */
function Choice({
  icon,
  label,
  active,
  children,
}: {
  icon: ReactNode;
  label: string;
  /** Something other than the usual is chosen. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 max-w-48 items-center gap-1.5 rounded-lg px-2.5 text-[13px] hover:bg-foreground/8",
            active ? "bg-foreground/8 font-medium" : "text-muted-foreground",
          )}
        >
          {icon}
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Everything the person keeps: the notes agents write and the files they upload or
 * agents make, in one library.
 *
 * Made for a library of a thousand (the owner, 2026-11-22: "如果我有 1000 份文件，这里会
 * 变成啥样"). Until then the page was handed the newest five hundred and no more, without
 * saying so, searched their names only, and drew every one as a card. Now the server
 * finds, narrows, sorts and counts; a page comes at a time as the person scrolls; a word
 * is looked for in what files say as well as in their names; each says which
 * conversation and project it came from; and several can be deleted at once.
 */
export function MyDocuments({
  open: wanted,
  projects,
  onChange,
}: {
  open: string | null;
  projects: Project[];
  onChange(): void;
}) {
  const { t, ago } = useI18n();
  const d = t.app.docs;
  const [limits, setLimits] = useState<FileLimits>();
  const [editing, setEditing] = useState<Doc | null>(null);
  const { error: failure, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const attach = useAttachments();
  const openFile = useOpenFile();
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [typed, setTyped] = useState("");
  // What is looked for, a moment after the person stops typing.
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [kind, setKind] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [chosenView, setChosenView] = useState<View | null>(() => {
    const kept = localStorage.getItem(VIEW_KEY);
    return kept === "list" || kept === "grid" ? kept : null;
  });
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Each asking has a number: an answer to an earlier one is not shown over a later one.
  const asked = useRef(0);
  // The asking whose answer is the list now shown: more is asked only of that list.
  const shownAsk = useRef(0);
  const address = (offset: number) => {
    const params = new URLSearchParams({ show, sort, offset: String(offset) });
    if (query) params.set("q", query);
    if (kind) params.set("kind", kind);
    if (projectId) params.set("project", projectId);
    return `/api/app/library?${params}`;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `address` is made of what is listed
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const got = await api<Page>(address(0));
      if (mine !== asked.current) return;
      shownAsk.current = mine;
      setPage(got);
      setError(undefined);
      // What is no longer listed is no longer picked.
      setPicked((now) => {
        const there = new Set(got.rows.map((row) => `${row.type}:${row.id}`));
        const kept = new Set([...now].filter((key) => there.has(key)));
        return kept.size === now.size ? now : kept;
      });
    } catch (problem) {
      if (mine === asked.current)
        setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [query, show, kind, projectId, sort]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const wait = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(wait);
  }, [typed]);
  useEffect(() => {
    void api<FileLimits>("/api/app/files/limits").then(setLimits, () => undefined);
  }, []);
  const next = page?.next ?? null;
  const loadMore = async () => {
    // While a new list is on its way, where the old one ended says nothing about it.
    if (next === null || more || shownAsk.current !== asked.current) return;
    const mine = asked.current;
    setMore(true);
    try {
      const got = await api<Page>(address(next));
      // Asked of an earlier list: not added to this one.
      if (mine !== asked.current) return;
      setPage((now) => {
        if (!now) return got;
        const have = new Set(now.rows.map((row) => `${row.type}:${row.id}`));
        return {
          ...got,
          rows: [...now.rows, ...got.rows.filter((row) => !have.has(`${row.type}:${row.id}`))],
        };
      });
    } catch {
      // Tried again when the foot of the list comes into view once more.
    } finally {
      setMore(false);
    }
  };
  // The next page is asked for when the foot of the list comes into view.
  const foot = useRef<HTMLDivElement>(null);
  const moreRef = useRef(loadMore);
  moreRef.current = loadMore;
  useEffect(() => {
    const mark = foot.current;
    if (!mark) return;
    const watcher = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && void moreRef.current(),
      { rootMargin: "400px" },
    );
    watcher.observe(mark);
    return () => watcher.disconnect();
  });
  // The address can name a document, as when a conversation links to one it saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per document named in the address
  useEffect(() => {
    if (!wanted) return;
    void run(async () => {
      const all = await api<DocumentSummary[]>("/api/app/documents");
      const target = all.find((doc) => doc.title === wanted)?.id;
      if (target) setEditing(await api<Doc>(`/api/app/documents/${target}`));
    });
  }, [wanted]);
  // An upload that has finished belongs in the library, not in the tray.
  const uploaded = attach.ready.map((file) => file.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of finished uploads changes
  useEffect(() => {
    if (!uploaded) return;
    onChange();
    void load();
    for (const item of attach.items) if (item.file) attach.remove(item.key);
  }, [uploaded]);
  if (!page) return error ? <Notice tone="bad">{error}</Notice> : <Loading />;

  const rows = page.rows;
  const narrowed = Boolean(query || kind || projectId || show !== "all");
  // Many things are a list; a few are cards, as before. What the person chose stands.
  const view: View = chosenView ?? (page.counts.all > 24 ? "list" : "grid");
  const share = limits ? Math.min(1, page.usedBytes / limits.quotaBytes) : 0;
  const keyOf = (row: Row) => `${row.type}:${row.id}`;
  const open = (row: Row) =>
    row.type === "file"
      ? openFile(asFile(row))
      : void run(async () => setEditing(await api<Doc>(`/api/app/documents/${row.id}`)));
  const toggle = (row: Row) =>
    setPicked((now) => {
      const nextPicked = new Set(now);
      if (!nextPicked.delete(keyOf(row))) nextPicked.add(keyOf(row));
      return nextPicked;
    });
  // Only what is the person's own can be deleted.
  const mine = rows.filter((row) => row.mine);
  const pickedRows = mine.filter((row) => picked.has(keyOf(row)));
  const remove = async () => {
    if (pickedRows.length === 0) return;
    if (!(await confirm(t.common.delete, d.deleteMany(pickedRows.length)))) return;
    await run(async () => {
      await api("/api/app/library/delete", {
        method: "POST",
        body: {
          files: pickedRows.filter((row) => row.type === "file").map((row) => row.id),
          notes: pickedRows.filter((row) => row.type === "note").map((row) => row.id),
        },
      });
      setPicked(new Set());
      onChange();
      await load();
    });
  };
  /** Where it came from: its project and the conversation, which opens. */
  const origin = (row: Row) =>
    row.sharedBy ? (
      <span className="truncate">{d.sharedBy(row.sharedBy.name || row.sharedBy.email)}</span>
    ) : row.conversationId ? (
      <button
        type="button"
        className="relative flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
        title={d.openConversation}
        onClick={() => goApp(`c/${row.conversationId}`)}
      >
        {row.projectName && <FolderIcon className="size-3 shrink-0" />}
        <span className="truncate">
          {[row.projectName, row.conversationTitle || t.app.untitled].filter(Boolean).join(" · ")}
        </span>
      </button>
    ) : (
      <span className="truncate">
        {row.type === "note"
          ? d.kindNote
          : row.source === "agent"
            ? d.madeByAgent
            : d.uploadedByYou}
      </span>
    );
  const check = (row: Row, always: boolean) =>
    row.mine && (
      <button
        type="button"
        aria-pressed={picked.has(keyOf(row))}
        aria-label={d.pick(row.name)}
        onClick={() => toggle(row)}
        className={cn(
          "relative grid size-4 shrink-0 place-items-center rounded border",
          picked.has(keyOf(row))
            ? "border-brand bg-brand text-background"
            : cn(
                "border-foreground/30 hover:border-foreground/60",
                !always &&
                  picked.size === 0 &&
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              ),
        )}
      >
        {picked.has(keyOf(row)) && <CheckIcon className="size-3" />}
      </button>
    );
  const kindOf = (row: Row) => t.files.kinds[row.kind] ?? row.kind;
  const sizeOf = (row: Row) => (row.type === "file" ? t.files.size(row.size) : d.size(row.size));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is an extra way in; the Upload button is the one everyone can use
    <div
      className="relative min-h-0 flex-1 overflow-y-auto"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        attach.add(event.dataTransfer.files);
      }}
    >
      <div className="grid gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={d.filter}
              aria-label={d.filter}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <div className="flex rounded-lg bg-foreground/6 p-0.5">
            {SHOWS.map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={show === key}
                onClick={() => setShow(key)}
                className={cn(
                  "h-7 rounded-md px-3 text-[13px]",
                  show === key ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
                )}
              >
                {d.show[key]}
                <span className="num pl-1.5 text-muted-foreground">{page.counts[key]}</span>
              </button>
            ))}
          </div>
          {limits && (
            // How much of the person's space is used, where they decide what to keep.
            <div className="ml-auto hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10">
                <span
                  className={cn(
                    "block h-full rounded-full",
                    share > 0.9 ? "bg-destructive" : "bg-brand",
                  )}
                  style={{ width: `${Math.max(2, share * 100)}%` }}
                />
              </span>
              {d.space(t.files.size(page.usedBytes), t.files.size(limits.quotaBytes))}
            </div>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) attach.add(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className={cn(!limits && "ml-auto", "lg:ml-0")}
            onClick={() => picker.current?.click()}
          >
            <UploadIcon />
            {t.files.upload}
          </Button>
          <Button size="sm" onClick={() => setEditing({ id: null, title: "", content: "" })}>
            <PlusIcon />
            {d.new}
          </Button>
        </div>
        {/* What narrows the list, how it is ordered and drawn; or, once things are picked,
            what is done with them. One row, so the list under it does not jump. */}
        {picked.size > 0 ? (
          <div className="flex h-8 items-center gap-2 text-[13px]">
            <span className="font-medium">{d.picked(pickedRows.length)}</span>
            <Button size="sm" variant="outline" onClick={() => void remove()}>
              <Trash2Icon />
              {t.common.delete}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              <XIcon />
              {t.common.cancel}
            </Button>
          </div>
        ) : (
          (page.counts.all > 0 || narrowed) && (
            <div className="flex flex-wrap items-center gap-1">
              <Choice
                icon={<ListFilterIcon className="size-3.5 shrink-0" />}
                label={kind ? (t.files.kinds[kind] ?? kind) : d.anyKind}
                active={Boolean(kind)}
              >
                <DropdownMenuItem onSelect={() => setKind(null)}>{d.anyKind}</DropdownMenuItem>
                <DropdownMenuSeparator />
                {KINDS.map((one) => (
                  <DropdownMenuItem key={one} onSelect={() => setKind(one)}>
                    <span className="flex-1">{t.files.kinds[one] ?? one}</span>
                    {kind === one && <CheckIcon className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </Choice>
              {projects.length > 0 && (
                <Choice
                  icon={<FolderIcon className="size-3.5 shrink-0" />}
                  label={projects.find((one) => one.id === projectId)?.name ?? d.anyProject}
                  active={Boolean(projectId)}
                >
                  <DropdownMenuItem onSelect={() => setProjectId(null)}>
                    {d.anyProject}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {projects.map((one) => (
                    <DropdownMenuItem key={one.id} onSelect={() => setProjectId(one.id)}>
                      <span className="min-w-0 flex-1 truncate">{one.name}</span>
                      {projectId === one.id && <CheckIcon className="size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </Choice>
              )}
              <span className="flex-1" />
              <Choice icon={<ArrowDownUpIcon className="size-3.5 shrink-0" />} label={d.sort[sort]}>
                {(["recent", "name", "size"] as Sort[]).map((one) => (
                  <DropdownMenuItem key={one} onSelect={() => setSort(one)}>
                    <span className="flex-1">{d.sort[one]}</span>
                    {sort === one && <CheckIcon className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </Choice>
              <div className="flex rounded-lg bg-foreground/6 p-0.5">
                {(["list", "grid"] as View[]).map((one) => (
                  <button
                    type="button"
                    key={one}
                    aria-pressed={view === one}
                    title={d.view[one]}
                    onClick={() => {
                      localStorage.setItem(VIEW_KEY, one);
                      setChosenView(one);
                    }}
                    className={cn(
                      "grid size-7 place-items-center rounded-md",
                      view === one ? "bg-background shadow-xs" : "text-muted-foreground",
                    )}
                  >
                    {one === "list" ? (
                      <ListIcon className="size-3.5" />
                    ) : (
                      <LayoutGridIcon className="size-3.5" />
                    )}
                    <span className="sr-only">{d.view[one]}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
        {(failure || error) && <Notice tone="bad">{failure ?? error}</Notice>}
        <AttachmentTray attach={attach} />
        {page.counts.all === 0 && !narrowed ? (
          <Guide icon={UploadIcon} text={t.app.guides.documents}>
            <Button size="sm" variant="outline" onClick={() => picker.current?.click()}>
              <UploadIcon />
              {t.files.upload}
            </Button>
            <Button size="sm" onClick={() => goApp("")}>
              {d.askAgent}
            </Button>
          </Guide>
        ) : rows.length === 0 ? (
          <Notice>{d.noMatch}</Notice>
        ) : view === "list" ? (
          <ul className="glass-thick grid rounded-2xl p-1">
            {rows.map((row) => (
              <li
                key={keyOf(row)}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl px-2.5 py-1.5 hover:bg-accent/40",
                  picked.has(keyOf(row)) && "bg-accent/40",
                )}
              >
                <button
                  type="button"
                  className="absolute inset-0 rounded-xl"
                  aria-label={row.name}
                  onClick={() => open(row)}
                />
                <span className="grid w-4 place-items-center">{check(row, true)}</span>
                <FileTypeIcon
                  name={row.name}
                  kind={row.type === "file" ? (row.kind as FileKind) : undefined}
                  note={row.type === "note"}
                  className="size-7 shrink-0"
                />
                <span className="grid min-w-0 flex-[3] gap-0.5">
                  <span className="truncate text-[13px] font-medium" title={row.name}>
                    {row.name}
                  </span>
                  {row.found && (
                    <span className="truncate text-xs text-muted-foreground" title={row.found}>
                      …{row.found}…
                    </span>
                  )}
                </span>
                <span className="hidden min-w-0 flex-[2] text-xs text-muted-foreground md:flex">
                  {origin(row)}
                </span>
                <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground lg:block">
                  {kindOf(row)}
                </span>
                <span className="num hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block">
                  {sizeOf(row)}
                </span>
                <span className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground">
                  {ago(row.at)}
                </span>
                <span className="grid w-6 place-items-center">
                  {row.type === "file" && (
                    <button
                      type="button"
                      className="relative rounded-md p-1 text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                      title={t.files.download}
                      onClick={() => downloadFile(row.id)}
                    >
                      <DownloadIcon className="size-4" />
                      <span className="sr-only">{t.files.download}</span>
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
            {rows.map((row) => (
              <article
                key={keyOf(row)}
                className={cn(
                  "glass-thick group relative flex items-start gap-3 rounded-2xl p-3 transition-colors hover:bg-accent/40",
                  picked.has(keyOf(row)) && "bg-accent/40",
                )}
              >
                <button
                  type="button"
                  className="absolute inset-0 rounded-2xl"
                  aria-label={row.name}
                  onClick={() => open(row)}
                />
                <FileTypeIcon
                  name={row.name}
                  kind={row.type === "file" ? (row.kind as FileKind) : undefined}
                  note={row.type === "note"}
                  className="size-10 shrink-0"
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-[13px] font-medium" title={row.name}>
                    {row.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kindOf(row)} · {sizeOf(row)} · {ago(row.at)}
                  </span>
                  <span className="flex min-w-0 text-xs text-muted-foreground">{origin(row)}</span>
                  {row.found && (
                    <span className="truncate text-xs text-muted-foreground" title={row.found}>
                      …{row.found}…
                    </span>
                  )}
                </span>
                <span className="grid gap-1.5">
                  {check(row, false)}
                  {row.type === "file" && (
                    <button
                      type="button"
                      className="relative -mx-1 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                      title={t.files.download}
                      onClick={() => downloadFile(row.id)}
                    >
                      <DownloadIcon className="size-4" />
                      <span className="sr-only">{t.files.download}</span>
                    </button>
                  )}
                </span>
              </article>
            ))}
          </div>
        )}
        {/* The foot of the list: coming into view, it asks for the next page. */}
        <div ref={foot} className="grid h-8 place-items-center text-xs text-muted-foreground">
          {next !== null ? more ? <Loading /> : null : rows.length > 24 ? d.end(page.total) : null}
        </div>
      </div>
      {over && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-brand bg-background/80 text-sm font-medium backdrop-blur-sm">
          {t.files.drop}
        </div>
      )}
      {dialog}
      {editing && (
        <DocumentEditor
          doc={editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) {
              void load();
              onChange();
            }
            if (wanted) goApp("documents");
          }}
        />
      )}
    </div>
  );
}
