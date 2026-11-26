import { DownloadIcon, HistoryIcon, PencilLineIcon, SendIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";
import type { Attachment, SheetGrid } from "./api";
import { FileTypeIcon } from "./FileTypeIcon";
import { useOpenFile } from "./FileViewer";
import { LockedFrame } from "./LockedFrame";
import { ReplyActions } from "./reply";
import { FirstSlide } from "./slides/SlidesView";

/**
 * What a reply made, as a card: the thing itself in small (its first slide, its first
 * rows, its first lines), which version it is and what changed, and what can be done
 * with it. The preview is read from the person's file when the card comes into view.
 */
interface Version {
  n: number;
  note: string;
}
/** A file's versions, asked once for each version it is at. */
const listed = new Map<string, Promise<Version[]>>();
const versionsOf = (id: string, at: number) => {
  const key = `${id}:${at}`;
  let asked = listed.get(key);
  if (!asked) {
    asked = api<{ versions: Version[] }>(`/api/app/files/${id}/versions`).then(
      (found) => found.versions,
      () => {
        listed.delete(key);
        return [];
      },
    );
    listed.set(key, asked);
  }
  return asked;
};
const PREVIEW_WIDTH = 218;
const PREVIEW_HEIGHT = 123;

function Rows({ id, seen, onFail }: { id: string; seen: number; onFail(): void }) {
  const [grid, setGrid] = useState<SheetGrid | null>(null);
  const [sheets, setSheets] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the file's version changes
  useEffect(() => {
    let live = true;
    void api<SheetGrid[]>(`/api/app/files/${id}/sheets`).then(
      (all) => {
        if (!live) return;
        setSheets(all.length);
        setGrid(all[0] ?? null);
        if (!all[0]) onFail();
      },
      () => live && onFail(),
    );
    return () => {
      live = false;
    };
  }, [id, seen]);
  const { t } = useI18n();
  if (!grid) return <div className="h-full bg-foreground/5" />;
  const rows = grid.rows.slice(0, 6).map((row) => row.slice(0, 5));
  return (
    <div className="flex h-full flex-col bg-white text-[9px] leading-tight text-neutral-800">
      <table className="w-full table-fixed border-collapse">
        <tbody>
          {rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows of a preview never reorder
            <tr key={r} className={cn(r === 0 && "bg-emerald-700/10 font-semibold")}>
              {row.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: nor do its cells
                <td key={c} className="truncate border border-neutral-200 px-1 py-[3px]">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span className="mt-auto px-1.5 py-1 text-[9px] text-neutral-500">
        {t.app.result.sheets(sheets, grid.totalRows)}
      </span>
    </div>
  );
}

function Lines({
  id,
  seen,
  page,
  onFail,
}: {
  id: string;
  seen: number;
  page: boolean;
  onFail(): void;
}) {
  const [text, setText] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the file's version changes
  useEffect(() => {
    let live = true;
    const read = page
      ? fetch(fileUrl(id), { credentials: "same-origin" }).then((response) => {
          if (!response.ok) throw new Error("not found");
          return response.text();
        })
      : api<{ text: string }>(`/api/app/files/${id}/text`).then((found) => found.text);
    void read.then(
      (found) => {
        if (!live) return;
        if (found.trim()) setText(found);
        else onFail();
      },
      () => live && onFail(),
    );
    return () => {
      live = false;
    };
  }, [id, seen, page]);
  if (text === null) return <div className="h-full bg-foreground/5" />;
  if (page)
    return (
      // A page an agent wrote, shown small and still: see LockedFrame.
      <LockedFrame
        html={text}
        still
        className="pointer-events-none h-[246px] w-[436px] origin-top-left scale-50"
      />
    );
  return (
    <div className="h-full overflow-hidden bg-white px-3 py-2 text-[9px] leading-snug whitespace-pre-wrap text-neutral-800">
      {text.slice(0, 700)}
    </div>
  );
}

export function ResultCard({
  file,
  latest,
}: {
  file: Attachment;
  /** The newest reply that made or changed this file: the card that speaks for its version. */
  latest: boolean;
}) {
  const { t } = useI18n();
  const r = t.app.result;
  const open = useOpenFile();
  const { send, disabled } = useContext(ReplyActions);
  const frame = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [slides, setSlides] = useState(0);
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState("");
  const version = file.version ?? 1;
  // Read only once the card is looked at: a long conversation holds many.
  useEffect(() => {
    const element = frame.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true),
      // The conversation scrolls in a box of its own: a little before the card enters it.
      { root: element.closest("[data-scroller]"), rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    void versionsOf(file.id, version).then((found) => live && setVersions(found));
    return () => {
      live = false;
    };
  }, [seen, file.id, version]);
  const note = versions.find((one) => one.n === version)?.note;
  const ending = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  // Exactly what pressing send will say, shown before it is said: the file's name is
  // not the person's own words.
  const saying = r.ask(file.name, change.trim() || "…");
  const say = () => {
    const what = change.trim();
    if (!what) return;
    send(r.ask(file.name, what));
    setChange("");
    setChanging(false);
  };
  return (
    <div
      ref={frame}
      className="glass-thick grid w-[236px] shrink-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl text-sm"
    >
      <div
        className="relative m-2 mb-0 overflow-hidden rounded-lg border bg-foreground/5"
        style={{ height: PREVIEW_HEIGHT }}
      >
        {/* What is drawn here is a picture of the file: nothing in it can be reached. */}
        <div inert className="h-full">
          {!seen ? null : failed ? (
            <div className="grid h-full place-items-center">
              <FileTypeIcon name={file.name} kind={file.kind} className="size-12 opacity-80" />
            </div>
          ) : ending === "pptx" ? (
            <FirstSlide
              id={file.id}
              seen={version}
              width={PREVIEW_WIDTH}
              onCount={setSlides}
              onFail={() => setFailed(true)}
            />
          ) : ending === "xlsx" || ending === "xlsm" ? (
            <Rows id={file.id} seen={version} onFail={() => setFailed(true)} />
          ) : file.kind === "image" ? (
            <img
              src={fileUrl(file.id)}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setFailed(true)}
            />
          ) : (
            <Lines
              id={file.id}
              seen={version}
              page={file.kind === "page"}
              onFail={() => setFailed(true)}
            />
          )}
        </div>
        <button
          type="button"
          aria-label={r.open(file.name)}
          className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => open(file)}
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 px-3 pt-2">
        <div className="flex items-center gap-1.5">
          <FileTypeIcon name={file.name} kind={file.kind} small className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={file.name}>
            {file.name}
          </span>
          {latest && version > 1 && (
            <span className="num shrink-0 rounded bg-foreground/8 px-1 text-[10px] font-medium">
              v{version}
            </span>
          )}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
          {[
            t.files.kinds[file.kind],
            slides > 0 && r.slides(slides),
            t.files.size(file.size),
            // Only the newest card of a file says what its last change was: an older
            // reply did not make that change.
            latest ? version > 1 && note : r.since(version),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {changing ? (
        <form
          className="flex flex-wrap items-center gap-1 px-2 pt-1 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            say();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the person just asked to say what to change
            autoFocus
            aria-label={r.change}
            value={change}
            placeholder={r.changeHint}
            onChange={(event) => setChange(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setChanging(false)}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background/60 px-2 text-xs outline-none focus:border-ring"
          />
          <Button
            type="submit"
            size="icon"
            className="size-7 shrink-0"
            disabled={disabled || !change.trim()}
          >
            <SendIcon className="size-3.5" />
            <span className="sr-only">{r.change}</span>
          </Button>
          <p className="w-full px-1 text-[11px] break-words text-muted-foreground">
            {r.sends} {saying}
          </p>
        </form>
      ) : (
        <div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-1.5 text-xs"
            disabled={disabled}
            onClick={() => setChanging(true)}
          >
            <PencilLineIcon className="size-3.5" />
            {r.change}
          </Button>
          {versions.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-1.5 text-xs"
              onClick={() => open(file)}
            >
              <HistoryIcon className="size-3.5" />
              {r.versions(versions.length)}
            </Button>
          )}
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="ml-auto size-7"
            title={t.files.download}
          >
            <a href={fileUrl(file.id)} download={file.name}>
              <DownloadIcon className="size-3.5" />
              <span className="sr-only">{t.files.download}</span>
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}
