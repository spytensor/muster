import Ionicons from "@expo/vector-icons/Ionicons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { open as openNatively } from "react-native-file-viewer-turbo";
import { useI18n } from "./i18n";
import { ApiError, api, bearer, serverUrl, signedOut } from "./lib/api";
import { cacheName, fileSize, opensAs, refusedBefore, uploadUrl } from "./lib/files";
import type { Attachment, FileItem, FileKind, FileLimits } from "./lib/types";
import { useNav } from "./nav";
import { useColors } from "./theme";
import type { IconName } from "./ui";

export const kindIcon: Record<FileKind | "note", IconName> = {
  document: "document-text-outline",
  spreadsheet: "grid-outline",
  slides: "easel-outline",
  pdf: "reader-outline",
  image: "image-outline",
  page: "code-slash-outline",
  text: "document-outline",
  data: "list-outline",
  note: "create-outline",
};

/** Where downloaded files are kept while they are being looked at. Emptied on sign-out. */
const CACHE = `${FileSystem.cacheDirectory ?? ""}files/`;

/** Removes every file this app downloaded for viewing. */
export const forgetDownloads = () =>
  FileSystem.deleteAsync(CACHE, { idempotent: true }).catch(() => undefined);

/** A file someone picked on the device, before it is sent. */
export interface Picked {
  uri: string;
  name: string;
  size: number | null;
}

/** The system's file chooser. Empty when the person cancelled. */
export async function pickDocuments(): Promise<Picked[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? null,
  }));
}

/** The photo library. The system's own picker shows only what the person chooses; no permission prompt is needed. */
export async function pickPhotos(): Promise<Picked[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 0.9,
    // Photos are sent in a format every model and viewer reads.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `photo-${index + 1}.jpg`,
    size: asset.fileSize ?? null,
  }));
}

/** Sends one file to the person's files. The body is the file itself; its name travels in the address. */
export async function uploadFile(
  picked: Picked,
  onProgress?: (fraction: number) => void,
  /** Receives a way to stop the upload, for when the person changes their mind. */
  onStart?: (cancel: () => void) => void,
): Promise<FileItem> {
  // The pickers hand over a copy in the app's cache; it is removed once it has been sent or refused.
  const forget = () => {
    if (FileSystem.cacheDirectory && picked.uri.startsWith(FileSystem.cacheDirectory))
      void FileSystem.deleteAsync(picked.uri, { idempotent: true }).catch(() => undefined);
  };
  const task = FileSystem.createUploadTask(
    uploadUrl(serverUrl(), picked.name),
    picked.uri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { ...bearer(), "content-type": "application/octet-stream" },
    },
    (progress) => {
      if (progress.totalBytesExpectedToSend > 0)
        onProgress?.(progress.totalBytesSent / progress.totalBytesExpectedToSend);
    },
  );
  onStart?.(() => void task.cancelAsync().catch(() => undefined));
  let result: FileSystem.FileSystemUploadResult | undefined | null;
  try {
    result = await task.uploadAsync();
  } catch {
    throw new ApiError(0, "network", "network");
  } finally {
    forget();
  }
  if (!result) throw new ApiError(0, "cancelled", "");
  let payload: (FileItem & { error?: { code: string; message: string } }) | null = null;
  try {
    payload = JSON.parse(result.body);
  } catch {
    // Not JSON: treated as a failure below.
  }
  if (result.status === 401) signedOut();
  if (result.status < 200 || result.status >= 300 || !payload?.id)
    throw new ApiError(
      result.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? "",
    );
  return payload;
}

/** Fetches a file into the app's cache, with the session token, and returns where it is. */
async function download(file: Attachment): Promise<string> {
  await FileSystem.makeDirectoryAsync(CACHE, { intermediates: true }).catch(() => undefined);
  const target = `${CACHE}${encodeURIComponent(cacheName(file.id, file.name))}`;
  let result: FileSystem.FileSystemDownloadResult;
  try {
    result = await FileSystem.downloadAsync(
      `${serverUrl()}/api/app/files/${file.id}/content?download`,
      target,
      { headers: bearer() },
    );
  } catch {
    throw new ApiError(0, "network", "network");
  }
  if (result.status !== 200) {
    // What was saved is the server's error, not the file.
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    if (result.status === 401) signedOut();
    throw new ApiError(result.status, result.status === 404 ? "not_found" : "unknown", "");
  }
  return target;
}

/**
 * Opens one of the person's files. Office files, PDFs and images are fetched and shown by the
 * system's own viewer (Quick Look); the copy is removed when the viewer closes. A web page is
 * never handed to anything that would run it: `asText` shows its text instead.
 */
export async function openFile(
  file: Attachment,
  asText: (file: Attachment) => void,
): Promise<void> {
  if (opensAs(file) === "text") {
    asText(file);
    return;
  }
  const uri = await download(file);
  const forget = () =>
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  try {
    await openNatively(decodeURIComponent(uri.replace(/^file:\/\//, "")), {
      displayName: file.name,
      showOpenWithDialog: false,
      showAppsSuggestions: false,
      onDismiss: forget,
    });
  } catch {
    forget();
    throw new ApiError(415, "cannot_open", "");
  }
}

/** Opens files from a screen: which one is being fetched, and what went wrong. */
export function useOpenFile() {
  const { t, errorText } = useI18n();
  const nav = useNav();
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = useCallback(
    (file: Attachment) => {
      if (opening) return;
      setOpening(file.id);
      setProblem(null);
      openFile(file, (page) => nav.navigate("FileText", { id: page.id, name: page.name }))
        .catch((failure) =>
          setProblem(
            failure instanceof ApiError && failure.code === "cannot_open"
              ? t.files.cannotOpen
              : errorText(failure),
          ),
        )
        .finally(() => setOpening(null));
    },
    [opening, nav, t, errorText],
  );
  return { open, opening, problem };
}

/** One file as a small chip: what it is, its name and size. Tapping opens it. */
export function FileChip({
  file,
  onPress,
  onRemove,
  busy,
}: {
  file: Attachment;
  onPress?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const c = useColors();
  return (
    <View style={[styles.chip, { borderColor: c.border, backgroundColor: c.card }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.files.open(file.name)}
        disabled={!onPress || busy}
        hitSlop={6}
        onPress={onPress}
        style={styles.chipMain}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c.muted} style={styles.spinner} />
        ) : (
          <Ionicons name={kindIcon[file.kind] ?? "document-outline"} size={14} color={c.muted} />
        )}
        <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.chipName, { color: c.text }]}>
          {file.name}
        </Text>
        <Text style={{ fontSize: 11, color: c.muted }}>{fileSize(file.size)}</Text>
      </Pressable>
      {onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.files.remove(file.name)}
          hitSlop={10}
          onPress={onRemove}
        >
          <Ionicons name="close" size={14} color={c.muted} />
        </Pressable>
      )}
    </View>
  );
}

/** What the server accepts, asked once per sign-in. Null until known, and when it cannot be asked. */
export function useFileLimits(): FileLimits | null {
  const [limits, setLimits] = useState<FileLimits | null>(null);
  useEffect(() => {
    let live = true;
    api<FileLimits>("/api/app/files/limits").then(
      (found) => live && setLimits(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return limits;
}

interface Pending {
  key: string;
  name: string;
  /** How much has been sent, from 0 to 1. */
  sent: number;
  /** The stored file, once the upload has finished. */
  file?: FileItem;
  /** Why it could not be uploaded. */
  problem?: string;
}

/** The files a person is about to send with a message: each uploads as soon as it is chosen. */
export function useAttachments() {
  const { t, errorText } = useI18n();
  const limits = useFileLimits();
  const [items, setItems] = useState<Pending[]>([]);
  const words = useRef({ t, errorText, limits });
  words.current = { t, errorText, limits };
  const count = useRef(0);
  /** How to stop each upload that is still going. */
  const stops = useRef(new Map<string, () => void>());
  const add = useCallback((picked: Picked[]) => {
    for (const one of picked) {
      const key = `a${++count.current}`;
      const settle = (change: Partial<Pending>) =>
        setItems((now) => now.map((item) => (item.key === key ? { ...item, ...change } : item)));
      const { t, limits } = words.current;
      const refused = refusedBefore(one, limits);
      setItems((now) => [
        ...now,
        {
          key,
          name: one.name,
          sent: 0,
          problem:
            refused === "kind"
              ? t.files.notAccepted(one.name)
              : refused === "size"
                ? t.files.tooLarge(one.name, fileSize(limits?.maxBytes ?? 0))
                : undefined,
        },
      ]);
      if (refused) continue;
      uploadFile(
        one,
        (sent) => settle({ sent }),
        (stop) => stops.current.set(key, stop),
      ).then(
        (stored) => {
          stops.current.delete(key);
          settle({ file: stored });
        },
        (failure) => {
          stops.current.delete(key);
          const { t, errorText } = words.current;
          const code = failure instanceof ApiError ? failure.code : "";
          if (code === "cancelled") return;
          settle({
            problem:
              code === "unsupported_file" ? t.files.notAccepted(one.name) : errorText(failure),
          });
        },
      );
    }
  }, []);
  const fail = useCallback((failure: unknown) => {
    const key = `a${++count.current}`;
    setItems((now) => [
      ...now,
      { key, name: "", sent: 0, problem: words.current.errorText(failure) },
    ]);
  }, []);
  const remove = useCallback((key: string) => {
    // Taking away a file that is still on its way stops it, so it does not land in the person's files.
    stops.current.get(key)?.();
    stops.current.delete(key);
    setItems((now) => now.filter((item) => item.key !== key));
  }, []);
  const clear = useCallback(() => setItems([]), []);
  return {
    items,
    add,
    fail,
    remove,
    clear,
    /** Files that are uploaded and will go with the message. */
    ready: items.flatMap((item) => (item.file ? [item.file] : [])),
    /** Whether something is still uploading. */
    busy: items.some((item) => !item.file && !item.problem),
  };
}
export type Attachments = ReturnType<typeof useAttachments>;

/** What is about to be sent along: uploaded files as chips, uploads in progress, and anything refused with its reason. */
export function AttachmentTray({ attach }: { attach: Attachments }) {
  const { t } = useI18n();
  const c = useColors();
  if (attach.items.length === 0) return null;
  return (
    <View style={styles.tray}>
      {attach.items.map((item) =>
        item.file ? (
          <FileChip key={item.key} file={item.file} onRemove={() => attach.remove(item.key)} />
        ) : (
          <View
            key={item.key}
            accessibilityRole={item.problem ? "alert" : undefined}
            style={[
              styles.chip,
              { borderColor: item.problem ? c.bad : c.border, backgroundColor: c.card },
            ]}
          >
            <Text
              style={{
                flexShrink: 1,
                fontSize: 12,
                lineHeight: 16,
                color: item.problem ? c.bad : c.muted,
              }}
            >
              {item.problem ?? t.files.uploading(item.name, Math.round(item.sent * 100))}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.files.remove(item.name)}
              hitSlop={10}
              onPress={() => attach.remove(item.key)}
            >
              <Ionicons name="close" size={14} color={item.problem ? c.bad : c.muted} />
            </Pressable>
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    maxWidth: "100%",
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipMain: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 5 },
  chipName: { flexShrink: 1, fontSize: 12, fontWeight: "500" },
  spinner: { transform: [{ scale: 0.65 }], width: 14, height: 14 },
  tray: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
