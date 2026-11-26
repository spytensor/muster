import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { riskOf } from "../lib/risk";
import type { AppAgent, Tool } from "../lib/types";
import type { RootParams } from "../nav";
import { PRESSED, useColors } from "../theme";
import { Group, LoadError, Loading, Notice, SectionTitle, useAction } from "../ui";
import { useUnsaved } from "../unsaved";

/** Builds a new agent of the person's own, or changes one they built. */
export function AgentEditor({ navigation, route }: NativeStackScreenProps<RootParams, "Agent">) {
  const id = route.params?.id;
  const { t, errorText } = useI18n();
  const c = useColors();
  const b = t.app.builder;
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  // What the agent carries is set on the web; the phone hands it back as it was, since a
  // save that leaves it out would take it all away.
  const [carries, setCarries] = useState<NonNullable<AppAgent["carries"]>>([]);
  // What was there when the page opened: leaving asks first only when something differs.
  const [was, setWas] = useState(JSON.stringify(["", "", "", []]));
  const { busy, error, run } = useAction();
  const leave = useUnsaved(
    tools !== null && JSON.stringify([name, description, instructions, chosen]) !== was,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per agent and on retry
  useEffect(() => {
    let cancelled = false;
    setMissing(null);
    void (async () => {
      try {
        const available = await api<Tool[]>("/api/app/tools");
        if (id) {
          const { agents } = await api<{ agents: AppAgent[] }>("/api/app/agents");
          const agent = agents.find((candidate) => candidate.id === id && candidate.mine);
          if (cancelled) return;
          if (!agent) {
            setMissing(t.errors.not_found ?? "");
            return;
          }
          setName(agent.name);
          setDescription(agent.description);
          setInstructions(agent.instructions);
          setChosen(agent.tools);
          setCarries(agent.carries ?? []);
          setWas(JSON.stringify([agent.name, agent.description, agent.instructions, agent.tools]));
        }
        if (!cancelled) setTools(available);
      } catch (failure) {
        if (!cancelled) setMissing(errorText(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (!tools)
    return missing ? (
      <LoadError message={missing} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <Loading />
    );
  const risk = riskOf(tools.filter((tool) => chosen.includes(tool.name)));
  const save = () =>
    void run(async () => {
      await api(id ? `/api/app/agents/${id}` : "/api/app/agents", {
        method: id ? "PATCH" : "POST",
        body: {
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          tools: chosen,
          ...Object.fromEntries(
            (
              [
                ["skills", "skill"],
                ["knowledge", "knowledge"],
                ["connectors", "connector"],
              ] as const
            ).map(([field, kind]) => [
              field,
              carries.filter((part) => part.kind === kind).map((part) => part.id),
            ]),
          ),
        },
      });
      leave();
    });
  // What it may use, by kind: a short word for each, and the system's own switch.
  const families = FAMILIES.map((family) => ({
    family,
    tools: tools.filter((tool) => familyOf(tool.name) === family),
  })).filter((group) => group.tools.length > 0);
  const ready = Boolean(name.trim() && instructions.trim()) && !busy;
  return (
    <>
      <Save
        navigation={navigation}
        title={id ? b.edit : b.new}
        label={t.common.save}
        ready={ready}
        onPress={save}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.page}
      >
        {/* At the top, under the bar that holds Save: a refusal is seen where it was asked. */}
        {error && <Notice tone="bad">{error}</Notice>}
        <View style={styles.who}>
          <View style={[styles.avatar, { backgroundColor: c.soft }]}>
            {name.trim() ? (
              <Text style={{ fontSize: 30, fontWeight: "600", color: c.text }}>
                {name.trim().slice(0, 1).toUpperCase()}
              </Text>
            ) : (
              <Ionicons name="sparkles-outline" size={30} color={c.muted} />
            )}
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={60}
            placeholder={b.name}
            placeholderTextColor={c.faint}
            accessibilityLabel={b.name}
            autoFocus={!id}
            returnKeyType="next"
            style={[styles.name, { color: c.text }]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            maxLength={300}
            multiline
            placeholder={b.descriptionHint}
            placeholderTextColor={c.faint}
            accessibilityLabel={b.description}
            style={[styles.purpose, { color: c.muted }]}
          />
        </View>

        <View style={styles.section}>
          <SectionTitle>{b.instructions}</SectionTitle>
          <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <TextInput
              value={instructions}
              onChangeText={setInstructions}
              multiline
              scrollEnabled={false}
              placeholder={b.instructionsHint}
              placeholderTextColor={c.faint}
              accessibilityLabel={b.instructions}
              style={[styles.brief, { color: c.text }]}
            />
          </View>
        </View>

        {families.map(({ family, tools: inFamily }, at) => (
          <View key={family} style={styles.section}>
            <SectionTitle>
              {at === 0 ? `${b.toolsLabel} · ${b.family[family]}` : (b.family[family] ?? family)}
            </SectionTitle>
            <Group>
              {inFamily.map((tool) => {
                const on = chosen.includes(tool.name);
                const far = tool.level === "A3" || tool.level === "A4";
                const said = b.toolShort[tool.name] ?? t.app.toolSummary[tool.name] ?? tool.summary;
                return (
                  <View key={tool.name} style={styles.tool}>
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text numberOfLines={2} style={{ fontSize: 16, color: c.text }}>
                        {said}
                      </Text>
                      {far && (
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: "600",
                            color: tool.level === "A4" ? c.bad : c.warn,
                          }}
                        >
                          {t.risk[tool.level === "A4" ? "R4" : "R3"]}
                        </Text>
                      )}
                    </View>
                    <Switch
                      accessibilityLabel={said}
                      value={on}
                      onValueChange={(next) =>
                        setChosen((now) =>
                          next ? [...now, tool.name] : now.filter((item) => item !== tool.name),
                        )
                      }
                    />
                  </View>
                );
              })}
            </Group>
          </View>
        ))}
        {(risk === "R3" || risk === "R4") && (
          <Text style={[styles.foot, { color: c.muted }]}>{b.riskNote[risk]}</Text>
        )}
      </ScrollView>
    </>
  );
}

/** Puts the title and the one action in the bar: said in words, dim until there is something to keep. */
function Save({
  navigation,
  title,
  label,
  ready,
  onPress,
}: {
  navigation: NativeStackScreenProps<RootParams, "Agent">["navigation"];
  title: string;
  label: string;
  ready: boolean;
  onPress(): void;
}) {
  const c = useColors();
  const press = useRef(onPress);
  press.current = onPress;
  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          hitSlop={10}
          onPress={() => press.current()}
          style={({ pressed }) => [{ paddingHorizontal: 6 }, pressed && { opacity: PRESSED }]}
        >
          <Text style={{ fontSize: 16, fontWeight: "600", color: ready ? c.text : c.faint }}>
            {label}
          </Text>
        </Pressable>
      ),
    });
  }, [navigation, title, label, ready, c]);
  return null;
}

const FAMILIES = ["docs", "files", "web", "m365", "other"] as const;
const familyOf = (name: string): (typeof FAMILIES)[number] => {
  const head = name.split(".")[0] ?? "";
  return (FAMILIES as readonly string[]).includes(head)
    ? (head as (typeof FAMILIES)[number])
    : "other";
};

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 28 },
  who: { alignItems: "center", gap: 4 },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  name: { fontSize: 22, fontWeight: "700", textAlign: "center", minWidth: 200, paddingVertical: 4 },
  purpose: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    alignSelf: "stretch",
    paddingVertical: 4,
  },
  section: { gap: 8 },
  card: {
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  brief: { fontSize: 16, lineHeight: 23, minHeight: 120, textAlignVertical: "top" },
  tool: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  foot: { fontSize: 13, lineHeight: 20, paddingHorizontal: 4 },
});
