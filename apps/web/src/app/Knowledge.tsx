import {
  AlertTriangleIcon,
  BookOpenIcon,
  FileTextIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Guide } from "@/components/guide";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import type { DocumentSummary, FileItem } from "./api";
import { FileTypeIcon } from "./FileTypeIcon";
import { ShareDialog } from "./Share";
import { Lead } from "@/components/ui/hint";

export interface Base {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  mine: boolean;
  sharedBy: { name: string; email: string } | null;
  shares: number;
  items: number;
  passages: number;
}
interface Item {
  id: string;
  name: string;
  status: "ready" | "failed";
  problem: string | null;
  chars: number;
  passages: number;
}

function BaseTile({ base, onOpen }: { base: Base; onOpen(): void }) {
  const { t } = useI18n();
  const k = t.app.knowledge;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="glass-thick flex flex-col gap-2 rounded-2xl p-4 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand-text">
          <BookOpenIcon className="size-4" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{base.name}</span>
            <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {base.mine
                ? t.app.builder.byYou
                : t.app.builder.sharedBy(base.sharedBy?.name || base.sharedBy?.email || "")}
            </span>
          </span>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">
            {base.description || k.noDescription}
          </span>
        </span>
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
          <FileTextIcon className="size-3" />
          {k.itemsCount(base.items)}
        </span>
        {base.mine && base.shares > 0 && (
          <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
            <UsersIcon className="size-3" />
            {t.app.builder.sharedWith(base.shares)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Picks from what the person already has here: their files and their documents. */
function Picker({ onPick, busy }: { onPick(body: object): void; busy: boolean }) {
  const { t } = useI18n();
  const k = t.app.knowledge;
  const files = useLoad(() => api<FileItem[]>("/api/app/files"));
  const documents = useLoad(() => api<DocumentSummary[]>("/api/app/documents"));
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = [
    ...(documents.data ?? []).map((doc) => ({
      key: `d${doc.id}`,
      name: doc.title,
      body: { documentId: doc.id },
    })),
    ...(files.data ?? []).map((file) => ({
      key: `f${file.id}`,
      name: file.name,
      body: { fileId: file.id },
    })),
  ].filter((row) => !needle || row.name.toLowerCase().includes(needle));
  if (!files.data || !documents.data) return <Loading />;
  return (
    <div className="grid gap-1.5 rounded-lg border p-2">
      <label className="flex h-8 items-center gap-2 rounded-md bg-foreground/5 px-2 text-sm">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={k.findMine}
          aria-label={k.findMine}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      <ul className="max-h-44 overflow-y-auto">
        {rows.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">{k.nothingMine}</li>
        )}
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(row.body)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50"
            >
              <FileTypeIcon name={row.name} small className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{k.add}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One knowledge base: what it is for and what is in it. Its owner fills it; others read. */
function BaseEditor({
  base,
  onClose,
  onShare,
}: {
  base: Base | null;
  onClose(changed: boolean): void;
  onShare(base: Base): void;
}) {
  const { t } = useI18n();
  const k = t.app.knowledge;
  // A new base is saved first, then filled in the same dialog.
  const [id, setId] = useState(base?.id ?? null);
  const readOnly = base !== null && !base.mine;
  const [name, setName] = useState(base?.name ?? "");
  const [description, setDescription] = useState(base?.description ?? "");
  const [changed, setChanged] = useState(false);
  const [picking, setPicking] = useState(false);
  const items = useLoad(
    () => (id ? api<Item[]>(`/api/app/knowledge/${id}`) : Promise.resolve([] as Item[])),
    [id],
  );
  const { error, busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const pick = useRef<HTMLInputElement>(null);
  const save = () =>
    run(async () => {
      const result = await api<{ id: string }>(
        id ? `/api/app/knowledge/${id}` : "/api/app/knowledge",
        { method: id ? "PATCH" : "POST", body: { name, description } },
      );
      setChanged(true);
      if (id) onClose(true);
      else setId(result.id);
    });
  const add = (body: object) =>
    run(async () => {
      await api(`/api/app/knowledge/${id}/items`, { method: "POST", body });
      setChanged(true);
      setPicking(false);
      await items.reload();
    });
  const upload = (list: FileList | null) =>
    run(async () => {
      for (const file of Array.from(list ?? []).slice(0, 10)) {
        const stored = await uploadFile(file);
        await api(`/api/app/knowledge/${id}/items`, {
          method: "POST",
          body: { fileId: stored.id },
        });
        setChanged(true);
      }
      await items.reload();
    });
  const take = (item: Item) =>
    run(async () => {
      await api(`/api/app/knowledge/${id}/items/${item.id}`, { method: "DELETE" });
      setChanged(true);
      await items.reload();
    });
  const remove = async () => {
    if (!base || !(await confirm(t.common.delete, k.deleteConfirm(base.name)))) return;
    await run(async () => {
      await api(`/api/app/knowledge/${base.id}`, { method: "DELETE" });
      onClose(true);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(changed)}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{readOnly ? base.name : id ? k.edit : k.new}</DialogTitle>
          <DialogDescription>{readOnly ? k.readOnly : k.lead}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {readOnly ? (
            base.description && <p className="text-sm">{base.description}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <Label className="grid gap-1.5">
                {k.name}
                <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </Label>
              <Label className="grid gap-1.5">
                {k.about}
                <Input
                  value={description}
                  maxLength={300}
                  placeholder={k.aboutHint}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Label>
            </div>
          )}
          {id && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{k.contents}</span>
              {!items.data ? (
                <Loading />
              ) : items.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">{k.empty}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {items.data.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      {item.status === "ready" ? (
                        <FileTypeIcon name={item.name} small className="size-4 shrink-0" />
                      ) : (
                        <AlertTriangleIcon className="size-4 shrink-0 text-warn" />
                      )}
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate">{item.name}</span>
                        {item.problem && (
                          <span className="text-xs text-warn">
                            {item.status === "ready"
                              ? item.problem
                              : `${k.notRead}: ${item.problem}`}
                          </span>
                        )}
                      </span>
                      {item.status === "ready" && (
                        <span className="num shrink-0 text-xs text-muted-foreground">
                          {k.size(item.chars, item.passages)}
                        </span>
                      )}
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          disabled={busy}
                          title={k.takeOut}
                          aria-label={k.takeOut}
                          onClick={() => void take(item)}
                        >
                          <XIcon className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={pick}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void upload(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => pick.current?.click()}
                  >
                    <UploadIcon />
                    {k.fromComputer}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPicking((now) => !now)}
                  >
                    <PlusIcon />
                    {k.fromMine}
                  </Button>
                  <span className="text-xs text-muted-foreground">{k.kinds}</span>
                </div>
              )}
              {picking && !readOnly && <Picker busy={busy} onPick={(body) => void add(body)} />}
            </div>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
        <DialogFooter>
          {base?.mine && (
            <span className="flex items-center gap-2 sm:mr-auto">
              <MoreMenu
                label={t.common.more}
                items={[
                  { label: t.common.delete, destructive: true, onSelect: () => void remove() },
                ]}
              />
              <Button variant="outline" onClick={() => onShare(base)}>
                <UsersIcon />
                {base.shares ? t.app.builder.sharedWith(base.shares) : t.app.builder.share}
              </Button>
            </span>
          )}
          <Button variant="outline" onClick={() => onClose(changed)}>
            {readOnly || (id && !base) ? t.common.close : t.common.cancel}
          </Button>
          {!readOnly && (
            <Button disabled={!name.trim() || busy} onClick={() => void save()}>
              {id ? t.common.save : k.create}
            </Button>
          )}
        </DialogFooter>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

/** A person's knowledge bases: the documents their agents look things up in. */
export function MyKnowledge() {
  const { t } = useI18n();
  const k = t.app.knowledge;
  const { data, error, reload } = useLoad(() => api<Base[]>("/api/app/knowledge"));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Base | "new" | null>(null);
  const [sharing, setSharing] = useState<Base | null>(null);
  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Loading />;
  const needle = query.trim().toLowerCase();
  const shown = data.filter(
    (base) => !needle || `${base.name} ${base.description}`.toLowerCase().includes(needle),
  );
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={k.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Lead as="span" className="text-xs text-muted-foreground">
            {k.how}
          </Lead>
          <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
            <PlusIcon />
            {k.new}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((base) => (
            <BaseTile key={base.id} base={base} onOpen={() => setEditing(base)} />
          ))}
          {!needle && data.length > 0 && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed p-4 text-center text-muted-foreground hover:bg-accent/40"
            >
              <PlusIcon className="size-5" />
              <span className="text-sm font-medium text-foreground">{k.first}</span>
              <span className="max-w-64 text-xs">{k.firstHint}</span>
            </button>
          )}
        </div>
        {shown.length === 0 && needle && <Notice>{k.noMatch}</Notice>}
        {data.length === 0 && <Guide icon={BookOpenIcon} text={t.app.guides.knowledge} />}
      </div>
      {editing && (
        <BaseEditor
          base={editing === "new" ? null : editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
          onShare={(base) => {
            setEditing(null);
            setSharing(base);
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          kind="knowledge"
          id={sharing.id}
          name={sharing.name}
          onClose={(changed) => {
            setSharing(null);
            if (changed) void reload();
          }}
        />
      )}
    </div>
  );
}
