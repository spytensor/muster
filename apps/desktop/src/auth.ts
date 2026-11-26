import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The secret this app keeps and the value derived from it that the server is shown first. */
export function newChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muster</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f4f5;color:#18181b}
main{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:32px;max-width:340px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#71717a}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#27272a}p{color:#a1a1aa}}</style>
<main><h1>${title}</h1><p>${text}</p></main>`;

export interface Waiting {
  /** Where the server must send the browser back to. */
  redirect: string;
  /** The one-time code, once the person has signed in and agreed; null if they did not in time. */
  code: Promise<string | null>;
  cancel(): void;
}

/**
 * Listens on this machine only, for the browser coming back from sign-in.
 * It answers one request that carries a code, then stops.
 */
export function waitForCode(timeoutMs = 10 * 60_000): Promise<Waiting> {
  return new Promise((ready, failed) => {
    let finish: (code: string | null) => void = () => undefined;
    const code = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const got = url.searchParams.get("code");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (url.pathname !== "/callback" || !got) {
        response.statusCode = 404;
        response.end(page("Nothing here", "This address only finishes a Muster sign-in."));
        return;
      }
      response.end(page("You are signed in", "You can close this tab and return to Muster."));
      done(got);
    });
    const timer = setTimeout(() => done(null), timeoutMs);
    const done = (value: string | null) => {
      clearTimeout(timer);
      server.close();
      finish(value);
    };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ready({ redirect: `http://127.0.0.1:${port}/callback`, code, cancel: () => done(null) });
    });
  });
}

const SYSTEMS: Record<string, string> = { darwin: "Mac OS X", win32: "Windows", linux: "Linux" };
const APP_AGENT = `Muster/1 (${SYSTEMS[process.platform] ?? process.platform})`;

/** Trades the one-time code for a session token. Only the app holding the verifier can. */
export async function redeem(
  server: string,
  code: string,
  verifier: string,
): Promise<string | null> {
  const response = await fetch(`${server}/auth/app/token`, {
    method: "POST",
    // Named, so the person's list of where they are signed in says which app and system this is.
    headers: { "content-type": "application/json", "user-agent": APP_AGENT },
    body: JSON.stringify({ code, verifier }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { token?: unknown };
  return typeof body.token === "string" ? body.token : null;
}
