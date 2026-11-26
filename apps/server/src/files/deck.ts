/**
 * What an agent hands over to have a presentation made. The agent says what each slide
 * is for and gives its content; how it looks is decided here, so every deck comes out
 * designed: a cover, section breaks, a consistent grid, real charts and tables, a footer
 * with page numbers.
 */
import type { Cover } from "./document.js";
import { hasSquare, linesOf, textWide } from "./measure.js";

export type Bullet = string | { text: string; sub?: string[] };
export interface SlideRecipe {
  /**
   * cover, section, bullets, columns, stats, table, chart, quote, steps or closing.
   * Left out, it follows from what the slide holds.
   */
  layout?: string;
  title: string;
  subtitle?: string;
  bullets?: Bullet[];
  /** Two to four blocks side by side: options, pillars, before and after. */
  columns?: { heading: string; bullets?: string[]; text?: string }[];
  /** Two to four headline numbers. */
  stats?: { value: string; label: string; note?: string }[];
  table?: { headers: string[]; rows: (string | number | null)[][] };
  chart?: {
    type?: string;
    categories: string[];
    series: { name: string; values: number[] }[];
    /** How values are written: "0", "0.0", "0%", "$0", "¥0.0". */
    format?: string;
  };
  quote?: { text: string; by?: string };
  /** Three to six steps in order: a plan, a process, a timeline. */
  steps?: { title: string; text?: string }[];
  /** The one line the audience should leave with, set apart at the bottom. */
  takeaway?: string;
  notes?: string;
}

export class BadDeck extends Error {}

interface Theme {
  /** Cover, section and closing background. */
  dark: string;
  accent: string;
  /** A lighter companion of the accent, for second series and soft fills. */
  soft: string;
  /** Chart series after the first two. */
  more: string[];
}
const THEMES: Record<string, Theme> = {
  ink: {
    dark: "0B1F3A",
    accent: "2F6BFF",
    soft: "DCE7FF",
    more: ["12B5A5", "F59E0B", "8B5CF6", "EF4444"],
  },
  ember: {
    dark: "1F2328",
    accent: "FF7F41",
    soft: "FFE6D9",
    more: ["2F6BFF", "12B5A5", "8B5CF6", "E5484D"],
  },
  forest: {
    dark: "0F2A22",
    accent: "17A673",
    soft: "D7F2E6",
    more: ["2F6BFF", "F59E0B", "8B5CF6", "EF4444"],
  },
  plum: {
    dark: "241538",
    accent: "8B5CF6",
    soft: "E9E0FF",
    more: ["EC4899", "12B5A5", "F59E0B", "2F6BFF"],
  },
};
const INK = "14181F";
const MUTED = "5B6472";
const FAINT = "8A93A0";
const RULE = "D9DCE1";
const WHITE = "FFFFFF";

// The slide is 13.33 by 7.5 inches. Everything sits on one grid, flat on the page: no
// cards, no tinted panels, no bars of colour. What sets things apart is space, a hairline
// and the size and weight of the type.
const W = 13.333;
const LEFT = 0.75;
const WIDE = W - LEFT * 2;
/** Where a slide's title begins, and where its content must end. */
const HEAD = 0.6;
const BOTTOM = 6.7;
/** Running text is never wider than this: a line across the whole slide is hard to read. */
const MEASURE = 9.6;

const SLIDE_LIMIT = 60;

type Pptx = import("pptxgenjs").default;
type Slide = ReturnType<Pptx["addSlide"]>;
type TextRun = Extract<Parameters<Slide["addText"]>[0], unknown[]>[number];
type TextOptions = NonNullable<TextRun["options"]>;
type TableCell = Parameters<Slide["addTable"]>[0][number][number];
type TableCellProps = NonNullable<TableCell["options"]>;
interface Kit {
  pptx: Pptx;
  theme: Theme;
  font: string;
  /** The deck holds Chinese, Japanese or Korean, and is set in a font that has them. */
  square: boolean;
  /** How tall a line of this font stands, in parts of its size, with a little to spare. */
  line: number;
}

// A line break inside a text is taken out: every text here is one paragraph, measured
// as one, and a break would begin another with space and a bullet of its own.
const str = (value: unknown) =>
  (typeof value === "string" ? value : value == null ? "" : String(value))
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
const list = <T>(value: T[] | undefined, most: number): T[] =>
  Array.isArray(value) ? value.slice(0, most) : [];

/** A line as runs, with **bold** kept. */
function runs(line: string, options: TextOptions = {}): TextRun[] {
  return line
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? { text: part.slice(2, -2), options: { ...options, bold: true } }
        : { text: part, options },
    );
}
/** A text without the marks of its bold. */
const bare = (text: string) => text.replace(/\*\*/g, "");
/**
 * How tall a text stands in a box so many inches wide, measured from the widths of its
 * letters. A text with any bold in it is measured as bold, which is the wider.
 */
function tallOf(kit: Kit, text: string, size: number, wide: number, bold = false, spacing = 1) {
  const counted = linesOf(bare(text), size, wide, bold || text.includes("**"), kit.square);
  // A long text is given a line to spare, and a very long one two: measured against a
  // program that sets the file, the count was a line short once in four hundred, always
  // on a text of many lines with long unbreakable words.
  const lines = counted + (counted >= 8 ? 2 : counted >= 3 ? 1 : 0);
  return (lines * size * kit.line * spacing) / 72;
}
/** The largest of these sizes at which a text takes this many lines at most, or the smallest. */
function sizeFor(kit: Kit, text: string, wide: number, sizes: number[], most: number, bold = true) {
  return (
    sizes.find((size) => linesOf(bare(text), size, wide, bold, kit.square) <= most) ??
    (sizes[sizes.length - 1] as number)
  );
}
/** What is said when a slide holds more than can be set without one thing standing on another. */
const tooMuch = (title: string) =>
  `Slide "${title}" holds more text than fits on it: give fewer or shorter points, move detail to the notes, or use two slides.`;

/**
 * The title and what stands under it. Returns where the content begins. With no slide it
 * only measures.
 */
function titleOf(kit: Kit, slide: Slide | null, item: SlideRecipe): number {
  const title = str(item.title);
  const size = sizeFor(kit, title, WIDE, [30, 26, 24], 2);
  const tall = tallOf(kit, title, size, WIDE, true);
  slide?.addText(runs(title), {
    x: LEFT,
    y: HEAD,
    w: WIDE,
    h: tall,
    fontFace: kit.font,
    fontSize: size,
    bold: true,
    color: INK,
    valign: "top",
    margin: 0,
  });
  let y = HEAD + tall;
  const subtitle = str(item.subtitle);
  if (subtitle) {
    const under = tallOf(kit, subtitle, 16, WIDE);
    slide?.addText(runs(subtitle), {
      x: LEFT,
      y: y + 0.08,
      w: WIDE,
      h: under,
      fontFace: kit.font,
      fontSize: 16,
      color: MUTED,
      valign: "top",
      margin: 0,
    });
    y += 0.08 + under;
  }
  return y + 0.35;
}

/** The page's number and nothing else: a footer is not a second place to write. */
function footer(kit: Kit, slide: Slide, number: number) {
  slide.addText(String(number), {
    x: W - LEFT - 1,
    y: 6.95,
    w: 1,
    h: 0.3,
    fontFace: kit.font,
    fontSize: 10,
    color: FAINT,
    align: "right",
    valign: "middle",
    margin: 0,
  });
}

/**
 * The line to leave with, under a hairline at the foot of the content. Returns where
 * content must now end. With no slide it only measures.
 */
function takeaway(kit: Kit, slide: Slide | null, item: SlideRecipe): number {
  const text = str(item.takeaway);
  if (!text) return BOTTOM;
  const size = sizeFor(kit, text, WIDE, [18, 16], 2);
  const tall = tallOf(kit, text, size, WIDE, true);
  const y = BOTTOM - tall - 0.18;
  slide?.addShape("line", { x: LEFT, y, w: WIDE, h: 0, line: { color: RULE, width: 0.75 } });
  slide?.addText(runs(text), {
    x: LEFT,
    y: y + 0.18,
    w: WIDE,
    h: tall,
    fontFace: kit.font,
    fontSize: size,
    bold: true,
    color: INK,
    valign: "top",
    margin: 0,
  });
  return y - 0.3;
}

/** Between the lines of a list. */
const LIST_SPACING = 1.15;
function bulletRuns(bullets: Bullet[], size: number): TextRun[] {
  const out: TextRun[] = [];
  for (const bullet of bullets) {
    const text = str(typeof bullet === "string" ? bullet : bullet?.text);
    if (!text) continue;
    const parts = runs(text, { fontSize: size, color: INK });
    const last = parts.length - 1;
    parts.forEach((part, index) => {
      part.options = {
        ...part.options,
        ...(index === 0
          ? { bullet: { characterCode: "2022", indent: size * 1.1 }, paraSpaceBefore: size * 0.6 }
          : {}),
        ...(index === last ? { breakLine: true } : {}),
      };
    });
    // The bullet belongs to the paragraph; the library takes it from the paragraph's first run.
    out.push(...parts);
    if (typeof bullet !== "string")
      for (const sub of list(bullet.sub, 6)) {
        const line = str(sub);
        if (line)
          out.push({
            text: line,
            options: {
              bullet: { characterCode: "2013", indent: size * 0.9 },
              indentLevel: 1,
              fontSize: size - 2,
              color: MUTED,
              paraSpaceBefore: size * 0.25,
              breakLine: true,
            },
          });
      }
  }
  return out;
}
/** How tall a list stands at a size, in inches: every line of every point, and the space before each. */
function listTall(kit: Kit, bullets: Bullet[], wide: number, size: number): number {
  let tall = 0;
  for (const bullet of bullets) {
    const text = str(typeof bullet === "string" ? bullet : bullet?.text);
    if (!text) continue;
    tall +=
      (size * 0.6) / 72 + tallOf(kit, text, size, wide - (size * 1.1) / 72, false, LIST_SPACING);
    if (typeof bullet !== "string")
      for (const sub of list(bullet.sub, 6)) {
        const line = str(sub);
        // A point under a point is set in by twice its own indent.
        if (line)
          tall +=
            (size * 0.25) / 72 +
            tallOf(kit, line, size - 2, wide - (size * 1.8) / 72, false, LIST_SPACING);
      }
  }
  return tall;
}
/** The largest of these sizes at which a list fits the room given, or none. */
const listSize = (kit: Kit, items: Bullet[], wide: number, room: number, sizes: number[]) =>
  sizes.find((size) => listTall(kit, items, wide, size) <= room);
/** A list at the largest size at which it fits; refused when it fits at none. */
function bullets(
  kit: Kit,
  slide: Slide,
  items: Bullet[],
  x: number,
  y: number,
  w: number,
  room: number,
  sizes: number[],
  title: string,
) {
  if (!items.length) return;
  const size = listSize(kit, items, w, room, sizes);
  if (!size) throw new BadDeck(tooMuch(title));
  slide.addText(bulletRuns(items, size), {
    x,
    y,
    w,
    h: room,
    fontFace: kit.font,
    valign: "top",
    margin: 0,
    lineSpacingMultiple: LIST_SPACING,
  });
}

const CHARTS: Record<string, "bar" | "line" | "pie" | "doughnut" | "area"> = {
  bar: "bar",
  column: "bar",
  line: "line",
  pie: "pie",
  doughnut: "doughnut",
  donut: "doughnut",
  area: "area",
};
function chart(
  kit: Kit,
  slide: Slide,
  spec: NonNullable<SlideRecipe["chart"]>,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const categories = list(spec.categories, 24).map(str);
  const series = list(spec.series, 6)
    .map((one) => ({
      name: str(one?.name) || " ",
      labels: categories,
      values: categories.map((_, index) => {
        const value = Number(one?.values?.[index]);
        return Number.isFinite(value) ? value : 0;
      }),
    }))
    .filter((one) => one.values.length);
  if (!categories.length || !series.length)
    throw new BadDeck("A chart needs categories and at least one series of numbers.");
  const type = CHARTS[str(spec.type).toLowerCase()] ?? "bar";
  const round = type === "pie" || type === "doughnut";
  const colors = [kit.theme.accent, kit.theme.dark, ...kit.theme.more];
  const format = /^[^\s"]{1,12}$/.test(str(spec.format)) ? str(spec.format) : "General";
  const used = round ? [series[0] as (typeof series)[number]] : series;
  slide.addChart(type, used, {
    x,
    y,
    w,
    h,
    chartColors: round
      ? colors.slice(0, Math.max(1, categories.length))
      : colors.slice(0, used.length),
    showLegend: round || used.length > 1,
    legendPos: "t",
    legendFontFace: kit.font,
    legendFontSize: 12,
    legendColor: MUTED,
    showValue: !round && categories.length * used.length <= 16,
    showPercent: round,
    dataLabelFormatCode: round ? "0%" : format,
    dataLabelFontFace: kit.font,
    dataLabelFontSize: 11,
    dataLabelColor: round ? WHITE : INK,
    dataLabelPosition: round ? "bestFit" : type === "bar" ? "outEnd" : "t",
    catAxisLabelFontFace: kit.font,
    catAxisLabelFontSize: 12,
    catAxisLabelColor: MUTED,
    catAxisLineShow: true,
    valAxisLabelFontFace: kit.font,
    valAxisLabelFontSize: 11,
    valAxisLabelColor: FAINT,
    valAxisLabelFormatCode: format,
    valAxisLineShow: false,
    valGridLine: { color: RULE, size: 0.75 },
    catGridLine: { style: "none" },
    barGapWidthPct: 60,
    holeSize: 58,
    lineSize: 2.5,
    lineDataSymbol: "circle",
    lineDataSymbolSize: 7,
  });
}

const numeric = (value: unknown) =>
  typeof value === "number" ||
  (typeof value === "string" && /^[\s$¥€£+-]*[\d,.]+\s*[%kKmMbB万亿]?\s*$/.test(value));
const TOTAL_ROW = /^\s*(total|grand total|subtotal|sum|合计|总计|小计)(?![a-z])/i;
interface TablePlan {
  headers: string[];
  size: number;
  pad: number;
  widths: number[];
  right: boolean[];
  headTall: number;
  /** The rows of each slide the table runs over, with how tall each stands. */
  pages: { rows: (string | number | null)[][]; talls: number[] }[];
}
/**
 * Where a table's columns and rows go, and over how many slides. A column is as wide as
 * what it holds; a row is as tall as its longest cell needs at that width; a slide holds
 * the rows that fit under the header.
 */
function planTable(
  kit: Kit,
  spec: NonNullable<SlideRecipe["table"]>,
  room: number,
  title: string,
): TablePlan {
  const headers = list(spec.headers, 8).map(str);
  const body = (Array.isArray(spec.rows) ? spec.rows : []).map((row) =>
    Array.isArray(row) ? row : [],
  );
  // A table of many columns is set smaller and tighter before any column is made
  // narrower than what it holds, which would break a word or a figure in two.
  const looks = [
    { size: body.length > 8 ? 14 : 16, pad: 0.2 },
    { size: 14, pad: 0.16 },
    { size: 12, pad: 0.12 },
    { size: 11, pad: 0.09 },
  ];
  // No column asks for more than this of its own accord: a long cell wraps.
  const most = 4.2;
  const natural = (look: { size: number; pad: number }) =>
    headers.map(
      (header, column) =>
        Math.min(
          most,
          Math.max(
            0.7,
            textWide(header, look.size, true, kit.square),
            ...body.map((row) =>
              textWide(str(row[column]), look.size, TOTAL_ROW.test(str(row[0])), kit.square),
            ),
          ),
        ) +
        look.pad * 2 +
        0.05,
    );
  const look =
    looks.find((one) => natural(one).reduce((sum, w) => sum + w, 0) <= WIDE) ??
    (looks[looks.length - 1] as (typeof looks)[number]);
  const asked = natural(look);
  // A column that was held to the most and so wraps takes what room the slide has left.
  const wants = headers.map(
    (header, column) =>
      Math.max(
        textWide(header, look.size, true, kit.square),
        ...body.map((row) => textWide(str(row[column]), look.size, false, kit.square)),
      ) +
      look.pad * 2 +
      0.05,
  );
  let spare = WIDE - asked.reduce((all, one) => all + one, 0);
  for (const [column, want] of wants.entries()) {
    const more = Math.min(spare, want - (asked[column] as number));
    if (more > 0) {
      asked[column] = (asked[column] as number) + more;
      spare -= more;
    }
  }
  const sum = asked.reduce((all, one) => all + one, 0);
  const whole = Math.min(WIDE, Math.max(sum, WIDE * 0.6));
  const widths = asked.map((one) => (one / sum) * whole);
  const cellTall = (text: string, column: number, bold: boolean) =>
    tallOf(kit, text, look.size, (widths[column] as number) - look.pad * 2, bold) + 0.2;
  const least = look.size >= 16 ? 0.52 : look.size >= 14 ? 0.46 : 0.4;
  const rowTall = (row: (string | number | null)[], bold: boolean) =>
    Math.max(least, ...headers.map((_, column) => cellTall(str(row[column]), column, bold)));
  const headTall = rowTall(headers, true);
  const pages: TablePlan["pages"] = [{ rows: [], talls: [] }];
  let used = headTall;
  for (const row of body) {
    const tall = rowTall(row, TOTAL_ROW.test(str(row[0])));
    if (headTall + tall > room) throw new BadDeck(tooMuch(title));
    let page = pages[pages.length - 1] as TablePlan["pages"][number];
    if (used + tall > room && page.rows.length) {
      page = { rows: [], talls: [] };
      pages.push(page);
      used = headTall;
    }
    page.rows.push(row);
    page.talls.push(tall);
    used += tall;
  }
  return {
    headers,
    size: look.size,
    pad: look.pad,
    widths,
    right: headers.map(
      (_, column) =>
        column > 0 &&
        body.length > 0 &&
        body.every((row) => row[column] == null || numeric(row[column])),
    ),
    headTall,
    pages,
  };
}
function table(kit: Kit, slide: Slide, plan: TablePlan, part: number, y: number) {
  const columns = plan.headers.length;
  const page = plan.pages[part] as TablePlan["pages"][number];
  const hair = { type: "solid" as const, color: RULE, pt: 0.75 };
  const firm = { type: "solid" as const, color: INK, pt: 1 };
  const no = { type: "none" as const };
  const cell = (text: string, column: number, options: TableCellProps): TableCell => ({
    text,
    options: {
      fontFace: kit.font,
      fontSize: plan.size,
      color: INK,
      valign: "middle",
      align: plan.right[column] ? "right" : "left",
      // In inches, as the library reads a table's margins whenever the first is under 1:
      // given in points with a top of 0, each cell got ten inches of margin and its text
      // stood one letter to a line. The first and last columns stand on the grid's edges.
      margin: [0, column === columns - 1 ? 0 : plan.pad, 0, column === 0 ? 0 : plan.pad],
      ...options,
    },
  });
  slide.addTable(
    [
      plan.headers.map((text, column) =>
        cell(text, column, { bold: true, border: [no, no, firm, no] }),
      ),
      ...page.rows.map((row) => {
        const total = TOTAL_ROW.test(str(row[0]));
        return Array.from({ length: columns }, (_, column) =>
          cell(str(row[column]), column, {
            bold: total,
            border: [total ? firm : no, no, total ? no : hair, no],
          }),
        );
      }),
    ],
    {
      x: LEFT,
      y,
      w: plan.widths.reduce((all, one) => all + one, 0),
      colW: plan.widths,
      rowH: [plan.headTall, ...page.talls],
    },
  );
}

/** The first and last page: the deck's colour, the title, and nothing drawn. */
function cover(kit: Kit, slide: Slide, item: SlideRecipe, byline: string, closing: boolean) {
  slide.background = { color: kit.theme.dark };
  const title = str(item.title);
  const size = sizeFor(kit, title, MEASURE, [44, 38, 32, 28], 2);
  const tall = tallOf(kit, title, size, MEASURE, true);
  const subtitle = str(item.subtitle);
  const under = subtitle ? tallOf(kit, subtitle, 20, MEASURE) : 0;
  const lines = closing
    ? list(item.bullets, 3)
        .map((b) => str(typeof b === "string" ? b : b?.text))
        .filter(Boolean)
    : [byline].filter(Boolean);
  const foot = lines.reduce((sum, line) => sum + tallOf(kit, line, 14, MEASURE), 0);
  const footY = 6.9 - foot;
  // The title and its subtitle stand together a little above the middle, and always
  // clear of the lines at the foot.
  const block = tall + (subtitle ? 0.25 + under : 0);
  const y = Math.min(Math.max(1.2, 3.5 - tall - (subtitle ? 0.4 : 0)), footY - 0.4 - block);
  if (y < 0.5)
    throw new BadDeck(
      `The ${closing ? "closing slide" : "cover"} "${title}" holds more than fits: shorten its title and subtitle.`,
    );
  slide.addText(runs(title), {
    x: LEFT,
    y,
    w: MEASURE,
    h: tall,
    fontFace: kit.font,
    fontSize: size,
    bold: true,
    color: WHITE,
    valign: "top",
    margin: 0,
  });
  if (subtitle)
    slide.addText(runs(subtitle), {
      x: LEFT,
      y: y + tall + 0.25,
      w: MEASURE,
      h: under,
      fontFace: kit.font,
      fontSize: 20,
      color: "C9D2E0",
      valign: "top",
      margin: 0,
    });
  if (lines.length)
    slide.addText(
      lines.map((text, index) => ({
        text: bare(text),
        options: { breakLine: index < lines.length - 1 },
      })),
      {
        x: LEFT,
        y: footY,
        w: MEASURE,
        h: foot,
        fontFace: kit.font,
        fontSize: 14,
        color: "9AA7BA",
        valign: "top",
        margin: 0,
      },
    );
}

/** A page that opens a part of the deck: its name, large, on an empty page. */
function section(kit: Kit, slide: Slide, item: SlideRecipe) {
  slide.background = { color: WHITE };
  const title = str(item.title);
  const size = sizeFor(kit, title, MEASURE, [38, 32, 28], 2);
  const tall = tallOf(kit, title, size, MEASURE, true);
  const subtitle = str(item.subtitle);
  const under = subtitle ? tallOf(kit, subtitle, 18, MEASURE) : 0;
  const block = tall + (subtitle ? 0.2 + under : 0);
  const y = Math.min(3.6 - tall, 6.6 - block);
  if (y < 0.5) throw new BadDeck(tooMuch(title));
  slide.addText(runs(title), {
    x: LEFT,
    y,
    w: MEASURE,
    h: tall,
    fontFace: kit.font,
    fontSize: size,
    bold: true,
    color: INK,
    valign: "top",
    margin: 0,
  });
  if (subtitle)
    slide.addText(runs(subtitle), {
      x: LEFT,
      y: y + tall + 0.2,
      w: MEASURE,
      h: under,
      fontFace: kit.font,
      fontSize: 18,
      color: MUTED,
      valign: "top",
      margin: 0,
    });
}

/**
 * Headline numbers, side by side under a hairline each: what it is, the number, a note.
 * `small` is for a slide that holds more under them. Every line of the three is measured,
 * and the next begins under the tallest of the one before. Returns how tall they stand.
 */
function stats(
  kit: Kit,
  slide: Slide | null,
  items: NonNullable<SlideRecipe["stats"]>,
  y: number,
  small: boolean,
) {
  const gap = 0.5;
  const w = (WIDE - gap * (items.length - 1)) / items.length;
  // One size for every number on the slide: the largest at which the longest is one line.
  const sizes = small ? [36, 30, 26, 22] : [54, 48, 40, 34, 28, 24];
  const big =
    sizes.find((size) =>
      items.every((item) => linesOf(str(item.value), size, w, true, kit.square) === 1),
    ) ?? (sizes[sizes.length - 1] as number);
  const text = small ? 14 : 16;
  const most = (pick: (item: (typeof items)[number]) => string, size: number, bold = false) =>
    Math.max(0, ...items.map((item) => (pick(item) ? tallOf(kit, pick(item), size, w, bold) : 0)));
  const labelTall = most((item) => str(item.label), text);
  const valueTall = most((item) => str(item.value), big, true);
  const noteTall = most((item) => str(item.note), text);
  const valueY = y + 0.2 + labelTall + 0.08;
  const noteY = valueY + valueTall + 0.08;
  const tall = (noteTall ? noteY + noteTall : valueY + valueTall) - y;
  // With no slide it only measures.
  if (!slide) return tall;
  items.forEach((item, index) => {
    const x = LEFT + index * (w + gap);
    slide.addShape("line", { x, y, w, h: 0, line: { color: RULE, width: 0.75 } });
    if (str(item.label))
      slide.addText(runs(str(item.label)), {
        x,
        y: y + 0.2,
        w,
        h: labelTall,
        fontFace: kit.font,
        fontSize: text,
        color: MUTED,
        valign: "top",
        margin: 0,
      });
    slide.addText(runs(str(item.value)), {
      x,
      y: valueY,
      w,
      h: valueTall,
      fontFace: kit.font,
      fontSize: big,
      bold: true,
      color: INK,
      valign: "top",
      margin: 0,
    });
    if (str(item.note))
      slide.addText(runs(str(item.note)), {
        x,
        y: noteY,
        w,
        h: noteTall,
        fontFace: kit.font,
        fontSize: text,
        color: MUTED,
        valign: "top",
        margin: 0,
      });
  });
  return tall;
}

/** Blocks side by side: a heading over a hairline, then what belongs to it. */
function columns(
  kit: Kit,
  slide: Slide,
  items: NonNullable<SlideRecipe["columns"]>,
  y: number,
  room: number,
  title: string,
) {
  const gap = 0.6;
  const w = (WIDE - gap * (items.length - 1)) / items.length;
  // The headings are one size and one height, so the hairlines under them line up.
  const size = Math.min(
    ...items.map((item) => sizeFor(kit, str(item.heading), w, [22, 20, 18], 2)),
  );
  const tall = Math.max(...items.map((item) => tallOf(kit, str(item.heading), size, w, true)));
  const top = y + tall + 0.3;
  const under = room - tall - 0.3;
  // One size of text across the columns: the largest at which the fullest column fits.
  const held = items.map((item) => ({
    lines: list(item.bullets, 8).map(str).filter(Boolean),
    text: str(item.text),
  }));
  const body = [18, 16, 14].find((one) =>
    held.every((column) =>
      column.lines.length
        ? listTall(kit, column.lines, w, one) <= under
        : !column.text || tallOf(kit, column.text, one, w, false, 1.2) + 0.1 <= under,
    ),
  );
  // Better said than drawn off the page: the agent can shorten or split.
  if (!body)
    throw new BadDeck(
      `The columns of slide "${title}" hold more than fits: give each column fewer or shorter points, or put the columns on two slides.`,
    );
  items.forEach((item, index) => {
    const x = LEFT + index * (w + gap);
    slide.addText(runs(str(item.heading)), {
      x,
      y,
      w,
      h: tall,
      fontFace: kit.font,
      fontSize: size,
      bold: true,
      color: INK,
      valign: "bottom",
      margin: 0,
    });
    slide.addShape("line", {
      x,
      y: y + tall + 0.14,
      w,
      h: 0,
      line: { color: RULE, width: 0.75 },
    });
    const column = held[index] as (typeof held)[number];
    if (column.lines.length)
      slide.addText(bulletRuns(column.lines, body), {
        x,
        y: top,
        w,
        h: under,
        fontFace: kit.font,
        valign: "top",
        margin: 0,
        lineSpacingMultiple: LIST_SPACING,
      });
    else if (column.text)
      slide.addText(runs(column.text), {
        x,
        y: top + 0.1,
        w,
        h: under - 0.1,
        fontFace: kit.font,
        fontSize: body,
        color: INK,
        valign: "top",
        margin: 0,
        lineSpacingMultiple: 1.2,
      });
  });
}

/** Steps in order, left to right: a number, what the step is, and a line about it. */
function steps(
  kit: Kit,
  slide: Slide,
  items: NonNullable<SlideRecipe["steps"]>,
  y: number,
  room: number,
  title: string,
) {
  const gap = 0.45;
  const w = (WIDE - gap * (items.length - 1)) / items.length;
  const many = items.length > 4;
  // A step's name is as large as lets its longest word stand on one line.
  const longest = (size: number) =>
    Math.max(
      0,
      ...items.flatMap((item) =>
        str(item.title)
          // Chinese breaks between any two characters: only a run of the rest is a word.
          .replace(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g, " ")
          .split(/\s+/)
          .map((word) => textWide(word, size, true, kit.square)),
      ),
    );
  const head =
    (many ? [16, 14, 12] : [20, 18, 16, 14, 12]).find((size) => longest(size) <= w * 0.97) ?? 12;
  const numeral = many ? 26 : 32;
  const numeralTall = (numeral * kit.line) / 72;
  const headTall = Math.max(...items.map((item) => tallOf(kit, str(item.title), head, w, true)));
  const textY = y + 0.2 + numeralTall + 0.12 + headTall + 0.1;
  // The lines about the steps are one size: the largest at which the longest fits.
  const text = [16, 14, 13, 12]
    .filter((size) => size <= head)
    .find((size) =>
      items.every(
        (item) =>
          !str(item.text) || textY + tallOf(kit, str(item.text), size, w, false, 1.15) <= y + room,
      ),
    );
  if (!text || textY > y + room) throw new BadDeck(tooMuch(title));
  items.forEach((item, index) => {
    const x = LEFT + index * (w + gap);
    slide.addShape("line", { x, y, w, h: 0, line: { color: RULE, width: 0.75 } });
    slide.addText(String(index + 1), {
      x,
      y: y + 0.2,
      w,
      h: numeralTall,
      fontFace: kit.font,
      fontSize: numeral,
      bold: true,
      color: kit.theme.accent,
      valign: "top",
      margin: 0,
    });
    slide.addText(runs(str(item.title)), {
      x,
      y: y + 0.2 + numeralTall + 0.12,
      w,
      h: headTall,
      fontFace: kit.font,
      fontSize: head,
      bold: true,
      color: INK,
      valign: "top",
      margin: 0,
    });
    if (str(item.text))
      slide.addText(runs(str(item.text)), {
        x,
        y: textY,
        w,
        h: y + room - textY,
        fontFace: kit.font,
        fontSize: text,
        color: MUTED,
        valign: "top",
        margin: 0,
        lineSpacingMultiple: 1.15,
      });
  });
}

function quote(
  kit: Kit,
  slide: Slide,
  item: NonNullable<SlideRecipe["quote"]>,
  y: number,
  room: number,
  title: string,
) {
  const said = str(item.text);
  const text = /^["“「『]/.test(said) ? said : `“${said}”`;
  const by = str(item.by);
  const byTall = by ? 0.4 + tallOf(kit, by, 16, MEASURE) : 0;
  const size = [30, 24, 20, 18].find(
    (one) => tallOf(kit, text, one, MEASURE, false, 1.25) + byTall <= room,
  );
  if (!size) throw new BadDeck(tooMuch(title));
  const tall = tallOf(kit, text, size, MEASURE, false, 1.25);
  // A little above the middle of the room it has.
  const top = y + Math.max(0, (room - tall - byTall) * 0.35);
  slide.addText(runs(text), {
    x: LEFT,
    y: top,
    w: MEASURE,
    h: tall,
    fontFace: kit.font,
    fontSize: size,
    color: INK,
    valign: "top",
    margin: 0,
    lineSpacingMultiple: 1.25,
  });
  if (by)
    slide.addText(runs(by), {
      x: LEFT,
      y: top + tall + 0.4,
      w: MEASURE,
      h: byTall - 0.4,
      fontFace: kit.font,
      fontSize: 16,
      color: MUTED,
      valign: "top",
      margin: 0,
    });
}

/**
 * The pages of a deck as they are numbered in the file. A deck opens with a cover: when
 * the agent gave none, one is made from the deck's own title. A file's kept source holds
 * the pages as numbered here, so "slide 3" means the same to the person and to the agent.
 */
export function deckPages(deck: Cover | undefined, slides: SlideRecipe[]): SlideRecipe[] {
  const first = slides[0];
  if (!first || typeof first !== "object") return [...slides];
  const pages: SlideRecipe[] = [...slides];
  const bare = (item: SlideRecipe) =>
    !item.bullets?.length &&
    !item.table &&
    !item.chart &&
    !item.stats?.length &&
    !item.columns?.length &&
    !item.steps?.length &&
    !item.quote;
  // A first slide that is only a title is the cover itself.
  if (
    str(first.layout).toLowerCase() !== "cover" &&
    !(bare(first) && !str(first.layout)) &&
    (slides.length > 2 || str(deck?.title))
  )
    pages.unshift({
      layout: "cover",
      title: str(deck?.title) || str(first.title),
      subtitle: str(deck?.subtitle),
    });
  return pages;
}

/** Makes a presentation. Throws BadDeck with what is wrong when the recipe cannot become one. */
export async function makeDeck(
  deck: Cover | undefined,
  slides: SlideRecipe[],
  /** The slides are the pages exactly as kept: no cover is added. */
  exact = false,
): Promise<Uint8Array> {
  // A kept deck counts its cover among its pages; the limit is on what the agent wrote.
  const most = SLIDE_LIMIT + (exact ? 1 : 0);
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > most)
    throw new BadDeck(`A presentation has 1 to ${SLIDE_LIMIT} slides.`);
  // The package is published in the older module style; its class is the default export, sometimes nested once.
  const loaded = (await import("pptxgenjs")) as unknown as { default: unknown };
  const Pptx = ((loaded.default as { default?: unknown }).default ??
    loaded.default) as new () => Pptx;
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE";
  const first = slides[0] as SlideRecipe;
  const deckTitle = str(deck?.title) || str(first.title);
  pptx.title = deckTitle;
  const everything = JSON.stringify([deck, slides]);
  const kit: Kit = {
    pptx,
    theme: THEMES[str(deck?.theme).toLowerCase()] ?? (THEMES.ink as Theme),
    // One family through the whole deck. Where there is Chinese, one that has it on every computer.
    font: hasSquare(everything) ? "Microsoft YaHei" : "Arial",
    square: hasSquare(everything),
    // Arial's line is 1.15 of its size and a Chinese font's about 1.32 to 1.4.
    line: hasSquare(everything) ? 1.45 : 1.22,
  };
  const pages = exact ? [...slides] : deckPages(deck, slides);

  let number = 0;
  const add = (item: SlideRecipe) => {
    number += 1;
    const slide = pptx.addSlide();
    if (str(item.notes)) slide.addNotes(str(item.notes));
    return slide;
  };
  for (const [index, item] of pages.entries()) {
    if (!item || typeof item !== "object")
      throw new BadDeck("Each slide is an object with a title.");
    const named = str(item.layout).toLowerCase();
    const title = str(item.title);
    const points = list(item.bullets, 12);
    if (
      named === "cover" ||
      (index === 0 &&
        pages.length > 1 &&
        !named &&
        !points.length &&
        !item.table &&
        !item.chart &&
        !item.stats &&
        !item.columns &&
        !item.steps &&
        !item.quote)
    ) {
      cover(
        kit,
        add(item),
        { ...item, subtitle: str(item.subtitle) || str(deck?.subtitle) },
        str(deck?.byline),
        false,
      );
      continue;
    }
    if (named === "closing") {
      cover(kit, add(item), item, "", true);
      continue;
    }
    const nothing =
      !points.length &&
      !item.table &&
      !item.chart &&
      !item.stats?.length &&
      !item.columns?.length &&
      !item.steps?.length &&
      !item.quote;
    if (named === "section" || nothing) {
      const slide = add(item);
      section(kit, slide, item);
      footer(kit, slide, number);
      continue;
    }
    if (item.table && (!Array.isArray(item.table.headers) || !item.table.headers.length))
      throw new BadDeck("A table needs headers.");
    // Everything is measured before anything is drawn: where the content begins under
    // the title, where it must end over the takeaway, and so how much room it has.
    const end = takeaway(kit, null, item);
    // A long table runs over as many slides as it needs, with its header on each; its
    // title then carries which part it is, measured at its longest.
    const least =
      end - titleOf(kit, null, item.table ? { ...item, title: `${title} (99/99)` } : item);
    // Better said than drawn one thing over another: the agent can shorten or split.
    if (least < 1.2)
      throw new BadDeck(
        `Slide "${title}" has a title and a takeaway that leave no room for what it shows: shorten them.`,
      );
    const plan = item.table ? planTable(kit, item.table, least, title) : null;
    const parts = plan ? plan.pages.length : 1;
    for (let part = 0; part < parts; part++) {
      const slide = add(item);
      slide.background = { color: WHITE };
      const y = titleOf(
        kit,
        slide,
        parts > 1 ? { ...item, title: `${title} (${part + 1}/${parts})` } : item,
      );
      takeaway(kit, slide, item);
      const h = end - y;
      const cards = list(item.stats, 4);
      const blocks = list(item.columns, 4);
      const stages = list(item.steps, 6);
      if (plan) table(kit, slide, plan, part, y);
      else if (item.quote) quote(kit, slide, item.quote, y, h, title);
      else if (cards.length) {
        // Alone on the slide the numbers stand a little lower, nearer its middle.
        const alone = !points.length && !item.chart;
        // Smaller when there is more under them, or when at full size they would not fit.
        const small = !alone || stats(kit, null, cards, y, false) > h;
        const tall = stats(kit, null, cards, y, small);
        // And no lower than leaves them whole.
        const top = alone ? y + Math.max(0, Math.min(0.9, h * 0.15, h - tall)) : y;
        stats(kit, slide, cards, top, small);
        const under = top + tall + 0.4;
        const rest = y + h - under;
        if (alone ? tall > h : rest < (item.chart ? 1.5 : 0.4))
          throw new BadDeck(
            `Slide "${title}" holds more than fits ${alone ? "on it" : "under its numbers"}: shorten the labels and notes of the numbers${alone ? "" : `, or put the ${item.chart ? "chart" : "points"} on a slide of its own`}.`,
          );
        if (item.chart && points.length) {
          bullets(kit, slide, points, LEFT, under, 5.2, rest, [16, 14], title);
          chart(kit, slide, item.chart, LEFT + 5.8, under, WIDE - 5.8, rest);
        } else if (item.chart) chart(kit, slide, item.chart, LEFT, under, WIDE, rest);
        else bullets(kit, slide, points, LEFT, under, MEASURE, rest, [20, 18, 16, 14], title);
      } else if (blocks.length > 1) columns(kit, slide, blocks, y, h, title);
      else if (stages.length > 1) {
        const lift = Math.min(0.6, h * 0.1);
        steps(kit, slide, stages, y + lift, h - lift, title);
      } else if (item.chart && points.length) {
        bullets(kit, slide, points, LEFT, y, 4.9, h, [18, 16, 14], title);
        chart(kit, slide, item.chart, LEFT + 5.5, y - 0.1, WIDE - 5.5, h + 0.1);
      } else if (item.chart) chart(kit, slide, item.chart, LEFT, y - 0.1, WIDE, h + 0.1);
      else bullets(kit, slide, points, LEFT, y, MEASURE, h, [22, 20, 18, 16, 14], title);
      footer(kit, slide, number);
    }
  }
  return new Uint8Array((await pptx.write({ outputType: "nodebuffer" })) as Buffer);
}
