import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { Env } from "./app.js";

/**
 * The desktop app's updates: what the newest build is, and the build itself.
 *
 * The app asks on its own, signed in or not, before a person has done anything, so these
 * two addresses need no session. They give out nothing a person keeps: a version number
 * and the application, which anyone given its address may have.
 *
 * A build is put here by `apps/desktop/scripts/release.mjs`: its archive, and beside it a
 * small file named for the system and processor it is for (`darwin-arm64.json`) that
 * says which version it is and which archive holds it.
 */
export interface DesktopRelease {
  version: string;
  /** The archive's name, in the same folder. */
  file: string;
  notes?: string;
  date?: string;
}

const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ARCHS = new Set(["arm64", "x64"]);
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
/** An archive's name: letters, digits, dots, dashes, and one of the endings a build has. */
const ARCHIVE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(zip|dmg|exe|nupkg)$/;

/** Whether one version is later than another: 0.10.0 is later than 0.9.3. */
export function later(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i++)
    if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) > (y[i] as number);
  return false;
}

/** The newest build kept for a system and processor, or null when there is none that can be given. */
export async function newest(
  dir: string,
  platform: string,
  arch: string,
): Promise<DesktopRelease | null> {
  if (!PLATFORMS.has(platform) || !ARCHS.has(arch)) return null;
  try {
    const said = JSON.parse(
      await readFile(join(dir, `${platform}-${arch}.json`), "utf8"),
    ) as Partial<DesktopRelease>;
    if (typeof said.version !== "string" || !VERSION.test(said.version)) return null;
    if (typeof said.file !== "string" || !ARCHIVE.test(said.file)) return null;
    // A build that is named and not there is not offered: the app would fail to fetch it.
    if (!(await stat(join(dir, said.file))).isFile()) return null;
    return {
      version: said.version,
      file: said.file,
      notes: typeof said.notes === "string" ? said.notes.slice(0, 2000) : undefined,
      date: typeof said.date === "string" ? said.date : undefined,
    };
  } catch {
    return null;
  }
}

export function registerDesktop(app: Hono<Env>, dir: string, publicUrl: string): void {
  const base = resolve(dir);

  // Asked by the app itself (Squirrel on macOS): 204 when it has the newest, else where
  // the newer one is, in the form that asks for.
  app.get("/desktop/update", async (c) => {
    const have = c.req.query("version") ?? "";
    const found = await newest(base, c.req.query("platform") ?? "", c.req.query("arch") ?? "");
    c.header("cache-control", "no-store");
    if (!found || !later(found.version, have)) return c.body(null, 204);
    return c.json({
      url: `${publicUrl.replace(/\/$/, "")}/desktop/releases/${found.file}`,
      name: found.version,
      notes: found.notes ?? "",
      pub_date: found.date ?? new Date().toISOString(),
    });
  });

  app.get("/desktop/releases/:file", async (c) => {
    const name = c.req.param("file");
    const path = resolve(join(base, name));
    // Only an archive by a plain name, in this folder.
    if (!ARCHIVE.test(name) || !path.startsWith(base + sep)) return c.notFound();
    const size = await stat(path).then(
      (found) => (found.isFile() ? found.size : null),
      () => null,
    );
    if (size === null) return c.notFound();
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        // A version's archive never changes.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}
