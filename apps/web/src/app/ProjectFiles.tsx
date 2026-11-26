import { Panel } from "./panel";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, useAction } from "@/components/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Lead } from "@/components/ui/hint";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import type { ConversationSummary, DocKind, FileKind, Project, ProjectDoc } from "./api";
import { FileTypeIcon } from "./FileTypeIcon";
import { useOpenFile } from "./FileViewer";
import { asFile, type Row as LibraryRow } from "./Library";

const KINDS: DocKind[] = ["spec", "decisions", "research", "release", "other"];

/**
 * A project's files: first the key documents, the few everything else rests on, each
 * named for what it is (the spec, the decisions, the research, the release notes); then
 * what was made in the project, newest first. A file is pinned from its row, as one of
 * those kinds. Agents working in the project are told which the key documents are.
 */
export function ProjectFiles({
  project,
  conversations,
  pinnedElsewhere = false,
  onPinned,
}: {
  project: Project;
  conversations: ConversationSummary[];
  /** The pinned files are listed beside this, among the project's guides: not again here. */
  pinnedElsewhere?: boolean;
  /** A file was pinned or unpinned from its row. */
  onPinned?(): void;
}) {
  const { t, ago } = useI18n();
  const p = t.app.project;
  const d = p.docs;
  const openFile = useOpenFile();
  const { error, run, busy } = useAction();
  const [files, setFiles] = useState<LibraryRow[]>();
  const [docs, setDocs] = useState<ProjectDoc[]>([]);
  const [all, setAll] = useState(false);
  // Asked again when one of the project's conversations has moved on: it may have made a file.
  const moved = conversations[0]?.updatedAt ?? "";
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    const [page, pinned] = await Promise.all([
      api<{ rows: LibraryRow[] }>(
        `/api/app/library?project=${project.id}&limit=${all ? 50 : 8}`,
      ).catch(() => ({ rows: [] as LibraryRow[] })),
      api<ProjectDoc[]>(`/api/app/projects/${project.id}/docs`).catch(() => [] as ProjectDoc[]),
    ]);
    if (mine !== asked.current) return;
    setFiles(page.rows);
    setDocs(pinned);
  }, [project.id, all]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is why it is asked again
  useEffect(() => {
    void load();
  }, [load, moved]);
  const pin = (fileId: string, kind: DocKind | null) =>
    run(async () => {
      await api(`/api/app/projects/${project.id}/docs/${fileId}`, {
        method: kind ? "PUT" : "DELETE",
        ...(kind ? { body: { kind } } : {}),
      });
      await load();
      onPinned?.();
    });
  // Key documents are the owner's files, and theirs to pin; the others in the project open them.
  const owns = project.role === "owner";
  const pinned = new Set(docs.map((doc) => doc.fileId));
  const others = (files ?? []).filter((file) => !pinned.has(file.id) && file.type === "file");
  const row =
    "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/40";
  const small =
    "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:!opacity-100 data-[state=open]:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100";

  return (
    <Panel title={p.files}>
      {error && <Notice tone="bad">{error}</Notice>}
      {docs.length > 0 && !pinnedElsewhere && (
        <ul className="grid">
          {docs.map((doc) => (
            <li key={doc.fileId} className={row}>
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {d.kind[doc.kind]}
              </span>
              <FileTypeIcon
                name={doc.name}
                kind={doc.fileKind as FileKind}
                className="size-5 shrink-0"
              />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title={doc.name}
                onClick={() =>
                  openFile({
                    id: doc.fileId,
                    name: doc.name,
                    kind: doc.fileKind as FileKind,
                    size: doc.size,
                    version: doc.version,
                  })
                }
              >
                {doc.name}
              </button>
              {doc.shadowed && (
                <span className="shrink-0 text-xs text-warn" title={d.shadowedHint}>
                  {d.shadowed}
                </span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={small} title={d.change} hidden={!owns}>
                    <PinIcon className="size-3.5" />
                    <span className="sr-only">{d.change}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{d.pinAs}</p>
                  {KINDS.filter((kind) => kind !== doc.kind).map((kind) => (
                    <DropdownMenuItem
                      key={kind}
                      disabled={busy}
                      onSelect={() => void pin(doc.fileId, kind)}
                    >
                      {d.kind[kind]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                className={small}
                title={d.unpin}
                hidden={!owns}
                disabled={busy}
                onClick={() => void pin(doc.fileId, null)}
              >
                <PinOffIcon className="size-3.5" />
                <span className="sr-only">{d.unpin}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files === undefined ? (
        <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">…</p>
      ) : others.length > 0 ? (
        <ul className="grid sm:grid-cols-2">
          {others.map((file) => (
            <li key={file.id} className={row}>
              <FileTypeIcon
                name={file.name}
                kind={file.kind as FileKind}
                className="size-6 shrink-0"
              />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title={file.name}
                onClick={() => openFile(asFile(file))}
              >
                {file.name}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(file.at)}</span>
              {file.mine && owns && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={small} title={d.pin}>
                      <PinIcon className="size-3.5" />
                      <span className="sr-only">{d.pinFile(file.name)}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{d.pinAs}</p>
                    {KINDS.map((kind) => (
                      <DropdownMenuItem
                        key={kind}
                        disabled={busy}
                        onSelect={() => void pin(file.id, kind)}
                      >
                        {d.kind[kind]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      ) : (
        docs.length === 0 && (
          <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">{p.noFiles}</p>
        )
      )}
      {!all && (files?.length ?? 0) >= 8 && (
        <button
          type="button"
          className="justify-self-start rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
          onClick={() => setAll(true)}
        >
          {d.more}
        </button>
      )}
      {owns && docs.length === 0 && others.length > 0 && (
        <Lead className="px-2.5 py-1 text-xs text-muted-foreground">{d.hint}</Lead>
      )}
      {owns && docs.length > 0 && project.people > 0 && (
        <Lead className="px-2.5 py-1 text-xs text-muted-foreground">{d.peopleRead}</Lead>
      )}
    </Panel>
  );
}
