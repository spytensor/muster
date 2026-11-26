/**
 * The files of a working folder as one stream, in and out of a sandbox.
 *
 * The stream is this service's own and as plain as it can be: four letters, then for
 * each file the length of its name, the name, the length of its content and the content,
 * then a name of no length, and nothing after it. There is nowhere in it for a link, a
 * device, an owner or a permission to be written, so there is nothing of that kind to
 * refuse. (It was a tar archive for a day; a tar name holds 100 bytes, which a Chinese
 * file name of 34 characters passes.)
 *
 * What comes out of a sandbox was written beside code nobody here has read, so it is
 * still checked whole: a name that climbs out of the folder, the same name twice, a file
 * where another's folder is, a length that runs past the end or anything after the end
 * refuses the lot, not the one entry. A stream that holds one such thing is not one to
 * pick through.
 */
export interface Entry {
  name: string;
  bytes: Uint8Array;
}

export class BadBundle extends Error {}

/** The longest name a file in a working folder may have, folders included, in bytes. */
export const NAME_BYTES = 400;
/** The longest one part of it may be: what a file system takes. */
const PART_BYTES = 255;
/** Folders the sandbox keeps for itself: what to run, and what the run said. */
export const RESERVED = [".run", ".result"];
const MAGIC = [77, 83, 66, 49]; // "MSB1"

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's place in a working folder, or null when it is not one: no way up or out,
 * nothing hidden in a backslash or a control character, and no longer than a file system
 * and this stream take.
 */
export function safePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being refused
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/") || raw.endsWith("/")) return null;
  if (encoder.encode(raw).length > NAME_BYTES) return null;
  const parts = raw.split("/");
  for (const part of parts)
    if (!part || part === "." || part === ".." || encoder.encode(part).length > PART_BYTES)
      return null;
  return raw;
}

/**
 * Files as a stream, piece by piece: a file's content is handed on as it is, never
 * copied into one large block.
 */
export function* frames(entries: Iterable<Entry>): Generator<Uint8Array> {
  yield Uint8Array.from(MAGIC);
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (!safePath(entry.name)) throw new BadBundle(`"${entry.name}" is not a name a file may have`);
    if (entry.bytes.length > 0xffffffff) throw new BadBundle(`"${entry.name}" is too large`);
    const head = new Uint8Array(2 + name.length + 4);
    const view = new DataView(head.buffer);
    view.setUint16(0, name.length);
    head.set(name, 2);
    view.setUint32(2 + name.length, entry.bytes.length);
    yield head;
    if (entry.bytes.length) yield entry.bytes;
  }
  yield new Uint8Array(2);
}

/** The same, as one block: for tests and small streams. */
export function pack(entries: Iterable<Entry>): Uint8Array {
  const parts = [...frames(entries)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The files of a stream, each a view into it (nothing is copied). Anything in it that is
 * not a plain file with a plain name, and the whole stream is refused.
 */
export function unpack(stream: Uint8Array, most = 5000): Entry[] {
  if (stream.length < 6 || MAGIC.some((byte, i) => stream[i] !== byte))
    throw new BadBundle("not a stream of files");
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const entries: Entry[] = [];
  const names = new Set<string>();
  const folders = new Set<string>();
  let at = 4;
  for (;;) {
    if (at + 2 > stream.length) throw new BadBundle("the stream stops short");
    const named = view.getUint16(at);
    at += 2;
    if (named === 0) break;
    if (at + named + 4 > stream.length) throw new BadBundle("the stream stops short");
    let raw: string;
    try {
      raw = decoder.decode(stream.subarray(at, at + named));
    } catch {
      throw new BadBundle("a name is not text");
    }
    at += named;
    const size = view.getUint32(at);
    at += 4;
    if (at + size > stream.length) throw new BadBundle("the stream stops short");
    const name = safePath(raw);
    if (!name) throw new BadBundle(`"${raw.slice(0, 80)}" is not a name a file may have`);
    if (names.has(name)) throw new BadBundle(`"${name}" is there twice`);
    if (entries.length >= most) throw new BadBundle("too many files");
    names.add(name);
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    entries.push({ name, bytes: stream.subarray(at, at + size) });
    at += size;
  }
  if (at !== stream.length) throw new BadBundle("there is something after the end");
  for (const name of names)
    if (folders.has(name)) throw new BadBundle(`"${name}" is both a file and a folder`);
  return entries;
}
