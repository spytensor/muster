import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A server address in the one form this app uses: scheme, host and port, nothing after. */
export function cleanServer(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // Plain http is only for a server on this machine.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The server this build of the app is for, written in `server.json` beside the code. An
 * organisation's build opens on its own sign-in page: nobody is asked for an address
 * they were never given. Null when the file is missing or holds no good address, and the
 * first-run page asks, as before.
 */
export function builtInServer(file = join(__dirname, "..", "server.json")): string | null {
  try {
    const { server } = JSON.parse(readFileSync(file, "utf8")) as { server?: unknown };
    return typeof server === "string" ? cleanServer(server) : null;
  } catch {
    return null;
  }
}

/** Where the app asks whether there is a newer build of itself: see the server's desktop.ts. */
export function feedUrl(server: string, platform: string, arch: string, version: string): string {
  const query = new URLSearchParams({ platform, arch, version });
  return `${server.replace(/\/$/, "")}/desktop/update?${query}`;
}
