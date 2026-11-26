import Ionicons from "@expo/vector-icons/Ionicons";
import { type FormAction, readAction, UI_VERSION } from "@muster/ui-schema";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ApprovalCard } from "../approval";
import {
  type Attachments,
  AttachmentTray,
  FileChip,
  pickDocuments,
  pickPhotos,
  useAttachments,
  useOpenFile,
} from "../files";
import { AnswerCard, type AnswerForm, FormScope, formPlace } from "../forms";
import { useI18n } from "../i18n";
import { ApiError, api, watchConversation } from "../lib/api";
import { madeFiles } from "../lib/files";
import { broughtBack, cameBack, lastOwn } from "../lib/followups";
import { readableReply } from "../lib/format";
import { applyEvent, idle, type Live, mergeMessages } from "../lib/live";
import {
  type AppAgent,
  type ConversationDetail,
  type ConversationSummary,
  type FileItem,
  type Message,
  generalOf,
  shownName,
} from "../lib/types";
import { choose } from "../menu";
import { useKeyboardUp, useReducedMotion } from "../motion";
import { type RootParams, useWaiting } from "../nav";
import { Activity, PlanCard } from "../progress";
import { Reply, ReplyActions } from "../reply";
import { useSession } from "../session";
import { curve, PRESSED, radius, type, useColors } from "../theme";
import { Badge, Glass, LoadError, Loading, Notice, useAction, useLoad } from "../ui";
import { Drawer } from "./Drawer";

function Composer({
  placeholder,
  disabled,
  running,
  attach,
  onSend,
  onStop,
}: {
  placeholder: string;
  disabled: boolean;
  running: boolean;
  attach: Attachments;
  /** Sends, and says whether it was taken: what was typed is put back when it was not. */
  onSend(text: string, files: FileItem[]): Promise<boolean>;
  onStop(): void;
}) {
  const { t } = useI18n();
  const c = useColors();
  const [text, setText] = useState("");
  /** The + menu: where a file comes from. */
  const [menu, setMenu] = useState(false);
  /** Whether the person is in the box: it opens up, with room to write. */
  const [focused, setFocused] = useState(false);
  // The menu is for a box that can be used: it goes when the box cannot.
  useEffect(() => {
    if (disabled) setMenu(false);
  }, [disabled]);
  const open = focused || text.includes("\n");
  const send = () => {
    const content = text.trim();
    // A message waits for its files: sending while one is still uploading would leave it behind.
    if (!content || disabled || running || attach.busy) return;
    setText("");
    setMenu(false);
    void onSend(content, attach.ready).then((taken) => {
      if (taken) attach.clear();
      // Not sent: the words go back in the box, unless the person has typed again since.
      else setText((now) => now || content);
    });
  };
  const can = !disabled && Boolean(text.trim()) && !attach.busy;
  return (
    <View>
      {menu && (
        <Glass style={styles.menu}>
          {(
            [
              ["image-outline", t.files.fromPhotos, pickPhotos],
              ["attach-outline", t.files.fromFiles, pickDocuments],
            ] as const
          ).map(([icon, label, pick]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() => {
                setMenu(false);
                void pick().then(attach.add, attach.fail);
              }}
              style={({ pressed }) => [styles.menuRow, pressed && { opacity: PRESSED }]}
            >
              <View style={[styles.menuIcon, { backgroundColor: c.soft }]}>
                <Ionicons name={icon} size={20} color={c.text} />
              </View>
              <Text style={{ fontSize: 17, color: c.text }}>{label}</Text>
            </Pressable>
          ))}
        </Glass>
      )}
      <Glass style={[styles.composer, open && styles.composerOpen]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.files.attach}
          accessibilityState={{ expanded: menu, disabled }}
          disabled={disabled}
          hitSlop={4}
          onPress={() => setMenu((now) => !now)}
          style={({ pressed }) => [styles.plus, (disabled || pressed) && { opacity: 0.4 }]}
        >
          <Ionicons name={menu ? "close" : "add"} size={26} color={c.text} />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => {
            setMenu(false);
            setFocused(true);
          }}
          onBlur={() => setFocused(false)}
          multiline
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={c.faint}
          accessibilityLabel={placeholder}
          style={[styles.input, open && styles.inputOpen, { color: c.text }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={running ? t.app.stop : t.app.send}
          accessibilityState={{ disabled: !running && !can }}
          disabled={!running && !can}
          hitSlop={4}
          onPress={running ? onStop : send}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: c.primary },
            !running && !can && { opacity: 0.35 },
            pressed && { opacity: PRESSED },
          ]}
        >
          <Ionicons
            name={running ? "square" : "arrow-up"}
            size={running ? 14 : 20}
            color={c.onPrimary}
          />
        </Pressable>
      </Glass>
    </View>
  );
}

/** The page fading out under the status bar and the pill, so text scrolls away instead of colliding. */
function TopFade() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const height = insets.top + 64;
  return (
    <View pointerEvents="none" style={[styles.fade, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="page" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.page} stopOpacity={1} />
            <Stop offset="0.55" stopColor={c.page} stopOpacity={0.95} />
            <Stop offset="1" stopColor={c.page} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={height} fill="url(#page)" />
      </Svg>
    </View>
  );
}

/**
 * What floats over the top of the conversation, laid out as the apps people know: a round
 * menu button on the left that opens the drawer, one glass pill in the middle that names
 * who the person is talking to, and a round button for a new conversation on the right.
 * There is no bar and no tabs. A swipe from the left edge opens the drawer too.
 */
function Top({
  name,
  note,
  live,
  onOpen,
  onNew,
  onMore,
}: {
  name: string;
  /** A short word after the name: "Replying", "Reconnecting". */
  note?: string;
  /** Whether the dot is lit: connected and able to answer. */
  live: boolean;
  onOpen(): void;
  onNew?: () => void;
  /** Rename or delete, from a touch on the pill. */
  onMore?: () => void;
}) {
  const { t } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const waiting = useWaiting();
  const open = useRef(onOpen);
  open.current = onOpen;
  const edge = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, move) => move.dx > 12 && Math.abs(move.dy) < 24,
        onPanResponderRelease: (_event, move) => {
          if (move.dx > 40) open.current();
        },
      }),
    [],
  );
  return (
    <>
      <TopFade />
      <View pointerEvents="box-none" style={[styles.top, { top: insets.top + 6 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.app.menu}
          accessibilityHint={t.app.openThings}
          hitSlop={6}
          onPress={onOpen}
          style={({ pressed }) => pressed && { opacity: PRESSED }}
        >
          <Glass style={styles.round}>
            {/* Apple's sign for a sidebar: a rounded frame with its left part marked off. */}
            <View style={[styles.sidebar, { borderColor: c.text }]}>
              <View style={[styles.sidebarRule, { backgroundColor: c.text }]} />
            </View>
          </Glass>
        </Pressable>
        <Pressable
          // With nothing to do to it (the start of a conversation) it is a name, not a button.
          accessibilityRole={onMore ? "button" : "header"}
          accessibilityLabel={`${name}${note ? `, ${note}` : ""}`}
          accessibilityHint={onMore ? `${t.app.rename}, ${t.app.delete}` : undefined}
          disabled={!onMore}
          onPress={onMore}
          style={({ pressed }) => [{ flexShrink: 1 }, pressed && { opacity: PRESSED }]}
        >
          <Glass style={styles.pill}>
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 16, fontWeight: "600", color: c.text }}
            >
              {name}
            </Text>
            <View style={[styles.status, { backgroundColor: live ? c.ok : c.faint }]} />
            {note !== undefined && (
              <Text numberOfLines={1} style={{ fontSize: 13, color: c.muted }}>
                {note}
              </Text>
            )}
            {waiting.count > 0 && <Badge tone="warn" label={String(waiting.count)} />}
          </Glass>
        </Pressable>
        <View style={styles.side}>
          {onNew && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.app.newChat}
              hitSlop={6}
              onPress={onNew}
              style={({ pressed }) => pressed && { opacity: PRESSED }}
            >
              <Glass style={styles.round}>
                <Ionicons name="create-outline" size={22} color={c.text} />
              </Glass>
            </Pressable>
          )}
        </View>
      </View>
      <View {...edge.panHandlers} style={[styles.edge, { top: insets.top + 60, bottom: 120 }]} />
    </>
  );
}

/**
 * The start of a new conversation: the first message. Who answers is not chosen before
 * speaking (the owner, 2026-11-17): it is the person's usual agent — the general assistant
 * unless they set another in Settings — or the one they called from its own row in Agents.
 */
function Start({
  agentId,
  onStarted,
  onOpen,
}: {
  agentId?: string;
  onStarted(id: string): void;
  onOpen(): void;
}) {
  const { t } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const attach = useAttachments();
  const typing = useKeyboardUp();
  const { data, error, reload } = useLoad(() =>
    api<{ agents: AppAgent[]; canRun: boolean }>("/api/app/agents"),
  );
  const chosen = agentId ?? session.defaultAgent;
  const { busy, error: failure, run } = useAction();
  const usable = (data?.agents ?? []).filter((agent) => agent.state === "published");
  const agent =
    usable.find((candidate) => candidate.id === chosen) ?? generalOf(usable) ?? usable[0];
  const start = async (content: string, files: FileItem[]) => {
    let taken = false;
    await run(async () => {
      if (!agent) return;
      const { id } = await api<{ id: string }>("/api/app/conversations", {
        method: "POST",
        body: { agentId: agent.id },
      });
      await api(`/api/app/conversations/${id}/messages`, {
        method: "POST",
        body: { content, files: files.map((file) => file.id), ui: UI_VERSION },
      });
      taken = true;
      onStarted(id);
    });
    return taken;
  };
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.start, { paddingTop: insets.top + 64 }]}>
        {!data && (error ? <LoadError message={error} onRetry={reload} /> : <Loading />)}
      </View>
      <View style={[styles.footStart, { paddingBottom: typing ? 8 : Math.max(insets.bottom, 8) }]}>
        {data && usable.length === 0 && (
          <Text style={[type.secondary, styles.quiet, { color: c.muted }]}>{t.app.noAgents}</Text>
        )}
        {data && !data.canRun && (
          <Text style={[type.secondary, styles.quiet, { color: c.muted }]}>{t.app.noModel}</Text>
        )}
        {failure && <Notice tone="bad">{failure}</Notice>}
        <AttachmentTray attach={attach} />
        <Composer
          placeholder={t.app.composer(agentId && agent ? shownName(agent) : "Muster")}
          disabled={!agent || !data?.canRun || busy}
          running={false}
          attach={attach}
          onSend={start}
          onStop={() => undefined}
        />
      </View>
      <Top
        // An agent called from Agents is named; the usual one is simply Muster.
        name={agentId && agent ? shownName(agent) : "Muster"}
        live={Boolean(data?.canRun)}
        onOpen={onOpen}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * The home screen (CHA-260): the conversation in front. Which one is said by the route; with
 * nothing said, it is the person's latest, or the start of their first.
 */
export function Home({ navigation, route }: NativeStackScreenProps<RootParams, "Home">) {
  const params = route.params;
  const starting = Boolean(params?.agentId || params?.fresh);
  /** The latest conversation: undefined while it is being looked for, null when there is none. */
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { t, errorText } = useI18n();
  const c = useColors();
  const said = params?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again on each retry; the wording of a failure is read when it happens
  useEffect(() => {
    if (said || starting || latest !== undefined) return;
    let live = true;
    api<ConversationSummary[]>("/api/app/conversations").then(
      (all) => live && setLatest(all[0]?.id ?? null),
      (failure) => live && setFailed(errorText(failure)),
    );
    return () => {
      live = false;
    };
  }, [said, starting, latest, attempt]);
  // The drawer lies under the conversation; the conversation slides right to uncover it.
  const { width: screen } = useWindowDimensions();
  const width = Math.min(Math.round(screen * 0.78), 340);
  const [drawer, setDrawer] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  const still = useReducedMotion();
  const move = useCallback(
    (to: boolean) => {
      setDrawer(to);
      if (to) Keyboard.dismiss();
      if (still) slide.setValue(to ? 1 : 0);
      else
        Animated.spring(slide, {
          toValue: to ? 1 : 0,
          damping: 20,
          stiffness: 240,
          mass: 1,
          useNativeDriver: true,
        }).start();
    },
    [slide, still],
  );
  const open = useCallback(() => move(true), [move]);
  const close = useCallback(() => move(false), [move]);
  const fresh = useCallback(() => {
    move(false);
    navigation.setParams({ id: undefined, agentId: undefined, fresh: Date.now() });
  }, [navigation, move]);
  const id = said ?? (starting ? undefined : (latest ?? undefined));
  const looking = !said && !starting && latest === undefined;
  return (
    <View style={{ flex: 1, backgroundColor: c.page }}>
      <Drawer
        width={width}
        open={drawer}
        current={id}
        onClose={close}
        onNew={fresh}
        onPick={(picked) => {
          close();
          navigation.setParams({ id: picked, agentId: undefined, fresh: undefined });
        }}
      />
      <Animated.View
        style={[
          styles.front,
          {
            backgroundColor: c.page,
            borderColor: c.border,
            transform: [
              { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, width] }) },
            ],
          },
          drawer && styles.aside,
        ]}
      >
        <View
          style={{ flex: 1 }}
          accessibilityElementsHidden={drawer}
          importantForAccessibility={drawer ? "no-hide-descendants" : "auto"}
        >
          {looking ? (
            <View style={{ flex: 1, justifyContent: "center" }}>
              {failed ? (
                <LoadError
                  message={failed}
                  onRetry={() => {
                    setFailed(null);
                    setAttempt((n) => n + 1);
                  }}
                />
              ) : (
                <Loading />
              )}
            </View>
          ) : id ? (
            <Conversation key={id} id={id} onOpen={open} onNew={fresh} onGone={fresh} />
          ) : (
            <Start
              key={params?.fresh ?? 0}
              agentId={params?.agentId}
              onOpen={open}
              onStarted={(started) =>
                navigation.setParams({ id: started, agentId: undefined, fresh: undefined })
              }
            />
          )}
        </View>
        {drawer && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.app.closeMenu}
            onPress={close}
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: c.dark ? "#ffffff14" : "#0000000f" },
            ]}
          />
        )}
      </Animated.View>
    </View>
  );
}

/** One conversation: its messages, the reply as it is written, its steps and plan, and anything waiting for approval. */
function Conversation({
  id,
  onOpen,
  onNew,
  onGone,
}: {
  id: string;
  /** Opens the sheet with everything else. */
  onOpen(): void;
  onNew(): void;
  /** The conversation was deleted. */
  onGone(): void;
}) {
  const { t, errorText } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const waiting = useWaiting();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(idle);
  const [connected, setConnected] = useState(true);
  const [synced, setSynced] = useState(false);
  /** How tall the glass panel over the bottom of the messages is, so the last message clears it. */
  const [foot, setFoot] = useState(64);
  const { error, run } = useAction();
  const attach = useAttachments();
  const typing = useKeyboardUp();
  const { open, opening, problem } = useOpenFile();
  /** The person's files, to find the ones an agent made while writing a reply. */
  const [files, setFiles] = useState<FileItem[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  /** Follow new text only while the person is at the bottom; reading back up is left alone. */
  const atEnd = useRef(true);
  const translate = useRef(errorText);
  translate.current = errorText;
  const gone = useRef(onGone);
  gone.current = onGone;
  const recount = useRef(waiting.refresh);
  recount.current = waiting.refresh;
  const liveNow = useRef(live);

  const load = useCallback(async () => {
    // Without the list, files an agent made are simply not offered under its reply.
    api<FileItem[]>("/api/app/files").then(setFiles, () => undefined);
    try {
      const loaded = await api<ConversationDetail>(`/api/app/conversations/${id}`);
      setMissing(null);
      setDetail(loaded);
      setLive((now) => ({ ...now, approval: now.approval ?? loaded.approvals[0] ?? null }));
    } catch (failure) {
      // Gone: deleted from the sheet or on another device. There is nothing here to show.
      if (failure instanceof ApiError && failure.status === 404) return gone.current();
      setMissing(translate.current(failure));
    }
  }, [id]);
  // Read again each time this screen is back in front, as after the sheet closes.
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else void load();
    }, [load]),
  );

  useEffect(() => {
    void load();
    liveNow.current = idle;
    const stream = watchConversation(id, {
      connected: setConnected,
      event(event) {
        if (event.type === "state") setSynced(true);
        const applied = applyEvent(liveNow.current, event);
        liveNow.current = applied.live;
        setLive(applied.live);
        // No run is going: what the screen holds may be out of date, so fetch it again.
        if (applied.reload) void load();
        if (event.type === "approval") recount.current();
        if (applied.finished) {
          const { message, title } = applied.finished;
          setDetail(
            (now) => now && { ...now, title, messages: mergeMessages(now.messages, message) },
          );
          recount.current();
          // The reply may have made files: fetch the list so they can be opened from here.
          api<FileItem[]>("/api/app/files").then(setFiles, () => undefined);
        }
      },
    });
    // The system cuts connections while the app is in the background: open a fresh one on return.
    // The `state` event that opens it brings everything up to date.
    const watching = AppState.addEventListener("change", (state) => {
      if (state === "active") stream.reconnect();
    });
    return () => {
      watching.remove();
      stream.close();
    };
  }, [id, load]);

  const send = useCallback(
    async (content: string, sending: FileItem[] = []) => {
      let taken = false;
      await run(async () => {
        // The server returns both rows in full: the person's message and the reply being written.
        const sent = await api<
          { userMessage: Message; assistantMessage: Message } | { aside: true }
        >(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: { content, files: sending.map((file) => file.id), ui: UI_VERSION },
        });
        // A run was already going (begun on another device): the words were added to the
        // reply being written. There is no new message and no new reply to show.
        taken = true;
        if ("aside" in sent) return;
        atEnd.current = true;
        liveNow.current = { ...liveNow.current, running: true };
        setLive(liveNow.current);
        setDetail(
          (now) =>
            now && {
              ...now,
              // The reply may already have finished; keep the finished one.
              messages: mergeMessages([sent.userMessage, sent.assistantMessage], ...now.messages),
            },
        );
      });
      return taken;
    },
    [id, run],
  );
  /** Answers a form in the last reply. The server writes the message from the form and the values. */
  const answer = useCallback<AnswerForm>(
    async (action) => {
      let taken = false;
      await run(async () => {
        const sent = await api<
          { userMessage: Message; assistantMessage: Message } | { aside: true }
        >(`/api/app/conversations/${id}/messages`, {
          method: "POST",
          body: { action, ui: UI_VERSION },
        });
        // The server never takes an answer as words added to a run. If it ever said so,
        // the form was not answered.
        if ("aside" in sent) return;
        taken = true;
        atEnd.current = true;
        liveNow.current = { ...liveNow.current, running: true };
        setLive(liveNow.current);
        setDetail(
          (now) =>
            now && {
              ...now,
              messages: mergeMessages([sent.userMessage, sent.assistantMessage], ...now.messages),
            },
        );
      });
      // Refused: the conversation is not as this screen shows it. It is read again.
      if (!taken) void load();
      return taken;
    },
    [id, run, load],
  );
  const stop = () => void run(() => api(`/api/app/conversations/${id}/stop`, { method: "POST" }));
  const remove = useCallback(() => {
    Alert.alert(t.app.delete, t.app.deleteConfirm, [
      { text: t.common.cancel, style: "cancel" },
      {
        text: t.common.delete,
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await api(`/api/app/conversations/${id}`, { method: "DELETE" });
            onGone();
          }),
      },
    ]);
  }, [id, onGone, run, t]);

  const title = detail ? detail.title || t.app.untitled : "";
  const rename = useCallback(() => {
    Alert.prompt(
      t.app.rename,
      t.app.renameLead,
      [
        { text: t.common.cancel, style: "cancel" },
        {
          text: t.common.save,
          onPress: (typed?: string) => {
            const next = (typed ?? "").trim().slice(0, 120);
            if (!next || next === title) return;
            void run(async () => {
              await api(`/api/app/conversations/${id}`, { method: "PATCH", body: { title: next } });
              setDetail((now) => now && { ...now, title: next });
            });
          },
        },
      ],
      "plain-text",
      title,
    );
  }, [id, run, t, title]);
  const more = () =>
    choose(
      { options: [t.app.rename, t.app.delete], destructive: 1, cancel: t.common.cancel },
      (index) => (index === 0 ? rename() : remove()),
    );
  const copy = (message: Message) =>
    void Clipboard.setStringAsync(readableReply(message.content)).then(() => {
      setCopied(message.id);
      setTimeout(() => setCopied((now) => (now === message.id ? null : now)), 1500);
    });

  // The server's word on whether a run is going is final. Until it has spoken, a reply the
  // conversation holds as running is taken to be running, so it is not shown as stopped.
  const running =
    live.running ||
    (!synced && (detail?.messages.some((message) => message.status === "running") ?? false));
  const actions = useMemo(() => ({ send, disabled: running }), [send, running]);
  if (!detail)
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 64 }}>
        {missing ? <LoadError message={missing} onRetry={load} /> : <Loading />}
        <Top name="Muster" live={false} onOpen={onOpen} onNew={onNew} />
      </View>
    );
  const answers = shownName(detail.agent);
  const usable = detail.agent.state === "published";
  const lastReply = detail.messages.findLast((message) => message.role === "assistant");
  // What "Try again" sends: the person's own last message, never one Muster wrote.
  const lastAsked = lastOwn(detail.messages);

  const follow = () => {
    if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
  };
  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    atEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
  };

  return (
    <ReplyActions.Provider value={actions}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* The inner view shrinks with the keyboard, so the floating panel rides above it. */}
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scroll}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onContentSizeChange={follow}
            onLayout={follow}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            scrollIndicatorInsets={{ bottom: foot }}
            contentContainerStyle={[
              styles.messages,
              { paddingTop: insets.top + 64, paddingBottom: foot + 16 },
            ]}
          >
            {detail.messages.map((message) =>
              broughtBack(message) ? (
                // Muster brought the agent back: a line that says why, not Muster's own text.
                <View key={message.id} style={styles.back}>
                  <Ionicons name="notifications-outline" size={13} color={c.muted} />
                  <Text numberOfLines={2} style={{ flexShrink: 1, fontSize: 12, color: c.muted }}>
                    {(() => {
                      const { awaited, mail } = cameBack(message.content);
                      return `${mail ? t.app.cameBackMail(mail) : t.app.cameBack}${awaited ? ` · ${awaited}` : ""}`;
                    })()}
                  </Text>
                </View>
              ) : message.role === "user" ? (
                <View key={message.id} style={styles.asked}>
                  {(message.attachments ?? []).length > 0 && (
                    <View style={[styles.chips, { justifyContent: "flex-end" }]}>
                      {(message.attachments ?? []).map((file) => (
                        <FileChip
                          key={file.id}
                          file={file}
                          busy={opening === file.id}
                          onPress={() => open(file)}
                        />
                      ))}
                    </View>
                  )}
                  {readAction(message.action) ? (
                    <AnswerCard action={readAction(message.action) as FormAction} />
                  ) : (
                    <View style={[styles.mine, { backgroundColor: c.bubble }]}>
                      <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.text }}>
                        {message.content}
                      </Text>
                    </View>
                  )}
                </View>
              ) : message.status === "running" && running ? (
                // The plan of the reply being written is pinned above the message box, not repeated here.
                <View key={message.id} style={styles.reply} accessibilityLiveRegion="polite">
                  <Activity steps={live.steps} running conversation={detail.id} />
                  <Reply
                    text={live.text}
                    streaming
                    fallback={
                      live.approval || live.steps.length > 0 ? null : (
                        <View style={styles.working}>
                          <ActivityIndicator size="small" color={c.muted} style={styles.spinner} />
                          <Text style={{ fontSize: 13, color: c.muted }}>{t.app.working}</Text>
                        </View>
                      )
                    }
                  />
                  {live.approval && (
                    <ApprovalCard
                      approval={live.approval}
                      // The agent that wants it: one a step was passed to, when it is not the conversation's own (CHA-264).
                      agentName={live.approval.agentName ?? answers}
                    />
                  )}
                </View>
              ) : (
                <View key={message.id} style={styles.reply}>
                  <PlanCard plan={message.plan ?? []} live={false} />
                  <Activity steps={message.steps ?? []} running={false} conversation={detail.id} />
                  <FormScope.Provider value={formPlace(message, detail.messages, answers, answer)}>
                    <Reply text={message.content} streaming={false} />
                  </FormScope.Provider>
                  {madeFiles(message.steps ?? [], files).length > 0 && (
                    <View style={styles.chips}>
                      {madeFiles(message.steps ?? [], files).map((file) => (
                        <FileChip
                          key={file.id}
                          file={file}
                          busy={opening === file.id}
                          onPress={() => open(file)}
                        />
                      ))}
                    </View>
                  )}
                  {message.status === "failed" && <Notice tone="bad">{t.app.failed}</Notice>}
                  {message.ending && t.app.ending[message.ending] && (
                    <Notice tone="bad">{t.app.ending[message.ending] ?? ""}</Notice>
                  )}
                  {message.status === "complete" && message.ending === "checks_failed" && (
                    <Notice tone="bad">{t.app.checksFailed}</Notice>
                  )}
                  {message.status === "complete" && message.ending === "walkthrough_unmatched" && (
                    <Notice tone="bad">
                      {unmatchedText(message.endingDetail ?? null, t.app.unmatched)}
                    </Notice>
                  )}
                  {(message.status === "stopped" || message.status === "running") && (
                    <Text style={{ fontSize: 13, color: c.muted }}>{t.app.stopped}</Text>
                  )}
                  <View style={styles.under}>
                    {message.content !== "" && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t.app.copy}
                        hitSlop={10}
                        onPress={() => copy(message)}
                        style={styles.small}
                      >
                        <Ionicons
                          name={copied === message.id ? "checkmark" : "copy-outline"}
                          size={14}
                          color={copied === message.id ? c.ok : c.muted}
                        />
                        <Text style={{ fontSize: 12, color: c.muted }}>
                          {copied === message.id ? t.common.copied : t.common.copy}
                        </Text>
                      </Pressable>
                    )}
                    {message.id === lastReply?.id && message.status !== "complete" && lastAsked && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t.app.retry}
                        disabled={running || !usable}
                        hitSlop={10}
                        onPress={() => send(lastAsked.content, [])}
                        style={[styles.small, (running || !usable) && { opacity: 0.4 }]}
                      >
                        <Ionicons name="refresh" size={14} color={c.accentText} />
                        <Text style={{ fontSize: 12, color: c.accentText }}>{t.app.retry}</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              ),
            )}
          </ScrollView>
          <View
            onLayout={(event) => setFoot(event.nativeEvent.layout.height)}
            style={[styles.foot, { paddingBottom: typing ? 8 : Math.max(insets.bottom, 8) }]}
          >
            {!connected && (
              <Text style={{ fontSize: 12, color: c.muted, textAlign: "center" }}>
                {t.app.reconnecting}
              </Text>
            )}
            {(error ?? problem) && <Notice tone="bad">{error ?? problem ?? ""}</Notice>}
            {!usable && (
              <Notice>
                {detail.agent.state === "suspended"
                  ? t.app.builder.suspendedNote
                  : t.app.builder.pendingNote}
              </Notice>
            )}
            {/* Keyed by the reply, so each new plan starts open. */}
            {running && <PlanCard key={detail.messages.at(-1)?.id} plan={live.plan} live />}
            <AttachmentTray attach={attach} />
            <Composer
              placeholder={t.app.composer(answers)}
              disabled={!usable}
              running={running}
              attach={attach}
              onSend={send}
              onStop={stop}
            />
          </View>
        </View>
        <Top
          name={answers}
          note={!connected ? t.app.reconnecting : running ? t.app.running : undefined}
          live={connected && usable}
          onOpen={onOpen}
          onNew={onNew}
          onMore={more}
        />
      </KeyboardAvoidingView>
    </ReplyActions.Provider>
  );
}

const styles = StyleSheet.create({
  messages: { paddingHorizontal: 16, gap: 24, flexGrow: 1 },
  working: { flexDirection: "row", alignItems: "center", gap: 4 },
  spinner: { transform: [{ scale: 0.7 }] },
  reply: { gap: 12 },
  asked: { alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "87%", gap: 6 },
  back: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  under: { flexDirection: "row", alignItems: "center", gap: 20, minHeight: 24 },
  small: { flexDirection: "row", alignItems: "center", gap: 4 },
  mine: { borderRadius: radius.bubble, ...curve, paddingHorizontal: 16, paddingVertical: 12 },
  // Floats over the bottom of the messages, so they show through the glass as they scroll.
  foot: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 12, gap: 8 },
  footStart: { paddingHorizontal: 12, gap: 8 },
  // One element tree for both shapes, so the box keeps its focus as it changes: the two
  // buttons sit at its bottom corners, and the text makes room for them beside or under it.
  composer: { borderRadius: 30, ...curve, overflow: "hidden", minHeight: 52 },
  composerOpen: { borderRadius: 26 },
  input: {
    fontSize: 17,
    lineHeight: 22,
    minHeight: 52,
    maxHeight: 132,
    paddingTop: 15,
    paddingBottom: 15,
    marginLeft: 50,
    marginRight: 54,
  },
  inputOpen: {
    minHeight: 60,
    maxHeight: 180,
    paddingTop: 14,
    paddingBottom: 4,
    marginLeft: 16,
    marginRight: 16,
    marginBottom: 50,
  },
  send: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  fade: { position: "absolute", top: 0, left: 0, right: 0 },
  top: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  side: { width: 44, height: 44 },
  sidebar: { width: 23, height: 18, borderRadius: 5, borderCurve: "continuous", borderWidth: 1.8 },
  sidebarRule: { position: "absolute", left: 6, top: 0, bottom: 0, width: 1.8 },
  front: { flex: 1 },
  // Moved aside: its left edge is a rounded corner over the drawer.
  aside: {
    borderTopLeftRadius: 36,
    borderBottomLeftRadius: 36,
    borderCurve: "continuous",
    borderLeftWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  menu: {
    position: "absolute",
    left: 0,
    bottom: "100%",
    marginBottom: 8,
    minWidth: 230,
    borderRadius: 26,
    borderCurve: "continuous",
    overflow: "hidden",
    padding: 8,
  },
  menuRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 8,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  quiet: { paddingHorizontal: 12, textAlign: "center" },
  plus: {
    position: "absolute",
    left: 6,
    bottom: 6,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    height: 44,
    borderRadius: 24,
    ...curve,
    overflow: "hidden",
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  status: { width: 6, height: 6, borderRadius: 3 },
  round: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  edge: { position: "absolute", left: 0, width: 10 },
  start: { flex: 1, justifyContent: "center", paddingHorizontal: 16 },
});

/**
 * What the Walkthrough a reply ended with says that its own steps do not bear out (C1), as
 * one notice: the title, then each point on a line of its own, files and commands as they are.
 */
function unmatchedText(
  detail: string | null,
  u: {
    title: string;
    missing: string;
    noSummary: string;
    unnamed: (files: string) => string;
    notRun: (what: string) => string;
    stale: (what: string) => string;
    wrong: (what: string, code: number, ok: boolean) => string;
    unlisted: (what: string) => string;
    piped: (what: string) => string;
    noChecksRan: string;
    noChecksNone: string;
  },
): string {
  let gap: {
    missing?: boolean;
    noSummary?: boolean;
    unnamed?: string[];
    notRun?: string[];
    stale?: string[];
    wrong?: { what: string; code: number; ok: boolean }[];
    unlisted?: string[];
    piped?: string[];
    noChecks?: "ran" | "none";
  } = {};
  try {
    gap = JSON.parse(detail ?? "{}") ?? {};
  } catch {
    // Nothing readable: the notice says only that it does not hold.
  }
  const names = (items?: string[]) => (items ?? []).join(", ");
  return [
    u.title,
    ...[
      gap.missing && u.missing,
      gap.noSummary && u.noSummary,
      gap.unnamed?.length && u.unnamed(names(gap.unnamed)),
      gap.notRun?.length && u.notRun(names(gap.notRun)),
      gap.stale?.length && u.stale(names(gap.stale)),
      ...(gap.wrong ?? []).map((wrong) => u.wrong(wrong.what, wrong.code, wrong.ok)),
      gap.unlisted?.length && u.unlisted(names(gap.unlisted)),
      gap.piped?.length && u.piped(names(gap.piped)),
      gap.noChecks === "ran" && u.noChecksRan,
      gap.noChecks === "none" && u.noChecksNone,
    ]
      .filter((point): point is string => typeof point === "string" && point.length > 0)
      .map((point) => `• ${point}`),
  ].join("\n");
}
