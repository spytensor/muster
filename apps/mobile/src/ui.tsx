import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "@react-navigation/native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { useI18n } from "./i18n";
import type { Risk } from "./lib/types";
import { PRESSED, useColors } from "./theme";

export type IconName = keyof typeof Ionicons.glyphMap;

export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  disabled,
  busy,
  small,
  style,
}: {
  label: string;
  onPress(): void;
  variant?: "primary" | "outline" | "ghost" | "danger";
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const color = variant === "primary" ? c.onPrimary : variant === "danger" ? c.bad : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variant === "primary" && { backgroundColor: c.primary },
        (variant === "outline" || variant === "danger") && {
          borderWidth: 1,
          borderColor: c.outline,
        },
        (disabled || busy) && { opacity: 0.4 },
        pressed && { opacity: PRESSED },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        icon && <Ionicons name={icon} size={small ? 16 : 18} color={color} />
      )}
      <Text style={[styles.buttonText, small && { fontSize: 14 }, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** A round button that is only an icon; the label is for screen readers. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = "plain",
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  tone?: "plain" | "primary" | "soft" | "danger";
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        tone === "primary" && { backgroundColor: c.primary },
        tone === "soft" && { backgroundColor: c.soft },
        disabled && { opacity: 0.35 },
        pressed && { opacity: PRESSED },
      ]}
    >
      <Ionicons
        name={icon}
        size={22}
        color={tone === "primary" ? c.onPrimary : tone === "danger" ? c.bad : c.text}
      />
    </Pressable>
  );
}

const liquid = Platform.OS === "ios" && isLiquidGlassAvailable();

/**
 * A translucent panel in the system's material: Liquid Glass where the system has it, a blur
 * on older iOS, and a solid surface elsewhere or when the person asked for less transparency.
 */
export function Glass({
  children,
  style,
  bar,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A full-width bar (header, tab bar): the system's bar material, with no outline. */
  bar?: boolean;
}) {
  const c = useColors();
  const [solid, setSolid] = useState(Platform.OS !== "ios");
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setSolid);
    const watching = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setSolid);
    return () => watching.remove();
  }, []);
  const edge = bar ? null : { borderColor: c.outline, borderWidth: StyleSheet.hairlineWidth };
  if (solid) return <View style={[edge, { backgroundColor: c.card }, style]}>{children}</View>;
  if (liquid && !bar)
    return (
      <GlassView glassEffectStyle="regular" colorScheme={c.dark ? "dark" : "light"} style={style}>
        {children}
      </GlassView>
    );
  return (
    <BlurView
      intensity={bar ? 90 : 70}
      tint={
        bar
          ? c.dark
            ? "systemChromeMaterialDark"
            : "systemChromeMaterialLight"
          : c.dark
            ? "systemMaterialDark"
            : "systemMaterialLight"
      }
      style={[edge, { overflow: "hidden" }, style]}
    >
      {children}
    </BlurView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, style]}>
      {children}
    </View>
  );
}

/**
 * A grouped list: rows in one inset card, a hairline between them. Never the system's grey
 * form.
 */
export function Group({ children }: { children: ReactNode }) {
  const c = useColors();
  const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return (
    <View style={[styles.group, { backgroundColor: c.card, borderColor: c.border }]}>
      {rows.map((row, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one group are drawn together
        <View key={at}>
          {at > 0 && <Divider />}
          {row}
        </View>
      ))}
    </View>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "bad"; children: string }) {
  const c = useColors();
  const bad = tone === "bad";
  return (
    <View
      accessibilityRole={bad ? "alert" : undefined}
      style={[styles.notice, { backgroundColor: bad ? c.badSoft : c.soft }]}
    >
      <Ionicons
        name={bad ? "warning-outline" : "information-circle-outline"}
        size={18}
        color={bad ? c.bad : c.muted}
      />
      <Text style={[styles.noticeText, { color: bad ? c.bad : c.text }]}>{children}</Text>
    </View>
  );
}

export function Badge({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "warn" | "bad" | "ok" | "accent";
}) {
  const c = useColors();
  const [fg, bg] =
    tone === "warn"
      ? [c.warn, c.warnSoft]
      : tone === "bad"
        ? [c.bad, c.badSoft]
        : tone === "ok"
          ? [c.ok, c.okSoft]
          : tone === "accent"
            ? [c.accentText, c.accentSoft]
            : [c.muted, c.soft];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

const riskTone = { R1: "muted", R2: "accent", R3: "warn", R4: "bad" } as const;
/** How far an agent can reach, in words. */
export function RiskBadge({ risk }: { risk: Risk }) {
  const { t } = useI18n();
  return <Badge tone={riskTone[risk] ?? "muted"} label={`${risk} · ${t.risk[risk] ?? ""}`} />;
}

export function Field({ label, style, ...input }: { label: string } & TextInputProps) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.faint}
        {...input}
        style={[
          styles.input,
          { color: c.text, backgroundColor: c.card, borderColor: c.border },
          input.multiline && { minHeight: 120, textAlignVertical: "top" },
          style,
        ]}
      />
    </View>
  );
}

/** One compact line of a list: a title, a quieter line under it, and something at the end. */
export function Row({
  title,
  meta,
  icon,
  trail,
  onPress,
  onLongPress,
  more,
}: {
  title: string;
  meta?: string;
  icon?: IconName;
  trail?: ReactNode;
  onPress(): void;
  onLongPress?(): void;
  /** What a long press offers, said to a screen reader as an action of the row. */
  more?: string;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={more && onLongPress ? [{ name: "more", label: more }] : undefined}
      onAccessibilityAction={(event) => event.nativeEvent.actionName === "more" && onLongPress?.()}
      style={({ pressed }) => [styles.row, pressed && { opacity: PRESSED }]}
    >
      {icon && <Ionicons name={icon} size={22} color={c.muted} />}
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "500", color: c.text }}>
          {title}
        </Text>
        {meta !== undefined && (
          <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: c.muted }}>
            {meta}
          </Text>
        )}
      </View>
      {trail}
    </Pressable>
  );
}

/** The thin line between rows of a list. */
export function Divider() {
  const c = useColors();
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginLeft: 14 }}
    />
  );
}

export function SectionTitle({ children }: { children: string }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" style={[styles.section, { color: c.muted }]}>
      {children}
    </Text>
  );
}

export function Empty({ children }: { children: string }) {
  const c = useColors();
  return <Text style={[styles.empty, { color: c.muted }]}>{children}</Text>;
}

export function Loading() {
  const c = useColors();
  return (
    <View style={{ padding: 20, alignItems: "center" }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

/** A request that failed to load a whole screen, with a way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 10, padding: 16, alignItems: "flex-start" }}>
      <Notice tone="bad">{message}</Notice>
      <Button small variant="outline" label={t.common.retry} icon="refresh" onPress={onRetry} />
    </View>
  );
}

/**
 * Loads what a screen shows, again each time the screen comes into view, and on demand.
 * `refreshing` is true only for a reload the person asked for by pulling down.
 */
export function useLoad<T>(load: () => Promise<T>) {
  const { errorText } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loader = useRef(load);
  loader.current = load;
  const translate = useRef(errorText);
  translate.current = errorText;
  const reload = useCallback(async () => {
    try {
      setData(await loader.current());
      setError(null);
    } catch (failure) {
      setError(translate.current(failure));
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);
  return { data, error, reload, refresh, refreshing };
}

/** Runs something the person asked for, showing that it is busy and what went wrong. */
export function useAction() {
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
      } catch (failure) {
        setError(errorText(failure));
      } finally {
        setBusy(false);
      }
    },
    [errorText],
  );
  return { busy, error, run };
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: 999,
    borderCurve: "continuous",
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: 16, gap: 6 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 12,
  },
  notice: {
    flexDirection: "row",
    gap: 10,
    borderRadius: 12,
    borderCurve: "continuous",
    padding: 14,
    alignItems: "flex-start",
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 20 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderRadius: 18,
    borderCurve: "continuous",
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 16,
    minHeight: 50,
  },
  row: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  group: {
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  section: { fontSize: 13, fontWeight: "600", marginTop: 12, paddingHorizontal: 4 },
  empty: { fontSize: 13, lineHeight: 20, paddingVertical: 2 },
});
