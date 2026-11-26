import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useI18n } from "./i18n";
import {
  areaPath,
  bars,
  compact,
  fitLabel,
  layout,
  linePath,
  niceScale,
  plain,
  withUnit,
} from "./lib/chart";
import {
  comboSplit,
  kept,
  PALETTE,
  type Palette,
  radarPath,
  type Step,
  slices,
  span,
  spoke,
  stackSums,
  type Up,
  waterfall,
} from "./lib/visuals";
import { mono, useColors } from "./theme";
import { DIAGRAM_PAGE } from "./vendor/diagram-page";

/** The colours values are shown in, for the appearance in effect. */
export const usePalette = (): Palette => (useColors().dark ? PALETTE.dark : PALETTE.light);

/** The frame a chart or a diagram sits in: its title, and one switch on the right. */
export function Frame({
  title,
  toggle,
  children,
}: {
  title: string;
  toggle?: { label: string; on: boolean; press(): void };
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <View style={[styles.frame, { borderColor: c.border }]}>
      <View style={[styles.bar, { borderColor: c.border }]}>
        <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
          {title}
        </Text>
        {toggle && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: toggle.on }}
            hitSlop={8}
            onPress={toggle.press}
          >
            <Text style={{ fontSize: 12, color: c.accentText }}>{toggle.label}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

const HEIGHT = 200;
/** A chart has at most this many series: a fifth is not a fifth colour. */
const MOST_SERIES = 4;

interface Series {
  name: string;
  values: number[];
}
export type ChartKind =
  | "bar"
  | "hbar"
  | "stacked"
  | "line"
  | "area"
  | "pie"
  | "radar"
  | "combo"
  | "waterfall";

/** The numbers behind a drawing, as a small table that scrolls sideways. */
export function Numbers({ head, rows }: { head: string[]; rows: string[][] }) {
  const c = useColors();
  return (
    <ScrollView horizontal bounces={false}>
      <View style={{ padding: 10 }}>
        <View style={styles.row}>
          {head.map((name, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: columns of one table never reorder
              key={index}
              numberOfLines={1}
              style={[styles.cell, index === 0 && styles.first, { color: c.muted }]}
            >
              {name}
            </Text>
          ))}
        </View>
        {rows.map((row, at) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of one table never reorder
            key={at}
            style={[
              styles.row,
              { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border },
            ]}
          >
            {head.map((_, index) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                key={index}
                numberOfLines={1}
                style={[styles.cell, index === 0 ? styles.first : styles.number, { color: c.text }]}
              >
                {row[index] ?? ""}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Each thing a colour stands for, named beside its colour. */
export function Legend({ items }: { items: { name: string; color: string }[] }) {
  const c = useColors();
  return (
    <View style={styles.legend}>
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: series of one chart never reorder
        <View key={index} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: item.color }]} />
          <Text numberOfLines={1} style={{ fontSize: 12, color: c.muted, flexShrink: 1 }}>
            {item.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The shares of one whole, as a ring with each share named under it. */
function Pie({
  labels,
  values,
  value,
  width,
  title,
}: {
  labels: string[];
  values: number[];
  value(n: number): string;
  width: number;
  title: string;
}) {
  const { t } = useI18n();
  const c = useColors();
  const palette = usePalette();
  const size = Math.max(60, Math.min(width, 168));
  const parts = slices(values, size / 2, size / 2, size / 2 - 1, size / 4);
  if (parts.length === 0) return null;
  const named = parts.map((part, at) => ({
    name: part.index < 0 ? t.app.visual.other : (labels[part.index] ?? ""),
    color: part.index < 0 ? palette.other : (palette.series[at] ?? palette.other),
    part,
  }));
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <Svg
        width={size}
        height={size}
        accessibilityRole="image"
        accessibilityLabel={`${title}. ${named
          .map((item) => `${item.name}: ${value(item.part.value)}`)
          .join(". ")}`}
      >
        {named.map((item, at) => (
          <Path
            // biome-ignore lint/suspicious/noArrayIndexKey: slices of one pie never reorder
            key={at}
            d={item.part.path}
            fill={item.color}
            // The page between two slices, so that neighbours never run together.
            stroke={c.page}
            strokeWidth={2}
          />
        ))}
      </Svg>
      <View style={{ alignSelf: "stretch", gap: 3 }}>
        {named.map((item, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: slices of one pie never reorder
          <View key={at} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={[styles.swatch, { backgroundColor: item.color }]} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: c.text }}>
              {item.name}
            </Text>
            <Text style={[styles.number, { fontSize: 12, color: c.muted }]}>
              {value(item.part.value) === `${Math.round(item.part.share * 100)}%`
                ? value(item.part.value)
                : `${value(item.part.value)} · ${Math.round(item.part.share * 100)}%`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A few things compared on the same measures, each an outline round one middle. */
function Radar({
  labels,
  shown,
  colors,
  width,
  title,
  value,
}: {
  labels: string[];
  shown: Series[];
  colors: readonly string[];
  width: number;
  title: string;
  value(n: number): string;
}) {
  const c = useColors();
  const count = labels.length;
  if (count < 3) return null;
  const size = Math.max(120, Math.min(width, 260));
  const height = size * 0.86;
  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = height / 2 - 22;
  const scale = niceScale(shown.flatMap((item) => item.values.slice(0, count)));
  const rings = scale.ticks.filter((tick) => tick > 0);
  const ring = (share: number) =>
    `M${Array.from({ length: count }, (_, index) => {
      const at = spoke(cx, cy, radius * share, index, count);
      return `${at.x.toFixed(1)} ${at.y.toFixed(1)}`;
    }).join(" L")} Z`;
  return (
    <Svg
      width={width}
      height={height + 8}
      accessibilityRole="image"
      accessibilityLabel={`${title}. ${shown
        .map((item) => `${item.name}: ${item.values.slice(0, count).map(value).join(", ")}`)
        .join(". ")}`}
    >
      {rings.map((tick) => (
        <Path
          key={`r${tick}`}
          d={ring(tick / scale.max)}
          stroke={c.border}
          strokeWidth={1}
          fill="none"
        />
      ))}
      {labels.map((label, index) => {
        const end = spoke(cx, cy, radius, index, count);
        const at = spoke(cx, cy, radius + 10, index, count);
        return [
          <Line
            // biome-ignore lint/suspicious/noArrayIndexKey: spokes follow the labels
            key={`k${index}`}
            x1={cx}
            y1={cy}
            x2={end.x}
            y2={end.y}
            stroke={c.border}
            strokeWidth={StyleSheet.hairlineWidth}
          />,
          <SvgText
            // biome-ignore lint/suspicious/noArrayIndexKey: spokes follow the labels
            key={`l${index}`}
            x={at.x}
            y={at.y + 3.5}
            fontSize={10}
            fill={c.muted}
            textAnchor={Math.abs(at.x - cx) < 4 ? "middle" : at.x > cx ? "start" : "end"}
          >
            {fitLabel(label, 64)}
          </SvgText>,
        ];
      })}
      {shown.map((item, index) => (
        <Path
          // biome-ignore lint/suspicious/noArrayIndexKey: series of one chart never reorder
          key={`s${index}`}
          d={radarPath(item.values, count, cx, cy, radius, scale.max)}
          stroke={colors[index]}
          strokeWidth={2}
          strokeLinejoin="round"
          fill={colors[index]}
          fillOpacity={0.14}
        />
      ))}
    </Svg>
  );
}

/** A line across a drawing at a value worth measuring against: a target, an average. */
interface Target {
  value: number;
  name: string;
}

/** Bars lying down: a row for each label, its name written whole and its number at the bar's end. */
function HBars({
  labels,
  shown,
  colors,
  value,
  moved,
  target,
  width,
}: {
  labels: string[];
  shown: Series[];
  colors: readonly string[];
  value(n: number): string;
  /** One series of changes: the colour of a rise and of a fall. */
  moved: { rise: string; fall: string; still: string } | null;
  target: Target | null;
  width: number;
}) {
  const c = useColors();
  const all = shown.flatMap((item) => item.values.slice(0, labels.length)).filter(Number.isFinite);
  const negative = all.some((n) => n < 0);
  // The line is drawn where every bar starts at the left edge: with bars both ways it is not.
  const line = target && !negative && target.value > 0 ? target : null;
  const most = Math.max(0, ...all.map(Math.abs), line ? line.value : 0);
  // What a bar may take: the row without its number and the gap before it.
  const room = Math.max(0, width - 70);
  const at = line && most > 0 ? (line.value / most) * room : 0;
  return (
    <View style={{ gap: 7 }}>
      {line ? (
        <Text
          numberOfLines={1}
          style={{
            fontSize: 10,
            color: c.muted,
            marginLeft: Math.max(0, Math.min(room - 4, at) - 4),
          }}
        >
          {line.name || value(line.value)}
        </Text>
      ) : null}
      <View style={{ gap: 7 }}>
        {labels.map((label, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels of one chart never reorder
          <View key={index} style={{ gap: 2 }}>
            <Text numberOfLines={1} style={{ fontSize: 12, color: c.text }}>
              {label}
            </Text>
            {shown.map((item, which) => {
              const n = item.values[index];
              if (n === undefined || !Number.isFinite(n)) return null;
              const share = most > 0 ? Math.abs(n) / most : 0;
              const fill = moved
                ? n < 0
                  ? moved.fall
                  : n > 0
                    ? moved.rise
                    : moved.still
                : colors[which];
              const bar = (
                <View
                  style={{
                    width: `${Math.max(1, share * 100)}%`,
                    height: 10,
                    borderRadius: 3,
                    backgroundColor: fill,
                  }}
                />
              );
              return (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: series of one chart never reorder
                  key={which}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                  accessibilityLabel={`${label}, ${item.name}: ${value(n)}`}
                >
                  {negative && (
                    <View style={{ flex: 1, alignItems: "flex-end" }}>{n < 0 ? bar : null}</View>
                  )}
                  <View style={{ flex: negative ? 1 : 2 }}>{n >= 0 ? bar : null}</View>
                  <Text
                    numberOfLines={1}
                    style={[styles.number, { width: 64, fontSize: 11, color: c.muted }]}
                  >
                    {value(n)}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
        {line ? (
          <Svg
            width={2}
            height="100%"
            style={{ position: "absolute", left: at, top: 0, bottom: 0 }}
            pointerEvents="none"
          >
            <Line
              x1={1}
              x2={1}
              y1={0}
              y2="100%"
              stroke={c.muted}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          </Svg>
        ) : null}
      </View>
    </View>
  );
}

/** The grid, the numbers up the side and the names along the bottom that upright drawings share. */
function Axes({
  box,
  at,
  labels,
  names,
  bottom,
  tick,
  target,
}: {
  box: { left: number; top: number; width: number; height: number };
  at: ReturnType<typeof layout>;
  labels: string[];
  /** Whether the names are written: the upper of two panels leaves them to the lower. */
  names: boolean;
  bottom: number;
  tick(n: number): string;
  target: Target | null;
}) {
  const c = useColors();
  const slot = labels.length > 0 ? box.width / labels.length : box.width;
  // A name has the room of its own slot and of the slots left empty beside it.
  const every = Math.max(1, at.shown.indexOf(true, 1) > 0 ? at.shown.indexOf(true, 1) : 1);
  const room = Math.max(8, slot * every - 4);
  return (
    <>
      {at.scale.ticks.map((value) => (
        <Line
          key={`g${value}`}
          x1={box.left}
          x2={box.left + box.width}
          y1={at.y(value)}
          y2={at.y(value)}
          stroke={c.border}
          strokeWidth={value === 0 ? 1 : StyleSheet.hairlineWidth}
        />
      ))}
      {at.scale.ticks.map((value) => (
        <SvgText
          key={`t${value}`}
          x={box.left - 6}
          y={at.y(value) + 3.5}
          fontSize={10}
          fill={c.muted}
          textAnchor="end"
        >
          {tick(value)}
        </SvgText>
      ))}
      {names &&
        labels.map((label, index) =>
          at.shown[index] ? (
            <SvgText
              // biome-ignore lint/suspicious/noArrayIndexKey: labels of one chart never reorder
              key={`l${index}`}
              x={at.centers[index]}
              y={bottom}
              fontSize={10}
              fill={c.muted}
              textAnchor="middle"
            >
              {fitLabel(label, room)}
            </SvgText>
          ) : null,
        )}
      {target ? (
        <>
          <Line
            x1={box.left}
            x2={box.left + box.width}
            y1={at.y(target.value)}
            y2={at.y(target.value)}
            stroke={c.muted}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          {target.name ? (
            <SvgText
              x={box.left + box.width}
              y={at.y(target.value) - 3}
              fontSize={9}
              fill={c.muted}
              textAnchor="end"
            >
              {fitLabel(target.name, box.width / 2, 9)}
            </SvgText>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** One upright drawing on one scale: bars side by side, parts stacked, lines or areas. */
function Plot({
  title,
  width,
  height,
  labels,
  shown,
  colors,
  mode,
  moved,
  target,
  names,
  free = false,
  value,
  tick,
}: {
  title: string;
  width: number;
  height: number;
  labels: string[];
  shown: Series[];
  colors: readonly string[];
  mode: "bar" | "stacked" | "line" | "area";
  /** The scale covers the numbers and need not start at zero: lines whose movement is the point. */
  free?: boolean;
  moved: { rise: string; fall: string; still: string } | null;
  target: Target | null;
  names: boolean;
  value(n: number): string;
  tick(n: number): string;
}) {
  const stacked = mode === "stacked";
  const sums = stacked ? stackSums(shown, labels.length) : null;
  const box = {
    left: 44,
    top: 8,
    width: Math.max(10, width - 52),
    height: height - (names ? 32 : 14),
  };
  const measured = [
    ...(sums ? [{ values: sums.above }, { values: sums.below }] : shown),
    // The scale reaches the line it is measured against.
    ...(target ? [{ values: [target.value] }] : []),
  ];
  const at = layout(
    box,
    labels.length,
    measured,
    44,
    free
      ? span(
          measured.flatMap((item) => item.values.slice(0, labels.length)),
          3,
        )
      : undefined,
  );
  const slot = box.width / Math.max(1, labels.length);
  return (
    <Svg
      width={width}
      height={height}
      accessibilityRole="image"
      accessibilityLabel={`${title}. ${shown
        .map((item) => `${item.name}: ${item.values.filter(Number.isFinite).map(value).join(", ")}`)
        .join(". ")}`}
    >
      <Axes
        box={box}
        at={at}
        labels={labels}
        names={names}
        bottom={height - 8}
        tick={tick}
        target={target}
      />
      {mode === "bar" &&
        shown.map((item, index) =>
          bars(at, item.values, index, shown.length, slot).map((bar, place) =>
            bar ? (
              <Rect
                // biome-ignore lint/suspicious/noArrayIndexKey: bars follow the labels
                key={`b${index}-${place}`}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx={Math.min(3, bar.width / 2)}
                fill={
                  moved
                    ? (item.values[place] ?? 0) < 0
                      ? moved.fall
                      : (item.values[place] ?? 0) > 0
                        ? moved.rise
                        : moved.still
                    : colors[index]
                }
              />
            ) : null,
          ),
        )}
      {stacked &&
        labels.map((_, place) => {
          const wide = Math.max(1, slot * 0.6);
          const x = (at.centers[place] ?? 0) - wide / 2;
          let above = 0;
          let below = 0;
          return shown.map((item, index) => {
            const n = item.values[place];
            if (n === undefined || !Number.isFinite(n) || n === 0) return null;
            const from = n > 0 ? above : below;
            if (n > 0) above += n;
            else below += n;
            const top = at.y(Math.max(from, from + n));
            const bottom = at.y(Math.min(from, from + n));
            return (
              <Rect
                // biome-ignore lint/suspicious/noArrayIndexKey: parts follow the series and the labels
                key={`k${index}-${place}`}
                x={x}
                y={top}
                width={wide}
                // The page shows between two parts of one bar.
                height={Math.max(0.5, bottom - top - 2)}
                rx={Math.min(2, wide / 2)}
                fill={colors[index]}
              />
            );
          });
        })}
      {(mode === "line" || mode === "area") &&
        shown.map((item, index) => {
          const area = mode === "area" ? areaPath(at, item.values) : "";
          return [
            area ? (
              <Path
                // biome-ignore lint/suspicious/noArrayIndexKey: series of one chart never reorder
                key={`a${index}`}
                d={area}
                fill={colors[index]}
                fillOpacity={0.15}
              />
            ) : null,
            <Path
              // biome-ignore lint/suspicious/noArrayIndexKey: series of one chart never reorder
              key={`s${index}`}
              d={linePath(at, item.values)}
              stroke={colors[index]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
            />,
          ];
        })}
    </Svg>
  );
}

/**
 * How an amount became another: the opening amount, each change as a bar from where the
 * last one ended, and the closing total, which is added here.
 */
function Falls({
  title,
  width,
  labels,
  steps,
  moved,
  target,
  value,
  tick,
}: {
  title: string;
  width: number;
  labels: string[];
  steps: Step[];
  moved: { rise: string; fall: string; still: string } | null;
  target: Target | null;
  value(n: number): string;
  tick(n: number): string;
}) {
  const c = useColors();
  const palette = usePalette();
  const box = { left: 44, top: 8, width: Math.max(10, width - 52), height: HEIGHT - 32 };
  const at = layout(box, steps.length, [
    { values: steps.map((step) => step.from) },
    { values: steps.map((step) => step.to) },
    ...(target ? [{ values: [target.value] }] : []),
  ]);
  const slot = box.width / Math.max(1, steps.length);
  const wide = Math.max(1, slot * 0.62);
  return (
    <Svg
      width={width}
      height={HEIGHT}
      accessibilityRole="image"
      accessibilityLabel={`${title}. ${steps
        .filter((step) => Number.isFinite(step.change))
        .map((step, index) => `${labels[index] ?? ""}: ${value(step.change)}`)
        .join(". ")}`}
    >
      <Axes
        box={box}
        at={at}
        labels={labels}
        names
        bottom={HEIGHT - 8}
        tick={tick}
        target={target}
      />
      {steps.map((step, index) => {
        if (!Number.isFinite(step.change)) return null;
        const x = (at.centers[index] ?? 0) - wide / 2;
        const top = at.y(Math.max(step.from, step.to));
        const bottom = at.y(Math.min(step.from, step.to));
        const fill =
          step.kind !== "change"
            ? palette.other
            : step.change === 0
              ? palette.other
              : moved
                ? step.change > 0
                  ? moved.rise
                  : moved.fall
                : step.change > 0
                  ? palette.blue
                  : palette.orange;
        const next = at.centers[index + 1];
        return [
          <Rect
            // biome-ignore lint/suspicious/noArrayIndexKey: steps follow the labels
            key={`w${index}`}
            x={x}
            y={top}
            width={wide}
            height={Math.max(1, bottom - top)}
            rx={Math.min(3, wide / 2)}
            fill={fill}
          />,
          // From where this one ends to where the next begins: the eye carries the total over.
          next !== undefined && step.kind !== "close" ? (
            <Line
              // biome-ignore lint/suspicious/noArrayIndexKey: steps follow the labels
              key={`c${index}`}
              x1={x + wide}
              x2={next - wide / 2}
              y1={at.y(step.total)}
              y2={at.y(step.total)}
              stroke={c.muted}
              strokeWidth={StyleSheet.hairlineWidth}
            />
          ) : null,
        ];
      })}
    </Svg>
  );
}

/**
 * Numbers an agent charted: one scale to a drawing, at most four series in fixed colours,
 * and the numbers themselves one tap away. Nine kinds. Two measures of different scale are
 * two drawings over the same names, never two scales on one. With `up`, one series of
 * changes is coloured bar by bar as rises and falls.
 */
export function ChartView({
  title,
  kind,
  labels: given,
  series,
  unit = "",
  up,
  target: line,
  targetName = "",
  unit2 = "",
}: {
  title: string;
  kind: ChartKind;
  labels: string[];
  series: Series[];
  unit?: string;
  up?: Up;
  target?: number;
  targetName?: string;
  unit2?: string;
}) {
  const { t, locale } = useI18n();
  const palette = usePalette();
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const colors = palette.series;
  // A pie is the shares of one whole, and a waterfall one amount on its way: one series.
  const one = kind === "pie" || kind === "waterfall";
  const cut = kept(kind, given, series.slice(0, one ? 1 : MOST_SERIES));
  const labels = cut.labels;
  const shown = cut.series;
  if (labels.length === 0 || shown.length === 0) return null;
  const combo = kind === "combo" ? comboSplit(shown) : null;
  const value = (n: number) => withUnit(plain(n), unit);
  const second = (n: number) => withUnit(plain(n), unit2);
  /** Each series in its own unit: in a combo the lines have theirs. */
  const written = (index: number) => (combo && index > 0 ? second : value);
  const tick = (n: number) => compact(n, locale === "zh");
  const moved =
    up && shown.length === 1
      ? {
          rise: up === "red" ? palette.red : palette.green,
          fall: up === "red" ? palette.green : palette.red,
          still: palette.other,
        }
      : null;
  const target =
    line !== undefined && Number.isFinite(line) && kind !== "pie" && kind !== "radar"
      ? { value: line, name: targetName }
      : null;
  const steps =
    kind === "waterfall" ? waterfall(shown[0]?.values.slice(0, labels.length) ?? []) : [];
  if (kind === "waterfall" && steps.length === 0) return null;
  const head =
    kind === "waterfall"
      ? ["", t.app.visual.change, t.app.visual.total]
      : ["", ...shown.map((item) => item.name)];
  const rows =
    kind === "waterfall"
      ? steps.map((step, index) => [
          step.kind === "close" ? t.app.visual.total : (labels[index] ?? ""),
          step.kind === "close" ? "" : value(step.change),
          value(step.total),
        ])
      : labels.map((label, at) => [
          label,
          // A place without a number is left empty, not written as one.
          ...shown.map((item, index) => {
            const n = item.values[at];
            return n === undefined || !Number.isFinite(n) ? "" : written(index)(n);
          }),
        ]);
  return (
    <Frame
      title={title}
      toggle={{
        label: table ? t.app.visual.chart : t.app.visual.numbers,
        on: table,
        press: () => setTable(!table),
      }}
    >
      {table ? (
        <Numbers head={head} rows={rows} />
      ) : (
        <View
          style={{ padding: 8 }}
          onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width) - 16)}
        >
          {/* With one series the title names it; with more, each has its colour named here. */}
          {shown.length > 1 && (
            <Legend
              items={shown.map((item, index) => ({ name: item.name, color: colors[index] ?? "" }))}
            />
          )}
          {width > 0 && kind === "pie" && (
            <Pie
              labels={labels}
              values={shown[0]?.values.slice(0, labels.length) ?? []}
              value={value}
              width={width}
              title={title}
            />
          )}
          {width > 0 && kind === "radar" && (
            <Radar
              labels={labels}
              shown={shown}
              colors={colors}
              width={width}
              title={title}
              value={value}
            />
          )}
          {kind === "hbar" && (
            <HBars
              labels={labels}
              shown={shown}
              colors={colors}
              value={value}
              moved={moved}
              target={target}
              width={width}
            />
          )}
          {width > 0 && kind === "waterfall" && (
            <Falls
              title={title}
              width={width}
              labels={[...labels, t.app.visual.total]}
              steps={steps}
              moved={moved}
              target={target}
              value={value}
              tick={tick}
            />
          )}
          {width > 0 && combo && (
            <>
              <Plot
                title={title}
                width={width}
                height={combo.lines.length > 0 ? 150 : HEIGHT}
                labels={labels}
                shown={combo.bars}
                colors={colors}
                mode="bar"
                moved={null}
                target={target}
                names={combo.lines.length === 0}
                value={value}
                tick={tick}
              />
              {combo.lines.length > 0 && (
                <Plot
                  title={title}
                  width={width}
                  height={112}
                  labels={labels}
                  shown={combo.lines}
                  // Each keeps the colour the legend gave it.
                  colors={colors.slice(1)}
                  mode="line"
                  moved={null}
                  target={null}
                  names
                  // A margin moving between 31% and 36% is the point: its scale starts near it.
                  free
                  value={second}
                  tick={tick}
                />
              )}
            </>
          )}
          {width > 0 &&
            (kind === "bar" || kind === "stacked" || kind === "line" || kind === "area") && (
              <Plot
                title={title}
                width={width}
                height={HEIGHT}
                labels={labels}
                shown={shown}
                colors={colors}
                mode={kind}
                moved={moved}
                target={target}
                names
                value={value}
                tick={tick}
              />
            )}
        </View>
      )}
    </Frame>
  );
}

/** How long the page gets to load Mermaid and draw before the source is shown instead. */
const PATIENCE_MS = 8000;

/**
 * A diagram drawn from Mermaid source an agent wrote. Mermaid needs a browser's page to lay a
 * diagram out, so it runs in a web view that holds nothing but the copy of Mermaid shipped in
 * this app: the page cannot load anything or go anywhere, and Mermaid draws in its strict mode,
 * where labels are text and nothing in a diagram can run or link out. Source that does not
 * parse, or a page that does not answer, is shown as source.
 */
export function DiagramView({ title, code }: { title: string; code: string }) {
  const { t } = useI18n();
  const c = useColors();
  const view = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(0);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(false);

  useEffect(() => {
    if (!ready) return;
    // A reply arrives piece by piece; wait for the source to settle before drawing.
    const timer = setTimeout(() => {
      view.current?.injectJavaScript(
        `window.draw(${JSON.stringify(code)}, ${c.dark ? "true" : "false"}); true;`,
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, code, c.dark]);
  useEffect(() => {
    if (height > 0 || failed) return;
    const timer = setTimeout(() => setFailed(true), PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [height, failed]);

  const onMessage = (event: WebViewMessageEvent) => {
    let message: { type?: string; height?: number };
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === "ready") setReady(true);
    if (message.type === "drawn" && typeof message.height === "number") {
      setFailed(false);
      setHeight(Math.min(2000, Math.max(40, message.height)));
    }
    if (message.type === "failed") {
      setFailed(true);
      setHeight(0);
    }
  };
  const asSource = source || failed;
  return (
    <Frame
      title={title}
      toggle={
        failed
          ? undefined
          : {
              label: source ? t.app.visual.diagram : t.app.visual.source,
              on: source,
              press: () => setSource(!source),
            }
      }
    >
      {asSource && (
        <ScrollView horizontal bounces={false}>
          <Text selectable style={[styles.source, { color: c.text }]}>
            {code}
          </Text>
        </ScrollView>
      )}
      {/* Kept mounted while the source is shown, so switching back does not draw again. */}
      <View
        style={asSource ? styles.hidden : { height: Math.max(height, 40), marginVertical: 8 }}
        pointerEvents="none"
        accessibilityRole="image"
        accessibilityLabel={title}
      >
        <WebView
          ref={view}
          source={{ html: DIAGRAM_PAGE, baseUrl: "about:blank" }}
          onMessage={onMessage}
          // The page is the only thing this view ever shows: it may not go anywhere else.
          originWhitelist={["about:*"]}
          onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          domStorageEnabled={false}
          incognito
          cacheEnabled={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowsLinkPreview={false}
          allowsBackForwardNavigationGestures={false}
          dataDetectorTypes="none"
          mediaPlaybackRequiresUserAction
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          automaticallyAdjustContentInsets={false}
          style={styles.web}
        />
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  bar: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 13, fontWeight: "600" },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2, paddingBottom: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  row: { flexDirection: "row" },
  cell: {
    width: 92,
    fontSize: 12,
    lineHeight: 17,
    paddingVertical: 4,
    paddingLeft: 10,
    textAlign: "right",
  },
  first: { width: 110, paddingLeft: 0, textAlign: "left" },
  number: { fontVariant: ["tabular-nums"] },
  source: { fontFamily: mono, fontSize: 12, lineHeight: 17, padding: 10 },
  hidden: { height: 0, opacity: 0 },
  web: { flex: 1, backgroundColor: "transparent" },
});
