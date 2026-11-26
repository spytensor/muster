import type { FileItem, FileKind, Step } from "./types.ts";

/** A size a person can read: "512 B", "34 KB", "2.1 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The ending of a file name, in lower case and without the dot; empty when it has none. */
export const endingOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * Why a file should not even be sent, or null when it may be: the server refuses the same
 * things, but saying so before the upload spares the person the wait.
 */
export function refusedBefore(
  file: { name: string; size: number | null },
  limits: { maxBytes: number; endings: string[] } | null,
): "kind" | "size" | null {
  if (!limits) return null;
  if (!limits.endings.includes(endingOf(file.name))) return "kind";
  if (file.size !== null && file.size > limits.maxBytes) return "size";
  return null;
}

/**
 * The name a downloaded file is kept under in the app's cache. The server's id keeps two
 * files with one name apart; the rest is the file's own name with anything that could
 * leave the folder, or confuse the system, taken out. The ending is kept: Quick Look
 * decides how to show a file by it.
 */
export function cacheName(id: string, name: string): string {
  const safeId = id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || "file";
  const ending = endingOf(name);
  const stem = (ending ? name.slice(0, -(ending.length + 1)) : name)
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 80);
  return `${safeId}-${stem || "file"}${ending ? `.${ending}` : ""}`;
}

/**
 * How a file opens. A web page is never handed to anything that would run it: its text is
 * shown instead. Everything else the server accepts is something Quick Look shows natively.
 */
export const opensAs = (file: { kind: FileKind; name: string }): "text" | "native" =>
  file.kind === "page" || ["html", "htm"].includes(endingOf(file.name)) ? "text" : "native";

/** Where the bytes of a file are sent to: the body is the file itself, its name travels in the address. */
export const uploadUrl = (server: string, name: string) =>
  `${server}/api/app/files?name=${encodeURIComponent(name)}`;

/**
 * Files an agent made or changed while writing a reply. A step says which file by its id
 * (CHA-269): a file uploaded later under the same name is another file. A reply written
 * before steps said so is matched by name, as it always was.
 */
export function madeFiles(steps: Step[], files: FileItem[]): FileItem[] {
  const seen = new Set<string>();
  return steps.flatMap((step) => {
    if (step.status !== "ok") return [];
    // A run of code may keep several files, and says each by its id.
    if (step.tool === "code.run") {
      const kept = (step.files ?? (step.file ? [step.file] : []))
        .map((id) => files.find((item) => item.id === id))
        .filter((file): file is FileItem => file !== undefined && !seen.has(file.id));
      for (const file of kept) seen.add(file.id);
      return kept;
    }
    if (step.tool !== "files.create" && step.tool !== "files.change") return [];
    const file = step.file
      ? files.find((item) => item.id === step.file)
      : files.find((item) => item.name === step.detail);
    if (!file || seen.has(file.id)) return [];
    seen.add(file.id);
    return [file];
  });
}
