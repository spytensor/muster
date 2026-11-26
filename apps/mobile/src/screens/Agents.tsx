import Ionicons from "@expo/vector-icons/Ionicons";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { type AppAgent, shownName } from "../lib/types";
import { choose } from "../menu";
import { useNav } from "../nav";
import { PRESSED, radius, type, useColors } from "../theme";
import { Group, LoadError, Loading, Notice, SectionTitle, useAction, useLoad } from "../ui";

/**
 * One agent as a row of a list (CHA-261): its initial, its name, what it is for in two
 * lines. A touch starts a conversation with it. How far it reaches is said in words only
 * when it reaches outside (R3, R4); the list of its tools is in its editor, not here.
 */
function AgentRow({ agent, onMore }: { agent: AppAgent; onMore?: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const nav = useNav();
  const b = t.app.builder;
  const usable = agent.state === "published";
  const far = agent.risk === "R3" || agent.risk === "R4";
  const note =
    agent.state === "pending"
      ? b.pendingNote
      : agent.state === "suspended"
        ? b.suspendedNote
        : far
          ? (t.risk[agent.risk] ?? "")
          : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${shownName(agent)}. ${agent.description} ${note}`}
      accessibilityHint={usable ? b.talk : undefined}
      accessibilityState={{ disabled: !usable }}
      accessibilityActions={
        onMore ? [{ name: "more", label: `${b.edit}, ${t.common.delete}` }] : undefined
      }
      onAccessibilityAction={(event) => event.nativeEvent.actionName === "more" && onMore?.()}
      disabled={!usable && !onMore}
      onPress={() =>
        usable ? nav.popTo("Home", { agentId: agent.id, fresh: Date.now() }) : onMore?.()
      }
      onLongPress={onMore}
      style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED }]}
    >
      <View style={[styles.mark, { backgroundColor: c.soft }]}>
        <Text style={{ fontSize: 17, fontWeight: "600", color: c.text }}>
          {shownName(agent).slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "600", color: c.text }}>
          {shownName(agent)}
        </Text>
        {agent.description !== "" && (
          <Text numberOfLines={2} style={[type.secondary, { color: c.muted }]}>
            {agent.description}
          </Text>
        )}
        {note !== "" && (
          <Text
            numberOfLines={2}
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: agent.state === "suspended" ? c.bad : c.warn,
            }}
          >
            {note}
          </Text>
        )}
      </View>
      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${b.edit}, ${t.common.delete}`}
          hitSlop={12}
          onPress={onMore}
          style={({ pressed }) => pressed && { opacity: PRESSED }}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={c.muted} />
        </Pressable>
      ) : (
        usable && <Ionicons name="chevron-forward" size={17} color={c.faint} />
      )}
    </Pressable>
  );
}

/** The agents a person can talk to, and the ones they built. */
export function Agents() {
  const { t } = useI18n();
  const c = useColors();
  const b = t.app.builder;
  const { data, error, reload, refresh, refreshing } = useLoad(() =>
    api<{ agents: AppAgent[] }>("/api/app/agents"),
  );
  const { error: failure, run } = useAction();
  const nav = useNav();
  if (!data)
    return (
      <View style={{ flex: 1 }}>
        {error ? <LoadError message={error} onRetry={reload} /> : <Loading />}
      </View>
    );
  // Built by the person, not merely by a person: a colleague's shared agent is not theirs
  // to edit or delete.
  const mine = data.agents.filter((agent) => agent.mine);
  const provided = data.agents.filter((agent) => !agent.mine);
  const more = (agent: AppAgent) =>
    choose(
      { options: [b.edit, t.common.delete], destructive: 1, cancel: t.common.cancel },
      (index) => {
        if (index === 0) nav.navigate("Agent", { id: agent.id });
        if (index === 1)
          Alert.alert(t.common.delete, b.deleteConfirm(agent.name), [
            { text: t.common.cancel, style: "cancel" },
            {
              text: t.common.delete,
              style: "destructive",
              onPress: () =>
                void run(async () => {
                  await api(`/api/app/agents/${agent.id}`, { method: "DELETE" });
                  await reload();
                }),
            },
          ]);
      },
    );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {failure && <Notice tone="bad">{failure}</Notice>}
      <View style={styles.section}>
        <SectionTitle>{b.mine}</SectionTitle>
        <Group>
          {mine.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onMore={() => more(agent)} />
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={b.new}
            onPress={() => nav.navigate("Agent")}
            style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED }]}
          >
            <View style={[styles.mark, { borderColor: c.outline, borderWidth: 1 }]}>
              <Ionicons name="add" size={22} color={c.text} />
            </View>
            <Text style={{ flex: 1, fontSize: 16, color: c.text }}>{b.new}</Text>
          </Pressable>
        </Group>
        <Text style={[type.secondary, styles.foot, { color: c.muted }]}>{b.lead}</Text>
      </View>
      {provided.length > 0 && (
        <View style={styles.section}>
          <SectionTitle>{b.provided}</SectionTitle>
          <Group>
            {provided.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </Group>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 28 },
  section: { gap: 8 },
  foot: { paddingHorizontal: 4 },
  row: {
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  mark: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
