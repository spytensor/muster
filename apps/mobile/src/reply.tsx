import Ionicons from "@expo/vector-icons/Ionicons";
import * as schema from "@muster/ui-schema";
import { isPart, toRenderable, webUrl } from "@muster/ui-schema";
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FormCard, FormScope } from "./forms";
import { useI18n } from "./i18n";
import { prose } from "./lib/followups";
import { signed } from "./lib/profile";
import { MOST, movedColour, numberOr, signOf, type Up, upOf } from "./lib/visuals";
import {
  CandlesView,
  FlowsView,
  HeatmapView,
  MetricsView,
  ProgressView,
  ScatterView,
  TilesView,
  TimelineView,
} from "./numbers";
import { useSession } from "./session";
import { mono, useColors } from "./theme";
import { type ChartKind, ChartView, DiagramView } from "./visuals";

/** How a part of a reply sends the person's next message. Disabled while a reply is being written. */
export const ReplyActions = createContext<{ send(text: string): void; disabled: boolean }>({
  send: () => undefined,
  disabled: true,
});

/** A paragraph's **bold** and `code` runs, and the plain words between them (as on the web). */
function Runs({ text, soft }: { text: string; soft: string }) {
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((run, at) =>
        run.length > 4 && run.startsWith("**") && run.endsWith("**") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs of one paragraph never reorder
          <Text key={at} style={{ fontWeight: "700" }}>
            {run.slice(2, -2)}
          </Text>
        ) : run.length > 2 && run.startsWith("`") && run.endsWith("`") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs of one paragraph never reorder
          <Text key={at} style={{ fontFamily: mono, fontSize: 14, backgroundColor: soft }}>
            {run.slice(1, -1)}
          </Text>
        ) : (
          run
        ),
      )}
    </>
  );
}

/** Text with **bold** and `code` runs; nothing else in it is interpreted. */
type Line =
  | { kind: "heading"; text: string }
  | { kind: "rule" }
  | { kind: "code"; code: string; language: string }
  | { kind: "item"; text: string; depth: number; mark: string }
  | { kind: "paragraph"; text: string };

/** Prose in the Markdown a Text may hold (as on the web): headings, rules, fenced code, lists set in, paragraphs. */
function linesOf(text: string): Line[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Line[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)[^`]*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (at++; at < lines.length && (lines[at] ?? "").trim() !== (fence[1] ?? "```"); at++)
        body.push(lines[at] ?? "");
      out.push({ kind: "code", code: body.join("\n"), language: fence[2] ?? "" });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", text: headingText(heading[1] ?? "") });
      continue;
    }
    if (/^\s*([=\-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const depth = Math.min(3, Math.round((item[1] ?? "").length / 2));
      const mark = /\d/.test(item[2] ?? "") ? (item[2] ?? "") : depth === 0 ? "•" : "◦";
      out.push({ kind: "item", text: item[3] ?? "", depth, mark });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

/** What a reply says in words, set as on the web: Markdown, with **bold** and `code`. */
function Prose({ text, muted, small }: { text: string; muted?: boolean; small?: boolean }) {
  const c = useColors();
  const body = [styles.body, { color: muted ? c.muted : c.text }, (muted || small) && styles.small];
  return (
    <View style={{ gap: 10 }}>
      {linesOf(text).map((line, index) => {
        // biome-ignore-start lint/suspicious/noArrayIndexKey: lines of one text never reorder
        if (line.kind === "heading")
          return (
            <Text
              key={index}
              selectable
              style={[body, { fontWeight: "700", fontSize: 17, marginTop: 4 }]}
            >
              <Runs text={line.text} soft={c.soft} />
            </Text>
          );
        if (line.kind === "rule")
          return (
            <View
              key={index}
              style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }}
            />
          );
        if (line.kind === "code")
          return <CodeBlock key={index} code={line.code} language={line.language} />;
        if (line.kind === "item")
          return (
            <View key={index} style={{ flexDirection: "row", gap: 6, marginLeft: line.depth * 16 }}>
              <Text style={[body, { color: c.muted }]}>{line.mark}</Text>
              <Text selectable style={[body, { flex: 1 }]}>
                <Runs text={line.text} soft={c.soft} />
              </Text>
            </View>
          );
        return (
          <Text key={index} selectable style={body}>
            <Runs text={line.text} soft={c.soft} />
          </Text>
        );
        // biome-ignore-end lint/suspicious/noArrayIndexKey: lines of one text never reorder
      })}
    </View>
  );
}

const TextPart = defineComponent({
  ...schema.Text,
  component: ({ props }) => (
    <Prose text={String(props.text ?? "")} muted={props.tone === "muted"} />
  ),
});

function HeadingView({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>
      {text}
    </Text>
  );
}
const Heading = defineComponent({
  ...schema.Heading,
  component: ({ props }) => <HeadingView text={String(props.text ?? "")} />,
});

function CalloutView({ title, text, tone }: { title: string; text: string; tone: string }) {
  const c = useColors();
  const look =
    tone === "warning"
      ? { icon: "warning-outline" as const, bg: c.warnSoft, border: c.warnBorder, fg: c.warn }
      : tone === "success"
        ? { icon: "checkmark-circle-outline" as const, bg: c.okSoft, border: c.okSoft, fg: c.ok }
        : { icon: "information-circle-outline" as const, bg: c.soft, border: c.soft, fg: c.muted };
  return (
    <View style={[styles.callout, { backgroundColor: look.bg, borderColor: look.border }]}>
      <Ionicons name={look.icon} size={18} color={look.fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.small, { color: c.text, fontWeight: "600" }]}>{title}</Text>
        <Prose text={text} small />
      </View>
    </View>
  );
}
const Callout = defineComponent({
  ...schema.Callout,
  component: ({ props }) => (
    <CalloutView
      title={String(props.title ?? "")}
      text={String(props.text ?? "")}
      tone={props.tone ?? "info"}
    />
  ),
});

function ListView({ items, ordered }: { items: string[]; ordered: boolean }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items of one list never reorder
        <View key={index} style={{ flexDirection: "row", gap: 8 }}>
          <Text style={[styles.body, { color: c.muted, minWidth: ordered ? 22 : 12 }]}>
            {ordered ? `${index + 1}.` : "•"}
          </Text>
          <View style={{ flex: 1 }}>
            <Prose text={item} />
          </View>
        </View>
      ))}
    </View>
  );
}
const List = defineComponent({
  ...schema.List,
  component: ({ props }) => (
    <ListView
      items={(props.items ?? []).filter((item): item is string => typeof item === "string")}
      ordered={props.ordered === true}
    />
  ),
});

/** A column is as wide as its longest cell needs, within limits, so wide tables scroll sideways. */
const columnWidth = (cells: string[]) => {
  const longest = cells.reduce((max, cell) => {
    // Chinese, Japanese and Korean characters are about twice as wide as Latin ones.
    const width = [...cell].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
    return Math.max(max, width);
  }, 0);
  return Math.min(240, Math.max(72, longest * 8 + 28));
};

function TableView({
  columns,
  rows,
  moved = [],
  up,
}: {
  columns: string[];
  rows: string[][];
  /** The columns whose cells are changes, coloured as rises and falls once `up` is given. */
  moved?: number[];
  up?: Up;
}) {
  const c = useColors();
  // Words on the page: the colours made for words, not a chart's fills.
  const colour = (index: number, cell: string) =>
    (moved.includes(index) && movedColour(signOf(cell), up, { red: c.bad, green: c.ok })) || c.text;
  const widths = columns.map((column, index) =>
    columnWidth([column, ...rows.map((row) => row[index] ?? "")]),
  );
  return (
    <View style={[styles.table, { borderColor: c.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator bounces={false}>
        <View>
          <View style={[styles.row, { backgroundColor: c.soft }]}>
            {columns.map((column, index) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: columns of one table never reorder
                key={index}
                style={[styles.cell, styles.headCell, { width: widths[index], color: c.muted }]}
              >
                {column}
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
              {columns.map((_, index) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                  key={index}
                  selectable
                  style={[
                    styles.cell,
                    { width: widths[index], color: colour(index, row[index] ?? "") },
                  ]}
                >
                  {row[index] ?? ""}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
const DataTable = defineComponent({
  ...schema.Table,
  component: ({ props }) => (
    <TableView
      columns={(props.columns ?? []).map(String)}
      rows={(props.rows ?? [])
        .filter(Array.isArray)
        .map((row) => row.map((cell) => String(cell ?? "")))}
      moved={(Array.isArray(props.signed) ? props.signed : []).filter(
        (index) => typeof index === "number" && Number.isInteger(index),
      )}
      up={upOf(props.up)}
    />
  ),
});

function FactsView({ items }: { items: { label: string; value: string }[] }) {
  const c = useColors();
  return (
    <View style={[styles.facts, { borderColor: c.border }]}>
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: facts of one reply never reorder
        <View key={index} style={{ gap: 1 }}>
          <Text style={[styles.small, { color: c.muted }]}>{item.label}</Text>
          <Text selectable style={[styles.body, { color: c.text, fontWeight: "500" }]}>
            {item.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
const Facts = defineComponent({
  ...schema.Facts,
  component: ({ props }) => (
    <FactsView
      items={(props.items ?? []).flatMap((item) =>
        item ? [{ label: String(item.label ?? ""), value: String(item.value ?? "") }] : [],
      )}
    />
  ),
});

/** How a reply that changed code ends (C1): what was done, the files, the checks, what is left. */
function WalkthroughView({ spec }: { spec: schema.WalkthroughSpec }) {
  const c = useColors();
  const { t } = useI18n();
  const w = t.app.walkthrough;
  const head = [styles.small, { color: c.muted, fontWeight: "600" as const }];
  const row = { flexDirection: "row" as const, gap: 8, alignItems: "flex-start" as const };
  return (
    <View style={[styles.facts, { borderColor: c.border, gap: 12 }]}>
      {spec.summary ? (
        <Text selectable style={[styles.body, { color: c.text }]}>
          <Runs text={spec.summary} soft={c.soft} />
        </Text>
      ) : null}
      {spec.changes.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={head}>{w.changes(spec.changes.length)}</Text>
          {spec.changes.map((change, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: files of one reply never reorder
            <View key={index} style={row}>
              <Ionicons name="document-text-outline" size={16} color={c.muted} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text selectable style={{ fontFamily: mono, fontSize: 13, color: c.text }}>
                  {change.file}
                </Text>
                {change.why ? (
                  <Text selectable style={[styles.small, { color: c.muted }]}>
                    <Runs text={change.why} soft={c.soft} />
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
      {spec.checks.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={head}>{w.checks}</Text>
          {spec.checks.map((check, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checks of one reply never reorder
            <View key={index} style={row}>
              <Ionicons
                name={check.ok ? "checkmark-circle" : "close-circle"}
                size={16}
                color={check.ok ? c.ok : c.bad}
                accessibilityLabel={check.ok ? w.passed : w.failed}
              />
              <View style={{ flex: 1, gap: 1 }}>
                <Text selectable style={{ fontFamily: mono, fontSize: 13, color: c.text }}>
                  {check.what}
                </Text>
                {check.result ? (
                  <Text selectable style={[styles.small, { color: c.muted }]}>
                    <Runs text={check.result} soft={c.soft} />
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
      {spec.left.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={head}>{w.left}</Text>
          {spec.left.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items of one reply never reorder
            <View key={index} style={row}>
              <Ionicons name="ellipse-outline" size={14} color={c.warn} style={{ marginTop: 3 }} />
              <Text selectable style={[styles.small, { color: c.text, flex: 1 }]}>
                <Runs text={item} soft={c.soft} />
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
const Walkthrough = defineComponent({
  ...schema.Walkthrough,
  component: ({ props }) => {
    const words = (value: unknown) => (typeof value === "string" ? value : "");
    const rows = (value: unknown) =>
      (Array.isArray(value) ? value : []).filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      );
    return (
      <WalkthroughView
        spec={{
          summary: words(props.summary),
          changes: rows(props.changes).map((item) => ({
            file: words(item.file),
            why: words(item.why),
          })),
          checks: rows(props.checks).map((item) => ({
            what: words(item.what),
            result: words(item.result),
            ok: item.ok === true,
          })),
          left: (Array.isArray(props.left) ? props.left : []).map(words).filter(Boolean),
        }}
      />
    );
  },
});

function CodeBlock({ code, language }: { code: string; language: string }) {
  const c = useColors();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.code, { borderColor: c.border, backgroundColor: c.soft }]}>
      <View style={[styles.codeBar, { borderColor: c.border }]}>
        <Text style={{ fontFamily: mono, fontSize: 12, color: c.muted }}>{language}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.copy}
          hitSlop={12}
          onPress={() => {
            void Clipboard.setStringAsync(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={styles.copy}
        >
          <Ionicons name={copied ? "checkmark" : "copy-outline"} size={14} color={c.muted} />
          <Text style={{ fontSize: 12, color: c.muted }}>
            {copied ? t.common.copied : t.common.copy}
          </Text>
        </Pressable>
      </View>
      {prose(language) ? (
        // Words to be read wrap, so nothing is off the edge.
        <Text selectable style={[styles.codeText, { color: c.text }]}>
          {code}
        </Text>
      ) : (
        <ScrollView horizontal bounces={false}>
          <Text selectable style={[styles.codeText, { color: c.text }]}>
            {code}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
const Code = defineComponent({
  ...schema.Code,
  component: ({ props }) => (
    <CodeBlock
      code={String(props.code ?? "")}
      language={props.language ? String(props.language) : ""}
    />
  ),
});

function SourcesView({ items }: { items: { title: string; url: string }[] }) {
  const c = useColors();
  return (
    <View style={styles.wrap}>
      {items.map((item) => (
        <Pressable
          key={item.url}
          accessibilityRole="link"
          accessibilityLabel={item.title || item.url}
          onPress={() => void WebBrowser.openBrowserAsync(item.url)}
          style={({ pressed }) => [
            styles.chip,
            { borderColor: c.border, maxWidth: 280 },
            pressed && { backgroundColor: c.soft },
          ]}
        >
          <Ionicons name="open-outline" size={13} color={c.muted} />
          <Text numberOfLines={1} style={{ fontSize: 13, color: c.text, flexShrink: 1 }}>
            {item.title || item.url}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
const Sources = defineComponent({
  ...schema.Sources,
  component: ({ props }) => {
    // Checked again here: a link the schema would refuse is never rendered as a link.
    const items = (props.items ?? []).flatMap((item) =>
      item && webUrl.safeParse(item.url).success
        ? [{ title: String(item.title ?? ""), url: String(item.url) }]
        : [],
    );
    return items.length > 0 ? <SourcesView items={items} /> : null;
  },
});

function FollowUpButtons({
  items,
  closed = false,
}: {
  items: { label: string; text: string }[];
  /** A decision the conversation has moved on from: shown, not pressable. */
  closed?: boolean;
}) {
  const c = useColors();
  const actions = useContext(ReplyActions);
  const { send } = actions;
  const disabled = actions.disabled || closed;
  return (
    <View style={styles.wrap}>
      {items.slice(0, 4).map((item) => (
        <Pressable
          key={item.text}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          disabled={disabled}
          onPress={() => send(item.text)}
          style={({ pressed }) => [
            styles.chip,
            styles.followUp,
            { borderColor: c.border, maxWidth: "100%" },
            disabled && { opacity: 0.5 },
            pressed && { backgroundColor: c.soft },
          ]}
        >
          <Text style={{ fontSize: 14, lineHeight: 19, color: c.accentText, flexShrink: 1 }}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
const FollowUps = defineComponent({
  ...schema.FollowUps,
  component: ({ props }) => (
    <FollowUpButtons
      items={(props.items ?? []).flatMap((item) =>
        item && typeof item.label === "string" && typeof item.text === "string"
          ? // The chip shows exactly what it sends: a reply cannot hide a request behind a friendly label.
            [{ label: item.text, text: item.text }]
          : [],
      )}
    />
  ),
});

const Diagram = defineComponent({
  ...schema.Diagram,
  component: ({ props }) => (
    <DiagramView title={String(props.title ?? "")} code={String(props.code ?? "")} />
  ),
});

const Chart = defineComponent({
  ...schema.Chart,
  component: ({ props }) => (
    <ChartView
      title={String(props.title ?? "")}
      kind={
        (schema.CHART_KINDS as readonly string[]).includes(String(props.kind))
          ? (props.kind as ChartKind)
          : "bar"
      }
      labels={(props.labels ?? []).map(String)}
      series={(props.series ?? []).flatMap((item) =>
        item && Array.isArray(item.values)
          ? [
              {
                name: String(item.name ?? ""),
                values: item.values.map((value) =>
                  typeof value === "number" ? value : Number.NaN,
                ),
              },
            ]
          : [],
      )}
      unit={props.unit ? String(props.unit) : ""}
      up={upOf(props.up)}
      {...(typeof props.target === "number" && Number.isFinite(props.target)
        ? { target: props.target }
        : {})}
      targetName={typeof props.targetName === "string" ? props.targetName : ""}
      unit2={typeof props.unit2 === "string" ? props.unit2 : ""}
    />
  ),
});

/**
 * The other ways of showing numbers (component set 4). Each takes only what is really a
 * name or a number from what the reply wrote, which may be half-written or wrong, and
 * draws nothing rather than something misleading when there is nothing to draw.
 */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
const words = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const unitOf = (value: unknown): string => (typeof value === "string" ? value : "");

const Scatter = defineComponent({
  ...schema.Scatter,
  component: ({ props }) => (
    <ScatterView
      title={words(props.title)}
      x={words(props.x)}
      y={words(props.y)}
      points={list(props.points).flatMap((point) => {
        const item = record(point);
        if (!item) return [];
        const group = words(item.group);
        const size = numberOr(item.size);
        return [
          {
            label: words(item.label),
            x: numberOr(item.x),
            y: numberOr(item.y),
            ...(group ? { group } : {}),
            ...(Number.isFinite(size) ? { size } : {}),
          },
        ];
      })}
    />
  ),
});

const Heatmap = defineComponent({
  ...schema.Heatmap,
  component: ({ props }) => (
    <HeatmapView
      title={words(props.title)}
      columns={list(props.columns).map(words)}
      rows={list(props.rows).flatMap((row) => {
        const item = record(row);
        return item ? [{ label: words(item.label), values: list(item.values).map(numberOr) }] : [];
      })}
      unit={unitOf(props.unit)}
      up={upOf(props.up)}
    />
  ),
});

const Tiles = defineComponent({
  ...schema.Tiles,
  component: ({ props }) => (
    <TilesView
      title={words(props.title)}
      items={list(props.items)
        .slice(0, MOST.tiles)
        .flatMap((tile) => {
          const item = record(tile);
          if (!item) return [];
          const weight = numberOr(item.weight);
          const note = words(item.note);
          return [
            {
              label: words(item.label),
              value: numberOr(item.value),
              ...(Number.isFinite(weight) ? { weight } : {}),
              ...(note ? { note } : {}),
            },
          ];
        })}
      unit={unitOf(props.unit)}
      up={upOf(props.up)}
    />
  ),
});

const Candles = defineComponent({
  ...schema.Candles,
  component: ({ props }) => (
    <CandlesView
      title={words(props.title)}
      labels={list(props.labels).map(words)}
      candles={list(props.candles).map((candle) => {
        const item = record(candle) ?? {};
        return {
          open: numberOr(item.open),
          high: numberOr(item.high),
          low: numberOr(item.low),
          close: numberOr(item.close),
        };
      })}
      unit={unitOf(props.unit)}
      up={upOf(props.up)}
    />
  ),
});

const Flows = defineComponent({
  ...schema.Flows,
  component: ({ props }) => (
    <FlowsView
      title={words(props.title)}
      // Which of these are flows, and how many are held, is the layout's to say.
      flows={list(props.flows)
        .slice(0, 200)
        .flatMap((flow) => {
          const item = record(flow);
          return item
            ? [{ from: words(item.from), to: words(item.to), value: numberOr(item.value) }]
            : [];
        })}
      unit={unitOf(props.unit)}
    />
  ),
});

const Metrics = defineComponent({
  ...schema.Metrics,
  component: ({ props }) => (
    <MetricsView
      items={list(props.items).flatMap((metric) => {
        const item = record(metric);
        if (!item) return [];
        const change = words(item.change);
        const note = words(item.note);
        const trend = list(item.trend).map(numberOr).filter(Number.isFinite).slice(-60);
        return [
          {
            label: words(item.label),
            value: words(item.value),
            ...(change ? { change } : {}),
            ...(note ? { note } : {}),
            ...(trend.length >= 2 ? { trend } : {}),
          },
        ];
      })}
      up={upOf(props.up)}
    />
  ),
});

const Progress = defineComponent({
  ...schema.Progress,
  component: ({ props }) => (
    <ProgressView
      title={words(props.title)}
      items={list(props.items).flatMap((row) => {
        const item = record(row);
        return item
          ? [{ label: words(item.label), value: numberOr(item.value), of: numberOr(item.of) }]
          : [];
      })}
      unit={unitOf(props.unit)}
    />
  ),
});

const Timeline = defineComponent({
  ...schema.Timeline,
  component: ({ props }) => (
    <TimelineView
      title={words(props.title)}
      items={list(props.items).flatMap((event) => {
        const item = record(event);
        if (!item) return [];
        const text = words(item.text);
        return [{ when: words(item.when), title: words(item.title), ...(text ? { text } : {}) }];
      })}
    />
  ),
});

const Stack = defineComponent({
  ...schema.Stack,
  component: ({ props, renderNode }) => (
    <View style={{ gap: 10 }}>
      {/* A part that came out as a bare value, not a component, is not drawn as "false". */}
      {(props.children ?? []).filter(isPart).map((child, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one reply never reorder
        <View key={index}>{renderNode(child)}</View>
      ))}
    </View>
  ),
});

// A draft is shown as what it says. Sending is done from the web or desktop app.
const draftLines = (rows: [string, unknown][]) =>
  rows
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
    .map(
      ([label, value]) => `**${label}** ${Array.isArray(value) ? value.join(", ") : String(value)}`,
    )
    .join("\n\n");
/** The mail as it would go: the person's own signature under it, as on the web's card. The agent never has it. */
function MailText({ head, body }: { head: string; body: string }) {
  const signature = useSession().profile?.ways.signature;
  return <Prose text={`${head}\n\n${signed(body, signature)}`} />;
}
const MailDraft = defineComponent({
  ...schema.MailDraft,
  component: ({ props }) => (
    <MailText
      head={draftLines([
        ["To", props.to],
        ["Cc", props.cc],
        ["Subject", props.subject],
      ])}
      body={String(props.body ?? "")}
    />
  ),
});
const TeamsDraft = defineComponent({
  ...schema.TeamsDraft,
  component: ({ props }) => (
    <Prose text={`${draftLines([["Teams", props.chat]])}\n\n${String(props.body ?? "")}`} />
  ),
});

// A decision put to the person: each way to go is a chip that sends its title.
const choiceOptions = (given: unknown) =>
  (Array.isArray(given) ? given : [])
    .flatMap((option) =>
      option && typeof option.title === "string" && option.title.trim()
        ? [
            {
              title: option.title.trim().replaceAll("*", "").slice(0, 160),
              detail: String(option.detail ?? "").slice(0, 400),
            },
          ]
        : [],
    )
    .slice(0, 4);
function ChoiceButtons({ options }: { options: { title: string }[] }) {
  const c = useColors();
  const { t } = useI18n();
  // A decision is for the moment it was asked: once anything is said after it, it is closed.
  const place = useContext(FormScope);
  const closed = Boolean(place && !place.last);
  return (
    <>
      <FollowUpButtons
        closed={closed}
        items={options.map((option) => ({ label: option.title, text: option.title }))}
      />
      {closed && <Text style={{ fontSize: 12, color: c.muted }}>{t.app.form.choiceClosed}</Text>}
    </>
  );
}
const Choices = defineComponent({
  ...schema.Choices,
  component: ({ props }) => (
    <>
      <Prose
        text={`**${String(props.question ?? "").replaceAll("*", "")}**\n\n${choiceOptions(
          props.options,
        )
          .map((option, index) => `${index + 1}. **${option.title}** ${option.detail}`)
          .join("\n")}`}
      />
      <ChoiceButtons options={choiceOptions(props.options)} />
    </>
  ),
});

// A form is drawn whole by its card, from what the reply gave it, checked. Its fields exist
// only inside it: met anywhere else they draw nothing.
const Form = defineComponent({
  ...schema.Form,
  component: ({ props }) => <FormCard props={props} />,
});
const nothing = () => null;
const TextField = defineComponent({ ...schema.TextField, component: nothing });
const SelectField = defineComponent({ ...schema.SelectField, component: nothing });
const DateField = defineComponent({ ...schema.DateField, component: nothing });
const NumberField = defineComponent({ ...schema.NumberField, component: nothing });

// An agent or a skill proposed in a reply. It is made from its card in the web or desktop
// app; here it can be read.
const AgentDraft = defineComponent({
  ...schema.AgentDraft,
  component: ({ props }) => (
    <Prose
      text={`${draftLines([
        ["New agent", props.name],
        ["What it does", props.description],
        ["It may", props.abilities],
      ])}\n\n${String(props.instructions ?? "")}\n\nCreate it from this conversation in the web or desktop app.`}
    />
  ),
});
const SkillDraft = defineComponent({
  ...schema.SkillDraft,
  component: ({ props }) => (
    <Prose
      text={`${draftLines([
        ["New skill", props.name],
        ["Use it when", props.description],
      ])}\n\n${String(props.instructions ?? "")}${props.template ? `\n\n${String(props.template)}` : ""}\n\nCreate it from this conversation in the web or desktop app.`}
    />
  ),
});

const library = createLibrary({
  root: "Stack",
  components: [
    Stack,
    TextPart,
    Heading,
    Callout,
    List,
    DataTable,
    Facts,
    Code,
    Diagram,
    Chart,
    Scatter,
    Heatmap,
    Tiles,
    Candles,
    Flows,
    Metrics,
    Progress,
    Timeline,
    Sources,
    FollowUps,
    Choices,
    MailDraft,
    TeamsDraft,
    AgentDraft,
    SkillDraft,
    Walkthrough,
    Form,
    TextField,
    SelectField,
    DateField,
    NumberField,
  ],
});

/**
 * One reply from an agent, rendered from the OpenUI Lang it wrote. Safe to call on every new piece of text.
 *
 * The renderer is given no tool provider and no handler for actions: a reply that writes a
 * query, a mutation or a step that opens an address calls nothing and opens nothing.
 */
export function Reply({
  text,
  streaming,
  fallback,
}: {
  text: string;
  streaming: boolean;
  fallback?: ReactNode;
}) {
  const response = toRenderable(text, streaming);
  if (!response) return <>{fallback ?? null}</>;
  return (
    <Renderer
      response={response}
      library={library}
      isStreaming={streaming}
      publishObservability={false}
    />
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 25 },
  small: { fontSize: 13, lineHeight: 20 },
  heading: { fontSize: 19, lineHeight: 27, fontWeight: "600", paddingTop: 4 },
  callout: {
    flexDirection: "row",
    gap: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  table: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row" },
  cell: { paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, lineHeight: 18 },
  headCell: { fontWeight: "600", fontSize: 13 },
  facts: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
  },
  code: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  codeBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  copy: { flexDirection: "row", alignItems: "center", gap: 4 },
  codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19, padding: 12 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  followUp: { minHeight: 36, paddingHorizontal: 12, borderRadius: 18 },
});

/** A heading's words without the closing #s Markdown allows ("## Title ##"), in one pass. */
function headingText(text: string): string {
  const words = text.trimEnd();
  let end = words.length;
  while (end > 0 && words[end - 1] === "#") end--;
  // Closing #s stand apart from the words; "C#" keeps its #.
  return end < words.length && (end === 0 || /\s/.test(words[end - 1] ?? ""))
    ? words.slice(0, end).trim()
    : words.trim();
}
