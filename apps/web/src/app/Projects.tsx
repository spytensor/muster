import { CheckIcon, FolderIcon, FolderPlusIcon, Settings2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Notice, useAction } from "@/components/shared";
import { MoreMenu } from "@/components/more";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { desktop, type LocalFolder } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import type { Project } from "./api";

const PROJECT_KEY = "muster.project";
/** The project new conversations start in, remembered between visits. Empty for none. */
export const preferProject = (id: string | null) =>
  id ? localStorage.setItem(PROJECT_KEY, id) : localStorage.removeItem(PROJECT_KEY);
export const preferredProject = () => localStorage.getItem(PROJECT_KEY);

/** Makes a project or changes one: its name, and what every agent working in it is told. */
export function ProjectDialog({
  project,
  onClose,
}: {
  project: Project | null;
  /** `saved` is the project's id when it was created or changed, "deleted" when it was removed. */
  onClose(saved?: string): void;
}) {
  const { t } = useI18n();
  const p = t.app.projects;
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const { busy, error, run } = useAction();
  const { confirm, dialog } = useConfirm();
  // A project made here stays open, so its folders can be attached right away.
  const [id, setId] = useState(project?.id ?? null);
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  useEffect(() => {
    if (desktop && id) void desktop.folders(id).then(setFolders, () => undefined);
  }, [id]);
  // Folders picked before the project is made: attached to it once it is.
  const [picked, setPicked] = useState<LocalFolder[]>([]);
  const [nameless, setNameless] = useState(false);
  const [picking, setPicking] = useState(false);
  // One making at a time: a second Enter or press before the page has drawn "busy" makes no second project.
  const making = useRef(false);
  const leave = (saved?: string) => {
    // What was picked and not attached is no longer wanted.
    if (picked.length > 0) void desktop?.forgetPicked?.(picked.map((folder) => folder.path));
    onClose(saved);
  };
  const make = async () =>
    (
      await api<{ id: string }>("/api/app/projects", {
        method: "POST",
        body: { name: name.trim(), instructions },
      })
    ).id;
  const save = async () => {
    if (making.current) return;
    making.current = true;
    try {
      await run(async () => {
        const body = { name: name.trim(), instructions };
        if (id) {
          await api(`/api/app/projects/${id}`, { method: "PUT", body });
          onClose(id);
          return;
        }
        const made = await make();
        if (!desktop?.attachPicked) {
          // An older desktop app attaches folders only to a project that is there: it stays open for that.
          if (desktop) setId(made);
          else onClose(made);
          return;
        }
        const left: LocalFolder[] = [];
        for (const folder of picked)
          await desktop.attachPicked(made, folder.path).catch(() => left.push(folder));
        if (left.length === 0) return onClose(made);
        // The project is made. What could not be attached is said, and the dialog stays
        // open on the project, where the folders can be added again.
        void desktop.forgetPicked?.(left.map((folder) => folder.path));
        setPicked([]);
        setId(made);
        throw new Error(p.notAttached(left.map((folder) => folder.name).join(", ")));
      });
    } finally {
      making.current = false;
    }
  };
  /** In a project not made yet: picks a folder now, to be attached when it is made. */
  const add = async () => {
    if (desktop?.pickFolder) {
      // One system dialog at a time.
      if (picking) return;
      setPicking(true);
      const folder = await desktop.pickFolder().catch(() => null);
      setPicking(false);
      if (!folder) return;
      setPicked((now) => (now.some((one) => one.path === folder.path) ? now : [...now, folder]));
      // A project is most often named after the folder its work is in.
      setName((now) => now.trim() || folder.name.slice(0, 60));
      return;
    }
    // An older desktop app: the project is made first, then its dialog opens at once.
    if (!name.trim()) return setNameless(true);
    await run(async () => {
      const made = await make();
      setId(made);
      await desktop?.addFolder(made).then(setFolders, () => undefined);
    });
  };
  const remove = async () => {
    if (!project || !(await confirm(t.common.delete, p.deleteConfirm(project.name)))) return;
    await run(async () => {
      await api(`/api/app/projects/${project.id}`, { method: "DELETE" });
      onClose("deleted");
    });
  };
  // One row for a folder, attached or only picked so far.
  const row = (folder: LocalFolder, drop: () => void) => (
    <li
      key={folder.path}
      className="flex items-center gap-2 rounded-lg bg-foreground/5 px-2.5 py-1.5 text-[13px]"
    >
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">{folder.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={folder.path}>
        {folder.path}
      </span>
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        title={p.detach}
        onClick={drop}
      >
        <XIcon className="size-3.5" />
        <span className="sr-only">{p.detach}</span>
      </button>
    </li>
  );
  const shown = id ? folders : picked;
  return (
    <Dialog
      open
      // Not while it is being made: the answer would come to a dialog that has gone.
      onOpenChange={(open) => !open && !busy && leave(id && !project ? id : undefined)}
    >
      {/* A name, where the work is, and one button (the owner, 2026-11-22, beside another
          product's dialog: "新项目也是，要非常简洁"). What a project is, and what agents may
          do in a folder, were paragraphs here that nobody read. */}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{id ? p.edit : p.create}</DialogTitle>
        </DialogHeader>
        <Label>
          {p.name}
          <Input
            autoFocus
            value={name}
            maxLength={60}
            placeholder={p.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim() && !busy && !event.nativeEvent.isComposing)
                void save();
            }}
          />
        </Label>
        {(desktop || id) && (
          <section className="grid gap-1.5">
            <h3 className="text-sm font-medium">{p.folders}</h3>
            {!desktop ? (
              <p className="text-[13px] text-muted-foreground">{p.foldersInApp}</p>
            ) : (
              <div
                className={cn(
                  "grid gap-2 rounded-xl border p-2",
                  shown.length === 0 && "place-items-center border-dashed py-5",
                )}
              >
                {shown.length > 0 && (
                  <ul className="grid gap-1">
                    {shown.map((folder) =>
                      row(folder, () => {
                        if (id)
                          void desktop
                            ?.removeFolder(id, folder.path)
                            .then(setFolders, () => undefined);
                        else {
                          void desktop?.forgetPicked?.([folder.path]);
                          setPicked((now) => now.filter((one) => one.path !== folder.path));
                        }
                      }),
                    )}
                  </ul>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={shown.length ? "ghost" : "outline"}
                    // No more than a project holds.
                    disabled={busy || picking || shown.length >= 20}
                    onClick={() =>
                      id
                        ? void desktop?.addFolder(id).then(setFolders, () => undefined)
                        : void add()
                    }
                  >
                    <FolderPlusIcon />
                    {p.addFolder}
                  </Button>
                  {nameless && !name.trim() && (
                    <span className="text-xs text-warn">{p.nameFirst}</span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
        {/* What agents are told belongs to a project that is there: it is in its settings. */}
        {id && (
          <Label>
            {p.instructions}
            <Textarea
              value={instructions}
              rows={4}
              maxLength={8000}
              placeholder={p.instructionsHint}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Label>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <DialogFooter>
          {project && (
            <span className="sm:mr-auto">
              <MoreMenu
                label={t.common.more}
                items={[
                  { label: t.common.delete, destructive: true, onSelect: () => void remove() },
                ]}
              />
            </span>
          )}
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {id ? t.common.save : p.create}
          </Button>
        </DialogFooter>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}

/** The project a new conversation will start in: pick one, pick none, or make one. */
export function ProjectPicker({
  projects,
  chosen,
  onChoose,
  onNew,
  onSettings,
}: {
  projects: Project[];
  chosen: Project | undefined;
  onChoose(id: string | null): void;
  onNew(): void;
  /** Opens the chosen project's settings. */
  onSettings?(): void;
}) {
  const { t } = useI18n();
  const p = t.app.projects;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = projects.filter(
    (project) => !needle || project.name.toLowerCase().includes(needle),
  );
  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 max-w-64 items-center gap-1.5 rounded-full px-2.5 text-[13px] hover:bg-foreground/8",
            chosen ? "font-medium" : "text-muted-foreground",
          )}
        >
          <FolderIcon className="size-3.5 shrink-0" />
          <span className="truncate">{chosen ? chosen.name : p.choose}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-72">
        {projects.length > 0 && (
          <div className="px-1 pb-1">
            <Input
              autoFocus
              className="h-8"
              placeholder={p.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Typing must reach the box, not jump through the menu's items; the keys
              // that move to the list or leave it are the menu's.
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key))
                  event.stopPropagation();
              }}
            />
          </div>
        )}
        <DropdownMenuItem onSelect={onNew}>
          <FolderPlusIcon />
          {p.create}
        </DropdownMenuItem>
        {projects.length > 0 && <DropdownMenuSeparator />}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((project) => (
            <DropdownMenuItem key={project.id} onSelect={() => onChoose(project.id)}>
              <FolderIcon />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {chosen?.id === project.id && <CheckIcon className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        </div>
        {chosen && (
          <>
            <DropdownMenuSeparator />
            {onSettings && (
              <DropdownMenuItem onSelect={onSettings}>
                <Settings2Icon />
                {p.edit}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onChoose(null)}>{p.none}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
