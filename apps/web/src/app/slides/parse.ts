import { strFromU8, unzipSync } from "fflate";
import { type Chart, readChart } from "./chart";
import { all, child, dig, parseXml, type Xml } from "./xml";

/** Where something sits on a slide, in pixels at 96 per inch, and how it is turned. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: number;
  flipH: boolean;
  flipV: boolean;
}
/** A CSS background, or a picture inside the file. */
export type Fill = { css: string } | { image: string };
export interface Run {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  font: string;
}
export interface Paragraph {
  align: "left" | "center" | "right" | "justify";
  marginLeft: number;
  indent: number;
  bullet: string | null;
  bulletColor: string | null;
  lineHeight: number | string;
  spaceBefore: number;
  /** The size an empty paragraph takes, and the bullet's. */
  size: number;
  runs: (Run | "break")[];
}
export interface TextBody {
  anchor: "top" | "middle" | "bottom";
  inset: [left: number, top: number, right: number, bottom: number];
  wrap: boolean;
  paragraphs: Paragraph[];
}
export interface Cell {
  text: TextBody | null;
  fill: string | null;
  /** The lines around it as CSS, left, top, right, bottom; null where the file draws none. */
  borders: (string | null)[];
  colSpan: number;
  rowSpan: number;
}
export type Item =
  | {
      type: "shape";
      box: Box;
      /** A preset shape's name, or "path" with `path` drawn in a `w` by `h` space. */
      geometry: string;
      path?: { d: string; w: number; h: number };
      radius: number;
      fill: Fill | null;
      line: { color: string; width: number } | null;
      text: TextBody | null;
    }
  | { type: "image"; box: Box; image: string; crop: [l: number, t: number, r: number, b: number] }
  | { type: "table"; box: Box; columns: number[]; rows: { height: number; cells: Cell[] }[] }
  | { type: "chart"; box: Box; chart: Chart }
  /** Something this viewer does not draw; shown as a labelled frame so it is not silently missing. */
  | { type: "other"; box: Box; what: "chart" | "diagram" | "picture" | "media" };
export interface Slide {
  background: Fill | null;
  items: Item[];
  notes: string;
}
export interface Deck {
  width: number;
  height: number;
  slides: Slide[];
  /** The pictures the slides use, by their path inside the file. */
  media: Record<string, Uint8Array>;
}

/** Thrown with a reason when the file is not a presentation this viewer can open. */
export class NotSlides extends Error {}

const SLIDE_LIMIT = 500;
const PART_BYTES = 48 * 1024 * 1024;
const TOTAL_BYTES = 160 * 1024 * 1024;
/** The most one slide may hold: past this the rest of it is left out, so no file can stall the viewer. */
const NODES_PER_SLIDE = 6000;
const PARAGRAPHS_PER_SLIDE = 1500;
const RUNS_PER_PARAGRAPH = 200;
const has = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;
const EMU = 9525;
const px = (emu: string | undefined) => (emu ? Number(emu) / EMU : 0);
/** Hundredths of a point to pixels. */
const pt = (value: string | undefined) => (value ? (Number(value) / 100) * (4 / 3) : undefined);

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
/** A relationship's target as a path inside the file. */
function resolve(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dirOf(from).split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// ---- colour ----

interface Theme {
  colors: Record<string, string>;
  major: string;
  minor: string;
}
/** What colours and fonts mean on one slide: its theme, and the master's names for them. */
interface Palette {
  theme: Theme;
  map: Record<string, string>;
}
const PRESET: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  gray: "808080",
  grey: "808080",
  orange: "FFA500",
};
const HEX = /^[0-9a-fA-F]{6}$/;

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const part = (t: number) => {
    const u = (t + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [part(h + 1 / 3), part(h), part(h - 1 / 3)];
}

/** The colour a fill, a line or a run names, as CSS. Undefined when the node names none. */
function color(holder: Xml | undefined, palette: Palette): string | undefined {
  const node = holder?.children.find((c) =>
    ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr"].includes(c.name),
  );
  if (!node) return undefined;
  let hex: string | undefined;
  if (node.name === "a:srgbClr") hex = node.attrs.val;
  else if (node.name === "a:sysClr") hex = node.attrs.lastClr;
  else if (node.name === "a:prstClr") hex = PRESET[node.attrs.val ?? ""];
  else {
    const name = node.attrs.val ?? "";
    hex = palette.theme.colors[palette.map[name] ?? name];
  }
  if (!hex || !HEX.test(hex)) return undefined;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt((hex as string).slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  let alpha = 1;
  for (const change of node.children) {
    const amount = Number(change.attrs.val) / 100000;
    if (!Number.isFinite(amount)) continue;
    if (change.name === "a:alpha") alpha = amount;
    else if (change.name === "a:tint")
      [r, g, b] = [r, g, b].map((c) => c * amount + (1 - amount)) as [number, number, number];
    else if (change.name === "a:shade")
      [r, g, b] = [r, g, b].map((c) => c * amount) as [number, number, number];
    else if (change.name === "a:lumMod" || change.name === "a:lumOff") {
      const [h, s, l] = toHsl(r, g, b);
      const light = change.name === "a:lumMod" ? l * amount : l + amount;
      [r, g, b] = fromHsl(h, s, Math.min(1, Math.max(0, light)));
    }
  }
  const byte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);
  return alpha < 1
    ? `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Math.round(alpha * 100) / 100})`
    : `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

// ---- the parts of the file ----

class Parts {
  private readonly xml = new Map<string, Xml | null>();
  private readonly rels = new Map<string, Record<string, { target: string; type: string }>>();
  readonly used = new Set<string>();
  constructor(private readonly files: Record<string, Uint8Array>) {}

  read(path: string): Xml | undefined {
    if (!this.xml.has(path)) {
      const bytes = has(this.files, path);
      this.xml.set(path, bytes ? parseXml(strFromU8(bytes)) : null);
    }
    return this.xml.get(path) ?? undefined;
  }
  /** The relationships of a part: what each id in it points at. */
  relations(path: string) {
    let found = this.rels.get(path);
    if (!found) {
      found = Object.create(null) as Record<string, { target: string; type: string }>;
      const file = `${dirOf(path)}_rels/${path.slice(dirOf(path).length)}.rels`;
      for (const rel of all(this.read(file), "Relationship")) {
        if (rel.attrs.TargetMode === "External" || !rel.attrs.Id || !rel.attrs.Target) continue;
        found[rel.attrs.Id] = {
          target: resolve(path, rel.attrs.Target),
          type: (rel.attrs.Type ?? "").split("/").pop() ?? "",
        };
      }
      this.rels.set(path, found);
    }
    return found;
  }
  related(path: string, type: string): string | undefined {
    return Object.values(this.relations(path)).find((r) => r.type === type)?.target;
  }
  /** A picture's path, noted as used so its bytes are kept. Undefined when the file has no such picture. */
  picture(part: string, id: string | undefined): string | undefined {
    const target = id ? this.relations(part)[id]?.target : undefined;
    if (!target || !has(this.files, target)) return undefined;
    this.used.add(target);
    return target;
  }
  media(): Record<string, Uint8Array> {
    return Object.fromEntries([...this.used].map((path) => [path, this.files[path] as Uint8Array]));
  }
}

function readTheme(xml: Xml | undefined): Theme {
  const colors: Record<string, string> = {};
  for (const entry of dig(xml, "a:themeElements", "a:clrScheme")?.children ?? []) {
    const value = entry.children[0];
    const hex =
      value?.attrs.val && HEX.test(value.attrs.val) ? value.attrs.val : value?.attrs.lastClr;
    if (hex) colors[entry.name.replace("a:", "")] = hex;
  }
  const fonts = dig(xml, "a:themeElements", "a:fontScheme");
  const face = (which: string) => {
    const set = child(fonts, which);
    return [child(set, "a:latin")?.attrs.typeface, child(set, "a:ea")?.attrs.typeface]
      .filter(Boolean)
      .join('", "');
  };
  return { colors, major: face("a:majorFont"), minor: face("a:minorFont") };
}

// ---- text ----

/** What decides how a paragraph and its runs look; each layer may leave any of it unsaid. */
interface Style {
  align?: Paragraph["align"];
  marginLeft?: number;
  indent?: number;
  /** A character, "auto" for numbering, or null for none. */
  bullet?: string | null;
  bulletColor?: string;
  lineHeight?: number | string;
  spaceBefore?: number | { ofSize: number };
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  font?: string;
}
const ALIGN: Record<string, Paragraph["align"]> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "justify",
  dist: "justify",
};
const flag = (value: string | undefined) =>
  value === undefined ? undefined : value === "1" || value === "true";
interface Budget {
  nodes: number;
  paragraphs: number;
}
/** Bullets set in a symbol font are letters that only look right in that font; these are what they show. */
const SYMBOLS: Record<string, string> = {
  "§": "■",
  n: "■",
  l: "●",
  q: "❑",
  u: "◆",
  v: "❖",
  Ø: "➢",
  ü: "✓",
};
const symbol = (char: string | undefined, font: string | undefined) =>
  char && font && /wingdings|symbol/i.test(font) ? (has(SYMBOLS, char) ?? "•") : char;
const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];
/** A list number written the way the file asks: 1. a) IV. and so on. */
function numbered(n: number, type: string): string {
  let text = String(n);
  if (/^alpha/.test(type)) text = String.fromCharCode(97 + ((n - 1) % 26));
  else if (/^roman/.test(type)) {
    let left = Math.min(3999, Math.max(1, n));
    text = "";
    for (const [value, letters] of ROMAN)
      while (left >= value) {
        text += letters;
        left -= value;
      }
  }
  if (/Uc/.test(type)) text = text.toUpperCase();
  return /ParenBoth$/.test(type) ? `(${text})` : /ParenR$/.test(type) ? `${text})` : `${text}.`;
}
const merge = (...layers: (Style | undefined)[]): Style => {
  const out: Style = {};
  for (const layer of layers)
    if (layer)
      for (const [key, value] of Object.entries(layer))
        if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
};

function fontOf(node: Xml | undefined, theme: Theme): string | undefined {
  const names = [child(node, "a:latin")?.attrs.typeface, child(node, "a:ea")?.attrs.typeface]
    .filter((name): name is string => Boolean(name))
    .map((name) =>
      name.startsWith("+mj")
        ? theme.major
        : name.startsWith("+mn")
          ? theme.minor
          : name.replace(/["\\;]/g, ""),
    )
    .filter(Boolean);
  return names.length ? names.join('", "') : undefined;
}
function runStyle(node: Xml | undefined, palette: Palette): Style {
  if (!node) return {};
  return {
    size: pt(node.attrs.sz),
    bold: flag(node.attrs.b),
    italic: flag(node.attrs.i),
    underline: node.attrs.u === undefined ? undefined : node.attrs.u !== "none",
    color: color(child(node, "a:solidFill"), palette),
    font: fontOf(node, palette.theme),
  };
}
/** A paragraph's properties, or one level of a list of them. */
function paragraphStyle(node: Xml | undefined, palette: Palette): Style {
  if (!node) return {};
  const spacing = (name: string): Style["spaceBefore"] => {
    const points = dig(node, name, "a:spcPts")?.attrs.val;
    const percent = dig(node, name, "a:spcPct")?.attrs.val;
    return points ? pt(points) : percent ? { ofSize: Number(percent) / 100000 } : undefined;
  };
  const line = spacing("a:lnSpc");
  const bullet = child(node, "a:buNone")
    ? null
    : child(node, "a:buAutoNum")
      ? `auto:${child(node, "a:buAutoNum")?.attrs.type ?? ""}:${child(node, "a:buAutoNum")?.attrs.startAt ?? "1"}`
      : symbol(child(node, "a:buChar")?.attrs.char, child(node, "a:buFont")?.attrs.typeface);
  return merge(
    {
      align: ALIGN[node.attrs.algn ?? ""],
      marginLeft: node.attrs.marL === undefined ? undefined : px(node.attrs.marL),
      indent: node.attrs.indent === undefined ? undefined : px(node.attrs.indent),
      bullet,
      bulletColor: color(child(node, "a:buClr"), palette),
      // A share of the font's own height; 1.2 is how tall a line of it is.
      lineHeight:
        typeof line === "number"
          ? `${line}px`
          : line
            ? Math.round(line.ofSize * 120) / 100
            : undefined,
      spaceBefore: spacing("a:spcBef"),
    },
    runStyle(child(node, "a:defRPr"), palette),
  );
}
const level = (list: Xml | undefined, n: number, palette: Palette) =>
  paragraphStyle(child(list, `a:lvl${n + 1}pPr`), palette);

interface BodyProps {
  anchor?: TextBody["anchor"];
  inset: (number | undefined)[];
  wrap?: boolean;
  scale?: number;
}
function bodyProps(node: Xml | undefined): BodyProps {
  const a = node?.attrs ?? {};
  const fit = child(node, "a:normAutofit")?.attrs.fontScale;
  return {
    anchor:
      a.anchor === "ctr"
        ? "middle"
        : a.anchor === "b"
          ? "bottom"
          : a.anchor === "t"
            ? "top"
            : undefined,
    inset: [a.lIns, a.tIns, a.rIns, a.bIns].map((v) => (v === undefined ? undefined : px(v))),
    wrap: a.wrap === undefined ? undefined : a.wrap !== "none",
    scale: fit ? Number(fit) / 100000 : undefined,
  };
}

/** The layers a text takes its looks from, most general first. */
interface TextSource {
  lists: (Xml | undefined)[];
  bodies: (Xml | undefined)[];
  /** What the shape's own style says its text is, when it has one. */
  base?: Style;
}

function readText(
  body: Xml | undefined,
  source: TextSource,
  palette: Palette,
  slideNumber: number,
  budget: Budget,
): TextBody | null {
  if (!body) return null;
  const props = [...source.bodies, child(body, "a:bodyPr")].map(bodyProps);
  const pick = <T>(get: (p: BodyProps) => T | undefined): T | undefined =>
    props.reduce<T | undefined>((found, p) => get(p) ?? found, undefined);
  const scale = pick((p) => p.scale) ?? 1;
  const lists = [...source.lists, child(body, "a:lstStyle")];
  const counters: number[] = [];
  const paragraphs: Paragraph[] = [];
  for (const p of all(body, "a:p")) {
    if (budget.paragraphs-- <= 0) break;
    const own = child(p, "a:pPr");
    const n = Math.min(8, Math.max(0, Number(own?.attrs.lvl ?? 0) || 0));
    const style = merge(
      { size: 24, color: "rgb(0, 0, 0)", font: palette.theme.minor },
      ...lists.map((list) => level(list, n, palette)),
      source.base,
      paragraphStyle(own, palette),
    );
    const runs: (Run | "break")[] = [];
    for (const part of p.children) {
      if (runs.length >= RUNS_PER_PARAGRAPH) break;
      if (part.name === "a:br") runs.push("break");
      if (part.name !== "a:r" && part.name !== "a:fld") continue;
      const look = merge(style, runStyle(child(part, "a:rPr"), palette));
      const text =
        part.name === "a:fld" && part.attrs.type === "slidenum"
          ? String(slideNumber)
          : (child(part, "a:t")?.text ?? "");
      if (!text) continue;
      runs.push({
        text,
        size: (look.size ?? 24) * scale,
        bold: look.bold ?? false,
        italic: look.italic ?? false,
        underline: look.underline ?? false,
        color: look.color ?? "rgb(0, 0, 0)",
        font: look.font ?? "",
      });
    }
    const size = (merge(style, runStyle(child(p, "a:endParaRPr"), palette)).size ?? 24) * scale;
    const first = runs.find((run): run is Run => run !== "break");
    let bullet: string | null = null;
    if (style.bullet?.startsWith("auto:") && first) {
      const [, type = "", startAt = "1"] = style.bullet.split(":");
      counters.length = n + 1;
      counters[n] = (counters[n] ?? (Number(startAt) || 1) - 1) + 1;
      bullet = numbered(counters[n] as number, type);
    } else {
      counters.length = Math.min(counters.length, n);
      if (style.bullet && first) bullet = style.bullet;
    }
    const before = style.spaceBefore;
    paragraphs.push({
      align: style.align ?? "left",
      marginLeft: style.marginLeft ?? 0,
      indent: style.indent ?? 0,
      bullet,
      bulletColor: style.bulletColor ?? null,
      lineHeight: style.lineHeight ?? 1.2,
      spaceBefore:
        typeof before === "number" ? before : before ? before.ofSize * (first?.size ?? size) : 0,
      size: first?.size ?? size,
      runs,
    });
  }
  if (!paragraphs.some((p) => p.runs.length)) return null;
  const inset = [0, 1, 2, 3].map(
    (i) => pick((p) => p.inset[i]) ?? (i % 2 === 0 ? 9.6 : 4.8),
  ) as TextBody["inset"];
  return {
    anchor: pick((p) => p.anchor) ?? "top",
    inset,
    wrap: pick((p) => p.wrap) ?? true,
    paragraphs,
  };
}

// ---- shapes ----

/** Turns a position inside a group into one on the slide. */
type Place = (box: Box) => Box;

function boxOf(xfrm: Xml | undefined): Box | undefined {
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  if (!xfrm || !off || !ext) return undefined;
  return {
    x: px(off.attrs.x),
    y: px(off.attrs.y),
    w: px(ext.attrs.cx),
    h: px(ext.attrs.cy),
    rotate: Number(xfrm.attrs.rot ?? 0) / 60000,
    flipH: flag(xfrm.attrs.flipH) === true,
    flipV: flag(xfrm.attrs.flipV) === true,
  };
}

function fillOf(
  holder: Xml | undefined,
  part: string,
  parts: Parts,
  palette: Palette,
): Fill | null | undefined {
  if (!holder) return undefined;
  if (child(holder, "a:noFill")) return null;
  const solid = color(child(holder, "a:solidFill"), palette);
  if (solid) return { css: solid };
  const gradient = child(holder, "a:gradFill");
  if (gradient) {
    const stops = all(child(gradient, "a:gsLst"), "a:gs")
      .map((stop) => ({ at: Number(stop.attrs.pos ?? 0) / 1000, css: color(stop, palette) }))
      .filter((stop): stop is { at: number; css: string } => Boolean(stop.css))
      .sort((a, b) => a.at - b.at);
    if (stops.length === 1) return { css: (stops[0] as { css: string }).css };
    if (stops.length > 1) {
      const angle = Number(child(gradient, "a:lin")?.attrs.ang ?? 5400000) / 60000 + 90;
      return {
        css: `linear-gradient(${angle}deg, ${stops.map((s) => `${s.css} ${s.at}%`).join(", ")})`,
      };
    }
  }
  const image = parts.picture(part, dig(holder, "a:blipFill", "a:blip")?.attrs["r:embed"]);
  if (image) return { image };
  return undefined;
}

/** A shape drawn by hand in the file, as an SVG path. Null when it uses a curve this viewer does not draw. */
function customPath(geometry: Xml): { d: string; w: number; h: number } | null {
  const path = dig(geometry, "a:pathLst", "a:path");
  if (!path) return null;
  const point = (node: Xml) =>
    all(node, "a:pt")
      .map((p) => `${Number(p.attrs.x) || 0} ${Number(p.attrs.y) || 0}`)
      .join(" ");
  const d: string[] = [];
  for (const step of path.children) {
    if (step.name === "a:moveTo") d.push(`M ${point(step)}`);
    else if (step.name === "a:lnTo") d.push(`L ${point(step)}`);
    else if (step.name === "a:cubicBezTo") d.push(`C ${point(step)}`);
    else if (step.name === "a:quadBezTo") d.push(`Q ${point(step)}`);
    else if (step.name === "a:close") d.push("Z");
    else return null;
  }
  const w = Number(path.attrs.w);
  const h = Number(path.attrs.h);
  return d.length && w > 0 && h > 0 ? { d: d.join(" "), w, h } : null;
}

/** A master or a layout: its shapes, and what its placeholders pass down. */
interface Template {
  path: string;
  tree: Xml | undefined;
  background: Xml | undefined;
  /** Its placeholders by their number, and the first of each kind. */
  byIndex: Map<string, Xml>;
  byKind: Map<string, Xml>;
}
const placeholderOf = (shape: Xml) =>
  dig(shape, "p:nvSpPr", "p:nvPr", "p:ph") ?? dig(shape, "p:nvPicPr", "p:nvPr", "p:ph");
/** Titles are one family and everything that holds body text another, when looking a placeholder up by kind. */
const family = (type: string | undefined) =>
  type === "title" || type === "ctrTitle"
    ? "title"
    : type === "dt" || type === "ftr" || type === "sldNum"
      ? type
      : "body";
function template(parts: Parts, path: string | undefined): Template | undefined {
  const xml = path ? parts.read(path) : undefined;
  if (!path || !xml) return undefined;
  const tree = dig(xml, "p:cSld", "p:spTree");
  const byIndex = new Map<string, Xml>();
  const byKind = new Map<string, Xml>();
  for (const shape of tree?.children ?? []) {
    const ph = placeholderOf(shape);
    if (!ph) continue;
    if (ph.attrs.idx !== undefined && !byIndex.has(ph.attrs.idx)) byIndex.set(ph.attrs.idx, shape);
    if (!byKind.has(family(ph.attrs.type))) byKind.set(family(ph.attrs.type), shape);
  }
  return { path, tree, background: dig(xml, "p:cSld", "p:bg"), byIndex, byKind };
}
function matching(from: Template | undefined, ph: Xml, byKindOnly: boolean): Xml | undefined {
  if (!from) return undefined;
  return (
    (!byKindOnly && ph.attrs.idx !== undefined ? from.byIndex.get(ph.attrs.idx) : undefined) ??
    (byKindOnly || ph.attrs.type !== undefined ? from.byKind.get(family(ph.attrs.type)) : undefined)
  );
}

interface Scope {
  parts: Parts;
  /** The part being read: where its pictures are looked up. */
  part: string;
  palette: Palette;
  layout?: Template;
  master?: Template;
  masterStyles?: Xml;
  defaults?: Xml;
  slideNumber: number;
  /** Whether placeholders are drawn: on the slide itself, never on what lies behind it. */
  own: boolean;
  /** How much more of this slide may be read. */
  budget: Budget;
}

function readShape(shape: Xml, scope: Scope, place: Place): Item | null {
  const { parts, palette } = scope;
  const ph = placeholderOf(shape);
  if (ph && !scope.own) return null;
  const inLayout = ph ? matching(scope.layout, ph, false) : undefined;
  const inMaster = ph
    ? matching(scope.master, inLayout ? (placeholderOf(inLayout) as Xml) : ph, true)
    : undefined;
  const props = child(shape, "p:spPr");
  const own = boxOf(child(props, "a:xfrm"));
  const inherited =
    own ?? boxOf(dig(inLayout, "p:spPr", "a:xfrm")) ?? boxOf(dig(inMaster, "p:spPr", "a:xfrm"));
  if (!inherited) return null;
  const box = own ? place(inherited) : inherited;
  const style = child(shape, "p:style");
  const fill =
    fillOf(props, scope.part, parts, palette) ??
    (Number(child(style, "a:fillRef")?.attrs.idx) > 0
      ? (() => {
          const css = color(child(style, "a:fillRef"), palette);
          return css ? { css } : null;
        })()
      : null);
  const ln = child(props, "a:ln");
  const lineColor = ln
    ? child(ln, "a:noFill")
      ? undefined
      : (color(child(ln, "a:solidFill"), palette) ??
        (child(ln, "a:solidFill") || !(Number(child(style, "a:lnRef")?.attrs.idx) > 0)
          ? undefined
          : color(child(style, "a:lnRef"), palette)))
    : Number(child(style, "a:lnRef")?.attrs.idx) > 0
      ? color(child(style, "a:lnRef"), palette)
      : undefined;
  const line = lineColor ? { color: lineColor, width: Math.max(0.75, px(ln?.attrs.w) || 1) } : null;

  const kind = family(ph?.attrs.type);
  const fromMaster = scope.masterStyles;
  const lists = ph
    ? [
        child(
          fromMaster,
          kind === "title" ? "p:titleStyle" : kind === "body" ? "p:bodyStyle" : "p:otherStyle",
        ),
        dig(inMaster, "p:txBody", "a:lstStyle"),
        dig(inLayout, "p:txBody", "a:lstStyle"),
      ]
    : [scope.defaults, child(fromMaster, "p:otherStyle")];
  const fontColor = color(child(style, "a:fontRef"), palette);
  const text = readText(
    child(shape, "p:txBody"),
    {
      lists,
      bodies: [dig(inMaster, "p:txBody", "a:bodyPr"), dig(inLayout, "p:txBody", "a:bodyPr")],
      base: ph || !fontColor ? undefined : { color: fontColor },
    },
    palette,
    scope.slideNumber,
    scope.budget,
  );

  const custom = child(props, "a:custGeom");
  const path = custom ? customPath(custom) : null;
  const geometry = path ? "path" : (child(props, "a:prstGeom")?.attrs.prst ?? "rect");
  if (!fill && !line && !text) return null;
  const adjust = dig(props, "a:prstGeom", "a:avLst", "a:gd")?.attrs.fmla?.match(/val (\d+)/)?.[1];
  return {
    type: "shape",
    box,
    geometry,
    ...(path ? { path } : {}),
    radius:
      geometry === "roundRect"
        ? (Math.min(box.w, box.h) * (adjust ? Number(adjust) : 16667)) / 100000
        : 0,
    fill,
    line,
    text,
  };
}

function readTable(table: Xml, box: Box, scope: Scope): Item {
  const { palette } = scope;
  const accent = color(
    {
      name: "",
      attrs: {},
      text: "",
      children: [{ name: "a:schemeClr", attrs: { val: "accent1" }, children: [], text: "" }],
    },
    palette,
  );
  const header = flag(child(table, "a:tblPr")?.attrs.firstRow) === true;
  const banded = flag(child(table, "a:tblPr")?.attrs.bandRow) === true;
  const rows = all(table, "a:tr").map((row, r) => ({
    height: px(row.attrs.h),
    cells: all(row, "a:tc")
      .filter((cell) => !flag(cell.attrs.hMerge) && !flag(cell.attrs.vMerge))
      .map((cell): Cell => {
        const set = fillOf(child(cell, "a:tcPr"), scope.part, scope.parts, palette);
        const styled = header && r === 0;
        const fill =
          set && "css" in set
            ? set.css
            : set === null
              ? null
              : styled
                ? (accent ?? null)
                : banded && r % 2 === 1
                  ? "rgba(128, 128, 128, 0.12)"
                  : null;
        return {
          text: readText(
            child(cell, "a:txBody"),
            {
              lists: [scope.defaults],
              bodies: [],
              base:
                styled && set === undefined
                  ? { color: "rgb(255, 255, 255)", bold: true }
                  : undefined,
            },
            palette,
            scope.slideNumber,
            scope.budget,
          ),
          fill,
          borders: ["a:lnL", "a:lnT", "a:lnR", "a:lnB"].map((side) => {
            const ln = child(child(cell, "a:tcPr"), side);
            // A table with no lines of its own gets the faint grid a presentation program gives it.
            if (!ln)
              return child(cell, "a:tcPr")?.children.some((c) => /^a:ln[LTRB]$/.test(c.name))
                ? null
                : "1px solid rgba(128, 128, 128, 0.35)";
            const css = child(ln, "a:noFill")
              ? undefined
              : color(child(ln, "a:solidFill"), palette);
            return css ? `${Math.max(1, Math.round(px(ln.attrs.w) || 1))}px solid ${css}` : null;
          }),
          colSpan: Number(cell.attrs.gridSpan ?? 1) || 1,
          rowSpan: Number(cell.attrs.rowSpan ?? 1) || 1,
        };
      }),
  }));
  return {
    type: "table",
    box,
    columns: all(child(table, "a:tblGrid"), "a:gridCol").map((col) => px(col.attrs.w)),
    rows,
  };
}

function readTree(tree: Xml | undefined, scope: Scope, place: Place, out: Item[], depth = 0): void {
  if (!tree || depth > 12) return;
  for (const node of tree.children) {
    if (scope.budget.nodes-- <= 0) return;
    // What the author hid stays hidden.
    if (flag(node.children[0]?.children.find((c) => c.name === "p:cNvPr")?.attrs.hidden)) continue;
    if (node.name === "p:sp" || node.name === "p:cxnSp") {
      const item = readShape(node, scope, place);
      if (item) out.push(item);
    } else if (node.name === "p:pic") {
      const ph = placeholderOf(node);
      if (ph && !scope.own) continue;
      // A picture dropped into a placeholder sits where its layout, or failing that its master, puts it.
      const inLayout = ph ? matching(scope.layout, ph, false) : undefined;
      const box =
        boxOf(dig(node, "p:spPr", "a:xfrm")) ??
        boxOf(dig(inLayout, "p:spPr", "a:xfrm")) ??
        (ph
          ? boxOf(
              dig(
                matching(scope.master, inLayout ? (placeholderOf(inLayout) as Xml) : ph, true),
                "p:spPr",
                "a:xfrm",
              ),
            )
          : undefined);
      if (!box) continue;
      const fill = child(node, "p:blipFill");
      const image = scope.parts.picture(scope.part, child(fill, "a:blip")?.attrs["r:embed"]);
      const rect = child(fill, "a:srcRect")?.attrs ?? {};
      // Never more than 45% from a side, so something of the picture is always left.
      const crop = [rect.l, rect.t, rect.r, rect.b].map((v) =>
        Math.min(0.45, Math.max(0, Number(v ?? 0) / 100000 || 0)),
      );
      out.push(
        image && SHOWN.test(image)
          ? {
              type: "image",
              box: place(box),
              image,
              crop: crop as [number, number, number, number],
            }
          : {
              type: "other",
              box: place(box),
              what: dig(node, "p:nvPicPr", "p:nvPr")?.children.some((c) =>
                /video|audio/i.test(c.name),
              )
                ? "media"
                : "picture",
            },
      );
    } else if (node.name === "p:graphicFrame") {
      const box = boxOf(child(node, "p:xfrm"));
      const data = dig(node, "a:graphic", "a:graphicData");
      if (!box || !data) continue;
      const table = child(data, "a:tbl");
      if (table) out.push(readTable(table, place(box), scope));
      else if (/chart/.test(data.attrs.uri ?? "")) {
        const target = has(
          scope.parts.relations(scope.part),
          child(data, "c:chart")?.attrs["r:id"] ?? "",
        )?.target;
        const { palette } = scope;
        const chart = target
          ? readChart(
              scope.parts.read(target),
              (holder) => color(holder, palette),
              [1, 2, 3, 4, 5, 6]
                .map((n) => palette.theme.colors[`accent${n}`])
                .filter((hex): hex is string => Boolean(hex))
                .map((hex) => `#${hex}`),
            )
          : null;
        out.push(
          chart
            ? { type: "chart", box: place(box), chart }
            : { type: "other", box: place(box), what: "chart" },
        );
      } else out.push({ type: "other", box: place(box), what: "diagram" });
    } else if (node.name === "p:grpSp") {
      const xfrm = dig(node, "p:grpSpPr", "a:xfrm");
      const outer = boxOf(xfrm);
      const inner = boxOf({
        name: "",
        text: "",
        attrs: {},
        children: [
          { ...(child(xfrm, "a:chOff") ?? { attrs: {}, children: [], text: "" }), name: "a:off" },
          { ...(child(xfrm, "a:chExt") ?? { attrs: {}, children: [], text: "" }), name: "a:ext" },
        ],
      });
      const within: Place =
        outer && inner && inner.w > 0 && inner.h > 0
          ? (box) =>
              place({
                ...box,
                x: outer.x + ((box.x - inner.x) * outer.w) / inner.w,
                y: outer.y + ((box.y - inner.y) * outer.h) / inner.h,
                w: (box.w * outer.w) / inner.w,
                h: (box.h * outer.h) / inner.h,
              })
          : place;
      readTree(node, scope, within, out, depth + 1);
    } else if (node.name === "mc:AlternateContent") {
      // What an older program is told to show instead: a picture of the newer thing.
      readTree(
        child(node, "mc:Fallback") ?? child(node, "mc:Choice"),
        scope,
        place,
        out,
        depth + 1,
      );
    }
  }
}
/** Picture formats a browser draws. */
// A drawing in SVG is a document of its own; it is not given an address in this page.
const SHOWN = /\.(png|jpe?g|gif|webp|bmp)$/i;

function backgroundOf(
  bg: Xml | undefined,
  part: string,
  parts: Parts,
  palette: Palette,
): Fill | null | undefined {
  if (!bg) return undefined;
  const set = fillOf(child(bg, "p:bgPr"), part, parts, palette);
  if (set !== undefined) return set;
  const named = color(child(bg, "p:bgRef"), palette);
  return named ? { css: named } : undefined;
}

/** Reads a .pptx into slides that can be drawn. Throws NotSlides when it is not one, or is too large to open here. */
export function readDeck(bytes: Uint8Array): Deck {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const wanted =
          /^(ppt\/|\[Content_Types\])/.test(file.name) && !/\.(bin|xlsx|vml)$/i.test(file.name);
        if (!wanted) return false;
        total += file.originalSize;
        if (file.originalSize > PART_BYTES || total > TOTAL_BYTES)
          throw new NotSlides("This presentation is too large to open here.");
        return true;
      },
    });
  } catch (error) {
    throw error instanceof NotSlides ? error : new NotSlides("This file is not a presentation.");
  }
  const parts = new Parts(files);
  const main = "ppt/presentation.xml";
  const presentation = parts.read(main);
  if (!presentation) throw new NotSlides("This file is not a presentation.");
  const size = child(presentation, "p:sldSz");
  const width = px(size?.attrs.cx) || 960;
  const height = px(size?.attrs.cy) || 540;
  const relations = parts.relations(main);
  const paths = all(child(presentation, "p:sldIdLst"), "p:sldId")
    .map((id) => relations[id.attrs["r:id"] ?? ""]?.target)
    .filter((path): path is string => Boolean(path))
    .slice(0, SLIDE_LIMIT);

  const palettes = new Map<string, Palette>();
  const slides = paths.map((path, index): Slide => {
    const xml = parts.read(path);
    const layout = template(parts, parts.related(path, "slideLayout"));
    const masterPath = layout ? parts.related(layout.path, "slideMaster") : undefined;
    const master = template(parts, masterPath);
    const masterXml = masterPath ? parts.read(masterPath) : undefined;
    let palette = palettes.get(masterPath ?? "");
    if (!palette) {
      const names = child(masterXml, "p:clrMap")?.attrs ?? {};
      palette = {
        theme: readTheme(
          masterPath ? parts.read(parts.related(masterPath, "theme") ?? "") : undefined,
        ),
        map: { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", ...names },
      };
      palettes.set(masterPath ?? "", palette);
    }
    const scope: Scope = {
      parts,
      part: path,
      palette,
      layout,
      master,
      masterStyles: child(masterXml, "p:txStyles"),
      defaults: child(presentation, "p:defaultTextStyle"),
      slideNumber: index + 1,
      own: true,
      budget: { nodes: NODES_PER_SLIDE, paragraphs: PARAGRAPHS_PER_SLIDE },
    };
    const items: Item[] = [];
    const same: Place = (box) => box;
    // What lies behind the slide's own content: the master's and the layout's shapes and pictures.
    const layoutXml = layout ? parts.read(layout.path) : undefined;
    const shown = (part: Xml | undefined) => flag(part?.attrs.showMasterSp) !== false;
    if (master && shown(xml) && shown(layoutXml))
      readTree(master.tree, { ...scope, part: master.path, own: false }, same, items);
    if (layout && shown(xml))
      readTree(layout.tree, { ...scope, part: layout.path, own: false }, same, items);
    readTree(dig(xml, "p:cSld", "p:spTree"), scope, same, items);

    const background =
      backgroundOf(dig(xml, "p:cSld", "p:bg"), path, parts, palette) ??
      (layout ? backgroundOf(layout.background, layout.path, parts, palette) : undefined) ??
      (master ? backgroundOf(master.background, master.path, parts, palette) : undefined) ??
      null;

    const notesPath = parts.related(path, "notesSlide");
    const notes = all(
      dig(notesPath ? parts.read(notesPath) : undefined, "p:cSld", "p:spTree"),
      "p:sp",
    )
      .filter((shape) => placeholderOf(shape)?.attrs.type === "body")
      .flatMap((shape) => all(child(shape, "p:txBody"), "a:p"))
      .map((p) =>
        p.children
          .filter((c) => c.name === "a:r" || c.name === "a:fld")
          .map((run) => child(run, "a:t")?.text ?? "")
          .join(""),
      )
      .join("\n")
      .trim();
    return { background, items, notes };
  });
  if (!slides.length) throw new NotSlides("This presentation has no slides.");
  return { width, height, slides, media: parts.media() };
}
