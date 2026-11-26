/** The kinds of file Muster keeps. Anything else is refused at the door. */
export type FileKind =
  | "document"
  | "spreadsheet"
  | "slides"
  | "pdf"
  | "image"
  | "page"
  | "text"
  | "data";

interface Known {
  kind: FileKind;
  mime: string;
  /** What the first bytes must be for a file with this ending. */
  shape: "zip" | "ole" | "pdf" | "png" | "jpeg" | "gif" | "webp" | "text";
}

const OFFICE = "application/vnd.openxmlformats-officedocument";
const BY_ENDING: Record<string, Known> = {
  docx: { kind: "document", mime: `${OFFICE}.wordprocessingml.document`, shape: "zip" },
  xlsx: { kind: "spreadsheet", mime: `${OFFICE}.spreadsheetml.sheet`, shape: "zip" },
  xlsm: {
    kind: "spreadsheet",
    mime: "application/vnd.ms-excel.sheet.macroEnabled.12",
    shape: "zip",
  },
  pptx: { kind: "slides", mime: `${OFFICE}.presentationml.presentation`, shape: "zip" },
  doc: { kind: "document", mime: "application/msword", shape: "ole" },
  xls: { kind: "spreadsheet", mime: "application/vnd.ms-excel", shape: "ole" },
  ppt: { kind: "slides", mime: "application/vnd.ms-powerpoint", shape: "ole" },
  pdf: { kind: "pdf", mime: "application/pdf", shape: "pdf" },
  png: { kind: "image", mime: "image/png", shape: "png" },
  jpg: { kind: "image", mime: "image/jpeg", shape: "jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg", shape: "jpeg" },
  gif: { kind: "image", mime: "image/gif", shape: "gif" },
  webp: { kind: "image", mime: "image/webp", shape: "webp" },
  html: { kind: "page", mime: "text/html", shape: "text" },
  htm: { kind: "page", mime: "text/html", shape: "text" },
  md: { kind: "text", mime: "text/markdown", shape: "text" },
  txt: { kind: "text", mime: "text/plain", shape: "text" },
  csv: { kind: "data", mime: "text/csv", shape: "text" },
  json: { kind: "data", mime: "application/json", shape: "text" },
};
export const FILE_ENDINGS = Object.keys(BY_ENDING);

const starts = (bytes: Uint8Array, ...head: number[]) =>
  head.every((value, index) => bytes[index] === value);

function looksLike(shape: Known["shape"], bytes: Uint8Array): boolean {
  switch (shape) {
    case "zip":
      return starts(bytes, 0x50, 0x4b, 0x03, 0x04);
    case "ole":
      return starts(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "pdf": {
      // Some programs write a few bytes before the marker; readers look for it near the start.
      const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
      return head.includes("%PDF-");
    }
    case "png":
      return starts(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "jpeg":
      return starts(bytes, 0xff, 0xd8, 0xff);
    case "gif":
      return starts(bytes, 0x47, 0x49, 0x46, 0x38);
    case "webp":
      return (
        starts(bytes, 0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case "text":
      // UTF-16 text says so in its first two bytes.
      if (starts(bytes, 0xff, 0xfe) || starts(bytes, 0xfe, 0xff)) return true;
      // Otherwise text has no zero bytes, and reads as UTF-8 or as the encoding Chinese Windows saves in.
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return !new TextDecoder("gb18030").decode(bytes).includes("\ufffd");
      }
  }
}

/**
 * What a file is, judged by its name's ending and by its own first bytes together.
 * A file whose content does not match its name is refused: a program renamed to
 * look like a document is not a document.
 */
/** The folder each newer Office format keeps its content in. */
const OFFICE_PARTS: Record<string, string> = { docx: "word/", xlsx: "xl/", pptx: "ppt/" };

export function identify(name: string, bytes: Uint8Array): { kind: FileKind; mime: string } | null {
  const ending = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const known = BY_ENDING[ending];
  if (!known || bytes.length === 0 || !looksLike(known.shape, bytes)) return null;
  // The newer Office files are all archives; which one it is shows in what the archive
  // holds. A Word file named .xlsx is not a spreadsheet.
  // (An archive with none of them is let in and found damaged when it is read.)
  const own = OFFICE_PARTS[ending];
  if (own) {
    const whole = Buffer.from(bytes);
    const another = Object.values(OFFICE_PARTS).some(
      (part) => part !== own && whole.includes(`${part}`) && whole.includes("[Content_Types].xml"),
    );
    if (another && !whole.includes(own)) return null;
  }
  return { kind: known.kind, mime: known.mime };
}

/**
 * Whether a file is a newer Office file wrapped in protection: a password, or a
 * sensitivity label that encrypts. Those have the older format's first bytes under
 * a newer ending. They cannot be read here, and the person is told that, not that
 * the file is of the wrong kind.
 */
export function isProtected(name: string, bytes: Uint8Array): boolean {
  const ending = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return BY_ENDING[ending]?.shape === "zip" && looksLike("ole", bytes);
}

/** A file name safe to keep and to send back in a header: no path, no control characters, a sane length. */
export function cleanName(raw: string): string | null {
  const name = raw
    .normalize("NFC")
    .replace(/[\\/]/g, "_")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Characters that cannot be seen or that turn the text around: "txt.exe" must not read "exe.txt".
    .replace(/[\u0080-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .trim();
  // A name is more than dots and more than an ending: ".txt" names nothing.
  return name.length >= 1 && name.length <= 200 && !/^\.+$/.test(name) && !/^\.[^.]*$/.test(name)
    ? name
    : null;
}
