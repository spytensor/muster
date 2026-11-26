import { useEffect } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApprovalCard } from "../approval";
import { useBars } from "../bars";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { type InboxNotice, opens, runsOf } from "../lib/inbox";
import type { Approval } from "../lib/types";
import { useNav, useWaiting } from "../nav";
import { PRESSED, useColors } from "../theme";
import { Button, Divider, LoadError, Loading, SectionTitle, useLoad } from "../ui";

/**
 * The inbox: what waits for the person, then what happened while they were away. One
 * list, as on the web (2026-11-24): what was decided before is in its conversation, not
 * here. The same thing told several times in a row is one line with how often.
 */
export function Inbox() {
  const { t, ago } = useI18n();
  const c = useColors();
  const nav = useNav();
  const waiting = useWaiting();
  const bars = useBars();
  const n = t.app.notices;
  const { data, error, reload, refresh, refreshing } = useLoad(async () => {
    const [approvals, notices] = await Promise.all([
      api<Approval[]>("/api/app/approvals"),
      api<{ unread: number; notices: InboxNotice[] }>("/api/app/notices"),
    ]);
    return { approvals, ...notices };
  });
  // Opening the list is having read it.
  const unread = data?.unread ?? 0;
  const recount = waiting.refresh;
  useEffect(() => {
    if (unread > 0)
      void api("/api/app/notices/read", { method: "POST" })
        .then(recount)
        .catch(() => undefined);
  }, [unread, recount]);
  if (!data)
    return (
      <View style={{ flex: 1, ...bars.pad }}>
        {error ? <LoadError message={error} onRetry={reload} /> : <Loading />}
      </View>
    );
  const pending = data.approvals.filter((approval) => approval.status === "pending");
  const runs = runsOf(data.notices);
  return (
    <ScrollView
      {...bars.scroll}
      contentContainerStyle={[styles.page, bars.pad]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {pending.length === 0 && runs.length === 0 && (
        <Text style={[styles.none, { color: c.muted }]}>{n.none}</Text>
      )}
      {pending.length > 0 && <SectionTitle>{t.app.approval.pending}</SectionTitle>}
      {pending.map((approval) => (
        <View key={approval.id} style={{ gap: 6 }}>
          <ApprovalCard
            approval={approval}
            agentName={approval.agentName ?? ""}
            onDecided={() => {
              void reload();
              waiting.refresh();
            }}
          />
          {approval.conversationId && (
            <Button
              small
              variant="ghost"
              icon="chatbubble-outline"
              label={t.app.approval.open}
              style={{ alignSelf: "flex-end" }}
              onPress={() => nav.popTo("Home", { id: approval.conversationId ?? "" })}
            />
          )}
        </View>
      ))}
      {runs.length > 0 && (
        <View>
          {runs.map(({ notice, times }, at) => {
            const to = opens(notice.link);
            const line = (
              <View style={styles.row}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: notice.readAt ? "transparent" : c.accent },
                  ]}
                />
                <Text style={[styles.text, { color: c.text }]}>
                  {(n.text[notice.kind] ?? n.other)(notice.detail)}
                </Text>
                <Text style={[styles.when, { color: c.muted }]}>
                  {times > 1 ? `${n.times(times)} · ` : ""}
                  {ago(notice.createdAt)}
                </Text>
              </View>
            );
            return (
              <View key={notice.id}>
                {at > 0 && <Divider />}
                {to ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      to.screen === "conversation"
                        ? nav.popTo("Home", { id: to.id })
                        : nav.navigate("Project", { id: to.id })
                    }
                    style={({ pressed }) => pressed && { opacity: PRESSED }}
                  >
                    {line}
                  </Pressable>
                ) : (
                  line
                )}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 16 },
  none: { fontSize: 15, textAlign: "center", paddingVertical: 48 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 12 },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  text: { flex: 1, fontSize: 15, lineHeight: 21 },
  when: { fontSize: 12, lineHeight: 21, fontVariant: ["tabular-nums"] },
});
