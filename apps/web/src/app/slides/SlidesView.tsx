import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Loading, Notice } from "@/components/shared";
import { useI18n } from "@/i18n";
import { fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";
import { ChartView } from "./ChartView";
import type { Box, Deck, Fill, Item, Slide, TextBody } from "./parse";

/** How long a file may take to read before the viewer gives up on it. */
const READ_SECONDS = 20;
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
/** Fonts to fall back on, so text in a face this computer lacks still looks like a slide. */
const FALLBACK = `"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;

/** Preset shapes drawn as polygons, as shares of the shape's box. */
const POLYGON: Record<string, string> = {
  triangle: "50% 0, 100% 100%, 0 100%",
  rtTriangle: "0 0, 100% 100%, 0 100%",
  diamond: "50% 0, 100% 50%, 50% 100%, 0 50%",
  parallelogram: "25% 0, 100% 0, 75% 100%, 0 100%",
  trapezoid: "25% 0, 75% 0, 100% 100%, 0 100%",
  pentagon: "50% 0, 100% 38%, 81% 100%, 19% 100%, 0 38%",
  hexagon: "25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%",
  homePlate: "0 0, 75% 0, 100% 50%, 75% 100%, 0 100%",
  chevron: "0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%",
  rightArrow: "0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%",
  leftArrow: "100% 25%, 40% 25%, 40% 0, 0 50%, 40% 100%, 40% 75%, 100% 75%",
  upArrow: "25% 100%, 25% 40%, 0 40%, 50% 0, 100% 40%, 75% 40%, 75% 100%",
  downArrow: "25% 0, 25% 60%, 0 60%, 50% 100%, 100% 60%, 75% 60%, 75% 0",
};
const LINES = new Set(["line", "straightConnector1", "bentConnector3", "curvedConnector3"]);

type Urls = Record<string, string>;
const background = (fill: Fill | null, urls: Urls): CSSProperties =>
  !fill
    ? {}
    : "css" in fill
      ? { background: fill.css }
      : urls[fill.image]
        ? {
            backgroundImage: `url("${urls[fill.image]}")`,
            backgroundSize: "100% 100%",
            backgroundRepeat: "no-repeat",
          }
        : {};
const placed = (box: Box): CSSProperties => ({
  position: "absolute",
  left: box.x,
  top: box.y,
  width: box.w,
  height: box.h,
  transform: box.rotate ? `rotate(${box.rotate}deg)` : undefined,
});
const flipped = (box: Box) =>
  box.flipH || box.flipV ? `scale(${box.flipH ? -1 : 1}, ${box.flipV ? -1 : 1})` : undefined;

/** A shape's text, filling the shape; `flow` lays it out in place instead, as a table cell needs. */
function Text({ body, flow }: { body: TextBody; flow?: boolean }) {
  const [left, top, right, bottom] = body.inset;
  return (
    <div
      style={{
        ...(flow
          ? { padding: `${top}px ${right}px ${bottom}px ${left}px` }
          : { position: "absolute", left, top, right, bottom }),
        display: "flex",
        flexDirection: "column",
        justifyContent:
          body.anchor === "middle"
            ? "center"
            : body.anchor === "bottom"
              ? "flex-end"
              : "flex-start",
        whiteSpace: body.wrap ? "pre-wrap" : "pre",
        overflowWrap: body.wrap ? "break-word" : undefined,
      }}
    >
      {body.paragraphs.map((p, index) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: the paragraphs of a slide never reorder
          key={index}
          style={{
            margin: 0,
            marginTop: index ? p.spaceBefore : 0,
            paddingLeft: p.marginLeft,
            textIndent: p.bullet ? p.indent : Math.max(0, p.indent),
            textAlign: p.align,
            lineHeight: p.lineHeight,
            fontSize: p.size,
            minHeight: `${typeof p.lineHeight === "number" ? p.lineHeight : 1.2}em`,
          }}
        >
          {p.bullet && (
            <span
              style={{
                display: "inline-block",
                textIndent: 0,
                minWidth: Math.max(0, -p.indent),
                color: p.bulletColor ?? p.runs.find((run) => run !== "break")?.color,
              }}
            >
              {p.bullet}
            </span>
          )}
          {p.runs.map((run, at) =>
            run === "break" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the runs of a paragraph never reorder
              <br key={at} />
            ) : (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the runs of a paragraph never reorder
                key={at}
                style={{
                  fontSize: run.size,
                  fontWeight: run.bold ? 700 : 400,
                  fontStyle: run.italic ? "italic" : undefined,
                  textDecoration: run.underline ? "underline" : undefined,
                  color: run.color,
                  fontFamily: run.font ? `"${run.font}", ${FALLBACK}` : FALLBACK,
                }}
              >
                {run.text}
              </span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Drawn({ item, urls, label }: { item: Item; urls: Urls; label(what: string): string }) {
  if (item.type === "image") {
    const [l, t, r, b] = item.crop;
    const src = urls[item.image];
    return (
      <div style={{ ...placed(item.box), overflow: "hidden" }}>
        {src && (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              width: `${100 / (1 - l - r)}%`,
              height: `${100 / (1 - t - b)}%`,
              left: `${(-l * 100) / (1 - l - r)}%`,
              top: `${(-t * 100) / (1 - t - b)}%`,
              maxWidth: "none",
              transform: flipped(item.box),
            }}
          />
        )}
      </div>
    );
  }
  if (item.type === "chart")
    return (
      <div style={placed(item.box)}>
        <ChartView chart={item.chart} w={item.box.w} h={item.box.h} />
      </div>
    );
  if (item.type === "other")
    return (
      <div
        style={{
          ...placed(item.box),
          display: "grid",
          placeItems: "center",
          border: "1px dashed rgba(128,128,128,0.6)",
          background: "rgba(128,128,128,0.08)",
          color: "rgb(110,110,115)",
          fontFamily: FALLBACK,
          fontSize: 14,
          textAlign: "center",
          overflow: "hidden",
        }}
      >
        {label(item.what)}
      </div>
    );
  if (item.type === "table") {
    const total = item.columns.reduce((sum, w) => sum + w, 0) || 1;
    return (
      <table
        style={{
          ...placed(item.box),
          height: undefined,
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          {item.columns.map((w, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the columns of a table never reorder
            <col key={index} style={{ width: `${(w / total) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {item.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows of a table never reorder
            <tr key={r} style={{ height: row.height }}>
              {row.cells.map((cell, c) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: the cells of a row never reorder
                  key={c}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  style={{
                    padding: 0,
                    borderLeft: cell.borders[0] ?? "none",
                    borderTop: cell.borders[1] ?? "none",
                    borderRight: cell.borders[2] ?? "none",
                    borderBottom: cell.borders[3] ?? "none",
                    background: cell.fill ?? undefined,
                    verticalAlign: "middle",
                  }}
                >
                  {cell.text && <Text body={cell.text} flow />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const { box, geometry } = item;
  const line = item.line;
  let shape: ReactNode = null;
  if (LINES.has(geometry)) {
    shape = line && (
      <svg
        aria-hidden="true"
        width={Math.max(box.w, 1)}
        height={Math.max(box.h, 1)}
        style={{ position: "absolute", overflow: "visible", transform: flipped(box) }}
      >
        <line x1={0} y1={0} x2={box.w} y2={box.h} stroke={line.color} strokeWidth={line.width} />
      </svg>
    );
  } else if (geometry === "path" && item.path) {
    const fill = item.fill && "css" in item.fill && !item.fill.css.includes("gradient");
    shape = (
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${item.path.w} ${item.path.h}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
          transform: flipped(box),
        }}
      >
        <path
          d={item.path.d}
          fill={fill && item.fill && "css" in item.fill ? item.fill.css : "none"}
          stroke={line?.color ?? "none"}
          strokeWidth={line?.width}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  } else {
    const polygon = POLYGON[geometry];
    shape = (
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxSizing: "border-box",
          ...background(item.fill, urls),
          border: line && !polygon ? `${line.width}px solid ${line.color}` : undefined,
          borderRadius: geometry === "ellipse" ? "50%" : item.radius || undefined,
          clipPath: polygon ? `polygon(${polygon})` : undefined,
          transform: flipped(box),
        }}
      />
    );
  }
  return (
    <div style={placed(box)}>
      {shape}
      {item.text && <Text body={item.text} />}
    </div>
  );
}

/** One slide, drawn at its own size and scaled to the width it is given. */
function SlideFrame({
  deck,
  slide,
  urls,
  width,
  label,
}: {
  deck: Deck;
  slide: Slide;
  urls: Urls;
  width: number;
  label(what: string): string;
}) {
  const scale = width / deck.width;
  return (
    <div
      style={{ width, height: deck.height * scale }}
      className="relative shrink-0 overflow-hidden bg-white shadow-md"
    >
      <div
        style={{
          width: deck.width,
          height: deck.height,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          position: "absolute",
          overflow: "hidden",
          color: "#000",
          ...background(slide.background, urls),
        }}
      >
        {slide.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the shapes of a slide never reorder
          <Drawn key={index} item={item} urls={urls} label={label} />
        ))}
      </div>
    </div>
  );
}

/** Draws what it holds once it has come into view; until then it only keeps its place. */
function WhenSeen({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true),
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return (
    <span ref={box} className="block bg-white" style={{ width, height }}>
      {seen && children}
    </span>
  );
}

/**
 * A presentation shown as its slides, drawn in the browser from the file itself: every
 * slide at its own size with its backgrounds, shapes, text, pictures and tables, the
 * slides in a rail on the left as in a presentation program. Nothing in the file runs:
 * its text is placed as text and its pictures as pictures.
 */
/** Reads a deck from the person's file, away from the page. Null when it cannot be read. */
function readDeck(id: string): { deck: Promise<Deck | null>; stop(): void } {
  let worker: Worker | undefined;
  const deck = (async () => {
    try {
      const response = await fetch(fileUrl(id), { credentials: "same-origin" });
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      return await new Promise<Deck | null>((done) => {
        worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
        const giveUp = setTimeout(() => done(null), READ_SECONDS * 1000);
        worker.onmessage = (event: MessageEvent<{ deck: Deck | null }>) => {
          clearTimeout(giveUp);
          done(event.data.deck);
        };
        worker.onerror = () => {
          clearTimeout(giveUp);
          done(null);
        };
        worker.postMessage(bytes, [bytes]);
      });
    } catch {
      return null;
    } finally {
      worker?.terminate();
    }
  })();
  return { deck, stop: () => worker?.terminate() };
}

/** The deck's pictures as addresses the page can show; let go when the deck is. */
function usePictures(deck: Deck | null): Urls {
  const [urls, setUrls] = useState<Urls>({});
  useEffect(() => {
    const made: Urls = Object.create(null);
    for (const [path, bytes] of Object.entries(deck?.media ?? {})) {
      const ending = path.toLowerCase().split(".").pop() ?? "";
      if (Object.hasOwn(MIME, ending))
        made[path] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ending] }));
    }
    setUrls(made);
    return () => {
      for (const url of Object.values(made)) URL.revokeObjectURL(url);
    };
  }, [deck]);
  return urls;
}

/**
 * A deck's first slide at a given width, for a card that shows what was made. `seen`
 * changes when the file does (its version), so the slide is read again.
 */
/** Decks read for a card, by file and version, so the same file in several replies is read once. */
const firsts = new Map<string, Promise<Deck | null>>();
const KEPT = 8;
function firstOf(id: string, seen: number): Promise<Deck | null> {
  const key = `${id}:${seen}`;
  const kept = firsts.get(key);
  if (kept) return kept;
  // Only what a first slide needs is kept: the other slides are let go.
  const read = readDeck(id).deck.then((deck) =>
    deck ? { ...deck, slides: deck.slides.slice(0, 1), count: deck.slides.length } : null,
  );
  firsts.set(key, read);
  // The oldest is forgotten once there are many.
  if (firsts.size > KEPT) firsts.delete(firsts.keys().next().value as string);
  return read;
}

/**
 * A deck's first slide at a given width, for a card that shows what was made. `seen` is
 * the file's version, so a changed file is read again. `onFail` is told when it cannot
 * be read.
 */
export function FirstSlide({
  id,
  seen,
  width,
  onCount,
  onFail,
}: {
  id: string;
  seen: number;
  width: number;
  /** Told how many slides the deck has, once it is read. */
  onCount?: (slides: number) => void;
  onFail?: () => void;
}) {
  const { t } = useI18n();
  const v = t.files.view;
  const [deck, setDeck] = useState<Deck | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the file's version changes
  useEffect(() => {
    let live = true;
    void firstOf(id, seen).then((read) => {
      if (!live) return;
      if (!read) return onFail?.();
      setDeck(read);
      onCount?.((read as Deck & { count?: number }).count ?? read.slides.length);
    });
    return () => {
      live = false;
    };
  }, [id, seen]);
  const urls = usePictures(deck);
  const slide = deck?.slides[0];
  if (!deck || !slide)
    return <div style={{ width, height: (width * 9) / 16 }} className="bg-foreground/5" />;
  return (
    <SlideFrame
      deck={deck}
      slide={slide}
      urls={urls}
      width={width}
      label={(what) => v.notDrawn[what as keyof typeof v.notDrawn] ?? what}
    />
  );
}

export function SlidesView({ id }: { id: string }) {
  const { t } = useI18n();
  const v = t.files.view;
  const [deck, setDeck] = useState<Deck | null>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [width, setWidth] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setDeck(null);
    setFailed(false);
    setCurrent(0);
    const reading = readDeck(id);
    void reading.deck.then((read) => {
      if (!live) return;
      if (read) setDeck(read);
      else setFailed(true);
    });
    return () => {
      live = false;
      reading.stop();
    };
  }, [id]);

  const urls = usePictures(deck);

  const ratio = deck ? deck.height / deck.width : 9 / 16;
  useEffect(() => {
    const element = stage.current;
    // The stage exists once the file has been read.
    if (!element || !deck) return;
    // As large as fits: the whole slide is always in view.
    const measure = () =>
      setWidth(
        Math.max(
          0,
          Math.floor(Math.min(element.clientWidth - 32, (element.clientHeight - 32) / ratio)),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ratio, deck]);

  const count = deck?.slides.length ?? 0;
  const go = (to: number) => {
    const next = Math.min(count - 1, Math.max(0, to));
    setCurrent(next);
    rail.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };
  const label = (what: string) => v.notDrawn[what as keyof typeof v.notDrawn] ?? what;

  if (failed) return <Notice tone="bad">{v.failed}</Notice>;
  if (!deck) return <Loading />;
  const slide = deck.slides[current] as Slide;
  return (
    <section
      className="flex h-full bg-muted/60 outline-none"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys move between slides, as in a presentation program
      tabIndex={0}
      aria-label={v.slideOf(current + 1, count)}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) go(current + 1);
        else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) go(current - 1);
        else if (event.key === "Home") go(0);
        else if (event.key === "End") go(count - 1);
        else return;
        event.preventDefault();
      }}
    >
      <div ref={rail} className="w-44 shrink-0 space-y-2 overflow-y-auto border-r p-2">
        {deck.slides.map((item, index) => (
          <button
            type="button"
            // biome-ignore lint/suspicious/noArrayIndexKey: the slides of one file never reorder
            key={index}
            onClick={() => go(index)}
            aria-current={index === current}
            aria-label={v.slideOf(index + 1, count)}
            className="flex w-full items-start gap-1.5 text-left"
          >
            <span className="w-5 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span
              className={cn(
                "block rounded-sm ring-2 ring-offset-1 ring-offset-transparent",
                index === current ? "ring-primary" : "ring-transparent hover:ring-foreground/20",
              )}
            >
              <WhenSeen width={136} height={(136 * deck.height) / deck.width}>
                <SlideFrame deck={deck} slide={item} urls={urls} width={136} label={label} />
              </WhenSeen>
            </span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={stage} className="grid min-h-0 flex-1 place-items-center overflow-hidden">
          {width > 0 && (
            <SlideFrame deck={deck} slide={slide} urls={urls} width={width} label={label} />
          )}
        </div>
        {slide.notes && (
          <div className="max-h-28 shrink-0 overflow-y-auto border-t px-4 py-2 text-xs whitespace-pre-wrap">
            <span className="mr-2 font-medium text-muted-foreground">{v.notes}</span>
            {slide.notes}
          </div>
        )}
        <p className="shrink-0 border-t py-1 text-center text-[11px] text-muted-foreground tabular-nums">
          {v.slideOf(current + 1, count)}
        </p>
      </div>
    </section>
  );
}
