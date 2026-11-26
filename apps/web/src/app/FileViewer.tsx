import { DownloadIcon, HistoryIcon, MessageSquareIcon, Undo2Icon, UsersIcon } from "lucide-react";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { Loading, Notice, useAction, useLoad } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { downloadFile, fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";
import type { Attachment, SheetGrid } from "./api";
import { type FileComment, FileComments } from "./FileComments";
import { FileTypeIcon } from "./FileTypeIcon";
import { LockedFrame } from "./LockedFrame";
import { ShareDialog } from "./Share";
import { ChartView } from "./slides/ChartView";
import type { Chart } from "./slides/chart";
import { SlidesView } from "./slides/SlidesView";

// The PDF engine runs in a worker of its own, loaded from this app, never from elsewhere.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const ending = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/** Opens one of the person's files in the viewer. Provided by the workspace. */
const OpenFile = createContext<(file: Attachment) => void>(() => undefined);
export const OpenFileProvider = OpenFile.Provider;
export const useOpenFile = () => useContext(OpenFile);

/** A file as a small chip: its kind, name and size. Opens the viewer; `onRemove` adds a way to take it away. */
export function FileChip({
  file,
  onRemove,
  busy,
}: {
  file: Attachment;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const open = useOpenFile();
  return (
    <span className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border bg-background/70 pr-1 pl-2 text-xs">
      <FileTypeIcon name={file.name} kind={file.kind} small className="size-4 shrink-0" />
      <button
        type="button"
        disabled={busy}
        className="min-w-0 truncate hover:underline disabled:opacity-60"
        title={file.name}
        onClick={() => open(file)}
      >
        {file.name}
      </button>
      {(file.version ?? 1) > 1 && (
        <span className="num shrink-0 rounded bg-foreground/8 px-1 text-[10px] font-medium">
          v{file.version}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">{t.files.size(file.size)}</span>
      {onRemove && (
        <button
          type="button"
          className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
          aria-label={t.files.remove(file.name)}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A PDF, page after page at the width of the viewer. Pages are drawn as the person reaches them. */
function PdfView({ url }: { url: string }) {
  const { t } = useI18n();
  const v = t.files.view;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  const [shown, setShown] = useState(4);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(Math.min(1100, element.clientWidth - 32));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const source = useMemo(() => ({ url, withCredentials: true }), [url]);
  // Reaching the end of what is drawn draws the next few pages.
  const more = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setShown((now) => Math.min(pages, now + 4));
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [pages],
  );
  if (failed) return <Notice tone="bad">{v.failed}</Notice>;
  return (
    <div ref={box} className="h-full overflow-auto bg-muted/60">
      <Document
        file={source}
        loading={<Loading />}
        onLoadSuccess={(pdf) => setPages(pdf.numPages)}
        onLoadError={() => setFailed(true)}
        className="grid justify-items-center gap-3 py-4"
      >
        {width > 0 &&
          Array.from({ length: Math.min(pages, shown) }, (_, index) => (
            <Page
              // biome-ignore lint/suspicious/noArrayIndexKey: pages of one file never reorder
              key={index}
              pageNumber={index + 1}
              width={width}
              renderAnnotationLayer={false}
              className="shadow-md"
            />
          ))}
        {shown < pages && <div ref={more} className="h-8" />}
      </Document>
      {pages > 0 && (
        <p className="pb-3 text-center text-[11px] text-muted-foreground">{v.pages(pages)}</p>
      )}
    </div>
  );
}

/**
 * A Word document laid out as pages, drawn in the browser from the file itself. It is drawn inside a frame of its own that runs no scripts and
 * loads nothing from outside, so nothing in the document can restyle or reach the app.
 */
function DocxView({ id }: { id: string }) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [{ renderAsync }, response] = await Promise.all([
          import("docx-preview"),
          fetch(fileUrl(id), { credentials: "same-origin" }),
        ]);
        if (!response.ok) throw new Error("not found");
        const bytes = await response.arrayBuffer();
        const page = frame.current?.contentDocument;
        if (!live || !page) return;
        page.open();
        page.write(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:"><body style="margin:0;background:#e9e9ec;color:#000"></body>`,
        );
        page.close();
        await renderAsync(bytes, page.body, page.head, { inWrapper: true, breakPages: true });
        if (live) setState("ready");
      } catch {
        if (live) setState("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <div className="relative h-full bg-muted/60">
      {state === "loading" && <Loading />}
      {state === "failed" && <Notice tone="bad">{t.files.view.failed}</Notice>}
      <iframe
        ref={frame}
        title="document"
        // Same origin so the page can draw into it; no "allow-scripts", so nothing in it runs.
        sandbox="allow-same-origin"
        className={cn("absolute inset-0 h-full w-full border-0", state !== "ready" && "invisible")}
      />
    </div>
  );
}

const letters = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : letters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));

/** One sheet as a grid: column letters, row numbers, merged cells, and the frozen top rows kept in view. */
function Grid({ grid }: { grid: SheetGrid }) {
  const { t } = useI18n();
  // Cells that a merged area covers are not drawn; its first cell spans them.
  const { spans, covered } = useMemo(() => {
    const spans = new Map<string, [number, number]>();
    const covered = new Set<string>();
    for (const [top, left, bottom, right] of grid.merges) {
      spans.set(`${top}:${left}`, [bottom - top + 1, right - left + 1]);
      for (let r = top; r <= bottom; r++)
        for (let c = left; c <= right; c++) if (r !== top || c !== left) covered.add(`${r}:${c}`);
    }
    return { spans, covered };
  }, [grid]);
  const columns = Math.max(1, ...grid.rows.map((row) => row.length));
  const head = "sticky bg-muted text-[11px] font-normal text-muted-foreground";
  // A workbook that colours its cells is shown as the sheet of paper it is, in either theme:
  // its bands and headers were chosen against white, and half of them on black read as broken.
  const paper = Object.values(grid.looks ?? {}).some((look) => look.fill);
  return (
    <div className="h-full overflow-auto">
      <table className="num border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className={cn(head, "top-0 left-0 z-30 w-10 border-r border-b")} />
            {Array.from({ length: columns }, (_, c) => (
              <th
                key={letters(c)}
                className={cn(head, "top-0 z-20 min-w-20 border-r border-b px-2 py-1")}
                style={
                  grid.widths?.[c]
                    ? { minWidth: Math.round((grid.widths[c] ?? 0) * 7.2) }
                    : undefined
                }
              >
                {letters(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of one sheet never reorder
            <tr key={r}>
              <th className={cn(head, "left-0 z-10 border-r border-b px-2 py-1 text-right")}>
                {r + 1}
              </th>
              {Array.from({ length: columns }, (_, c) => {
                if (covered.has(`${r}:${c}`)) return null;
                const span = spans.get(`${r}:${c}`);
                const text = row[c] ?? "";
                const look = grid.looks?.[`${r}:${c}`];
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells of one row never reorder
                    key={c}
                    rowSpan={span?.[0]}
                    colSpan={span?.[1]}
                    className={cn(
                      "max-w-80 truncate border-r border-b px-2 py-1 whitespace-nowrap",
                      r < grid.frozenRows && "sticky z-10 bg-background font-medium",
                      /^[\s$¥€£+-]*\d[\d,.]*\s*[%kKmMbB万亿]?\s*$/.test(text) && "text-right",
                    )}
                    style={{
                      ...(r < grid.frozenRows ? { top: 25 + r * 25 } : {}),
                      // A filled cell keeps the workbook's own colours, whatever the app's theme.
                      ...(look?.fill
                        ? { backgroundColor: `#${look.fill}`, color: `#${look.color ?? "000000"}` }
                        : paper
                          ? {
                              backgroundColor: "#ffffff",
                              // On white the workbook's own text colour (a red negative) can be kept.
                              color: `#${look?.color ?? "14181f"}`,
                              borderColor: "#e5e8ee",
                            }
                          : {}),
                      ...(look?.bold ? { fontWeight: 600 } : {}),
                    }}
                    title={text}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {grid.totalRows > grid.rows.length && (
        <p className="p-2 text-xs text-muted-foreground">
          {t.files.view.rowsShown(grid.rows.length, grid.totalRows)}
        </p>
      )}
    </div>
  );
}

function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange(value: T): void;
}) {
  return (
    <div className="flex rounded-md bg-foreground/6 p-0.5">
      {options.map(([id, label]) => (
        <button
          type="button"
          key={id}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "h-6 max-w-40 truncate rounded px-2 text-xs",
            value === id ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const CHART_W = 414;
const CHART_H = 290;
const SERIES = ["#2F6BFF", "#0B1F3A", "#17A673", "#FF7F41", "#8B5CF6", "#E5484D"];
/** A sheet's chart in the form the chart drawing takes. */
function sheetChart(chart: NonNullable<SheetGrid["charts"]>[number]): Chart {
  return {
    kind: chart.kind,
    sideways: false,
    stacked: false,
    title: chart.title,
    categories: chart.categories,
    series: chart.series.map((one, index) => ({
      name: one.name,
      color: one.color ? `#${one.color}` : (SERIES[index % SERIES.length] as string),
      colors: [],
      values: one.values,
    })),
    legend: "b",
    labels: chart.kind === "pie" ? "percent" : null,
    format: "#,##0",
    labelColor: "rgb(255,255,255)",
    axisColor: "rgb(91,100,114)",
    gridColor: "rgb(230,233,238)",
    hole: 0,
  };
}

/** A workbook's sheets, one at a time, with the sheet names along the bottom as in a spreadsheet. */
function SheetsView({ id }: { id: string }) {
  const { t } = useI18n();
  const { data, error } = useLoad(() => api<SheetGrid[]>(`/api/app/files/${id}/sheets`), [id]);
  const [sheet, setSheet] = useState(0);
  // A workbook that cannot be laid out as a grid can often still be read: shown as its text,
  // which is what an agent is given, so the person sees what the agent sees.
  if (error) return <TextFallback id={id} />;
  if (!data) return <Loading />;
  const grid = data[sheet] ?? data[0];
  if (!grid) return <Notice>{t.files.view.empty}</Notice>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Grid grid={grid} />
        </div>
        {grid.charts && grid.charts.length > 0 && (
          <div className="relative w-[440px] shrink-0 space-y-3 overflow-y-auto border-l bg-muted/40 p-3">
            {grid.charts.map((chart, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: the charts of a sheet never reorder
                key={index}
                className="relative overflow-hidden rounded-lg border bg-white"
                style={{ width: CHART_W, height: CHART_H }}
              >
                <ChartView chart={sheetChart(chart)} w={CHART_W} h={CHART_H} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t px-2 py-1">
        <Tabs
          value={String(data.indexOf(grid))}
          options={data.map((item, index) => [String(index), item.name])}
          onChange={(value) => setSheet(Number(value))}
        />
      </div>
    </div>
  );
}

/** Rows of comma-separated text as a grid. Quoted cells may hold commas and line breaks. */
function csvGrid(text: string): SheetGrid {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length <= 2000; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      rows.at(-1)?.push(cell);
      cell = "";
    } else if (char === "\n") {
      rows.at(-1)?.push(cell.replace(/\r$/, ""));
      cell = "";
      rows.push([]);
    } else cell += char;
  }
  if (cell || rows.at(-1)?.length) rows.at(-1)?.push(cell);
  const kept = rows.filter((row) => row.length > 0).slice(0, 2000);
  const total = text.split("\n").filter(Boolean).length;
  return {
    name: "",
    rows: kept,
    totalRows: Math.max(total, kept.length),
    totalColumns: Math.max(0, ...kept.map((row) => row.length)),
    merges: [],
    frozenRows: 1,
    frozenColumns: 0,
  };
}

/**
 * A web page someone else wrote, shown without letting it do anything: its frame
 * runs no scripts, loads nothing from anywhere, and cannot reach this app.
 */
function HtmlView({ html }: { html: string }) {
  return <LockedFrame html={html} className="h-full w-full" />;
}

function TextBody({ file, as }: { file: Attachment; as: "text" | "csv" | "page" | "source" }) {
  const { t } = useI18n();
  const { data, error } = useLoad(async () => {
    const response = await fetch(fileUrl(file.id), { credentials: "same-origin" });
    if (!response.ok) throw new Error("not found");
    return response.text();
  }, [file.id]);
  if (error) return <Notice tone="bad">{t.files.view.failed}</Notice>;
  if (data === null) return <Loading />;
  if (!data.trim()) return <Notice>{t.files.view.empty}</Notice>;
  if (as === "page") return <HtmlView html={data} />;
  if (as === "csv") return <Grid grid={csvGrid(data)} />;
  return (
    <pre className="h-full overflow-auto p-4 font-mono text-xs whitespace-pre-wrap break-words">
      {data}
    </pre>
  );
}

/** The file's text, for when it cannot be shown as it is. Says so. */
function TextFallback({ id }: { id: string }) {
  const { t } = useI18n();
  const { data, error } = useLoad(
    () => api<{ text: string; problem?: string }>(`/api/app/files/${id}/text`),
    [id],
  );
  if (error) return <Notice tone="bad">{t.files.view.failed}</Notice>;
  if (!data) return <Loading />;
  return (
    <div className="grid h-full content-start gap-3 overflow-auto p-4">
      <Notice>{data.problem ?? t.files.view.textOnly}</Notice>
      <pre className="font-mono text-xs whitespace-pre-wrap break-words">{data.text}</pre>
    </div>
  );
}

type Mode = "page" | "source";

interface Version {
  n: number;
  note: string;
  size: number;
  createdAt: string;
  by: string | null;
}
/**
 * The versions of a file an agent made: what changed in each, and a way back to any of
 * them. Shown only for a file that has more than one.
 */
function Versions({
  file,
  canChange,
  onRestored,
}: {
  file: Attachment;
  /** Bringing a version back changes the file: offered to whoever may change it. */
  canChange: boolean;
  onRestored(): void;
}) {
  const { t, ago } = useI18n();
  const w = t.files.versions;
  const { confirm, dialog } = useConfirm();
  const action = useAction();
  const { data, reload } = useLoad(
    () => api<{ current: number; versions: Version[] }>(`/api/app/files/${file.id}/versions`),
    [file.id],
  );
  if (!data || data.versions.length < 2) return null;
  const restore = async (n: number) => {
    if (!(await confirm(w.restore, w.restoreConfirm(n, data.current + 1)))) return;
    await action.run(async () => {
      await api(`/api/app/files/${file.id}/versions/${n}/restore`, { method: "POST" });
      await reload();
      onRestored();
    });
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={w.title}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-foreground/8 px-2 text-xs font-medium hover:bg-foreground/12"
          >
            <HistoryIcon className="size-3.5" />
            {w.label(data.current)}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-96 w-96 overflow-y-auto">
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{w.title}</div>
          {action.error && <p className="px-2 py-1 text-xs text-destructive">{action.error}</p>}
          {data.versions.map((version) => (
            <div key={version.n} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs">
              <span className="num w-8 shrink-0 font-medium">{version.n}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="break-words">{version.note}</span>
                <span className="text-[11px] text-muted-foreground">
                  {ago(version.createdAt)}
                  {version.by ? ` · ${w.by(version.by)}` : ""} · {t.files.size(version.size)}
                </span>
              </span>
              {version.n === data.current ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">{w.current}</span>
              ) : (
                <span className="flex shrink-0 items-center gap-0.5">
                  <a
                    className="grid size-6 place-items-center rounded hover:bg-accent"
                    title={w.download}
                    aria-label={w.download}
                    href={`/api/app/files/${file.id}/versions/${version.n}/content`}
                    download
                  >
                    <DownloadIcon className="size-3.5" />
                  </a>
                  {canChange && (
                    <button
                      type="button"
                      className="grid size-6 place-items-center rounded hover:bg-accent"
                      title={w.restore}
                      aria-label={w.restore}
                      onClick={() => void restore(version.n)}
                    >
                      <Undo2Icon className="size-3.5" />
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

/** One of the person's files, opened: each kind shown as itself, with a way to download and delete it. */
export function FileViewer({
  file,
  onClose,
  onDeleted,
}: {
  file: Attachment;
  onClose(): void;
  onDeleted(): void;
}) {
  const { t } = useI18n();
  const v = t.files.view;
  const { confirm, dialog } = useConfirm();
  const { error, run } = useAction();
  const end = ending(file.name);
  // Counted up when an earlier version is brought back: what is shown is read again.
  const [rev, setRev] = useState(0);
  const office = file.kind === "document" || file.kind === "spreadsheet" || file.kind === "slides";
  // A web page opens as the page; its source is one click away.
  const [mode, setMode] = useState<Mode>("page");
  const modes: [Mode, string][] =
    file.kind === "page"
      ? [
          ["page", v.page],
          ["source", v.source],
        ]
      : [];
  // Whose the file is, and whether the person may change it: asked of the server, which
  // decides. Until it answers, nothing that needs either is offered.
  const reach = useLoad(
    () => api<{ mine: boolean; canChange: boolean }>(`/api/app/files/${file.id}`),
    [file.id],
  );
  const mine = reach.data?.mine === true;
  const canChange = reach.data?.canChange === true;
  const shared = useLoad(
    () =>
      mine
        ? api<unknown[]>(`/api/app/items/file/${file.id}/shares`).then((list) => list.length)
        : Promise.resolve(0),
    [file.id, mine],
  );
  const talk = useLoad(() => api<FileComment[]>(`/api/app/files/${file.id}/comments`), [file.id]);
  const waiting = talk.data?.filter((one) => one.status === "open").length ?? 0;
  const [sharing, setSharing] = useState(false);
  const [talking, setTalking] = useState(false);
  const remove = async () => {
    if (!(await confirm(t.files.delete, t.files.deleteConfirm(file.name)))) return;
    await run(async () => {
      await api(`/api/app/files/${file.id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    });
  };

  let body: ReactNode;
  if (file.kind === "pdf") body = <PdfView url={fileUrl(file.id)} />;
  else if (file.kind === "image")
    body = (
      <div className="grid h-full place-items-center overflow-auto bg-muted/60 p-4">
        <img
          src={fileUrl(file.id)}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  else if (file.kind === "page")
    body = <TextBody file={file} as={mode === "source" ? "source" : "page"} />;
  else if (end === "csv") body = <TextBody file={file} as="csv" />;
  else if (!office) body = <TextBody file={file} as="text" />;
  else if (end === "xlsx" || end === "xlsm") body = <SheetsView id={file.id} />;
  else if (end === "docx") body = <DocxView id={file.id} />;
  else if (end === "pptx") body = <SlidesView id={file.id} />;
  else body = <TextFallback id={file.id} />;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="glass-thick flex h-[92dvh] w-[min(1200px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b pr-12 pl-3">
          <FileTypeIcon name={file.name} kind={file.kind} small className="size-[18px] shrink-0" />
          <DialogTitle className="min-w-0 truncate text-[13px] font-medium">
            {file.name}
          </DialogTitle>
          <DialogDescription className="shrink-0 text-xs text-muted-foreground">
            {t.files.kinds[file.kind]} · {t.files.size(file.size)}
          </DialogDescription>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {modes.length > 0 && <Tabs<Mode> value={mode} options={modes} onChange={setMode} />}
            <Versions
              file={file}
              canChange={canChange}
              onRestored={() => {
                setRev((n) => n + 1);
                onDeleted();
              }}
            />
            <Button
              variant={talking ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              title={t.files.comments.title}
              onClick={() => setTalking(!talking)}
            >
              <MessageSquareIcon className="size-3.5" />
              {waiting > 0 ? waiting : <span className="sr-only">{t.files.comments.title}</span>}
            </Button>
            {mine && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                title={t.files.share}
                onClick={() => setSharing(true)}
              >
                <UsersIcon className="size-3.5" />
                {shared.data ? shared.data : <span className="sr-only">{t.files.share}</span>}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title={t.files.download}
              onClick={() => downloadFile(file.id)}
            >
              <DownloadIcon className="size-3.5" />
              <span className="sr-only">{t.files.download}</span>
            </Button>
            {/* Only its owner deletes a file. */}
            {mine && (
              <MoreMenu
                label={t.common.more}
                items={[
                  { label: t.files.delete, destructive: true, onSelect: () => void remove() },
                ]}
              />
            )}
          </div>
        </header>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex min-h-0 flex-1">
          <div key={rev} className="min-h-0 min-w-0 flex-1 bg-background">
            {body}
          </div>
          {talking && (
            <FileComments
              fileId={file.id}
              comments={talk.data}
              canChange={canChange}
              error={talk.error}
              onChange={() => void talk.reload()}
            />
          )}
        </div>
        {sharing && (
          <ShareDialog
            kind="file"
            id={file.id}
            name={file.name}
            onClose={() => {
              setSharing(false);
              void shared.reload();
            }}
          />
        )}
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
