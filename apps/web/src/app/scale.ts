/**
 * What the drawings of numbers share: which colour a number wears, how strongly, and
 * where a tile sized by its weight lies. Nothing here draws; it is tested on its own.
 */

/** Which colour a rise wears: red by the custom of some markets and readers, green by others'. */
export type Up = "red" | "green" | undefined;

/** The four hues a number can be filled with. Two say rise and fall; two say more and less. */
export type Hue = "red" | "green" | "blue" | "orange";

export const HUE: Record<Hue, string> = {
  red: "var(--pole-red)",
  green: "var(--pole-green)",
  blue: "var(--series-1)",
  orange: "var(--series-2)",
};

/** Only what is a number: a model's reply may hold anything where a number belongs. */
export const numbers = (values: unknown): number[] =>
  Array.isArray(values) ? values.map(Number).filter((value) => Number.isFinite(value)) : [];

/** A number that is one, or not a number: a word in a number's place keeps the place and is not drawn. */
export const numberOr = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;

/**
 * How much of each a reply may hold, the same on the phone (apps/mobile/src/lib/visuals.ts,
 * `MOST`), so one reply is one drawing wherever it is read.
 */
export const MOST = {
  tiles: 60,
  heat: 20,
  candles: 120,
  points: 200,
  /** Lying bars, from the first: a ranking's top. */
  bars: 30,
  spokes: 12,
  /** Standing bars, the latest of them. */
  labels: 60,
  /** Points of a line or an area, the latest of them. */
  line: 240,
  metrics: 6,
  progress: 12,
  events: 40,
} as const;

/** -1, 0 or 1 for a change as it is written: "+2.1%", "-0.7", "−3" (a real minus), "▲ 4". */
export function signOf(text: string): -1 | 0 | 1 {
  const found = /([+\-−–▲▼↑↓])?\s*[$€£¥]?\s*(\d[\d,]*\.?\d*)/.exec(text.trim());
  if (!found) return 0;
  const amount = Number((found[2] ?? "").replace(/,/g, ""));
  if (!amount) return 0;
  const mark = found[1];
  if (mark === "-" || mark === "−" || mark === "–" || mark === "▼" || mark === "↓") return -1;
  return mark ? 1 : 0;
}

/** The hue of a rise or a fall. */
export const hueOf = (sign: number, up: Up): Hue | null =>
  sign === 0 || !up ? null : sign > 0 === (up === "red") ? "red" : "green";

/**
 * How a number among others is filled. With `up`, by whether it rose or fell and how far.
 * Without, by how large it is: one hue from faint to full, or two when some are below zero.
 * `strength` runs from 0 (the midpoint) to 1 (the furthest of them all).
 */
export function toneOf(value: number, all: number[], up: Up): { hue: Hue; strength: number } {
  const most = Math.max(0, ...all.map((one) => Math.abs(one)));
  const least = Math.min(...all);
  if (up || least < 0) {
    const strength = most ? Math.abs(value) / most : 0;
    const hue = up ? (hueOf(value, up) ?? "red") : value < 0 ? "orange" : "blue";
    return { hue, strength };
  }
  const top = Math.max(...all);
  return { hue: "blue", strength: top > least ? (value - least) / (top - least) : 1 };
}

/** The fill of a tone: its hue mixed into the neutral midpoint. Never a hue at the midpoint. */
export const fillOf = ({ hue, strength }: { hue: Hue; strength: number }): string =>
  strength <= 0
    ? "var(--heat-mid)"
    : `color-mix(in oklab, ${HUE[hue]} ${Math.round(18 + 82 * Math.min(1, strength))}%, var(--heat-mid))`;

/** Whether words on that fill are white: on a strong fill they are, on a faint one they are ink. */
export const onStrong = (strength: number) => strength > 0.6;

/** At most `most` slices: the largest keep their names, the rest are one. */
export function fold(
  labels: string[],
  values: number[],
  other: string,
  most = 6,
): { name: string; value: number }[] {
  const slices = labels
    .map((name, index) => ({ name, value: values[index] ?? 0 }))
    .filter((slice) => slice.value > 0);
  if (slices.length <= most) return slices;
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, most - 1);
  const rest = sorted.slice(most - 1).reduce((sum, slice) => sum + slice.value, 0);
  return [...kept, { name: other, value: rest }];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each weight lies in a box, as a rectangle whose area is its share: the squarified
 * treemap (Bruls, Huizing, van Wijk), which keeps tiles near square so a name fits in
 * them. The answer is in the order the weights were given; a weight of nothing or less
 * has no room.
 */
export function treemap(weights: number[], width: number, height: number): Rect[] {
  const out: Rect[] = weights.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const order = weights
    .map((weight, index) => ({ weight: Number.isFinite(weight) ? Math.max(0, weight) : 0, index }))
    .filter((one) => one.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const total = order.reduce((sum, one) => sum + one.weight, 0);
  if (!total || width <= 0 || height <= 0) return out;
  const scale = (width * height) / total;
  let box = { x: 0, y: 0, w: width, h: height };
  let row: { area: number; index: number }[] = [];
  // The worst ratio of sides in a row laid along a side of that length.
  const worst = (areas: number[], side: number) => {
    const sum = areas.reduce((a, b) => a + b, 0);
    const big = Math.max(...areas);
    const small = Math.min(...areas);
    return Math.max((side * side * big) / (sum * sum), (sum * sum) / (side * side * small));
  };
  const lay = () => {
    const sum = row.reduce((a, one) => a + one.area, 0);
    const along = box.w >= box.h;
    const side = along ? box.h : box.w;
    const thick = side ? sum / side : 0;
    let at = 0;
    for (const one of row) {
      const long = thick ? one.area / thick : 0;
      out[one.index] = along
        ? { x: box.x, y: box.y + at, w: thick, h: long }
        : { x: box.x + at, y: box.y, w: long, h: thick };
      at += long;
    }
    box = along
      ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h }
      : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
    row = [];
  };
  for (const one of order) {
    const area = one.weight * scale;
    const side = Math.min(box.w, box.h);
    const now = row.map((item) => item.area);
    if (row.length && worst([...now, area], side) > worst(now, side)) lay();
    row.push({ area, index: one.index });
  }
  if (row.length) lay();
  return out;
}

/** A few round numbers across a range, for an axis: 0, 25, 50, 75, 100. */
export function ticks(low: number, high: number, about = 4): number[] {
  if (!(high > low)) return [low];
  const rough = (high - low) / about;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * power).find((n) => n >= rough) ?? rough;
  const out: number[] = [];
  // Never more than a handful, and never on with numbers so large a step no longer moves them.
  for (
    let at = Math.ceil(low / step) * step;
    at <= high + step * 1e-9 && out.length < 12 && at + step > at;
    at += step
  )
    out.push(Number(at.toPrecision(12)));
  return out.length ? out : [low];
}

/**
 * A number with its unit. A currency sign leads the number and what follows the sign
 * follows the number ("$" gives $1,200; "$M" gives $1.2M); any other unit follows it.
 */
export function withUnit(text: string, unit = ""): string {
  const sign = /^\s*([$€£¥₩₹])(.*)$/s.exec(unit);
  if (!sign) return `${text}${unit}`;
  const minus = /^[-−]/.test(text) ? text.slice(0, 1) : "";
  return `${minus}${sign[1]}${text.slice(minus.length)}${sign[2]}`;
}

export interface Step {
  /** The amount before this bar and after it: the bar lies between them. */
  from: number;
  to: number;
  /** What it adds or takes away; for the opening and the total, the amount itself. */
  change: number;
  kind: "open" | "move" | "total";
}

/**
 * The bars of a waterfall: the opening amount from nothing, each change from where the
 * last one ended, and the closing total from nothing again. A place without a number
 * moves nothing and has no bar (`null`).
 */
export function waterfall(values: (number | null)[]): (Step | null)[] {
  const steps: (Step | null)[] = [];
  let at = 0;
  let opened = false;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) {
      steps.push(null);
      continue;
    }
    steps.push({
      from: opened ? at : 0,
      to: at + value,
      change: value,
      kind: opened ? "move" : "open",
    });
    at += value;
    opened = true;
  }
  if (opened) steps.push({ from: 0, to: at, change: at, kind: "total" });
  return steps;
}

/** How large a dot is for its third measure: its area, not its width, follows the number. */
export function radiusOf(size: number | undefined, all: number[], least = 4, most = 14): number {
  const top = Math.max(0, ...all);
  if (size === undefined || !Number.isFinite(size) || size <= 0 || top <= 0) return least;
  return least + (most - least) * Math.sqrt(Math.min(1, size / top));
}

/** The points of a small line of a figure's recent values, in a box of that size. */
export function sparkPoints(values: number[], width: number, height: number, pad = 2): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  // Values so far apart their distance is not a number are a level line, not no line.
  const span = Number.isFinite(high - low) ? high - low : 0;
  return values
    .map((value, index) => {
      const x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
      const y = span > 0 ? pad + ((high - value) / span) * (height - pad * 2) : height / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
