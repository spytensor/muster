import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { api } from "./lib/api";
import { ranCode } from "./lib/code";
import { doneOf, duration } from "./lib/live";
import { toolLabel } from "./lib/tools";
import type { PlanItem, Step, StepDetail } from "./lib/types";
import { mono, useColors } from "./theme";
import { Glass } from "./ui";

const stepIcon = {
  ok: "checkmark",
  error: "warning-outline",
  blocked: "ban-outline",
} as const;

/**
 * The code a step ran, as code, and what it printed: read from the run's record when the
 * row is opened. Long lines are scrolled sideways, never folded: folded code is not code.
 */
function RanCode({ conversation, step }: { conversation: string; step: Step }) {
  const { t } = useI18n();
  const c = useColors();
  const [detail, setDetail] = useState<StepDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the step ends
  useEffect(() => {
    let live = true;
    api<StepDetail>(`/api/app/conversations/${conversation}/steps/${encodeURIComponent(step.id)}`)
      .then((found) => live && setDetail(found))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [conversation, step.id, step.status]);
  if (missing)
    return <Text style={[styles.small, { color: c.muted }]}>{t.app.ranCode.notKept}</Text>;
  if (!detail) return <ActivityIndicator size="small" color={c.muted} style={styles.spinner} />;
  const ran = ranCode(detail.asked);
  const block = (text: string, sideways: boolean) => (
    <ScrollView
      nestedScrollEnabled
      style={[styles.code, { backgroundColor: c.page, borderColor: c.border }]}
    >
      <ScrollView horizontal={sideways} showsHorizontalScrollIndicator={sideways}>
        <Text selectable style={[styles.codeText, { color: c.text }]}>
          {text}
        </Text>
      </ScrollView>
    </ScrollView>
  );
  return (
    <View style={{ gap: 5, paddingBottom: 4 }}>
      {ran && (
        <>
          <Text style={[styles.label, { color: c.muted }]}>
            {ran.language === "shell" ? "Shell" : "Python"}
          </Text>
          {block(ran.code, true)}
        </>
      )}
      <Text style={[styles.label, { color: c.muted }]}>{t.app.ranCode.output}</Text>
      {block(detail.returned || t.app.ranCode.nothing, false)}
      {(ran?.cut || detail.returned.length >= detail.limit) && (
        <Text style={[styles.small, { color: c.muted }]}>{t.app.ranCode.cut}</Text>
      )}
    </View>
  );
}

function StepRow({ step, conversation }: { step: Step; conversation?: string }) {
  const { t } = useI18n();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const action = toolLabel(t.app.toolName, step.tool, t.app.connectorTool);
  // A run of code opens on its code; a failed one says so on its row, in the bad colour.
  const opens = step.tool === "code.run" && conversation !== undefined;
  const row = (
    <View style={styles.row}>
      <View style={styles.icon}>
        {step.status === "running" ? (
          <ActivityIndicator size="small" color={c.accentText} style={styles.spinner} />
        ) : (
          <Ionicons
            name={stepIcon[step.status]}
            size={14}
            color={step.status === "ok" ? c.ok : step.status === "error" ? c.bad : c.warn}
          />
        )}
      </View>
      <Text style={{ fontSize: 13, color: step.status === "error" ? c.bad : c.text }}>
        {step.status === "ok"
          ? toolLabel(t.app.toolDone, step.tool, t.app.connectorTool)
          : t.app.step[step.status](action)}
      </Text>
      <Text numberOfLines={1} style={[styles.subject, { color: c.muted }]}>
        {step.detail}
      </Text>
      {step.ms !== null && (
        <Text style={[styles.time, { color: c.muted }]}>{duration(step.ms)}</Text>
      )}
      {opens && (
        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={12} color={c.muted} />
      )}
    </View>
  );
  if (!opens) return row;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={4}
        onPress={() => setOpen(!open)}
      >
        {row}
      </Pressable>
      {open && conversation && <RanCode conversation={conversation} step={step} />}
    </View>
  );
}

/** The steps of one reply. One line when it is over; open, with the current step turning, while it runs. */
export function Activity({
  steps: all,
  running,
  conversation,
}: {
  steps: Step[];
  running: boolean;
  /** The conversation the steps are of: a run of code opens on its code when this is given. */
  conversation?: string;
}) {
  // What the agent said while it worked is a step of its own kind; here only what it did is listed.
  // Nor what the person added while it worked: those are words, not something done.
  const steps = all.filter((step) => step.tool !== "note" && step.tool !== "aside");
  const { t } = useI18n();
  const c = useColors();
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const shown = running || open;
  const problem = steps.some((step) => step.status === "error" || step.status === "blocked");
  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.soft }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: shown, disabled: running }}
        disabled={running}
        hitSlop={6}
        onPress={() => setOpen(!open)}
        style={styles.head}
      >
        <Ionicons name={shown ? "chevron-down" : "chevron-forward"} size={13} color={c.muted} />
        <Text style={[styles.headText, { color: c.text }]}>{t.app.usedTools(steps.length)}</Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: c.muted }}>
          {shown
            ? ""
            : steps
                .map((step) => toolLabel(t.app.toolDone, step.tool, t.app.connectorTool))
                .join(" · ")}
        </Text>
        {problem && <Ionicons name="warning-outline" size={14} color={c.warn} />}
      </Pressable>
      {shown && (
        <View style={[styles.body, { borderColor: c.border }]}>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} conversation={conversation} />
          ))}
        </View>
      )}
    </View>
  );
}

/** `live` is false in a finished reply: an item left unfinished there is no longer turning. */
function PlanList({ plan, live }: { plan: PlanItem[]; live: boolean }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      {plan.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a plan is replaced whole, never reordered
        <View key={index} style={[styles.row, { alignItems: "flex-start", minHeight: 22 }]}>
          <View style={[styles.icon, { marginTop: 2 }]}>
            {item.status === "in_progress" && live ? (
              <ActivityIndicator size="small" color={c.accentText} style={styles.spinner} />
            ) : (
              <Ionicons
                name={item.status === "done" ? "checkmark-circle" : "ellipse-outline"}
                size={15}
                color={item.status === "done" ? c.ok : c.muted}
              />
            )}
          </View>
          <Text
            style={[
              { flex: 1, fontSize: 13, lineHeight: 19, color: c.text },
              item.status === "done" && { color: c.muted },
              item.status === "in_progress" && live && { fontWeight: "600" },
            ]}
          >
            {item.title}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The agent's plan for a reply, with how far along it is. While the agent works it is the open
 * checklist pinned above the message box; in a finished reply it is one line that opens.
 */
export function PlanCard({ plan, live }: { plan: PlanItem[]; live: boolean }) {
  const { t } = useI18n();
  const c = useColors();
  const [open, setOpen] = useState(live);
  if (plan.length === 0) return null;
  const done = doneOf(plan);
  const inside = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${t.app.plan} · ${t.app.planProgress(done, plan.length)}`}
        hitSlop={6}
        onPress={() => setOpen(!open)}
        style={styles.head}
      >
        <Ionicons name="list-outline" size={14} color={c.muted} />
        <Text style={[styles.headText, { color: c.text }]}>{t.app.plan}</Text>
        <Text style={{ fontSize: 12, color: c.muted }}>
          {t.app.planProgress(done, plan.length)}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={[styles.track, { backgroundColor: c.border }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: c.ok, width: `${(done / plan.length) * 100}%` },
            ]}
          />
        </View>
        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={13} color={c.muted} />
      </Pressable>
      {open && (
        <View style={[styles.body, { borderColor: c.border }]}>
          <PlanList plan={plan} live={live} />
        </View>
      )}
    </>
  );
  return live ? (
    <Glass style={styles.glass}>{inside}</Glass>
  ) : (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.soft }]}>{inside}</View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  glass: { borderRadius: 14, overflow: "hidden" },
  head: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9 },
  headText: { fontSize: 12, fontWeight: "600" },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9, paddingVertical: 5 },
  row: { minHeight: 24, flexDirection: "row", alignItems: "center", gap: 7 },
  icon: { width: 16, alignItems: "center" },
  spinner: { transform: [{ scale: 0.7 }] },
  subject: { flex: 1, fontFamily: mono, fontSize: 11 },
  time: { fontSize: 11, fontVariant: ["tabular-nums"] },
  label: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  small: { fontSize: 11, lineHeight: 16 },
  code: { maxHeight: 220, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  codeText: { fontFamily: mono, fontSize: 11, lineHeight: 16, padding: 8 },
  track: { width: 56, height: 3, borderRadius: 2, overflow: "hidden" },
  fill: { height: 3, borderRadius: 2 },
});
