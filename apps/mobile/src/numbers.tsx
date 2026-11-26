import { bandPath, layoutFlows } from "@muster/ui-schema";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useI18n } from "./i18n";
import { compact, fitLabel, plain, withUnit } from "./lib/chart";
import {
  bubbleRadii,
  columnsFor,
  flowBox,
  fraction,
  groupsOf,
  MOST,
  movedColour,
  signOf,
  span,
  spark,
  type Tone,
  tones,
  treemap,
  type Up,
} from "./lib/visuals";
import { useColors } from "./theme";
import { Frame, Legend, Numbers, usePalette } from "./visuals";

/**
 * The ways a reply shows numbers besides a chart (component set 4): a scatter of dots, a
 * grid of colour, a market map, candles, headline figures, progress and a timeline. Each
 * writes its numbers; colour only says the same thing again.
 */

/** A number as it is written in a tile or a cell: a rise says so with its sign. */
const written = (value: number, unit: string, up: Up) =>
  withUnit(`${up && value > 0 ? "+" : ""}${plain(value)}`, unit);
/** What is written on a fill: white on a strong one, the page's own text otherwise. */
const ink = (tone: Tone | undefined, text: string) => (tone?.strong ? "#ffffff" : text);

/** How two measures go together: a dot for each thing. */
export function ScatterView({
  title,
  x,
  y,
  points,
}: {
  title: string;
  x: string;
  y: string;
  points: { label: string; x: number; y: number; group?: string; size?: number }[];
}) {
  const { t, locale } = useI18n();
  const c = useColors();
  const palette = usePalette();
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const shown = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, MOST.points);
  if (shown.length === 0) return null;
  const height = 210;
  const box = { left: 44, top: 8, width: Math.max(10, width - 56), height: height - 34 };
  const across = span(shown.map((point) => point.x));
  const upward = span(shown.map((point) => point.y));
  const px = (value: number) =>
    box.left + ((value - across.min) / (across.max - across.min)) * box.width;
  const py = (value: number) =>
    box.top + box.height - ((value - upward.min) / (upward.max - upward.min)) * box.height;
  const everyX = Math.max(1, Math.ceil((across.ticks.length * 44) / Math.max(1, box.width)));
  const tick = (n: number) => compact(n, locale === "zh");
  // Dots of a kind share a colour, in the fixed order; a third measure is a dot's size.
  const kinds = groupsOf(shown.map((point) => point.group));
  const radii = bubbleRadii(shown.map((point) => point.size));
  const sizes = shown.some((point) => point.size !== undefined && Number.isFinite(point.size));
  const colorOf = (index: number) => {
    if (kinds.names.length === 0) return palette.blue;
    const kind = kinds.of[index] ?? -1;
    return kind < 0 ? palette.other : (palette.series[kind] ?? palette.other);
  };
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
        <Numbers
          head={["", x, y, ...(sizes ? ["●"] : [])]}
          rows={shown.map((point) => [
            point.group ? `${point.label} · ${point.group}` : point.label,
            plain(point.x),
            plain(point.y),
            ...(sizes ? [plain(point.size ?? Number.NaN)] : []),
          ])}
        />
      ) : (
        <View
          style={{ padding: 8 }}
          onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width) - 16)}
        >
          {kinds.names.length > 0 && (
            <Legend
              items={kinds.names.map((name, index) => ({
                name,
                color: palette.series[index] ?? palette.other,
              }))}
            />
          )}
          <Text numberOfLines={1} style={{ fontSize: 11, color: c.muted, paddingBottom: 2 }}>
            {y}
          </Text>
          {width > 0 && (
            <Svg
              width={width}
              height={height}
              accessibilityRole="image"
              accessibilityLabel={`${title}. ${shown
                .map((point) => `${point.label}: ${plain(point.x)}, ${plain(point.y)}`)
                .join(". ")}`}
            >
              {upward.ticks.map((tick_) => (
                <Line
                  key={`g${tick_}`}
                  x1={box.left}
                  x2={box.left + box.width}
                  y1={py(tick_)}
                  y2={py(tick_)}
                  stroke={c.border}
                  strokeWidth={StyleSheet.hairlineWidth}
                />
              ))}
              {upward.ticks.map((tick_) => (
                <SvgText
                  key={`t${tick_}`}
                  x={box.left - 6}
                  y={py(tick_) + 3.5}
                  fontSize={10}
                  fill={c.muted}
                  textAnchor="end"
                >
                  {tick(tick_)}
                </SvgText>
              ))}
              {across.ticks.map((tick_, index) =>
                index % everyX === 0 ? (
                  <SvgText
                    key={`x${tick_}`}
                    x={px(tick_)}
                    y={height - 12}
                    fontSize={10}
                    fill={c.muted}
                    textAnchor="middle"
                  >
                    {tick(tick_)}
                  </SvgText>
                ) : null,
              )}
              {shown.map((point, index) => (
                <Circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: points of one drawing never reorder
                  key={`p${index}`}
                  cx={px(point.x)}
                  cy={py(point.y)}
                  r={radii[index] ?? 4.5}
                  fill={colorOf(index)}
                  fillOpacity={sizes ? 0.82 : 1}
                  // A ring of the page, so that dots that touch stay two dots.
                  stroke={c.page}
                  strokeWidth={2}
                />
              ))}
              {/* Named on the drawing only while there is room for names. */}
              {shown.length <= 10 &&
                shown.map((point, index) => {
                  const right = px(point.x) < box.left + box.width * 0.7;
                  return (
                    <SvgText
                      // biome-ignore lint/suspicious/noArrayIndexKey: points of one drawing never reorder
                      key={`n${index}`}
                      x={px(point.x) + (right ? 1 : -1) * ((radii[index] ?? 4.5) + 4)}
                      y={py(point.y) + 3.5}
                      fontSize={10}
                      fill={c.muted}
                      textAnchor={right ? "start" : "end"}
                    >
                      {fitLabel(point.label, 70)}
                    </SvgText>
                  );
                })}
            </Svg>
          )}
          <Text numberOfLines={1} style={{ fontSize: 11, color: c.muted, textAlign: "right" }}>
            {x}
          </Text>
        </View>
      )}
    </Frame>
  );
}

/** A grid of numbers shown as colour, each number written in its cell. */
export function HeatmapView({
  title,
  columns: givenColumns,
  rows: givenRows,
  unit = "",
  up,
}: {
  title: string;
  columns: string[];
  rows: { label: string; values: number[] }[];
  unit?: string;
  up?: Up;
}) {
  const c = useColors();
  const palette = usePalette();
  const columns = givenColumns.slice(0, MOST.heat);
  const rows = givenRows.slice(0, MOST.heat);
  if (columns.length === 0 || rows.length === 0) return null;
  const flat = rows.flatMap((row) => columns.map((_, index) => row.values[index] ?? Number.NaN));
  if (!flat.some(Number.isFinite)) return null;
  const toned = tones(flat, up, palette);
  return (
    <Frame title={title}>
      <ScrollView horizontal bounces={false}>
        <View style={{ padding: 8, gap: 2 }}>
          <View style={{ flexDirection: "row", gap: 2 }}>
            <View style={styles.heatLabel} />
            {columns.map((column, index) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: columns of one grid never reorder
                key={index}
                numberOfLines={1}
                style={[styles.heatHead, { color: c.muted }]}
              >
                {column}
              </Text>
            ))}
          </View>
          {rows.map((row, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of one grid never reorder
            <View key={at} style={{ flexDirection: "row", gap: 2 }}>
              <Text numberOfLines={1} style={[styles.heatLabel, { color: c.text }]}>
                {row.label}
              </Text>
              {columns.map((column, index) => {
                const value = row.values[index];
                const tone = toned[at * columns.length + index];
                const there = value !== undefined && Number.isFinite(value);
                return (
                  <View
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                    key={index}
                    style={[styles.heatCell, { backgroundColor: there ? tone?.fill : c.soft }]}
                    accessibilityLabel={
                      there ? `${row.label}, ${column}: ${written(value, unit, up)}` : undefined
                    }
                  >
                    {there && (
                      <Text
                        numberOfLines={1}
                        style={[styles.heatNumber, { color: ink(tone, c.text) }]}
                      >
                        {written(value, unit, up)}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </Frame>
  );
}

interface TileItem {
  label: string;
  value: number;
  weight?: number;
  note?: string;
}

/** What one tile says: its name, its number, and a few words if there is room. */
function TileText({
  item,
  unit,
  up,
  color,
  roomy,
}: {
  item: TileItem;
  unit: string;
  up: Up;
  color: string;
  /** There is room for the note as well. */
  roomy: boolean;
}) {
  return (
    <>
      <Text numberOfLines={1} style={[styles.tileLabel, { color }]}>
        {item.label}
      </Text>
      <Text numberOfLines={1} style={[styles.tileValue, { color }]}>
        {written(item.value, unit, up)}
      </Text>
      {roomy && item.note ? (
        <Text numberOfLines={1} style={[styles.tileNote, { color }]}>
          {item.note}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Many named numbers at a glance, each a coloured tile: a market map when every item has a
 * weight (the tile is as large as its weight), tiles of one size otherwise.
 */
export function TilesView({
  title,
  items: given,
  unit = "",
  up,
}: {
  title: string;
  items: TileItem[];
  unit?: string;
  up?: Up;
}) {
  const c = useColors();
  const palette = usePalette();
  const [width, setWidth] = useState(0);
  const items = given.filter((item) => Number.isFinite(item.value)).slice(0, MOST.tiles);
  if (items.length === 0) return null;
  const toned = tones(
    items.map((item) => item.value),
    up,
    palette,
  );
  const weighed = items.every(
    (item) => item.weight !== undefined && Number.isFinite(item.weight) && item.weight > 0,
  );
  const height = Math.round(Math.min(320, Math.max(180, width * 0.66)));
  const columns = columnsFor(items.length, width);
  const side = width > 0 ? Math.floor((width - (columns - 1) * 2) / columns) : 0;
  const says = (item: TileItem) =>
    `${item.label}: ${written(item.value, unit, up)}${item.note ? `, ${item.note}` : ""}`;
  return (
    <Frame title={title}>
      <View
        style={{ padding: 8 }}
        onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width) - 16)}
      >
        {width > 0 && weighed && (
          <View style={{ width, height }}>
            {treemap(
              items.map((item) => item.weight ?? 0),
              width,
              height,
            ).map((tile) => {
              const item = items[tile.index];
              if (!item) return null;
              const tone = toned[tile.index];
              // A tile too small to be read says nothing: its neighbours and the colour do.
              const named = tile.width >= 46 && tile.height >= 32;
              return (
                <View
                  key={tile.index}
                  accessibilityLabel={says(item)}
                  style={[
                    styles.tile,
                    {
                      position: "absolute",
                      left: tile.x + 1,
                      top: tile.y + 1,
                      width: Math.max(0, tile.width - 2),
                      height: Math.max(0, tile.height - 2),
                      backgroundColor: tone?.fill,
                    },
                  ]}
                >
                  {named && (
                    <TileText
                      item={item}
                      unit={unit}
                      up={up}
                      color={ink(tone, c.text)}
                      roomy={tile.height >= 58}
                    />
                  )}
                </View>
              );
            })}
          </View>
        )}
        {width > 0 && !weighed && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2 }}>
            {items.map((item, index) => {
              const tone = toned[index];
              return (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: tiles of one drawing never reorder
                  key={index}
                  accessibilityLabel={says(item)}
                  style={[styles.tile, { width: side, minHeight: 50, backgroundColor: tone?.fill }]}
                >
                  <TileText item={item} unit={unit} up={up} color={ink(tone, c.text)} roomy />
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Frame>
  );
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A price over time as candles: where it opened and closed, and how far it went between. */
export function CandlesView({
  title,
  labels,
  candles: given,
  unit = "",
  up,
}: {
  title: string;
  labels: string[];
  candles: Candle[];
  unit?: string;
  up?: Up;
}) {
  const { t, locale } = useI18n();
  const c = useColors();
  const palette = usePalette();
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const candles = given
    .map((candle, index) => ({ candle, label: labels[index] ?? "" }))
    .filter(({ candle }) =>
      [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite),
    )
    .slice(-MOST.candles);
  if (candles.length === 0) return null;
  const height = 210;
  const box = { left: 48, top: 8, width: Math.max(10, width - 56), height: height - 32 };
  const scale = span(
    candles.flatMap(({ candle }) => [candle.low, candle.high, candle.open, candle.close]),
  );
  const y = (value: number) =>
    box.top + box.height - ((value - scale.min) / (scale.max - scale.min)) * box.height;
  const slot = box.width / candles.length;
  const body = Math.max(1, Math.min(12, slot * 0.62));
  const every = Math.max(1, Math.ceil(48 / slot));
  // Candles tell a rise from a fall or they tell nothing: without a custom, green rises.
  const rise = up === "red" ? palette.red : palette.green;
  const fall = up === "red" ? palette.green : palette.red;
  const value = (n: number) => withUnit(plain(n), unit);
  const w = t.app.visual;
  return (
    <Frame
      title={title}
      toggle={{
        label: table ? w.chart : w.numbers,
        on: table,
        press: () => setTable(!table),
      }}
    >
      {table ? (
        <Numbers
          head={["", w.open, w.high, w.low, w.close]}
          rows={candles.map(({ candle, label }) => [
            label,
            value(candle.open),
            value(candle.high),
            value(candle.low),
            value(candle.close),
          ])}
        />
      ) : (
        <View
          style={{ padding: 8 }}
          onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width) - 16)}
        >
          {width > 0 && (
            <Svg
              width={width}
              height={height}
              accessibilityRole="image"
              accessibilityLabel={`${title}. ${candles
                .map(
                  ({ candle, label }) => `${label}: ${value(candle.open)}, ${value(candle.close)}`,
                )
                .join(". ")}`}
            >
              {scale.ticks.map((tick) => (
                <Line
                  key={`g${tick}`}
                  x1={box.left}
                  x2={box.left + box.width}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={c.border}
                  strokeWidth={StyleSheet.hairlineWidth}
                />
              ))}
              {scale.ticks.map((tick) => (
                <SvgText
                  key={`t${tick}`}
                  x={box.left - 6}
                  y={y(tick) + 3.5}
                  fontSize={10}
                  fill={c.muted}
                  textAnchor="end"
                >
                  {compact(tick, locale === "zh")}
                </SvgText>
              ))}
              {candles.map(({ candle, label }, index) => {
                const cx = box.left + slot * (index + 0.5);
                const color = candle.close >= candle.open ? rise : fall;
                const top = y(Math.max(candle.open, candle.close));
                const bottom = y(Math.min(candle.open, candle.close));
                return [
                  <Line
                    // biome-ignore lint/suspicious/noArrayIndexKey: candles follow the labels
                    key={`w${index}`}
                    x1={cx}
                    x2={cx}
                    y1={y(candle.high)}
                    y2={y(candle.low)}
                    stroke={color}
                    strokeWidth={1}
                  />,
                  <Rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: candles follow the labels
                    key={`b${index}`}
                    x={cx - body / 2}
                    y={top}
                    width={body}
                    height={Math.max(1, bottom - top)}
                    rx={Math.min(1.5, body / 2)}
                    fill={color}
                  />,
                  index % every === 0 ? (
                    <SvgText
                      // biome-ignore lint/suspicious/noArrayIndexKey: candles follow the labels
                      key={`l${index}`}
                      x={cx}
                      y={height - 8}
                      fontSize={10}
                      fill={c.muted}
                      textAnchor="middle"
                    >
                      {fitLabel(label, Math.max(8, slot * every - 4))}
                    </SvgText>
                  ) : null,
                ];
              })}
            </Svg>
          )}
        </View>
      )}
    </Frame>
  );
}

/**
 * Amounts going from sources to uses (a Sankey): a box for each name, as tall as what
 * passes through it, and a band for each flow, as thick as its amount. Where things lie is
 * worked out by the layout the web uses too, so one reply is one drawing.
 */
export function FlowsView({
  title,
  flows,
  unit = "",
}: {
  title: string;
  flows: { from: string; to: string; value: number }[];
  unit?: string;
}) {
  const { t } = useI18n();
  const c = useColors();
  const palette = usePalette();
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const names = new Set(flows.flatMap((flow) => [flow.from, flow.to])).size;
  const { height, side } = flowBox(names, width);
  // Laid out before its width is known as well: which flows are flows does not wait.
  const laid = layoutFlows(flows, Math.max(1, width - side * 2), height);
  if (laid.nodes.length === 0) return null;
  const say = (value: number) => withUnit(plain(value), unit);
  // A source keeps its colour across the drawing; what begins further right is grey.
  const colourOf = new Map<string, string>();
  laid.nodes
    .filter((node) => node.column === 0)
    .forEach((node, index) => {
      colourOf.set(node.name, palette.series[index % 4] ?? palette.other);
    });
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
        <Numbers
          head={["", "", ""]}
          rows={laid.bands.map((band) => [band.from, `→ ${band.to}`, say(band.value)])}
        />
      ) : (
        <View
          style={{ padding: 8 }}
          onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width) - 16)}
        >
          {width > 0 && (
            <Svg
              width={width}
              height={height}
              accessibilityRole="image"
              accessibilityLabel={`${title}. ${laid.bands
                .map((band) => `${band.from} → ${band.to}: ${say(band.value)}`)
                .join(". ")}`}
            >
              <G x={side}>
                {laid.bands.map((band, index) => (
                  <Path
                    // biome-ignore lint/suspicious/noArrayIndexKey: bands follow the flows
                    key={`b${index}`}
                    d={bandPath(band)}
                    fill="none"
                    stroke={colourOf.get(band.from) ?? palette.other}
                    strokeWidth={band.thickness}
                    strokeOpacity={0.35}
                  />
                ))}
                {laid.nodes.map((node) => {
                  const left = node.column === 0;
                  // A name has the edge it stands at, or part of the way to the next column.
                  const room = left || node.column === laid.columns - 1 ? side - 8 : 96;
                  const worth = say(node.value);
                  // On a narrow screen a name and its amount do not fit on one line beside
                  // a box: the name stands over the amount, and each has the whole room.
                  const name = fitLabel(node.name, Math.max(24, room), 11);
                  const two = node.height >= 26;
                  const middle = node.y + node.height / 2;
                  return [
                    <Rect
                      key={`n${node.name}`}
                      x={node.x}
                      y={node.y}
                      width={node.width}
                      height={node.height}
                      rx={2}
                      fill={colourOf.get(node.name) ?? palette.other}
                    />,
                    <SvgText
                      key={`t${node.name}`}
                      x={left ? node.x - 6 : node.x + node.width + 6}
                      y={two ? middle - 2 : middle + 4}
                      fontSize={11}
                      fill={c.text}
                      textAnchor={left ? "end" : "start"}
                    >
                      {name}
                    </SvgText>,
                    two ? (
                      <SvgText
                        key={`v${node.name}`}
                        x={left ? node.x - 6 : node.x + node.width + 6}
                        y={middle + 11}
                        fontSize={10}
                        fill={c.muted}
                        textAnchor={left ? "end" : "start"}
                      >
                        {fitLabel(worth, Math.max(24, room), 10)}
                      </SvgText>
                    ) : null,
                  ];
                })}
              </G>
            </Svg>
          )}
        </View>
      )}
    </Frame>
  );
}

/** A few headline numbers side by side, each with its name and how it moved. */
export function MetricsView({
  items: given,
  up,
}: {
  items: { label: string; value: string; change?: string; note?: string; trend?: number[] }[];
  up?: Up;
}) {
  const c = useColors();
  const items = given.filter((item) => item.label || item.value).slice(0, MOST.metrics);
  if (items.length === 0) return null;
  return (
    <View style={styles.metrics}>
      {items.map((item, index) => {
        // Words on the page, so the colours made for words: the ones "wrong" and "done" wear.
        const sign = item.change ? signOf(item.change) : 0;
        const moved = movedColour(sign, up, { red: c.bad, green: c.ok });
        // Said by a mark as well as by colour; a change that already begins with one keeps its own.
        const arrow = /^[▲▼↑↓]/.test(item.change?.trim() ?? "")
          ? ""
          : sign > 0
            ? "▲ "
            : sign < 0
              ? "▼ "
              : "";
        const line = item.trend ? spark(item.trend, 64, 20) : null;
        return (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: figures of one reply never reorder
            key={index}
            style={[styles.metric, { borderColor: c.border }]}
          >
            <Text numberOfLines={1} style={{ fontSize: 12, color: c.muted }}>
              {item.label}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.metricValue, { flex: 1, color: c.text }]}
              >
                {item.value}
              </Text>
              {line ? (
                <Svg width={64} height={20} accessibilityElementsHidden>
                  <Path
                    d={line.path}
                    stroke={c.muted}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    fill="none"
                  />
                  <Circle cx={line.end.x} cy={line.end.y} r={2} fill={c.muted} />
                </Svg>
              ) : null}
            </View>
            {item.change || item.note ? (
              <Text numberOfLines={1} style={{ fontSize: 12, color: c.muted }}>
                {item.change ? (
                  <Text style={[styles.metricChange, { color: moved ?? c.text }]}>
                    {arrow}
                    {item.change}
                  </Text>
                ) : null}
                {item.change && item.note ? "  " : ""}
                {item.note ?? ""}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** How far each of a few things is toward its target. */
export function ProgressView({
  title,
  items: given,
  unit = "",
}: {
  title: string;
  items: { label: string; value: number; of: number }[];
  unit?: string;
}) {
  const c = useColors();
  const palette = usePalette();
  const items = given
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.of) && item.of > 0)
    .slice(0, MOST.progress);
  if (items.length === 0) return null;
  return (
    <Frame title={title}>
      <View style={{ padding: 10, gap: 10 }}>
        {items.map((item, index) => {
          const share = fraction(item.value, item.of);
          return (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one drawing never reorder
              key={index}
              style={{ gap: 4 }}
              accessibilityRole="progressbar"
              accessibilityLabel={item.label}
              accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
            >
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: c.text }}>
                  {item.label}
                </Text>
                <Text style={[styles.figures, { color: c.muted }]}>
                  {withUnit(plain(item.value), unit)} / {withUnit(plain(item.of), unit)} ·{" "}
                  {Math.round((item.value / item.of) * 100)}%
                </Text>
              </View>
              <View style={[styles.track, { backgroundColor: c.soft }]}>
                <View
                  style={[styles.fill, { width: `${share * 100}%`, backgroundColor: palette.blue }]}
                />
              </View>
            </View>
          );
        })}
      </View>
    </Frame>
  );
}

/** What happened, or is to happen, in order: a mark down the left, and each event beside it. */
export function TimelineView({
  title,
  items: given,
}: {
  title: string;
  items: { when: string; title: string; text?: string }[];
}) {
  const c = useColors();
  const items = given.filter((item) => item.when || item.title).slice(0, MOST.events);
  if (items.length === 0) return null;
  return (
    <Frame title={title}>
      <View style={{ padding: 10 }}>
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: events of one timeline never reorder
          <View key={index} style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ width: 9, alignItems: "center" }}>
              <View style={[styles.dot, { backgroundColor: c.accent }]} />
              {index < items.length - 1 && (
                <View style={{ flex: 1, width: 1, backgroundColor: c.separator }} />
              )}
            </View>
            <View style={{ flex: 1, paddingBottom: index < items.length - 1 ? 12 : 0, gap: 1 }}>
              <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted }}>{item.when}</Text>
              <Text
                selectable
                style={{ fontSize: 15, lineHeight: 21, fontWeight: "500", color: c.text }}
              >
                {item.title}
              </Text>
              {item.text ? (
                <Text selectable style={{ fontSize: 13, lineHeight: 19, color: c.muted }}>
                  {item.text}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  heatLabel: { width: 78, fontSize: 12, lineHeight: 30, paddingRight: 6 },
  heatHead: { width: 54, fontSize: 11, lineHeight: 18, textAlign: "center" },
  heatCell: {
    width: 54,
    height: 30,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  heatNumber: { fontSize: 11, fontVariant: ["tabular-nums"] },
  tile: { borderRadius: 6, padding: 6, justifyContent: "center", overflow: "hidden" },
  tileLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  tileValue: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  tileNote: { fontSize: 10, lineHeight: 14, opacity: 0.85 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metric: {
    flexGrow: 1,
    flexBasis: "44%",
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
  },
  metricValue: { fontSize: 22, lineHeight: 28, fontWeight: "700", fontVariant: ["tabular-nums"] },
  metricChange: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  figures: { fontSize: 12, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 4 },
});
