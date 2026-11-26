/**
 * The arithmetic of the ways a reply shows numbers (component set 4), kept apart from
 * drawing so it can be checked without a screen: colour by value, the tiles of a market
 * map, the slices of a pie, the corners of a radar, a scale that need not start at zero.
 */

/** How many of each a drawing takes: more than this is not drawn. */
export const MOST = {
  tiles: 60,
  heat: 20,
  candles: 120,
  points: 200,
  slices: 6,
  bars: 30,
  /** Upright bars, and the parts of a stack, a combo or a waterfall. */
  columns: 60,
  /** Points along a line or an area. */
  line: 240,
  spokes: 12,
  metrics: 6,
  progress: 12,
  events: 40,
} as const;

/** Which colour a rise wears; absent, nothing is a rise or a fall. */
export type Up = "red" | "green" | undefined;
export const upOf = (value: unknown): Up =>
  value === "red" || value === "green" ? value : undefined;

/** The colours values are shown in. Light first, dark second. */
export const PALETTE = {
  light: {
    red: "#d03b3b",
    green: "#008300",
    blue: "#2a78d6",
    orange: "#eb6834",
    mid: "#f0efec",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6"],
    other: "#b5b3ad",
  },
  dark: {
    red: "#d03b3b",
    green: "#0c8f0c",
    blue: "#3987e5",
    orange: "#d95926",
    mid: "#383835",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"],
    other: "#6b6a65",
  },
} as const;
export type Palette = (typeof PALETTE)["light"] | (typeof PALETTE)["dark"];

const channels = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** One colour on the way from `from` to `to`: 0 is `from`, 1 is `to`. */
export function mix(from: string, to: string, t: number): string {
  const at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const a = channels(from);
  const b = channels(to);
  const part = (i: 0 | 1 | 2) =>
    Math.round(a[i] + (b[i] - a[i]) * at)
      .toString(16)
      .padStart(2, "0");
  return `#${part(0)}${part(1)}${part(2)}`;
}

export interface Tone {
  fill: string;
  /** The fill is strong enough that what is written on it is white. */
  strong: boolean;
}

/**
 * The colour of each value among the others. With `up`, rises and falls: two hues from a
 * neutral middle, as strong as the value is far from zero. Without it, one hue from light
 * to dark over the smallest to the largest; if some are negative, blue above zero and
 * orange below it.
 */
export function tones(values: number[], up: Up, palette: Palette): Tone[] {
  const finite = values.filter(Number.isFinite);
  const most = Math.max(0, ...finite.map(Math.abs));
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const polar = up !== undefined || low < 0;
  const above = up === "red" ? palette.red : up === "green" ? palette.green : palette.blue;
  const below = up === "red" ? palette.green : up === "green" ? palette.red : palette.orange;
  return values.map((value) => {
    if (!Number.isFinite(value)) return { fill: palette.mid, strong: false };
    let t: number;
    if (polar) t = most > 0 ? Math.abs(value) / most : 0;
    else t = high > low ? (value - low) / (high - low) : 1;
    if (polar && value === 0) return { fill: palette.mid, strong: false };
    const depth = 0.14 + 0.86 * t;
    return {
      fill: mix(palette.mid, polar && value < 0 ? below : above, depth),
      // White is read on a fill only once it is well past the middle (the web's rule too).
      strong: t > 0.6,
    };
  });
}

/** Whether a written change is a rise, a fall or neither, by the sign it begins with. */
export function signOf(text: string): 1 | -1 | 0 {
  // The same reading as the web's (apps/web/src/app/scale.ts): the mark before the first
  // number, a plus, a minus of any kind or an arrow. "-0.0%" and "+0" moved nowhere.
  const found = /([+\-−–▲▼↑↓])?\s*[$€£¥]?\s*(\d[\d,]*\.?\d*)/.exec(text.trim());
  if (!found) return 0;
  const amount = Number((found[2] ?? "").replace(/,/g, ""));
  if (!amount) return 0;
  const mark = found[1];
  if (mark === "-" || mark === "−" || mark === "–" || mark === "▼" || mark === "↓") return -1;
  return mark ? 1 : 0;
}

/** Which of the two colours a rise (1) or a fall (-1) wears. */
export function movedColour(
  sign: 1 | -1 | 0,
  up: Up,
  colours: { red: string; green: string },
): string | null {
  if (sign === 0 || up === undefined) return null;
  return (sign === 1) === (up === "red") ? colours.red : colours.green;
}

export interface Tile {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A market map: every item a rectangle whose area is its share of the weights, laid out
 * in rows as near to square as they can be made (the squarified treemap). Items come out
 * in their own order of size; `index` says which item each is.
 */
export function treemap(weights: number[], width: number, height: number): Tile[] {
  const items = weights
    .map((weight, index) => ({ weight, index }))
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !(width > 0) || !(height > 0)) return [];
  const scale = (width * height) / total;
  const out: Tile[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let at = 0;
  /** The worst shape in a row of these areas along a side this long. */
  const worst = (areas: number[], side: number) => {
    const sum = areas.reduce((a, b) => a + b, 0);
    const big = Math.max(...areas);
    const small = Math.min(...areas);
    return Math.max((side * side * big) / (sum * sum), (sum * sum) / (side * side * small));
  };
  while (at < items.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let end = at;
    while (end < items.length) {
      const area = (items[end]?.weight ?? 0) * scale;
      if (row.length > 0 && worst([...row, area], side) > worst(row, side)) break;
      row.push(area);
      end += 1;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    const thick = sum / side;
    let along = 0;
    row.forEach((area, i) => {
      const long = area / thick;
      const index = items[at + i]?.index ?? 0;
      out.push(
        w >= h
          ? { index, x, y: y + along, width: thick, height: long }
          : { index, x: x + along, y, width: long, height: thick },
      );
      along += long;
    });
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    at = end;
  }
  return out;
}

/** How many tiles of equal size go side by side in this width. */
export const columnsFor = (count: number, width: number, least = 78): number =>
  Math.max(1, Math.min(count, Math.max(2, Math.floor(width / least))));

export interface Slice {
  /** Which value it is; -1 for the rest, folded into one. */
  index: number;
  value: number;
  share: number;
  path: string;
}

/**
 * The slices of one whole, largest kept as they are and the rest folded into one once
 * there are more than `most`. Drawn as a ring from twelve o'clock, clockwise.
 */
export function slices(
  values: number[],
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  most: number = MOST.slices,
): Slice[] {
  const kept = values
    .map((value, index) => ({ value, index }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = kept.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0)) return [];
  let parts = kept;
  if (kept.length > most) {
    const ranked = [...kept].sort((a, b) => b.value - a.value);
    const head = new Set(ranked.slice(0, most - 1).map((item) => item.index));
    const rest = kept.filter((item) => !head.has(item.index));
    parts = [
      ...kept.filter((item) => head.has(item.index)),
      { index: -1, value: rest.reduce((sum, item) => sum + item.value, 0) },
    ];
  }
  const point = (radius: number, turn: number) => {
    const angle = turn * 2 * Math.PI - Math.PI / 2;
    return `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  };
  let from = 0;
  return parts.map((part) => {
    const share = part.value / total;
    // A whole ring cannot be one arc: it would begin where it ends.
    const to = from + Math.min(share, 0.9999);
    const large = to - from > 0.5 ? 1 : 0;
    const path = `M${point(outer, from)} A${outer} ${outer} 0 ${large} 1 ${point(outer, to)} L${point(inner, to)} A${inner} ${inner} 0 ${large} 0 ${point(inner, from)} Z`;
    from += share;
    return { index: part.index, value: part.value, share, path };
  });
}

/** Where spoke `index` of `count` ends at this distance from the middle; the first points up. */
export function spoke(cx: number, cy: number, radius: number, index: number, count: number) {
  const angle = (index / Math.max(1, count)) * 2 * Math.PI - Math.PI / 2;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/** The outline of one series on a radar, closed. Values below zero sit at the middle. */
export function radarPath(
  values: number[],
  count: number,
  cx: number,
  cy: number,
  radius: number,
  max: number,
): string {
  if (count < 3 || !(max > 0)) return "";
  const points = Array.from({ length: count }, (_, index) => {
    const value = values[index];
    const share = Number.isFinite(value) ? Math.min(1, Math.max(0, (value as number) / max)) : 0;
    const at = spoke(cx, cy, radius * share, index, count);
    return `${at.x.toFixed(1)} ${at.y.toFixed(1)}`;
  });
  return `M${points.join(" L")} Z`;
}

/** A scale with round numbers that covers the values and starts near them, not at zero. */
export function span(values: number[], wanted = 4): { min: number; max: number; ticks: number[] } {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: 0, max: 1, ticks: [0, 1] };
  let low = Math.min(...finite);
  let high = Math.max(...finite);
  if (low === high) {
    const pad = Math.abs(low) > 0 ? Math.abs(low) * 0.1 : 1;
    low -= pad;
    high += pad;
  }
  const rough = (high - low) / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (
    let tick = low, n = 0;
    tick <= high + step / 2 && n < 60 && tick + step > tick;
    tick += step, n += 1
  )
    ticks.push(Number(tick.toPrecision(12)));
  return { min: Number(low.toPrecision(12)), max: Number(high.toPrecision(12)), ticks };
}

/** For each label, what is above zero and what is below it when its series are stacked. */
export function stackSums(series: { values: number[] }[], count: number) {
  const above = Array.from({ length: count }, () => 0);
  const below = Array.from({ length: count }, () => 0);
  for (const item of series)
    for (let index = 0; index < count; index += 1) {
      const value = item.values[index];
      if (value === undefined || !Number.isFinite(value)) continue;
      if (value >= 0) above[index] = (above[index] ?? 0) + value;
      else below[index] = (below[index] ?? 0) + value;
    }
  return { above, below };
}

/** A fraction of a target, between nothing and all of it. */
export const fraction = (value: number, of: number): number =>
  Number.isFinite(value) && Number.isFinite(of) && of > 0
    ? Math.min(1, Math.max(0, value / of))
    : 0;

/** How many labels a chart of this kind takes, and from which end when there are more. */
export function limitOf(kind: string): { most: number; latest: boolean } {
  if (kind === "hbar") return { most: MOST.bars, latest: false };
  if (kind === "radar") return { most: MOST.spokes, latest: false };
  if (kind === "line" || kind === "area") return { most: MOST.line, latest: true };
  // A pie's slices and a waterfall, whose first bar is where it starts, keep the first.
  if (kind === "pie" || kind === "waterfall") return { most: MOST.columns, latest: false };
  return { most: MOST.columns, latest: true };
}

/**
 * The labels a chart keeps and each series' numbers for them, cut together so a number
 * stays under its label: the latest of a run over time, the first of a ranking.
 */
export function kept<S extends { values: number[] }>(
  kind: string,
  labels: string[],
  series: S[],
): { labels: string[]; series: S[] } {
  const { most, latest } = limitOf(kind);
  if (labels.length <= most) return { labels, series };
  const from = latest ? labels.length - most : 0;
  return {
    labels: labels.slice(from, from + most),
    series: series.map((item) => ({ ...item, values: item.values.slice(from, from + most) })),
  };
}

export interface Step {
  /** Which value it is; -1 for the closing total, which is added here. */
  index: number;
  kind: "open" | "change" | "close";
  /** Where its bar begins and ends. For a place without a number both are the running total. */
  from: number;
  to: number;
  /** What it adds or takes; not a number where the reply gave none. */
  change: number;
  /** The running total once it is counted. */
  total: number;
}

/**
 * How an amount became another: the first value is the opening amount, a bar from nothing;
 * each later one a change, a bar from the running total to the new one; and a closing total
 * is added at the end. A place without a number keeps its place and moves nothing.
 */
export function waterfall(values: number[]): Step[] {
  const steps: Step[] = [];
  let total = 0;
  let seen = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      steps.push({ index, kind: "change", from: total, to: total, change: Number.NaN, total });
      return;
    }
    const from = seen ? total : 0;
    total += value;
    steps.push({ index, kind: seen ? "change" : "open", from, to: total, change: value, total });
    seen = true;
  });
  if (!seen) return [];
  steps.push({ index: -1, kind: "close", from: 0, to: total, change: total, total });
  return steps;
}

/** Two measures of different scale: the first series is bars, the others lines of their own. */
export function comboSplit<S>(series: S[]): { bars: S[]; lines: S[] } {
  return { bars: series.slice(0, 1), lines: series.slice(1) };
}

const sized = (size: number | undefined): size is number =>
  typeof size === "number" && Number.isFinite(size) && size > 0;

/**
 * How large each dot is drawn when dots carry a third measure: its area follows the
 * measure, between a radius of 4 and of 14. A dot without one is the smallest; when no dot
 * has one, all are 4.5.
 */
export function bubbleRadii(sizes: (number | undefined)[], least = 4, most = 14): number[] {
  const finite = sizes.filter(sized);
  if (finite.length === 0) return sizes.map(() => 4.5);
  const top = Math.max(...finite);
  return sizes.map((size) =>
    sized(size) ? least + (most - least) * Math.sqrt(size / top) : least,
  );
}

/** The kinds dots are of, the first four in the order they appear; any other is -1. */
export function groupsOf(
  groups: (string | undefined)[],
  most = 4,
): { names: string[]; of: number[] } {
  const names: string[] = [];
  for (const group of groups)
    if (group && !names.includes(group) && names.length < most) names.push(group);
  return { names, of: groups.map((group) => (group ? names.indexOf(group) : -1)) };
}

/** A small line through recent values, oldest first, in a box this size; and where it ends. */
export function spark(
  values: number[],
  width: number,
  height: number,
): { path: string; end: { x: number; y: number } } | null {
  const finite = values.filter(Number.isFinite).slice(-60);
  if (finite.length < 2) return null;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const pad = 2;
  const points = finite.map((value, index) => ({
    x: pad + (index / (finite.length - 1)) * (width - pad * 2),
    y: high > low ? pad + (1 - (value - low) / (high - low)) * (height - pad * 2) : height / 2,
  }));
  const end = points[points.length - 1];
  if (!end) return null;
  return {
    path: points
      .map((point, i) => `${i ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
    end,
  };
}

/**
 * The box a flow diagram is drawn in, the same as the web's: as tall as its names need,
 * within reason, with room at both edges for the names that stand beside the boxes.
 */
export function flowBox(names: number, width: number): { height: number; side: number } {
  return {
    height: Math.round(Math.min(420, Math.max(200, Math.max(1, names) * 26))),
    // A quarter of a narrow screen at each edge: a name of five or six characters is whole.
    side: Math.min(140, Math.max(76, width * 0.25)),
  };
}

/** Only what is a number: anything else a reply put there is not one. */
export const numberOr = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
