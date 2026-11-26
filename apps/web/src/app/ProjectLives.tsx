import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpenIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  FolderIcon,
  GitBranchIcon,
  LightbulbIcon,
  LinkIcon,
  LoaderIcon,
  type LucideIcon,
  PencilIcon,
  PinOffIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Notice, useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { desktop, type LocalFolder } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import {
  type ConversationSummary,
  type FileKind,
  ITEM_KINDS,
  type ItemKind,
  type Project,
  type ProjectItem,
  type RepoFacts,
  worksIn,
} from "./api";
import { useOpenFile } from "./FileViewer";
import { Panel, PanelAdd, panelAction } from "./panel";

const ICON: Record<ItemKind, LucideIcon> = {
  repo: GitBranchIcon,
  guide: BookOpenIcon,
  environment: ServerIcon,
  link: LinkIcon,
  contact: UserIcon,
  fact: LightbulbIcon,
};

/** What is being added: one of the kinds, or a folder of this computer (the desktop app). */
export type Adding = ItemKind | "folder";

/** The blocks of the right column, and which kinds each holds. They are always there. */
const PANELS: { key: ItemKind; kinds: ItemKind[] }[] = [
  { key: "repo", kinds: ["repo"] },
  { key: "guide", kinds: ["guide", "fact"] },
  { key: "environment", kinds: ["environment", "link"] },
  { key: "contact", kinds: ["contact"] },
];

/** Where an address leads, in a word: its host, without the `www`. */
export const hostOf = (address: string | null): string => {
  if (!address) return "";
  try {
    return new URL(address).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** What the top of the page counts from the repositories' standing. */
export interface Standing {
  /** Repositories, those on this computer among them. */
  repos: number;
  failing: number;
  pulls: number;
}
export const standingOf = (
  items: readonly ProjectItem[],
  facts: Record<string, RepoFacts>,
  folders: number,
): Standing => {
  const repos = items.filter((item) => item.kind === "repo");
  const known = repos.flatMap((item) => (item.ref && facts[item.ref] ? [facts[item.ref]] : []));
  return {
    repos: repos.length + folders,
    failing: known.filter((fact) => fact?.checks === "failing").length,
    pulls: known.reduce((sum, fact) => sum + (fact?.pulls ?? 0), 0),
  };
};

type Draft = {
  title: string;
  detail: string;
  url: string;
  ref: string;
  version: string;
  email: string;
  phone: string;
  due: string;
};
const draftOf = (item?: ProjectItem): Draft => ({
  title: item?.title ?? "",
  detail: item?.detail ?? "",
  url: item?.url ?? "",
  ref: item?.ref ?? "",
  version: item?.state.version ?? "",
  email: item?.state.email ?? "",
  phone: item?.state.phone ?? "",
  due: item?.state.due ?? "",
});

/**
 * One thing being written: its name, where it is, and what Muster should know of it.
 * The same few boxes for every kind; a repository also has its name on the code host
 * and an environment what runs there now.
 */
function ItemForm({
  kind,
  item,
  busy,
  onSave,
  onCancel,
  onRemove,
  onMove,
}: {
  kind: ItemKind;
  item?: ProjectItem;
  busy: boolean;
  onSave(draft: Draft): void;
  onCancel(): void;
  onRemove?(): void;
  /** Up or down among those of its kind; absent where it cannot go. */
  onMove?: { up?: () => void; down?: () => void };
}) {
  const { t, ago } = useI18n();
  const l = t.app.project.lives;
  const [draft, setDraft] = useState(draftOf(item));
  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: event.target.value });
  const ready = kind === "repo" && !item ? draft.ref.trim() !== "" : draft.title.trim() !== "";
  return (
    <form
      className="grid gap-1.5 rounded-lg border bg-background/40 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSave(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      {kind === "repo" && (
        <Input
          autoFocus={!item}
          aria-label={l.ref}
          placeholder={l.refHint}
          className="h-7 font-mono text-xs"
          maxLength={200}
          value={draft.ref}
          onChange={set("ref")}
        />
      )}
      <Input
        autoFocus={kind !== "repo" || Boolean(item)}
        aria-label={l.name}
        placeholder={l.name}
        className="h-7 text-[13px]"
        maxLength={120}
        value={draft.title}
        onChange={set("title")}
      />
      {kind === "environment" && (
        <Input
          aria-label={l.version}
          placeholder={l.version}
          className="h-7 text-[13px]"
          maxLength={60}
          value={draft.version}
          onChange={set("version")}
        />
      )}
      {kind === "contact" && (
        <div className="grid grid-cols-2 gap-1.5">
          <Input
            aria-label={l.email}
            placeholder={l.email}
            className="h-7 text-[13px]"
            maxLength={200}
            inputMode="email"
            value={draft.email}
            onChange={set("email")}
          />
          <Input
            aria-label={l.phone}
            placeholder={l.phone}
            className="h-7 text-[13px]"
            maxLength={30}
            inputMode="tel"
            value={draft.phone}
            onChange={set("phone")}
          />
        </div>
      )}
      {kind !== "fact" && (
        <Input
          aria-label={l.url}
          placeholder={`${l.url} (https://…)`}
          className="h-7 text-[13px]"
          maxLength={2000}
          inputMode="url"
          value={draft.url}
          onChange={set("url")}
        />
      )}
      {(kind === "fact" || kind === "link" || kind === "guide" || kind === "contact") && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {l.dueBy}
          <Input
            type="date"
            aria-label={l.dueBy}
            className="h-7 w-40 text-[13px]"
            value={draft.due}
            onChange={set("due")}
          />
        </div>
      )}
      <Textarea
        aria-label={l.detail}
        placeholder={l.detail}
        rows={3}
        maxLength={2000}
        className="text-[13px]"
        value={draft.detail}
        onChange={set("detail")}
      />
      <div className="flex items-center gap-1">
        {item?.by && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {l.by(item.by, ago(item.updatedAt))}
          </span>
        )}
        <span className="flex-1" />
        {onMove && (
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              title={l.up}
              disabled={busy || !onMove.up}
              onClick={onMove.up}
            >
              <ArrowUpIcon className="size-3.5" />
              <span className="sr-only">{l.up}</span>
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              title={l.down}
              disabled={busy || !onMove.down}
              onClick={onMove.down}
            >
              <ArrowDownIcon className="size-3.5" />
              <span className="sr-only">{l.down}</span>
            </Button>
          </>
        )}
        {onRemove && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            title={l.remove}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
            <span className="sr-only">{l.remove}</span>
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t.common.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !ready}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

/**
 * What lives in a project (MUS-59): its repositories, guides, environments, links,
 * people to reach and facts, kind by kind, each shown only when the project has some. A
 * product manager's project and an engineer's are the same page with different things
 * in it. Everything here is told to Muster at the start of every conversation in the
 * project, and each thing is written by hand here or kept by an agent as it works.
 */
export function ProjectLives({
  project,
  conversations,
  adding,
  onAdding,
  onStanding,
  onChange,
  pinned,
  onPeople,
}: {
  project: Project;
  conversations: ConversationSummary[];
  /** What the page's "Add" asked for; written here. */
  adding: Adding | null;
  onAdding(kind: Adding | null): void;
  onStanding(standing: Standing): void;
  /** The project itself was changed here (what Muster should know). */
  onChange(): void;
  /** Counted up when a file was pinned or unpinned elsewhere on the page. */
  pinned: number;
  /** Opens who is in the project. */
  onPeople(): void;
}) {
  const { t, ago } = useI18n();
  const l = t.app.project.lives;
  const d = t.app.project.docs;
  const openFile = useOpenFile();
  const { error, run, busy } = useAction();
  const canWork = worksIn(project);
  const owns = project.role === "owner";
  const [items, setItems] = useState<ProjectItem[]>();
  const [facts, setFacts] = useState<Record<string, RepoFacts>>({});
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [knowing, setKnowing] = useState<string | null>(null);
  // Which thing is open to be read: what it is and what Muster is told of it, for everyone.
  const [reading, setReading] = useState<string | null>(null);
  const at = `/api/app/projects/${project.id}/items`;
  // Asked again when a conversation of the project has moved on: an agent may have kept something.
  const moved = conversations.map((one) => `${one.id}${one.updatedAt}${one.running}`).join();
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    const found = await api<{ items: ProjectItem[] }>(at).then(
      (answer) => answer.items,
      () => null,
    );
    if (mine !== asked.current) return;
    setItems((had) => found ?? had ?? []);
    // How the repositories stand is asked for once the list is on the page, and is
    // simply not there when it cannot be had.
    if (found?.some((item) => item.kind === "repo"))
      void api<{ facts: Record<string, RepoFacts> }>(`/api/app/projects/${project.id}/repos`).then(
        (answer) => {
          if (mine === asked.current) setFacts(answer.facts);
        },
        () => undefined,
      );
  }, [at, project.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` and `pinned` are why it is asked again
  useEffect(() => {
    void load();
  }, [load, moved, pinned, project.items]);
  useEffect(() => {
    if (desktop) void desktop.folders(project.id).then(setFolders, () => undefined);
  }, [project.id]);
  // A folder is added in the system's own dialog, at once: there is nothing to write.
  useEffect(() => {
    if (adding !== "folder") return;
    onAdding(null);
    if (desktop) void desktop.addFolder(project.id).then(setFolders, () => undefined);
  }, [adding, onAdding, project.id]);
  const standing = standingOf(items ?? [], facts, folders.length);
  const standingKey = `${standing.repos}:${standing.failing}:${standing.pulls}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: said when the counts change, not when the page draws
  useEffect(() => {
    onStanding(standing);
  }, [standingKey]);

  const act = (job: () => Promise<unknown>) =>
    run(async () => {
      await job();
      await load();
    });
  const bodyOf = (kind: ItemKind, draft: Draft, item?: ProjectItem) => ({
    title: draft.title.trim(),
    detail: draft.detail,
    ...(kind === "fact" ? {} : { url: draft.url.trim() || (item ? null : undefined) }),
    ...(kind === "repo" ? { ref: draft.ref.trim() } : {}),
    ...(kind === "environment" ? { version: draft.version.trim() } : {}),
    // An empty box takes away what was there; on a new thing it is simply not sent.
    ...(kind === "contact"
      ? {
          ...(draft.email.trim() || item ? { email: draft.email.trim() } : {}),
          ...(draft.phone.trim() || item ? { phone: draft.phone.trim() } : {}),
        }
      : {}),
    ...(draft.due || item?.state.due ? { due: draft.due } : {}),
  });
  const add = (kind: ItemKind, draft: Draft) =>
    act(async () => {
      await api(at, { method: "POST", body: { kind, ...bodyOf(kind, draft) } });
      onAdding(null);
      onChange();
    });
  const save = (item: ProjectItem, draft: Draft) =>
    act(async () => {
      await api(`${at}/${item.id}`, { method: "PATCH", body: bodyOf(item.kind, draft, item) });
      setEditing(null);
    });
  const remove = (item: ProjectItem) =>
    act(async () => {
      await api(`${at}/${item.id}`, { method: "DELETE" });
      setEditing(null);
      onChange();
    });
  const move = (item: ProjectItem, to: number) =>
    act(() => api(`${at}/${item.id}`, { method: "PATCH", body: { to } }));
  const unpin = (item: ProjectItem) =>
    act(() => api(`/api/app/projects/${project.id}/docs/${item.id}`, { method: "DELETE" }));
  const know = (instructions: string) =>
    run(async () => {
      await api(`/api/app/projects/${project.id}`, {
        method: "PUT",
        body: { name: project.name, instructions },
      });
      setKnowing(null);
      onChange();
    });

  const row =
    "group flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/40";
  const small =
    // Shown when the row is pointed at, where there is a pointer; always, where there is none.
    "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:!opacity-100 aria-expanded:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100";

  const fact = (item: ProjectItem) => {
    if (item.kind === "repo") {
      const known = item.ref ? facts[item.ref] : undefined;
      if (!known) return item.state.branch ?? "";
      return (
        <span className="flex items-center gap-1.5">
          {known.checks === "failing" ? (
            <CircleAlertIcon className="size-3.5 text-warn" aria-label={l.checks.failing} />
          ) : known.checks === "passing" ? (
            <CircleCheckIcon className="size-3.5 text-ok" aria-label={l.checks.passing} />
          ) : known.checks === "running" ? (
            <LoaderIcon className="size-3.5" aria-label={l.checks.running} />
          ) : null}
          {known.pulls ? l.pulls(known.pulls) : known.branch}
        </span>
      );
    }
    if (item.kind === "environment") return item.state.version ?? "";
    if (item.kind === "contact") return item.state.email ?? item.state.phone ?? hostOf(item.url);
    if (item.state.due) return item.state.due;
    if (item.file) return d.kind[item.state.doc ?? "other"] ?? "";
    return hostOf(item.url);
  };
  const open = (item: ProjectItem) => {
    if (item.file)
      return openFile({
        id: item.file.id,
        name: item.file.name,
        kind: item.file.kind as FileKind,
        size: item.file.size,
        version: item.file.version,
      });
    // Anything else is read here: what it is, and what Muster is told of it. Its address,
    // if it has one, is opened by the mark at the row's end.
    setEditing(null);
    setReading(reading === item.id ? null : item.id);
  };

  const groups = ITEM_KINDS.map((kind) => ({
    kind,
    items: (items ?? []).filter((item) => item.kind === kind),
  }));
  // What Muster should know of the whole project is the first of its guides: shown to
  // everyone once it says something, and to its owner always, who alone writes it.
  const knows = project.instructions.trim();
  const showKnow = knows !== "" || owns;

  /** The rows of one kind, or nothing when it has none and none is being written. */
  const rowsOf = ({ kind, items: own }: (typeof groups)[number]) => {
    const here = kind === "repo" ? folders : [];
    const knowRow = kind === "guide" && showKnow;
    if (own.length === 0 && here.length === 0 && adding !== kind && !knowRow) return null;
    // Pinned files keep the order of what they are; the rest can be moved among themselves.
    const movable = own.filter((item) => !item.file);
    return (
      <Fragment key={kind}>
        {knowRow && (
          <li className="grid gap-1">
            <div className={row}>
              <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                aria-expanded={knowing !== null || reading === "know"}
                onClick={() =>
                  owns
                    ? setKnowing(knowing === null ? project.instructions : null)
                    : setReading(reading === "know" ? null : "know")
                }
              >
                {l.know}
              </button>
              <span className="max-w-[50%] shrink truncate text-xs text-muted-foreground">
                {knows ? knows.split("\n")[0] : l.knowEmpty}
              </span>
            </div>
            {knowing !== null && (
              <div className="grid gap-1.5 rounded-lg border bg-background/40 p-2">
                <Textarea
                  autoFocus
                  aria-label={l.know}
                  placeholder={l.knowHint}
                  rows={6}
                  maxLength={8000}
                  className="text-[13px]"
                  value={knowing}
                  onChange={(event) => setKnowing(event.target.value)}
                />
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setKnowing(null)}
                  >
                    {t.common.cancel}
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void know(knowing)}>
                    {t.common.save}
                  </Button>
                </div>
              </div>
            )}
          </li>
        )}
        {own.map((item) => {
          const Icon = ICON[item.kind];
          const place = movable.indexOf(item);
          return (
            <li key={item.id} className="grid gap-1">
              <div className={row}>
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    item.kind === "repo" && "font-mono text-xs",
                  )}
                  aria-expanded={item.file ? undefined : reading === item.id}
                  onClick={() => open(item)}
                >
                  {item.title}
                </button>
                <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                  {fact(item)}
                </span>
                {item.url && !item.file && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={small}
                    title={hostOf(item.url)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    <span className="sr-only">{`${hostOf(item.url)}: ${item.title}`}</span>
                  </a>
                )}
                {item.file
                  ? owns && (
                      <button
                        type="button"
                        className={small}
                        title={l.unpin}
                        disabled={busy}
                        onClick={() => void unpin(item)}
                      >
                        <PinOffIcon className="size-3.5" />
                        <span className="sr-only">{`${l.unpin}: ${item.title}`}</span>
                      </button>
                    )
                  : canWork && (
                      <button
                        type="button"
                        className={small}
                        title={l.edit}
                        aria-expanded={editing === item.id}
                        onClick={() => {
                          setReading(null);
                          setEditing(editing === item.id ? null : item.id);
                        }}
                      >
                        <PencilIcon className="size-3.5" />
                        <span className="sr-only">{`${l.edit}: ${item.title}`}</span>
                      </button>
                    )}
              </div>
              {editing === item.id &&
                !item.file &&
                (canWork ? (
                  <ItemForm
                    kind={item.kind}
                    item={item}
                    busy={busy}
                    onSave={(draft) => void save(item, draft)}
                    onCancel={() => setEditing(null)}
                    onRemove={() => void remove(item)}
                    onMove={{
                      ...(place > 0 ? { up: () => void move(item, place - 1) } : {}),
                      ...(place < movable.length - 1
                        ? { down: () => void move(item, place + 1) }
                        : {}),
                    }}
                  />
                ) : null)}
              {reading === item.id && editing !== item.id && !item.file && (
                <div className="grid gap-1 px-2.5 pb-2 text-xs text-muted-foreground">
                  <p className="whitespace-pre-wrap text-foreground/90">
                    {item.detail || l.nothingSaid}
                  </p>
                  {(item.state.email || item.state.phone) && (
                    <p className="num flex flex-wrap gap-x-3">
                      {item.state.email && (
                        <a className="hover:underline" href={`mailto:${item.state.email}`}>
                          {item.state.email}
                        </a>
                      )}
                      {item.state.phone && (
                        <a className="hover:underline" href={`tel:${item.state.phone}`}>
                          {item.state.phone}
                        </a>
                      )}
                    </p>
                  )}
                  <p className="num flex flex-wrap gap-x-3">
                    {/* The number an agent names it by, so "I changed 4" can be found. */}
                    {item.n > 0 && <span>#{item.n}</span>}
                    {item.state.due && <span>{l.due(item.state.due)}</span>}
                    {item.by && <span>{l.by(item.by, ago(item.updatedAt))}</span>}
                  </p>
                </div>
              )}
            </li>
          );
        })}
        {here.map((folder) => (
          <li key={folder.path} className={row}>
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder.path}>
              {folder.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{l.thisMac}</span>
            {owns && (
              <button
                type="button"
                className={small}
                title={l.remove}
                onClick={() =>
                  desktop &&
                  void desktop
                    .removeFolder(project.id, folder.path)
                    .then(setFolders, () => undefined)
                }
              >
                <Trash2Icon className="size-3.5" />
                <span className="sr-only">{`${l.remove}: ${folder.name}`}</span>
              </button>
            )}
          </li>
        ))}
        {adding === kind && (
          <li>
            <ItemForm
              kind={kind}
              busy={busy}
              onSave={(draft) => void add(kind, draft)}
              onCancel={() => onAdding(null)}
            />
          </li>
        )}
      </Fragment>
    );
  };

  return (
    <div className="grid content-start gap-4">
      {error && <Notice tone="bad">{error}</Notice>}
      {items === undefined && <p className="px-1 text-[13px] text-muted-foreground">…</p>}
      {PANELS.map((panel) => {
        const rows = panel.kinds.map((kind) =>
          rowsOf(groups.find((group) => group.kind === kind) as (typeof groups)[number]),
        );
        const people = panel.key === "contact";
        const none = rows.every((one) => one === null) && !people;
        const first = panel.kinds[0] as ItemKind;
        return (
          <Panel
            key={panel.key}
            title={
              panel.key === "environment" ? l.envLinks : people ? l.peoplePanel : l.kind[panel.key]
            }
            action={
              canWork &&
              (panel.kinds.length === 1 ? (
                <button
                  type="button"
                  className={panelAction}
                  title={l.addOne(l.one[first] ?? "")}
                  onClick={() => onAdding(first)}
                >
                  <PlusIcon className="size-3.5" />
                  <span className="sr-only">{l.addOne(l.one[first] ?? "")}</span>
                </button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={panelAction} title={l.add}>
                      <PlusIcon className="size-3.5" />
                      <span className="sr-only">{l.add}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    {panel.kinds.map((kind) => (
                      <DropdownMenuItem key={kind} onSelect={() => onAdding(kind)}>
                        {l.one[kind]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ))
            }
          >
            <ul className="grid">
              {people && (
                <li>
                  <button type="button" className={row} onClick={onPeople}>
                    <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{l.members}</span>
                    <span className="num text-xs text-muted-foreground">{project.people + 1}</span>
                  </button>
                </li>
              )}
              {rows}
              {none &&
                (items === undefined ? (
                  <li className="px-2.5 py-1.5 text-[13px] text-muted-foreground">…</li>
                ) : canWork ? (
                  <li>
                    <PanelAdd onClick={() => onAdding(first)}>
                      {l.addOne(l.one[first] ?? "")}
                    </PanelAdd>
                  </li>
                ) : (
                  <li className="px-2.5 py-1.5 text-[13px] text-muted-foreground">{l.emptySeen}</li>
                ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}
