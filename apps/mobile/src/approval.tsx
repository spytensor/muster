import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { api } from "./lib/api";
import { minutesLeft } from "./lib/format";
import type { Approval } from "./lib/types";
import { mono, useColors } from "./theme";
import { Button, Notice, useAction } from "./ui";

/** The facts of an action that is waiting: the whole address and everything that would be sent. */
export function ApprovalFacts({ approval }: { approval: Approval }) {
  const { t } = useI18n();
  const c = useColors();
  const a = t.app.approval;
  const { summary } = approval;
  const label = [styles.label, { color: c.muted }];
  const code = { fontFamily: mono, fontSize: 12, lineHeight: 17, color: c.text };
  return (
    <View style={{ gap: 7 }}>
      <View style={styles.fact}>
        <Text style={label}>{a.destination}</Text>
        {/* The whole address, never shortened: what is hidden could be what matters. */}
        <ScrollView
          nestedScrollEnabled
          style={[styles.box, { backgroundColor: c.soft, maxHeight: 96 }]}
        >
          <Text selectable style={[code, styles.boxText]}>
            {summary.destination}
          </Text>
        </ScrollView>
      </View>
      <View style={styles.pair}>
        <View style={[styles.fact, { flex: 1 }]}>
          <Text style={label}>{a.method}</Text>
          <Text style={[styles.value, { color: c.text }]}>
            <Text style={{ fontFamily: mono, fontSize: 12 }}>{summary.method}</Text> ·{" "}
            {t.app.toolSummary[approval.tool] ?? approval.tool}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={label}>{a.size}</Text>
          <Text style={[styles.value, { color: c.text }]}>{a.bytes(summary.bytes)}</Text>
          {Boolean(summary.contentType) && (
            <Text style={{ fontFamily: mono, fontSize: 11, color: c.muted }}>
              {summary.contentType}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.fact}>
        <Text style={label}>{a.preview}</Text>
        {summary.bytes > 0 ? (
          <ScrollView
            nestedScrollEnabled
            style={[styles.box, { backgroundColor: c.soft, maxHeight: 200 }]}
          >
            <Text selectable style={[code, styles.boxText]}>
              {summary.preview}
            </Text>
          </ScrollView>
        ) : (
          <Text style={[styles.value, { color: c.muted }]}>{a.nothingSent}</Text>
        )}
      </View>
    </View>
  );
}

/** Asks the person to allow or refuse one action. Nothing happens until they choose. */
export function ApprovalCard({
  approval,
  agentName,
  onDecided,
}: {
  approval: Approval;
  agentName: string;
  onDecided?: () => void;
}) {
  const { t } = useI18n();
  const c = useColors();
  const a = t.app.approval;
  const { busy, error, run } = useAction();
  // Counted down while the card is on screen, so the person sees how long is left.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);
  const left = approval.status === "pending" ? minutesLeft(approval.expiresAt, now) : null;
  const decide = (decision: "approve" | "reject") =>
    void run(async () => {
      await api(`/api/app/approvals/${approval.id}`, { method: "POST", body: { decision } });
      onDecided?.();
    });
  return (
    <View
      accessibilityLabel={a.title}
      style={[styles.card, { backgroundColor: c.warnSoft, borderColor: c.warnBorder }]}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Ionicons name="shield-half-outline" size={18} color={c.warn} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
            {a.title}
          </Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: c.muted }}>
            {a.lead(agentName)}
            {left !== null && ` ${a.expiresIn(left)}`}
          </Text>
        </View>
      </View>
      <ApprovalFacts approval={approval} />
      {error && <Notice tone="bad">{error}</Notice>}
      <View style={styles.pair}>
        <Button
          variant="outline"
          label={a.reject}
          disabled={busy}
          style={{ flex: 1 }}
          onPress={() => decide("reject")}
        />
        <Button
          label={a.approve}
          disabled={busy}
          style={{ flex: 1 }}
          onPress={() => decide("approve")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 10 },
  title: { fontSize: 14, fontWeight: "700" },
  fact: { gap: 2 },
  pair: { flexDirection: "row", gap: 10 },
  label: { fontSize: 12 },
  value: { fontSize: 13, lineHeight: 18 },
  box: { borderRadius: 8 },
  boxText: { paddingHorizontal: 9, paddingVertical: 7 },
});
