import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { RootParams } from "../nav";
import { mono, useColors } from "../theme";
import { LoadError, Loading, Notice } from "../ui";

interface FileTextBody {
  text: string;
  truncated: boolean;
  problem?: string;
}

/**
 * A file as its text. This is how a web page from a file is shown: its markup is text on the
 * screen and is never given to anything that would run it.
 */
export function FileText({ navigation, route }: NativeStackScreenProps<RootParams, "FileText">) {
  const { id, name } = route.params;
  const { t, errorText } = useI18n();
  const c = useColors();
  const [body, setBody] = useState<FileTextBody | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => navigation.setOptions({ title: name }), [navigation, name]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per file and on retry
  useEffect(() => {
    let live = true;
    setMissing(null);
    api<FileTextBody>(`/api/app/files/${id}/text`).then(
      (found) => live && setBody(found),
      (failure) => live && setMissing(errorText(failure)),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);
  if (!body)
    return missing ? (
      <LoadError message={missing} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <Loading />
    );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 12, gap: 8 }}
    >
      <Notice>{t.files.pageAsText}</Notice>
      {body.problem ? (
        <Notice tone="bad">{body.problem}</Notice>
      ) : body.text ? (
        <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.text }}>
          {body.text}
        </Text>
      ) : (
        <Text style={{ fontSize: 13, color: c.muted }}>{t.files.empty}</Text>
      )}
      {body.truncated && <Notice>{t.files.truncated}</Notice>}
    </ScrollView>
  );
}
