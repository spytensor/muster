/**
 * A repository as its code host hands it over (a gzipped tar archive), read into the
 * files it holds. Only files: a link, a device or anything else in the archive is passed
 * over and named, never made. An archive is somebody else's bytes, so every name is
 * checked (bundle.ts, `safePath`) and nothing is trusted about its lengths.
 */
import { gunzipSync } from "node:zlib";
import { safePath } from "./bundle.js";

export class BadArchive extends Error {}

export interface Archived {
  name: string;
  bytes: Uint8Array;
  /** Whether the archive marks it as a program to run. */
  runs: boolean;
}
export interface Passed {
  name: string;
  /** Why it was not made: a link, too large, a name a workspace does not take, or not a file. */
  why: "link" | "large" | "name" | "kind";
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const text = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};
const octal = (bytes: Uint8Array): number => {
  // A length written in binary (for something of 8 GB or more) is not one a workspace takes.
  if ((bytes[0] ?? 0) & 0x80) throw new BadArchive("The archive holds something too large.");
  const value = Number.parseInt(text(bytes).trim() || "0", 8);
  if (!Number.isFinite(value) || value < 0) throw new BadArchive("The archive is damaged.");
  return value;
};

/** The "length key=value\n" records of an extended header. */
function records(bytes: Uint8Array): Map<string, string> {
  const found = new Map<string, string>();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    if (space < 0) break;
    const length = Number(decoder.decode(bytes.subarray(at, space)));
    if (!Number.isInteger(length) || length <= 0 || at + length > bytes.length) break;
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) found.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return found;
}

/**
 * The files of an archive. `strip` leading folders are taken off every name (a code host
 * puts the whole repository in one folder named after the commit).
 */
export function untar(
  archive: Uint8Array,
  limits: { bytes: number; fileBytes: number; files: number; strip?: number },
): { files: Archived[]; passed: Passed[] } {
  let tar: Uint8Array;
  try {
    // Never more than a workspace holds, plus the headers: an archive that swells past
    // that is refused while it swells, not after.
    tar = gunzipSync(archive, {
      maxOutputLength: Math.max(0, limits.bytes) + limits.files * 2048 + 1024 * 1024,
    });
  } catch {
    throw new BadArchive(
      "The repository is larger than a workspace holds, or its archive is damaged.",
    );
  }
  const files: Archived[] = [];
  const passed: Passed[] = [];
  const seen = new Set<string>();
  let total = 0;
  let long: string | null = null;
  let extended: Map<string, string> | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const kind = String.fromCharCode(header[156] ?? 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.length < size) throw new BadArchive("The archive ends before its last file does.");
    at += 512 + Math.ceil(size / 512) * 512;
    if (kind === "x") {
      extended = records(body);
      continue;
    }
    if (kind === "g") continue;
    if (kind === "L") {
      long = text(body);
      continue;
    }
    const prefix = text(header.subarray(345, 500));
    const plain = text(header.subarray(0, 100));
    const raw = extended?.get("path") ?? long ?? (prefix ? `${prefix}/${plain}` : plain);
    extended = null;
    long = null;
    const name = raw
      .replace(/\/+$/, "")
      .split("/")
      .slice(limits.strip ?? 0)
      .join("/");
    if (kind === "5" || !name) continue;
    // A name that is not text (its bytes are not UTF-8) cannot be written back as it was:
    // the file is left alone, and named as it could be read.
    if (raw.includes("\ufffd")) {
      passed.push({ name: name.slice(0, 400), why: "name" });
      continue;
    }
    if (kind === "2" || kind === "1") {
      passed.push({ name: name.slice(0, 400), why: "link" });
      continue;
    }
    if (kind !== "0" && kind !== "\0" && kind !== "7") {
      passed.push({ name: name.slice(0, 400), why: "kind" });
      continue;
    }
    if (!safePath(name) || seen.has(name)) {
      passed.push({ name: name.slice(0, 400), why: "name" });
      continue;
    }
    if (size > limits.fileBytes) {
      passed.push({ name, why: "large" });
      continue;
    }
    total += size;
    if (total > limits.bytes || files.length >= limits.files)
      throw new BadArchive("The repository is larger than a workspace holds.");
    seen.add(name);
    files.push({ name, bytes: body, runs: (octal(header.subarray(100, 108)) & 0o111) !== 0 });
  }
  return { files, passed };
}
