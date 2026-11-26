import type { FileItem } from "@/app/api";
import { ApiError } from "./api";

export const fileUrl = (id: string) => `/api/app/files/${id}/content`;

/** A file larger than this is not read first: the server refuses it by its size alone. */
const READ_FIRST_BYTES = 64 * 1024 * 1024;

/**
 * Sends one file to the person's files. The body is the file itself; its name travels in
 * the address.
 *
 * The file is read before anything is sent. A file the computer cannot read (one kept in
 * iCloud whose content is not on this disk, a folder dropped in, a file since moved)
 * failed inside the request, and the page said "Cannot reach the server" of a server that
 * was never asked (the owner, 2026-11-22, with a 307 KB file from an iCloud Desktop).
 * Now that is said for what it is: `file_not_readable`, a code of this page's own (the
 * server's `unreadable_file` is about a kept file that cannot be shown).
 *
 * It is sent once. Sent again after a dropped connection, a file whose first sending had
 * arrived would be kept twice.
 */
export async function uploadFile(file: File): Promise<FileItem> {
  let body: ArrayBuffer | File = file;
  if (file.size <= READ_FIRST_BYTES)
    try {
      body = await file.arrayBuffer();
    } catch (problem) {
      // Not readable, or no longer there. Anything else (no memory for it) is not the
      // file's fault: it is sent as it is, and what happens is said as it happens.
      const name = problem instanceof DOMException ? problem.name : "";
      if (name === "NotReadableError" || name === "NotFoundError")
        throw new ApiError(0, "file_not_readable", "file_not_readable");
    }
  let response: Response;
  try {
    response = await fetch(`/api/app/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: body !== file && file.type ? { "content-type": file.type } : undefined,
      body,
    });
  } catch {
    throw new ApiError(0, "network", "network");
  }
  const payload = (await response.json().catch(() => null)) as
    | (FileItem & { error?: { code: string; message: string } })
    | null;
  if (!response.ok || !payload)
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? "",
    );
  return payload;
}

/** Starts a download of one of the person's files. */
export function downloadFile(id: string): void {
  const link = document.createElement("a");
  link.href = `${fileUrl(id)}?download`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
