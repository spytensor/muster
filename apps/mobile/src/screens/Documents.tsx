import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { useBars } from "../bars";
import {
  kindIcon,
  type Picked,
  pickDocuments,
  pickPhotos,
  uploadFile,
  useFileLimits,
  useOpenFile,
} from "../files";
import { useI18n } from "../i18n";
import { ApiError, api } from "../lib/api";
import { fileSize, refusedBefore } from "../lib/files";
import type { DocumentSummary, FileItem } from "../lib/types";
import { choose } from "../menu";
import { useNav } from "../nav";
import { useColors } from "../theme";
import { Divider, IconButton, LoadError, Loading, Notice, Row, useAction, useLoad } from "../ui";

type Entry =
  | { type: "note"; key: string; at: string; note: DocumentSummary }
  | { type: "file"; key: string; at: string; file: FileItem };

/** Everything the person keeps: documents written here and files, newest first, in one list. */
export function Documents() {
  const { t, ago, errorText } = useI18n();
  const c = useColors();
  const nav = useNav();
  const tab = useNavigation();
  const bars = useBars();
  const limits = useFileLimits();
  const d = t.app.docs;
  const { data, error, reload, refresh, refreshing } = useLoad(async () => {
    const [notes, files] = await Promise.all([
      api<DocumentSummary[]>("/api/app/documents"),
      api<FileItem[]>("/api/app/files"),
    ]);
    return { notes, files };
  });
  const { open, opening, problem } = useOpenFile();
  const { error: failure, run } = useAction();
  /** Uploads in progress, and the ones that were refused, by name. */
  const [sending, setSending] = useState<{ name: string; sent: number }[]>([]);
  const [refused, setRefused] = useState<string[]>([]);

  const upload = useCallback(
    async (picked: Picked[]) => {
      setRefused([]);
      for (const one of picked) {
        const before = refusedBefore(one, limits);
        if (before) {
          setRefused((now) => [
            ...now,
            before === "kind"
              ? t.files.notAccepted(one.name)
              : t.files.tooLarge(one.name, fileSize(limits?.maxBytes ?? 0)),
          ]);
          continue;
        }
        setSending((now) => [...now, { name: one.name, sent: 0 }]);
        try {
          await uploadFile(one, (sent) =>
            setSending((now) =>
              now.map((item) => (item.name === one.name ? { ...item, sent } : item)),
            ),
          );
        } catch (problem) {
          const code = problem instanceof ApiError ? problem.code : "";
          setRefused((now) => [
            ...now,
            code === "unsupported_file"
              ? t.files.notAccepted(one.name)
              : `${one.name}: ${errorText(problem)}`,
          ]);
        }
        setSending((now) => now.filter((item) => item.name !== one.name));
      }
      await reload();
    },
    [limits, reload, t, errorText],
  );

  // The one + of this screen: write a document, or bring a file or a photo.
  useLayoutEffect(() => {
    const take = (pick: () => Promise<Picked[]>) =>
      void pick().then(upload, (problem) => setRefused([errorText(problem)]));
    const pick = () =>
      choose(
        { options: [d.new, t.files.upload, t.files.uploadPhoto], cancel: t.common.cancel },
        (index) => {
          if (index === 0) nav.navigate("Document");
          if (index === 1) take(pickDocuments);
          if (index === 2) take(pickPhotos);
        },
      );
    tab.setOptions({
      headerRight: () => (
        <IconButton icon="add" label={`${d.new}, ${t.files.upload}`} onPress={pick} />
      ),
    });
  }, [tab, nav, upload, d, t, errorText]);

  const entries = useMemo<Entry[]>(
    () =>
      [
        ...(data?.notes ?? []).map(
          (note): Entry => ({ type: "note", key: `n${note.id}`, at: note.updatedAt, note }),
        ),
        ...(data?.files ?? []).map(
          (file): Entry => ({ type: "file", key: `f${file.id}`, at: file.createdAt, file }),
        ),
      ].sort((a, b) => (a.at < b.at ? 1 : -1)),
    [data],
  );
  const remove = (file: FileItem) =>
    Alert.alert(t.files.delete, t.files.deleteConfirm(file.name), [
      { text: t.common.cancel, style: "cancel" },
      {
        text: t.common.delete,
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await api(`/api/app/files/${file.id}`, { method: "DELETE" });
            await reload();
          }),
      },
    ]);

  if (!data)
    return (
      <View style={{ flex: 1, ...bars.pad }}>
        {error ? <LoadError message={error} onRetry={reload} /> : <Loading />}
      </View>
    );
  return (
    <FlatList
      {...bars.scroll}
      data={entries}
      keyExtractor={(item) => item.key}
      contentContainerStyle={[{ paddingHorizontal: 6, flexGrow: 1 }, bars.pad]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      ItemSeparatorComponent={Divider}
      ListEmptyComponent={
        // Nothing yet: said once, in the middle of the page, with the sign of what goes here.
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 }}
        >
          <Ionicons name="document-text-outline" size={44} color={c.faint} />
          <Text style={{ fontSize: 15, lineHeight: 22, color: c.muted, textAlign: "center" }}>
            {d.none}
          </Text>
        </View>
      }
      ListHeaderComponent={
        <View style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8, gap: 8 }}>
          {entries.length > 0 && (
            <Text style={{ fontSize: 13, lineHeight: 20, color: c.muted }}>{d.lead}</Text>
          )}
          {error && <LoadError message={error} onRetry={reload} />}
          {(failure ?? problem) && <Notice tone="bad">{failure ?? problem ?? ""}</Notice>}
          {refused.map((reason) => (
            <Notice key={reason} tone="bad">
              {reason}
            </Notice>
          ))}
          {sending.map((item) => (
            <View key={item.name} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={c.muted} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: c.muted }}>
                {t.files.uploading(item.name, Math.round(item.sent * 100))}
              </Text>
            </View>
          ))}
        </View>
      }
      renderItem={({ item }) =>
        item.type === "note" ? (
          <Row
            icon={kindIcon.note}
            title={item.note.title}
            meta={`${t.files.kinds.note} · ${d.size(item.note.size)} · ${ago(item.note.updatedAt)}`}
            onPress={() => nav.navigate("Document", { id: item.note.id })}
          />
        ) : (
          <Row
            icon={kindIcon[item.file.kind] ?? "document-outline"}
            title={item.file.name}
            meta={[
              t.files.kinds[item.file.kind] ?? item.file.kind,
              fileSize(item.file.size),
              ago(item.file.createdAt),
              ...(item.file.source === "agent" ? [t.files.madeByAgent] : []),
            ].join(" · ")}
            onPress={() => open(item.file)}
            trail={
              opening === item.file.id ? (
                <ActivityIndicator size="small" color={c.muted} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t.files.delete}: ${item.file.name}`}
                  hitSlop={12}
                  onPress={() => remove(item.file)}
                >
                  <Ionicons name="trash-outline" size={17} color={c.muted} />
                </Pressable>
              )
            }
          />
        )
      }
    />
  );
}
