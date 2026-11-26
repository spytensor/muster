import { all, child, dig, type Xml } from "./xml";

/** A chart inside a presentation, as the numbers and looks the file keeps for it. */
export interface Chart {
  kind: "bar" | "line" | "area" | "pie" | "doughnut";
  /** Bars that run sideways. */
  sideways: boolean;
  stacked: boolean;
  title: string;
  categories: string[];
  series: {
    name: string;
    color: string;
    /** A colour for each point, where the file gives one: the slices of a pie. */
    colors: (string | undefined)[];
    values: (number | null)[];
  }[];
  legend: "t" | "b" | "l" | "r" | null;
  labels: "value" | "percent" | null;
  format: string;
  labelColor: string;
  axisColor: string;
  gridColor: string;
  /** The hole of a doughnut, as a share of its radius. */
  hole: number;
}

const KINDS: Record<string, Chart["kind"]> = {
  "c:barChart": "bar",
  "c:bar3DChart": "bar",
  "c:lineChart": "line",
  "c:areaChart": "area",
  "c:pieChart": "pie",
  "c:pie3DChart": "pie",
  "c:doughnutChart": "doughnut",
};
const POINT_LIMIT = 400;
const SERIES_LIMIT = 24;

/** The cached points of a reference: what the chart showed when the file was saved. */
function points(holder: Xml | undefined): string[] {
  const cache =
    dig(holder, "c:strRef", "c:strCache") ??
    dig(holder, "c:numRef", "c:numCache") ??
    dig(holder, "c:multiLvlStrRef", "c:multiLvlStrCache", "c:lvl") ??
    child(holder, "c:strLit") ??
    child(holder, "c:numLit");
  const out: string[] = [];
  for (const point of all(cache, "c:pt")) {
    const index = Number(point.attrs.idx);
    if (Number.isInteger(index) && index >= 0 && index < POINT_LIMIT)
      out[index] = child(point, "c:v")?.text ?? "";
  }
  return Array.from(out, (value) => value ?? "");
}
const on = (node: Xml | undefined, name: string) => child(node, name)?.attrs.val === "1";

/**
 * Reads a chart part. `colorOf` turns a node that holds a colour into CSS, with the slide's
 * theme; `accents` are the theme's own series colours, for a series that names none.
 * Null when it is a kind of chart this viewer does not draw.
 */
export function readChart(
  xml: Xml | undefined,
  colorOf: (holder: Xml | undefined) => string | undefined,
  accents: string[],
): Chart | null {
  const chart = child(xml, "c:chart");
  const plot = child(chart, "c:plotArea");
  const group = plot?.children.find((node) => KINDS[node.name]);
  if (!group) return null;
  const kind = KINDS[group.name] as Chart["kind"];
  const round = kind === "pie" || kind === "doughnut";

  let categories: string[] = [];
  const series = all(group, "c:ser")
    .slice(0, SERIES_LIMIT)
    .map((ser, index) => {
      const cats = points(child(ser, "c:cat"));
      if (cats.length > categories.length) categories = cats;
      const look = child(ser, "c:spPr");
      const colors: (string | undefined)[] = [];
      for (const point of all(ser, "c:dPt")) {
        const at = Number(dig(point, "c:idx")?.attrs.val);
        if (Number.isInteger(at) && at >= 0 && at < POINT_LIMIT)
          colors[at] = colorOf(child(child(point, "c:spPr"), "a:solidFill"));
      }
      return {
        name: points(child(ser, "c:tx"))[0] ?? dig(ser, "c:tx", "c:v")?.text ?? "",
        color:
          (kind === "line" ? colorOf(dig(look, "a:ln", "a:solidFill")) : undefined) ??
          colorOf(child(look, "a:solidFill")) ??
          accents[index % Math.max(1, accents.length)] ??
          "rgb(47, 107, 255)",
        colors,
        values: points(child(ser, "c:val")).map((value) => {
          const number = value === "" ? Number.NaN : Number(value);
          return Number.isFinite(number) ? number : null;
        }),
      };
    })
    .filter((one) => one.values.length);
  if (!series.length) return null;
  const count = Math.max(categories.length, ...series.map((one) => one.values.length));
  categories = Array.from({ length: count }, (_, index) => categories[index] ?? String(index + 1));

  const labels =
    child(group, "c:dLbls") ?? child(series.length ? all(group, "c:ser")[0] : undefined, "c:dLbls");
  const anyLabel = dig(labels, "c:dLbl") ?? labels;
  const textColor = (node: Xml | undefined) =>
    colorOf(dig(node, "c:txPr", "a:p", "a:pPr", "a:defRPr", "a:solidFill"));
  const grouping = child(group, "c:grouping")?.attrs.val ?? "";
  const legend = child(chart, "c:legend");
  const position = child(legend, "c:legendPos")?.attrs.val ?? "r";
  return {
    kind,
    sideways: kind === "bar" && child(group, "c:barDir")?.attrs.val === "bar",
    stacked: /stacked/i.test(grouping),
    title: all(dig(chart, "c:title", "c:tx", "c:rich"), "a:p")
      .flatMap((p) => all(p, "a:r"))
      .map((run) => child(run, "a:t")?.text ?? "")
      .join(""),
    categories,
    series,
    legend: legend ? (position === "tr" ? "r" : (position as Chart["legend"])) : null,
    labels: on(anyLabel, "c:showPercent") ? "percent" : on(anyLabel, "c:showVal") ? "value" : null,
    format:
      (round ? child(anyLabel, "c:numFmt") : child(labels, "c:numFmt"))?.attrs.formatCode ??
      "General",
    labelColor: textColor(anyLabel) ?? (round ? "rgb(255, 255, 255)" : "rgb(20, 24, 31)"),
    axisColor: textColor(child(plot, "c:catAx")) ?? "rgb(91, 100, 114)",
    gridColor:
      colorOf(dig(plot, "c:valAx", "c:majorGridlines", "c:spPr", "a:ln", "a:solidFill")) ??
      "rgb(227, 230, 235)",
    hole: Math.min(0.9, Math.max(0.1, Number(child(group, "c:holeSize")?.attrs.val ?? 50) / 100)),
  };
}

/**
 * A number written the way a spreadsheet format code says: decimals, thousands
 * separators, a percent sign, and any currency or unit the code puts around it.
 */
export function formatNumber(value: number, code: string): string {
  const pattern = (code.split(";")[0] ?? "").replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
  const digits = pattern.match(/[#0][#0,]*(?:\.([#0]+))?/);
  if (!digits || /general/i.test(code)) {
    const rounded = Math.round(value * 100) / 100;
    return Math.abs(rounded) >= 10000 ? rounded.toLocaleString("en-US") : String(rounded);
  }
  const percent = pattern.includes("%");
  const decimals = digits[1]?.length ?? 0;
  const text = (percent ? value * 100 : value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: digits[0].includes(","),
  });
  const at = digits.index ?? 0;
  return `${pattern.slice(0, at)}${text}${pattern.slice(at + digits[0].length)}`.replace(
    /[_*]./g,
    "",
  );
}

/** Round steps for an axis that holds every value, starting from zero. */
export function axis(low: number, high: number): { min: number; max: number; ticks: number[] } {
  const min = Math.min(0, low);
  const max = Math.max(0, high);
  const span = max - min || 1;
  const rough = span / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  const from = Math.floor(min / step) * step;
  const to = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = from; tick <= to + step / 2 && ticks.length < 12; tick += step)
    ticks.push(Math.round(tick * 1e6) / 1e6);
  return { min: from, max: to, ticks };
}
