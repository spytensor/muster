import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LOCALES, type Locale, useI18n } from "../i18n";
import { api } from "../lib/api";
import { zone as deviceZone } from "../lib/followups";
import { compact, deviceName, money } from "../lib/format";
import { daysWith, hours, zones } from "../lib/profile";
import { hitRate } from "../lib/tools";
import { type AppAgent, type DeviceSession, shownName, type Usage } from "../lib/types";
import { choose } from "../menu";
import { type RootParams, useNav, useWaiting } from "../nav";
import { type AppearanceChoice, useSession } from "../session";
import { mono, PRESSED, radius, type, useColors } from "../theme";
import {
  Button,
  Field,
  Group,
  type IconName,
  Loading,
  Notice,
  SectionTitle,
  useAction,
  useLoad,
} from "../ui";
import { useUnsaved } from "../unsaved";

/**
 * Settings, laid out as the system's own (CHA-261): who the person is at the top, then
 * grouped lists of one-line rows — a small mark, the name, what it is now, and an arrow
 * when it leads somewhere. A choice among a few is made from a menu on the row; anything
 * that is typed (working hours, how answers should read, a signature) has a page of its own
 * (`SettingPart`). Nothing is a form laid out on this page.
 */

/** One row of a group: a mark, what it is, what it is now. */
export function Item({
  icon,
  label,
  value,
  code,
  tone,
  onPress,
  plain,
}: {
  icon?: IconName;
  label: string;
  value?: string;
  /** The value is an address or the like: set in the fixed-width face. */
  code?: boolean;
  tone?: "bad";
  /** Without it the row only says something. */
  onPress?: () => void;
  /** It does something here rather than leading somewhere: no arrow. */
  plain?: boolean;
}) {
  const c = useColors();
  const body: ReactNode = (
    <>
      {icon && (
        <View style={[styles.mark, { backgroundColor: c.soft }]}>
          <Ionicons name={icon} size={17} color={tone === "bad" ? c.bad : c.muted} />
        </View>
      )}
      <Text numberOfLines={1} style={{ fontSize: 16, color: tone === "bad" ? c.bad : c.text }}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.value, { color: c.muted }, code && { fontFamily: mono, fontSize: 13 }]}
      >
        {value ?? ""}
      </Text>
      {onPress && !plain && <Ionicons name="chevron-forward" size={17} color={c.faint} />}
    </>
  );
  const said = value ? `${label}, ${value}` : label;
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={said}
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { opacity: PRESSED }]}
    >
      {body}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={said} style={styles.item}>
      {body}
    </View>
  );
}

function Foot({ text }: { text: string }) {
  const c = useColors();
  return <Text style={[type.secondary, styles.foot, { color: c.muted }]}>{text}</Text>;
}

/** Where the person is signed in. Ending this device's session is signing out. */
function Devices() {
  const { t, ago } = useI18n();
  const c = useColors();
  const a = t.prefs.account;
  const { data, error, reload } = useLoad(() => api<DeviceSession[]>("/api/app/sessions"));
  const { busy, error: failure, run } = useAction();
  const end = (device: DeviceSession, name: string) =>
    Alert.alert(a.signOut, a.endConfirm(name), [
      { text: t.common.cancel, style: "cancel" },
      {
        text: a.signOut,
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await api(`/api/app/sessions/${device.id}`, { method: "DELETE" });
            await reload();
          }),
      },
    ]);
  return (
    <View style={styles.section}>
      <SectionTitle>{a.devices}</SectionTitle>
      {(error ?? failure) && <Notice tone="bad">{error ?? failure ?? ""}</Notice>}
      {!data && !error && <Loading />}
      {data && data.length > 0 && (
        <Group>
          {data.map((device) => {
            const name = `${deviceName(device.userAgent) ?? a.unknownDevice} · ${a[device.kind] ?? device.kind}`;
            return (
              <View key={device.id} style={styles.item}>
                <View style={[styles.mark, { backgroundColor: c.soft }]}>
                  <Ionicons
                    name={device.kind === "app" ? "phone-portrait-outline" : "globe-outline"}
                    size={17}
                    color={c.muted}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, color: c.text }}>
                    {name}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 13, color: c.muted }}>
                    {device.current ? a.thisDevice : a.lastSeen(ago(device.lastSeenAt))}
                  </Text>
                </View>
                {/* This device is signed out with the row at the foot of the page. */}
                {!device.current && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${a.signOut}, ${name}`}
                    disabled={busy}
                    hitSlop={12}
                    onPress={() => end(device, name)}
                    style={({ pressed }) => pressed && { opacity: PRESSED }}
                  >
                    <Text style={{ fontSize: 15, color: c.bad }}>{a.signOut}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </Group>
      )}
      <Foot text={a.devicesLead} />
    </View>
  );
}

/** Who is signed in, how they work, how the app looks and speaks, where they are signed in, and their data. */
export function Settings() {
  const { t } = useI18n();
  const c = useColors();
  const nav = useNav();
  const session = useSession();
  const waiting = useWaiting();
  const s = t.settings;
  const p = t.prefs;
  const w = p.profile;
  const me = session.me;
  const profile = session.profile;
  const ways = profile?.ways;
  const agents = useLoad(() => api<{ agents: AppAgent[] }>("/api/app/agents"));
  const { error, run } = useAction();
  const [cleared, setCleared] = useState<string | null>(null);
  const usable = (agents.data?.agents ?? []).filter((agent) => agent.state === "published");
  const current = usable.find((agent) => agent.id === session.defaultAgent);
  const name = me?.user.name || me?.user.email || "";
  const initials = name
    .split(/\s+/)
    .map((piece) => piece.slice(0, 1))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const device = deviceZone();
  const pickZone = () => {
    const offered = zones(ways?.timezone ?? null, device);
    choose(
      { title: w.zone, options: [w.zoneDevice(device), ...offered], cancel: t.common.cancel },
      (index) =>
        void run(() =>
          session.saveWays({ timezone: index === 0 ? null : (offered[index - 1] ?? null) }),
        ),
    );
  };
  const locales = Object.keys(LOCALES) as Locale[];
  const looks: AppearanceChoice[] = ["system", "light", "dark"];
  const part = (which: RootParams["Setting"]["part"]) => () =>
    nav.navigate("Setting", { part: which });
  const clear = () =>
    Alert.alert(p.data.clear, p.data.clearConfirm, [
      { text: t.common.cancel, style: "cancel" },
      {
        text: p.data.clear,
        style: "destructive",
        onPress: () =>
          void run(async () => {
            const { removed } = await api<{ removed: number }>("/api/app/conversations", {
              method: "DELETE",
            });
            setCleared(p.data.cleared(removed));
            waiting.refresh();
          }),
      },
    ]);
  const signOut = () =>
    Alert.alert(s.signOut, s.signOutConfirm, [
      { text: t.common.cancel, style: "cancel" },
      { text: s.signOut, style: "destructive", onPress: () => void session.signOut() },
    ]);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      {me && (
        <View style={styles.who}>
          <View style={[styles.avatar, { backgroundColor: c.accentSoft }]}>
            <Text style={{ fontSize: 28, fontWeight: "700", color: c.accentText }}>{initials}</Text>
          </View>
          <Text style={[type.title, { color: c.text, textAlign: "center" }]}>{name}</Text>
          <Text selectable style={{ fontSize: 15, color: c.muted }}>
            {me.user.email}
          </Text>
        </View>
      )}
      {error && <Notice tone="bad">{error}</Notice>}

      {me && (
        <View style={styles.section}>
          <Group>
            <Item icon="business-outline" label={p.account.org} value={me.org.name} />
            <Item
              icon="person-outline"
              label={p.account.role}
              value={t.roles[me.role] ?? me.role}
            />
            {profile?.identity.department && (
              <Item
                icon="people-outline"
                label={w.department}
                value={profile.identity.department}
              />
            )}
          </Group>
          <Foot text={p.account.fromOrg} />
        </View>
      )}

      <View style={styles.section}>
        <SectionTitle>{w.title}</SectionTitle>
        {!ways ? (
          <Loading />
        ) : (
          <Group>
            <Item
              icon="globe-outline"
              label={w.zone}
              value={ways.timezone ?? w.zoneDevice(profile?.zone ?? device)}
              onPress={pickZone}
            />
            <Item
              icon="time-outline"
              label={w.hours}
              value={
                ways.workStart && ways.workEnd ? `${ways.workStart} – ${ways.workEnd}` : w.notSet
              }
              onPress={part("hours")}
            />
            <Item
              icon="chatbox-ellipses-outline"
              label={w.style}
              value={ways.answerStyle ? w.isSet : w.notSet}
              onPress={part("style")}
            />
            <Item
              icon="create-outline"
              label={w.signature}
              value={ways.signature ? w.isSet : w.notSet}
              onPress={part("signature")}
            />
          </Group>
        )}
        <Foot text={w.lead} />
      </View>

      <View style={styles.section}>
        <SectionTitle>{p.general.title}</SectionTitle>
        <Group>
          <Item
            icon="language-outline"
            label={s.language}
            value={LOCALES[session.locale].messages.language}
            onPress={() =>
              choose(
                {
                  title: s.language,
                  options: locales.map((locale) => LOCALES[locale].messages.language),
                  cancel: t.common.cancel,
                },
                (index) => {
                  const picked = locales[index];
                  if (picked) session.setLocale(picked);
                },
              )
            }
          />
          <Item
            icon="contrast-outline"
            label={s.appearance}
            value={s[session.appearance]}
            onPress={() =>
              choose(
                {
                  title: s.appearance,
                  options: looks.map((look) => s[look]),
                  cancel: t.common.cancel,
                },
                (index) => {
                  const picked = looks[index];
                  if (picked) session.setAppearance(picked);
                },
              )
            }
          />
          <Item
            icon="sparkles-outline"
            label={p.general.defaultAgent}
            // A list that could not be read is said, not shown as nothing chosen.
            value={
              agents.error ? t.common.failed : current ? shownName(current) : p.general.noDefault
            }
            onPress={
              agents.error
                ? agents.reload
                : usable.length > 0
                  ? () =>
                      choose(
                        {
                          title: p.general.defaultAgent,
                          options: usable.map(shownName),
                          cancel: t.common.cancel,
                        },
                        (index) => {
                          const chosen = usable[index];
                          if (chosen) session.setDefaultAgent(chosen.id);
                        },
                      )
                  : undefined
            }
          />
          <Item icon="stats-chart-outline" label={p.usage.title} onPress={part("usage")} />
        </Group>
      </View>

      <Devices />

      <View style={styles.section}>
        <SectionTitle>{p.data.title}</SectionTitle>
        {cleared && <Notice>{cleared}</Notice>}
        <Group>
          <Item icon="trash-outline" tone="bad" label={p.data.clear} onPress={clear} plain />
        </Group>
        <Foot text={`${p.data.clearLead} ${p.data.whoSees}`} />
      </View>

      <View style={styles.section}>
        <Group>
          <Item icon="server-outline" label={s.server} value={session.server} code />
          <Item icon="log-out-outline" tone="bad" label={s.signOut} onPress={signOut} plain />
        </Group>
      </View>
      <Text style={[type.meta, { color: c.faint, textAlign: "center" }]}>
        Muster · {s.version} {Constants.expoConfig?.version ?? ""}
      </Text>
    </ScrollView>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const RANGES = ["7d", "30d", "90d"] as const;

/** What the person's own conversations have used. */
function UsagePart() {
  const { t, errorText } = useI18n();
  const c = useColors();
  const u = t.prefs.usage;
  const [range, setRange] = useState<(typeof RANGES)[number]>("30d");
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads when the period changes
  useEffect(() => {
    let live = true;
    setError(null);
    api<Usage>(`/api/app/usage?range=${range}`).then(
      (found) => live && setData(found),
      (failure) => live && setError(errorText(failure)),
    );
    return () => {
      live = false;
    };
  }, [range]);
  const most = Math.max(1, ...(data?.byDay ?? []).map((day) => day.tokens));
  return (
    <>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={u.title}
        style={[styles.segments, { borderColor: c.border, backgroundColor: c.card }]}
      >
        {RANGES.map((value) => {
          const selected = value === range;
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={u.ranges[value] ?? value}
              onPress={() => setRange(value)}
              style={[styles.segment, selected && { backgroundColor: c.soft }]}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: selected ? "600" : "400",
                  color: selected ? c.text : c.muted,
                }}
              >
                {u.ranges[value] ?? value}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error && <Notice tone="bad">{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          {(data.month ?? []).map((limit) => (
            <View
              key={limit.scope}
              style={[styles.card, { backgroundColor: c.card, borderColor: c.border, gap: 8 }]}
            >
              <View style={styles.span}>
                <Text style={{ fontSize: 14, color: c.text }}>{u.month[limit.scope]}</Text>
                <Text style={{ fontSize: 13, color: c.muted, fontVariant: ["tabular-nums"] }}>
                  {limit.limitMicros !== undefined && limit.spentMicros !== undefined
                    ? u.monthOf(money(limit.spentMicros), money(limit.limitMicros))
                    : `${Math.round(limit.share * 100)}%`}
                </Text>
              </View>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  overflow: "hidden",
                  backgroundColor: c.border,
                }}
              >
                <View
                  style={{
                    height: 4,
                    width: `${Math.round(Math.min(1, limit.share) * 100)}%`,
                    backgroundColor: limit.share >= 1 ? c.bad : limit.share >= 0.8 ? c.warn : c.ok,
                  }}
                />
              </View>
            </View>
          ))}
          <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={styles.totals}>
              {(
                [
                  [u.runs, compact(data.totals.runs)],
                  [u.tokens, compact(data.totals.tokens)],
                  [u.cost, money(data.totals.costMicros)],
                ] as const
              ).map(([label, value]) => (
                <View key={label} style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: c.muted }}>{label}</Text>
                  <Text style={[styles.total, { color: c.text }]}>{value}</Text>
                </View>
              ))}
            </View>
            {/* What went in, what came out, and how much of what went in the model's service
                had seen before. An older server says none of it, and none is shown. */}
            {data.totals.inputTokens !== undefined && (
              <View style={styles.totals}>
                {(
                  [
                    [u.input, compact(data.totals.inputTokens)],
                    [u.output, compact(data.totals.outputTokens ?? 0)],
                    [u.cached, hitRate(data.totals)],
                  ] as const
                ).map(([label, value]) => (
                  <View key={label} style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: c.muted }}>{label}</Text>
                    <Text style={[styles.total, { color: c.text }]}>{value}</Text>
                  </View>
                ))}
              </View>
            )}
            {data.totals.runs > 0 && (
              <>
                <View style={styles.days}>
                  {data.byDay.map((day) => (
                    <View
                      key={day.day}
                      accessible
                      accessibilityLabel={u.dayTitle(day.day, day.runs, compact(day.tokens))}
                      style={[
                        styles.day,
                        {
                          backgroundColor: c.text,
                          height: Math.max(2, Math.round((day.tokens / most) * 56)),
                        },
                      ]}
                    />
                  ))}
                </View>
                <View style={styles.span}>
                  <Text style={[type.meta, { color: c.faint }]}>{data.byDay[0]?.day ?? ""}</Text>
                  <Text style={[type.meta, { color: c.faint }]}>
                    {data.byDay.at(-1)?.day ?? ""}
                  </Text>
                </View>
              </>
            )}
          </View>
          {data.totals.runs === 0 ? (
            <Foot text={u.none} />
          ) : (
            <View style={styles.section}>
              <SectionTitle>{u.byAgent}</SectionTitle>
              <Group>
                {data.byAgent.map((agent) => (
                  <View key={agent.agent} style={styles.item}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 16, color: c.text }}>{agent.agent}</Text>
                      <Text style={{ fontSize: 13, color: c.muted }}>
                        {u.agentLine(
                          agent.runs,
                          compact(agent.tokens),
                          money(agent.costMicros),
                          agent.inputTokens !== undefined ? hitRate(agent) : undefined,
                        )}
                      </Text>
                    </View>
                  </View>
                ))}
              </Group>
            </View>
          )}
          <Foot text={u.lead} />
        </>
      )}
    </>
  );
}

/** Working hours: when the day starts and ends, and on which days. */
function HoursPart() {
  const { t } = useI18n();
  const c = useColors();
  const session = useSession();
  const w = t.prefs.profile;
  const ways = session.profile?.ways;
  const { busy, error, run } = useAction();
  const [start, setStart] = useState(ways?.workStart ?? "");
  const [end, setEnd] = useState(ways?.workEnd ?? "");
  const [days, setDays] = useState(ways?.workDays ?? WEEKDAYS);
  const [wrong, setWrong] = useState<string | null>(null);
  const set = Boolean(ways?.workStart && ways?.workEnd);
  const leave = useUnsaved(
    start !== (ways?.workStart ?? "") ||
      end !== (ways?.workEnd ?? "") ||
      days.join() !== (ways?.workDays ?? WEEKDAYS).join(),
  );
  const keep = () => {
    const times = hours(start, end);
    if (!times) return setWrong(w.hoursWrong);
    setWrong(null);
    void run(async () => {
      await session.saveWays({ ...times, workDays: days });
      leave();
    });
  };
  const time = { textAlign: "center" as const };
  return (
    <>
      {(error ?? wrong) && <Notice tone="bad">{error ?? wrong ?? ""}</Notice>}
      <View style={styles.pair}>
        <View style={{ flex: 1 }}>
          <Field
            label={w.start}
            value={start}
            placeholder="09:00"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            autoFocus={!set}
            onChangeText={(value) => {
              setWrong(null);
              setStart(value);
            }}
            style={time}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label={w.end}
            value={end}
            placeholder="18:00"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            onChangeText={(value) => {
              setWrong(null);
              setEnd(value);
            }}
            style={time}
          />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[type.section, { color: c.muted, paddingHorizontal: 4 }]}>{w.days}</Text>
        <View style={styles.week}>
          {w.weekdays.map((name, day) => {
            const on = days.includes(day);
            return (
              <Pressable
                // biome-ignore lint/suspicious/noArrayIndexKey: the days of a week never reorder
                key={day}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${w.days}: ${name}`}
                onPress={() => setDays((now) => daysWith(now, day))}
                style={[
                  styles.weekday,
                  { borderColor: c.outline },
                  on && { backgroundColor: c.primary, borderColor: c.primary },
                ]}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: on ? "600" : "400",
                    color: on ? c.onPrimary : c.muted,
                  }}
                >
                  {name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Foot text={w.hoursLead} />
      <Button label={t.common.save} busy={busy} onPress={keep} />
      {set && (
        <Button
          variant="danger"
          label={w.clear}
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await session.saveWays({ workStart: null, workEnd: null, workDays: null });
              leave();
            })
          }
        />
      )}
    </>
  );
}

/** One piece of text the person writes: how answers should read, or their mail signature. */
function TextPart({ which }: { which: "style" | "signature" }) {
  const { t } = useI18n();
  const session = useSession();
  const w = t.prefs.profile;
  const profile = session.profile;
  const field = which === "style" ? "answerStyle" : "signature";
  const { busy, error, run } = useAction();
  const [text, setText] = useState(profile?.ways[field] ?? "");
  const limit = profile?.limits[field] ?? 300;
  const leave = useUnsaved(text !== (profile?.ways[field] ?? ""));
  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      <Field
        label={which === "style" ? w.style : w.signature}
        value={text}
        placeholder={which === "style" ? w.styleHint : undefined}
        multiline
        autoFocus
        maxLength={limit}
        autoCapitalize={which === "signature" ? "none" : "sentences"}
        onChangeText={setText}
        style={{ minHeight: which === "style" ? 110 : 150 }}
      />
      <Foot text={`${which === "style" ? w.styleLead : w.signatureLead} ${text.length}/${limit}`} />
      <Button
        label={t.common.save}
        busy={busy}
        onPress={() =>
          void run(async () => {
            await session.saveWays({ [field]: text.trim() || null });
            leave();
          })
        }
      />
    </>
  );
}

/** A page of its own for one setting that is typed or read at length. */
export function SettingPart({ navigation, route }: NativeStackScreenProps<RootParams, "Setting">) {
  const { t } = useI18n();
  const { part } = route.params;
  const w = t.prefs.profile;
  const title =
    part === "hours"
      ? w.hours
      : part === "style"
        ? w.style
        : part === "signature"
          ? w.signature
          : t.prefs.usage.title;
  useLayoutEffect(() => navigation.setOptions({ title }), [navigation, title]);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.part}
    >
      {part === "hours" ? (
        <HoursPart />
      ) : part === "usage" ? (
        <UsagePart />
      ) : (
        <TextPart which={part} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 28 },
  part: { padding: 20, paddingBottom: 48, gap: 16 },
  who: { alignItems: "center", gap: 6, paddingTop: 4 },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  section: { gap: 8 },
  item: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  mark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  value: { flex: 1, fontSize: 16, textAlign: "right" },
  foot: { paddingHorizontal: 4 },
  pair: { flexDirection: "row", gap: 12 },
  week: { flexDirection: "row", gap: 6 },
  weekday: {
    flex: 1,
    height: 44,
    borderRadius: radius.control,
    borderCurve: "continuous",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  segments: {
    flexDirection: "row",
    borderRadius: radius.control,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderRadius: radius.card,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 14,
  },
  totals: { flexDirection: "row", gap: 8 },
  total: { fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"] },
  days: { height: 58, flexDirection: "row", alignItems: "flex-end", gap: 1 },
  day: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2, minWidth: 1 },
  span: { flexDirection: "row", justifyContent: "space-between" },
});
