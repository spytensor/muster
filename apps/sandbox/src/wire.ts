/**
 * What passes between this service and a run, while it runs.
 *
 * A run still has no network and no mount: its standard input and output are the only
 * way in or out. They used to carry one thing each (the files in, the files out). Now
 * each carries small pieces, one after another, so that three things can share them:
 * the files, what the code prints as it prints it, and the connections it asks to have
 * made for it (egress.ts). A piece is a letter saying what it is, the number of the
 * connection it belongs to (0 for the rest), its length and its bytes.
 *
 *   to the run       I  files, a part        J  the files are all there
 *                    D  bytes for a connection        X  a connection is over
 *                    W  so many more bytes of a connection may be sent
 *   from the run     O  printed (stdout)     E  printed (stderr)
 *                    C  a connection is wanted        D  bytes of one        X  one is over
 *                    W  so many more bytes of a connection may be sent
 *                    R  the result, a part   Z  the result is all there, nothing follows
 *
 * A connection's bytes go no faster than they are taken. Each side may send `WINDOW`
 * bytes of a connection and then waits to be told (W, four bytes: how many more) that
 * the other has passed them on: to the host, or to the code that reads them. So code
 * that reads slowly slows the host it reads from, instead of having what it has not
 * read yet kept for it until there is too much and the connection is cut (MUS-53).
 *
 * What comes from a run was written beside code nobody here has read: a letter that is
 * not one of these, a piece longer than a piece may be, or anything after the end ends
 * the reading with an error. Nothing is guessed at.
 */
const MAGIC = [77, 83, 88, 49]; // "MSX1"
/** The most one piece carries. */
export const PIECE = 64 * 1024;
/** How many bytes of one connection either side may send before it is told to go on. */
export const WINDOW = 512 * 1024;

export type ToRun = "I" | "J" | "D" | "X" | "W";
export type FromRun = "O" | "E" | "C" | "D" | "X" | "W" | "R" | "Z";
const FROM_RUN = new Set(["O", "E", "C", "D", "X", "W", "R", "Z"]);

/** The piece that says so many more bytes of a connection may be sent. */
export function go(id: number, count: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, Math.max(0, Math.min(0xffffffff, Math.floor(count))));
  return piece("W", id, bytes);
}
/** How many bytes a W piece says. */
export function gone(bytes: Uint8Array): number {
  if (bytes.length !== 4) throw new BadWire("a piece of no known kind");
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
}

export class BadWire extends Error {}

/** The four letters either side begins with. */
export const hello = (): Uint8Array => Uint8Array.from(MAGIC);

/** One piece, as it is written. */
export function piece(kind: string, id: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  if (bytes.length > PIECE) throw new BadWire("a piece is too long");
  const out = new Uint8Array(9 + bytes.length);
  const view = new DataView(out.buffer);
  out[0] = kind.charCodeAt(0);
  view.setUint32(1, id);
  view.setUint32(5, bytes.length);
  out.set(bytes, 9);
  return out;
}

/** Bytes of any length as pieces of one kind. */
export function* pieces(kind: string, id: number, bytes: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += PIECE)
    yield piece(kind, id, bytes.subarray(at, Math.min(bytes.length, at + PIECE)));
}

/**
 * Reads what a run writes, as it arrives in whatever lumps it arrives in. Each whole
 * piece is handed on once; what is left of a lump waits for the rest.
 */
export class Reader {
  private held: Buffer = Buffer.alloc(0);
  private begun = false;
  private over = false;

  constructor(private readonly on: (kind: FromRun, id: number, bytes: Uint8Array) => void) {}

  /** Whether the end has been read. */
  get ended(): boolean {
    return this.over;
  }

  push(chunk: Uint8Array): void {
    if (this.over) {
      if (chunk.length) throw new BadWire("there is something after the end");
      return;
    }
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : Buffer.from(chunk);
    if (!this.begun) {
      if (this.held.length < 4) return;
      if (MAGIC.some((byte, i) => this.held[i] !== byte)) throw new BadWire("not a run's answer");
      this.held = this.held.subarray(4);
      this.begun = true;
    }
    for (;;) {
      if (this.held.length < 9) return;
      const kind = String.fromCharCode(this.held[0] as number);
      const id = this.held.readUInt32BE(1);
      const length = this.held.readUInt32BE(5);
      if (!FROM_RUN.has(kind)) throw new BadWire("a piece of no known kind");
      if (length > PIECE) throw new BadWire("a piece is too long");
      if (this.held.length < 9 + length) return;
      const bytes = this.held.subarray(9, 9 + length);
      this.held = this.held.subarray(9 + length);
      if (kind === "Z") {
        this.over = true;
        if (this.held.length) throw new BadWire("there is something after the end");
        this.on("Z", id, bytes);
        return;
      }
      this.on(kind as FromRun, id, bytes);
    }
  }
}
