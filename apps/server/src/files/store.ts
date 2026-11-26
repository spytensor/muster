import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

/**
 * Where the bytes of people's files are kept. The database knows what each file is
 * and whose; this only stores and returns bytes by key. One implementation today
 * (a folder); the shape is what an object store would also offer.
 */
export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The file's bytes as a stream, or null if there is nothing under that key. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

export function diskStore(root: string): FileStore {
  const base = resolve(root);
  // Keys are made by the server from ids, never from a name someone typed; this is the second lock.
  const pathOf = (key: string) => {
    const path = resolve(join(base, key));
    if (!path.startsWith(base + sep)) throw new Error("file key leaves the store");
    return path;
  };
  const exists = async (path: string) =>
    stat(path).then(
      (found) => found.isFile(),
      () => false,
    );
  return {
    async put(key, bytes) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
    },
    async get(key) {
      const path = pathOf(key);
      if (!(await exists(path))) return null;
      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    },
    async read(key) {
      const path = pathOf(key);
      if (!(await exists(path))) return null;
      const { readFile } = await import("node:fs/promises");
      return new Uint8Array(await readFile(path));
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}
