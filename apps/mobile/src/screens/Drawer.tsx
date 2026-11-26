import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { dayGroup } from "../lib/live";
import type { ConversationSummary } from "../lib/types";
import { choose } from "../menu";
import { useNav, useWaiting } from "../nav";
import { useSession } from "../session";
import { PRESSED, radius, useColors } from "../theme";
import { Badge, Button, Glass, type IconName, Loading, Notice } from "../ui";

const groups = ["today", "yesterday", "earlier"] as const;

/**
 * The drawer (CHA-261): everything that is not the conversation in front. It lies under the
 * conversation at the left and is uncovered when the conversation moves aside, as in the
 * apps people already know. A flat list, no cards: the name and a search button; Agents,
 * Documents and the Inbox; the person's conversations by day as plain titles; and at the
 * bottom a new conversation and the person, which opens Settings.
 */
export function Drawer({
  width,
  open,
  current,
  onClose,
  onPick,
  onNew,
}: {
  width: number;
  open: boolean;
  /** The conversation in front, marked in the list. */
  current?: string;
  onClose(): void;
  onPick(id: string): void;
  /** Starts a new conversation; also called when the one in front was deleted. */
  onNew(): void;
}) {
  const { t, errorText } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const session = useSession();
  const waiting = useWaiting();
  const [data, setData] = useState<ConversationSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const words = useRef(errorText);
  words.current = errorText;
  // Each reading is numbered: an older answer that arrives late does not replace a newer one.
  const asked = useRef(0);
  const load = useCallback(() => {
    const mine = ++asked.current;
    return api<ConversationSummary[]>("/api/app/conversations").then(
      (all) => {
        if (mine !== asked.current) return;
        setData(all);
        setProblem(null);
      },
      (failure) => mine === asked.current && setProblem(words.current(failure)),
    );
  }, []);
  // Read each time it is opened: a conversation may have been started or renamed since.
  useEffect(() => {
    if (open) void load();
    else {
      setSearching(false);
      setQuery("");
    }
  }, [open, load]);
  const sections = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    const shown = (data ?? []).filter(
      (item) =>
        !wanted ||
        item.title.toLowerCase().includes(wanted) ||
        item.agentName.toLowerCase().includes(wanted),
    );
    return groups
      .map((group) => ({
        title: t.app[group],
        items: shown.filter((item) => dayGroup(item.updatedAt) === group),
      }))
      .filter((section) => section.items.length > 0);
  }, [data, query, t]);
  const act = (work: () => Promise<void>) =>
    void work().then(load, (failure) => setProblem(words.current(failure)));
  /** Rename or delete, from a long press on a conversation. */
  const more = (item: ConversationSummary) =>
    choose(
      { options: [t.app.rename, t.app.delete], destructive: 1, cancel: t.common.cancel },
      (index) => {
        if (index === 0)
          Alert.prompt(
            t.app.rename,
            t.app.renameLead,
            [
              { text: t.common.cancel, style: "cancel" },
              {
                text: t.common.save,
                onPress: (typed?: string) => {
                  const next = (typed ?? "").trim().slice(0, 120);
                  if (!next || next === item.title) return;
                  act(() =>
                    api(`/api/app/conversations/${item.id}`, {
                      method: "PATCH",
                      body: { title: next },
                    }),
                  );
                },
              },
            ],
            "plain-text",
            item.title,
          );
        if (index === 1)
          Alert.alert(t.app.delete, t.app.deleteConfirm, [
            { text: t.common.cancel, style: "cancel" },
            {
              text: t.common.delete,
              style: "destructive",
              onPress: () =>
                act(async () => {
                  await api(`/api/app/conversations/${item.id}`, { method: "DELETE" });
                  // The one in front is gone: there is nothing of it left to show.
                  if (item.id === current) onNew();
                }),
            },
          ]);
      },
    );
  const go = (screen: "Agents" | "Documents" | "Inbox" | "Settings") => {
    onClose();
    nav.navigate("Sheet", { screen });
  };
  const me = session.me;
  const name = me?.user.name || me?.user.email || "";
  const initials = name
    .split(/\s+/)
    .map((part) => part.slice(0, 1))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const place = (icon: IconName, label: string, onPress: () => void, count = 0) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}, ${count}` : label}
      onPress={onPress}
      style={({ pressed }) => [styles.place, pressed && { opacity: PRESSED }]}
    >
      <Ionicons name={icon} size={24} color={c.text} />
      <Text style={{ fontSize: 17, fontWeight: "500", color: c.text }}>{label}</Text>
      {count > 0 && <Badge tone="warn" label={String(count)} />}
    </Pressable>
  );
  return (
    <View
      // Nothing in it can be reached while it is covered.
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[styles.drawer, { width, paddingTop: insets.top + 8, backgroundColor: c.page }]}
    >
      <View style={styles.head}>
        <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: "700", color: c.text }}>
          Muster
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.app.search}
          accessibilityState={{ expanded: searching }}
          hitSlop={6}
          onPress={() => {
            setSearching((now) => !now);
            setQuery("");
          }}
          style={({ pressed }) => pressed && { opacity: PRESSED }}
        >
          <Glass style={styles.round}>
            <Ionicons name={searching ? "close" : "search"} size={22} color={c.text} />
          </Glass>
        </Pressable>
      </View>
      {searching && (
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={t.app.search}
          placeholderTextColor={c.faint}
          accessibilityLabel={t.app.search}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.search, { color: c.text, backgroundColor: c.card }]}
        />
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
      >
        {!searching && (
          <View>
            {place("sparkles-outline", t.app.agents, () => go("Agents"))}
            {place("document-text-outline", t.app.documents, () => go("Documents"))}
            {place("file-tray-outline", t.app.inbox, () => go("Inbox"), waiting.count)}
          </View>
        )}
        {problem && (
          <View style={{ gap: 8, alignItems: "flex-start" }}>
            <Notice tone="bad">{problem}</Notice>
            <Button small variant="outline" label={t.common.retry} onPress={() => void load()} />
          </View>
        )}
        {!data && !problem && <Loading />}
        {data && data.length === 0 && (
          <Text style={{ fontSize: 15, color: c.muted }}>{t.app.noConversations}</Text>
        )}
        {data && data.length > 0 && sections.length === 0 && (
          <Text style={{ fontSize: 15, color: c.muted }}>{t.app.noMatches}</Text>
        )}
        {sections.map((section) => (
          <View key={section.title}>
            <Text
              accessibilityRole="header"
              style={{ fontSize: 15, fontWeight: "600", color: c.muted, paddingVertical: 8 }}
            >
              {section.title}
            </Text>
            {section.items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`${item.title || t.app.untitled}, ${item.agentName}`}
                accessibilityState={{ selected: item.id === current }}
                accessibilityActions={[{ name: "more", label: `${t.app.rename}, ${t.app.delete}` }]}
                onAccessibilityAction={(event) =>
                  event.nativeEvent.actionName === "more" && more(item)
                }
                onPress={() => onPick(item.id)}
                onLongPress={() => more(item)}
                style={({ pressed }) => [styles.talk, pressed && { opacity: PRESSED }]}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    fontSize: 16,
                    color: c.text,
                    fontWeight: item.id === current ? "600" : "400",
                  }}
                >
                  {item.title || t.app.untitled}
                </Text>
                {item.running && (
                  <View
                    accessibilityLabel={t.app.running}
                    style={[styles.dot, { backgroundColor: c.ok }]}
                  />
                )}
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
      <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.app.newChat}
          onPress={onNew}
          style={({ pressed }) => [
            styles.fresh,
            { backgroundColor: c.primary },
            pressed && { opacity: PRESSED },
          ]}
        >
          <Ionicons name="create-outline" size={20} color={c.onPrimary} />
          <Text style={{ fontSize: 16, fontWeight: "600", color: c.onPrimary }}>
            {t.app.newChatShort}
          </Text>
        </Pressable>
        {me && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${t.app.settings}`}
            hitSlop={6}
            onPress={() => go("Settings")}
            style={({ pressed }) => pressed && { opacity: PRESSED }}
          >
            <Glass style={styles.round}>
              <View style={[styles.me, { backgroundColor: c.accentSoft }]}>
                <Text style={{ fontSize: 13, fontWeight: "700", color: c.accentText }}>
                  {initials}
                </Text>
              </View>
            </Glass>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: { position: "absolute", left: 0, top: 0, bottom: 0 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 20,
    paddingRight: 12,
    minHeight: 48,
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    height: 44,
    borderRadius: radius.control,
    borderCurve: "continuous",
    paddingHorizontal: 14,
    fontSize: 16,
  },
  list: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 12 },
  place: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 14 },
  talk: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  fresh: {
    height: 48,
    borderRadius: radius.pill,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  me: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
