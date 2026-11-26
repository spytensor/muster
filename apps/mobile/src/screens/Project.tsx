import Ionicons from "@expo/vector-icons/Ionicons";
import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useEffect } from "react";
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useBars } from "../bars";
import { useOpenFile } from "../files";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import {
  factsOf,
  groupsOf,
  hostOf,
  itemsOf,
  opens,
  type ProjectItem,
  standingOf,
} from "../lib/lives";
import { progressOf } from "../lib/tools";
import type {
  FileKind,
  Health,
  Project as ProjectRow,
  ProjectStep,
  ProjectUpdate,
} from "../lib/types";
import type { RootParams } from "../nav";
import { type Colors, useColors } from "../theme";
import { Divider, Group, LoadError, Loading, Notice, SectionTitle, useLoad } from "../ui";

const healthColor = (c: Colors, health: Health) =>
  health === "on_track" ? c.ok : health === "at_risk" ? c.warn : c.bad;

const itemIcon = {
  repo: "git-branch-outline",
  guide: "book-outline",
  environment: "server-outline",
  link: "link-outline",
  contact: "person-outline",
  fact: "bulb-outline",
} as const;

const stepIcon = {
  todo: "ellipse-outline",
  doing: "ellipse",
  waiting: "pause-circle-outline",
  done: "checkmark-circle",
} as const;

/**
 * A project, to look at: how far its steps have got, how it was last said to be going,
 * and what lives in it (its repositories, guides, environments, links, people to reach
 * and facts; MUS-59), kind by kind, each opened with a tap. Changing it is done where
 * there is room to (the web and desktop apps); the phone is where one sees how it
 * stands, one's own or a colleague's.
 */
export function Project() {
  const { t, ago } = useI18n();
  const c = useColors();
  const bars = useBars();
  const nav = useNavigation();
  const { id } = useRoute<RouteProp<RootParams, "Project">>().params;
  const p = t.app.project;
  const files = useOpenFile();
  const { data, error, reload, refresh, refreshing } = useLoad(async () => {
    const at = `/api/app/projects/${id}`;
    const [projects, steps, updates, lives, facts] = await Promise.all([
      api<ProjectRow[]>("/api/app/projects"),
      api<ProjectStep[]>(`${at}/steps`),
      api<ProjectUpdate[]>(`${at}/updates`),
      // A server from before this page knew of them answers nothing here: then nothing is shown.
      api<{ items?: unknown }>(`${at}/items`).catch(() => ({ items: [] })),
      api<unknown>(`${at}/repos`).catch(() => null),
    ]);
    return {
      project: projects.find((one) => one.id === id) ?? null,
      steps,
      updates,
      items: itemsOf(lives.items),
      facts: factsOf(facts),
    };
  });
  const name = data?.project?.name;
  useEffect(() => {
    if (name) nav.setOptions({ title: name });
  }, [name, nav]);
  if (!data)
    return (
      <View style={{ flex: 1, ...bars.pad }}>
        {error ? <LoadError message={error} onRetry={reload} /> : <Loading />}
      </View>
    );
  if (!data.project)
    return (
      <View style={[styles.page, bars.pad]}>
        <Notice>{p.gone}</Notice>
      </View>
    );
  const { project, steps, items, facts } = data;
  const standing = standingOf(items, facts);
  const counted = [
    standing.repos > 0 ? p.repos(standing.repos) : "",
    standing.failing > 0 ? p.failing(standing.failing) : "",
    standing.pulls > 0 ? p.pulls(standing.pulls) : "",
  ].filter(Boolean);
  /** What is known of a thing, said at the end of its row. */
  const factOf = (item: ProjectItem): string => {
    if (item.kind === "repo") {
      const known = item.ref ? facts[item.ref] : undefined;
      if (!known) return item.state.branch ?? "";
      return known.pulls ? p.pulls(known.pulls) : known.branch;
    }
    if (item.kind === "environment") return item.state.version ?? "";
    return item.file ? "" : hostOf(item.url);
  };
  const open = (item: ProjectItem) => {
    if (item.file) {
      const file = { ...item.file, kind: item.file.kind as FileKind };
      void files.open(file);
    } else if (opens(item.url)) void Linking.openURL(item.url.trim()).catch(() => undefined);
  };
  const latest = data.updates[0];
  const progress = progressOf(steps);
  // What is still open first, in the project's own order; what is done after it.
  const ordered = [
    ...steps.filter((step) => step.state !== "done"),
    ...steps.filter((step) => step.state === "done"),
  ];
  return (
    <ScrollView
      {...bars.scroll}
      contentContainerStyle={[styles.page, bars.pad]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {project.role !== "owner" && project.owner && (
        <Text style={{ fontSize: 13, color: c.muted }}>
          {p.theirs(project.owner.name, project.role)}
        </Text>
      )}
      <View style={{ gap: 8 }}>
        <View style={styles.line}>
          <Text style={{ fontSize: 13, color: c.muted }}>
            {steps.length ? p.steps(progress.done, progress.total) : p.noSteps}
          </Text>
          {project.health && (
            <View style={styles.health}>
              <View style={[styles.dot, { backgroundColor: healthColor(c, project.health) }]} />
              <Text style={{ fontSize: 13, color: c.text }}>{p.health[project.health]}</Text>
            </View>
          )}
        </View>
        {counted.length > 0 && (
          <Text style={{ fontSize: 13, color: standing.failing > 0 ? c.warn : c.muted }}>
            {counted.join(" · ")}
          </Text>
        )}
        {steps.length > 0 && (
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: progress.total, now: progress.done }}
            style={[styles.track, { backgroundColor: c.border }]}
          >
            <View
              style={[styles.fill, { backgroundColor: c.ok, width: `${progress.share * 100}%` }]}
            />
          </View>
        )}
      </View>
      {ordered.length > 0 && (
        <Group>
          {ordered.map((step) => {
            const under = [
              step.due && step.state !== "done" ? p.due(step.due) : "",
              step.state === "doing" && step.agentName ? p.on(step.agentName) : "",
              step.result,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <View key={step.id} style={styles.step}>
                <Ionicons
                  name={stepIcon[step.state]}
                  size={18}
                  color={step.state === "done" ? c.ok : step.state === "doing" ? c.accent : c.muted}
                  accessibilityLabel={p.state[step.state]}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    style={{
                      fontSize: 15,
                      lineHeight: 20,
                      color: step.state === "done" ? c.muted : c.text,
                    }}
                  >
                    {step.title}
                  </Text>
                  {under !== "" && (
                    <Text
                      numberOfLines={2}
                      style={{ fontSize: 13, lineHeight: 18, color: c.muted }}
                    >
                      {under}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </Group>
      )}
      {latest && (
        <>
          <SectionTitle>{p.update}</SectionTitle>
          <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <View style={styles.health}>
              <View style={[styles.dot, { backgroundColor: healthColor(c, latest.health) }]} />
              <Text style={{ fontSize: 13, fontWeight: "600", color: c.text }}>
                {p.health[latest.health]}
              </Text>
              <Text style={{ fontSize: 12, color: c.muted }}>
                {p
                  .by(latest.by ?? latest.author?.name ?? "", ago(latest.createdAt))
                  .replace(/^ · /, "")}
              </Text>
            </View>
            <Divider />
            <Text selectable style={{ fontSize: 15, lineHeight: 22, color: c.text }}>
              {latest.text}
            </Text>
          </View>
        </>
      )}
      {files.problem && <Notice tone="bad">{files.problem}</Notice>}
      {groupsOf(items).map((group) => (
        <View key={group.kind} style={{ gap: 8 }}>
          <SectionTitle>{p.lives[group.kind] ?? ""}</SectionTitle>
          <Group>
            {group.items.map((item) => {
              const fact = factOf(item);
              const checks = item.kind === "repo" && item.ref ? facts[item.ref]?.checks : undefined;
              const tappable = Boolean(item.file) || opens(item.url);
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole={tappable ? "button" : "text"}
                  accessibilityLabel={[item.title, fact, item.detail].filter(Boolean).join(". ")}
                  disabled={!tappable}
                  onPress={() => open(item)}
                  style={styles.item}
                >
                  <Ionicons name={itemIcon[item.kind]} size={18} color={c.muted} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, color: c.text }}>
                      {item.title}
                    </Text>
                    {item.detail !== "" && (
                      <Text
                        numberOfLines={2}
                        style={{ fontSize: 13, lineHeight: 18, color: c.muted }}
                      >
                        {item.detail}
                      </Text>
                    )}
                  </View>
                  {checks === "failing" && (
                    <Ionicons
                      name="alert-circle"
                      size={16}
                      color={c.warn}
                      accessibilityLabel={p.failing(1)}
                    />
                  )}
                  {fact !== "" && (
                    <Text numberOfLines={1} style={{ maxWidth: 120, fontSize: 13, color: c.muted }}>
                      {fact}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </Group>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 16 },
  line: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  health: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 14 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
});
