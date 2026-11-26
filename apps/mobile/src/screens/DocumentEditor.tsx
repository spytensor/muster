import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { DocumentDetail } from "../lib/types";
import type { RootParams } from "../nav";
import { mono } from "../theme";
import { Button, Field, LoadError, Loading, Notice, useAction } from "../ui";

/** Opens one document to read and change, or starts a new one. */
export function DocumentEditor({
  navigation,
  route,
}: NativeStackScreenProps<RootParams, "Document">) {
  const id = route.params?.id;
  const { t, errorText } = useI18n();
  const d = t.app.docs;
  const headerHeight = useHeaderHeight();
  const [loaded, setLoaded] = useState(!id);
  const [missing, setMissing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const { busy, error, run } = useAction();

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per document and on retry
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setMissing(null);
    api<DocumentDetail>(`/api/app/documents/${id}`)
      .then((doc) => {
        if (cancelled) return;
        setTitle(doc.title);
        setContent(doc.content);
        navigation.setOptions({ title: doc.title });
        setLoaded(true);
      })
      .catch((failure) => {
        if (!cancelled) setMissing(errorText(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const ready = loaded && title.trim() !== "" && !busy;
  useLayoutEffect(() => {
    const save = () =>
      void run(async () => {
        await api(id ? `/api/app/documents/${id}` : "/api/app/documents", {
          method: id ? "PUT" : "POST",
          body: { title: title.trim(), content },
        });
        navigation.goBack();
      });
    navigation.setOptions({
      headerRight: () => (
        <Button small variant="ghost" label={t.common.save} disabled={!ready} onPress={save} />
      ),
    });
  }, [navigation, id, title, content, ready, run, t]);

  if (!loaded)
    return missing ? (
      <LoadError message={missing} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <Loading />
    );
  const remove = () =>
    Alert.alert(t.common.delete, d.deleteConfirm(title), [
      { text: t.common.cancel, style: "cancel" },
      {
        text: t.common.delete,
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await api(`/api/app/documents/${id}`, { method: "DELETE" });
            navigation.goBack();
          }),
      },
    ]);
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label={d.titleLabel} value={title} maxLength={120} onChangeText={setTitle} />
        <Field
          label={d.body}
          value={content}
          onChangeText={setContent}
          multiline
          scrollEnabled={false}
          autoCapitalize="sentences"
          style={{ fontFamily: mono, fontSize: 14, lineHeight: 20, minHeight: 280 }}
        />
        {id && (
          <View style={{ paddingTop: 8 }}>
            <Button
              variant="danger"
              icon="trash-outline"
              label={t.common.delete}
              disabled={busy}
              onPress={remove}
            />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
