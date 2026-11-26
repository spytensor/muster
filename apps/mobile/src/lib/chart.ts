/** The arithmetic of a chart, kept apart from drawing so it can be checked without a screen. */

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** A scale with round numbers that covers the values and always includes zero. */
export function niceScale(values: number[], wanted = 4): Scale {
  const finite = values.filter(Number.isFinite);
  let low = Math.min(0, ...finite);
  let high = Math.max(0, ...finite);
  if (low === high) high = low + 1;
  const rough = (high - low) / wanted;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // Rounded so that steps such as 0.1 do not gather floating-point dust.
  for (
    let tick = low, n = 0;
    tick <= high + step / 2 && n < 60 && tick + step > tick;
    tick += step, n += 1
  )
    ticks.push(Number(tick.toPrecision(12)));
  return { min: low, max: high, ticks };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Layout {
  scale: Scale;
  /** The height at which zero sits. */
  zero: number;
  /** The middle of each label's slot along the bottom. */
  centers: number[];
  /** Which labels to write so they do not run into each other. */
  shown: boolean[];
  y(value: number): number;
}

/** Where things go inside the plot area. `labelWidth` is how much room one written label needs. */
export function layout(
  box: Box,
  count: number,
  series: { values: number[] }[],
  labelWidth = 44,
  /** A scale made elsewhere, for a drawing that need not start at zero. */
  given?: Scale,
): Layout {
  const scale = given ?? niceScale(series.flatMap((item) => item.values.slice(0, count)));
  const y = (value: number) =>
    box.top + box.height - ((value - scale.min) / (scale.max - scale.min)) * box.height;
  const slot = count > 0 ? box.width / count : box.width;
  const centers = Array.from({ length: count }, (_, index) => box.left + slot * (index + 0.5));
  const every = Math.max(1, Math.ceil(labelWidth / slot));
  const shown = centers.map((_, index) => index % every === 0);
  return { scale, zero: y(0), centers, shown, y };
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bars of one series: side by side with the other series inside each label's slot. */
export function bars(
  at: Layout,
  values: number[],
  seriesIndex: number,
  seriesCount: number,
  slot: number,
): (Bar | null)[] {
  const group = slot * 0.76;
  const gap = seriesCount > 1 ? 2 : 0;
  const width = Math.max(1, (group - gap * (seriesCount - 1)) / seriesCount);
  return at.centers.map((center, index) => {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) return null;
    const top = at.y(Math.max(value, 0));
    const bottom = at.y(Math.min(value, 0));
    return {
      x: center - group / 2 + seriesIndex * (width + gap),
      y: top,
      width,
      height: Math.max(0, bottom - top),
    };
  });
}

/** The path of a line through one series' points. A missing value breaks the line there. */
export function linePath(at: Layout, values: number[]): string {
  let path = "";
  let pen = false;
  at.centers.forEach((x, index) => {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${x.toFixed(1)} ${at.y(value).toFixed(1)} `;
    pen = true;
  });
  return path.trim();
}

/** The filled shape under a line, down to zero. Empty when the series has a gap or under two points. */
export function areaPath(at: Layout, values: number[]): string {
  const points = at.centers.flatMap((x, index) => {
    const value = values[index];
    return value === undefined || !Number.isFinite(value) ? [] : [{ x, y: at.y(value) }];
  });
  if (points.length < 2 || points.length !== at.centers.length) return "";
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  const top = points.map(
    (point, i) => `${i ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
  );
  return `${top.join(" ")} L${last.x.toFixed(1)} ${at.zero.toFixed(1)} L${first.x.toFixed(1)} ${at.zero.toFixed(1)} Z`;
}

/**
 * A number as it is written beside a mark or in the table: thousands separated, two
 * decimals at most whatever its size (a price of 1234.56 stays 1,234.56), no trailing zeros.
 */
export function plain(value: number): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Number(value.toFixed(2));
  const [whole = "0", fraction] = Math.abs(rounded)
    .toFixed(2)
    .replace(/\.?0+$/, "")
    .split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "-" : ""}${fraction ? `${grouped}.${fraction}` : grouped}`;
}

/** At most three digits that mean something, no trailing zeros. */
const three = (value: number): string => String(Number(value.toPrecision(3)));

/**
 * A number on an axis, where room is short: from ten thousand up it is said in a larger
 * unit, 万 and 亿 in Chinese and K, M and B otherwise. Only an axis is written this way;
 * the numbers beside marks and in the table stay whole.
 */
export function compact(value: number, chinese: boolean): string {
  if (!Number.isFinite(value)) return "";
  const size = Math.abs(value);
  if (size < 10_000) return plain(value);
  const steps: [number, string][] = chinese
    ? [
        [1e8, "亿"],
        [1e4, "万"],
      ]
    : [
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "K"],
      ];
  for (const [step, name] of steps) if (size >= step) return `${three(value / step)}${name}`;
  return plain(value);
}

/** The signs of money that are written before a number. */
const LEADS = /^[$€£¥₩₹]/;

/**
 * A written number with its unit: a unit that begins with a sign of money leads the number
 * with that sign and follows it with the rest ("$" gives "$1,200", "$M" gives "$1.2M");
 * any other unit follows it. A plus or a minus stays in front of the sign.
 */
export function withUnit(text: string, unit: string): string {
  if (!text) return "";
  const trimmed = unit.trim();
  if (!LEADS.test(trimmed)) return `${text}${unit}`;
  const sign = /^[+\-−]/.test(text) ? text.slice(0, 1) : "";
  return `${sign}${trimmed.slice(0, 1)}${text.slice(sign.length)}${trimmed.slice(1)}`;
}

/** How wide a text is, about, at this size: a Chinese character takes two Latin ones. */
export function textWidth(text: string, fontSize = 10): number {
  let units = 0;
  for (const char of text) units += /[⺀-鿿豈-﫿＀-￯가-힯]/.test(char) ? 2 : 1;
  return units * fontSize * 0.55;
}

/** A label cut to the room it has, with a mark that it was cut; whole when it fits. */
export function fitLabel(text: string, room: number, fontSize = 10): string {
  if (textWidth(text, fontSize) <= room) return text;
  let kept = "";
  for (const char of text) {
    if (textWidth(`${kept}${char}…`, fontSize) > room) break;
    kept += char;
  }
  return kept ? `${kept}…` : "";
}
