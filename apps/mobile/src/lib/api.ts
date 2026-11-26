import { fetch as streamingFetch } from "expo/fetch";
import { createEventParser } from "./sse";
import type { LiveEvent } from "./types";

import { zone } from "./followups";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Which server to talk to and as whom. Set by the session; read by every request. */
const connection: { server: string; token: string | null; signedOut?: () => void } = {
  server: "",
  token: null,
};
export function connect(server: string, token: string | null, signedOut?: () => void): void {
  connection.server = server;
  connection.token = token;
  connection.signedOut = signedOut;
}

/** The server in use, for the few places that build an address themselves (uploads, downloads). */
export const serverUrl = () => connection.server;
/** Called when a request made outside `api` (an upload, a download) is refused as signed out. */
export const signedOut = () => connection.signedOut?.();

export const bearer = (): Record<string, string> =>
  connection.token ? { authorization: `Bearer ${connection.token}` } : {};

/** One JSON request to the server. Throws ApiError; a 401 also returns the app to sign-in. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; server?: string; token?: string | null } = {},
): Promise<T> {
  const token = init.token === undefined ? connection.token : init.token;
  let response: Response;
  try {
    response = await fetch(`${init.server ?? connection.server}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        // The person's own clock, so an agent told the time is told theirs.
        "x-muster-timezone": zone(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network", "network");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (response.status === 401 && token && token === connection.token) connection.signedOut?.();
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? "",
    );
  }
  return payload as T;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The server sends a ping every 25 seconds; a stream silent for longer than this is dead. */
const SILENCE_MS = 60_000;

/**
 * Follows a conversation's live events until closed. The stream carries the session token in
 * a header, which the platform's EventSource cannot do, so it is read with a streaming fetch.
 * When the connection drops it is opened again; the server then sends a `state` event with
 * everything so far, so nothing is missed.
 */
export function watchConversation(
  id: string,
  on: { event(event: LiveEvent): void; connected(connected: boolean): void },
): { close(): void; reconnect(): void } {
  let closed = false;
  let controller: AbortController | null = null;
  const run = async () => {
    let wait = 500;
    while (!closed) {
      const current = new AbortController();
      controller = current;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => current.abort(), SILENCE_MS);
      };
      try {
        alive();
        const response = await streamingFetch(
          `${connection.server}/api/app/conversations/${id}/events`,
          { headers: { accept: "text/event-stream", ...bearer() }, signal: current.signal },
        );
        if (response.status === 401) {
          connection.signedOut?.();
          return;
        }
        // The conversation is gone: there is nothing to follow.
        if (response.status === 404) return;
        if (response.ok && response.body) {
          on.connected(true);
          wait = 500;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const parse = createEventParser();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            alive();
            for (const { data } of parse(decoder.decode(value, { stream: true }))) {
              let event: LiveEvent;
              try {
                event = JSON.parse(data) as LiveEvent;
              } catch {
                continue;
              }
              if (!closed) on.event(event);
            }
          }
        }
      } catch {
        // Dropped or aborted: fall through and connect again.
      } finally {
        clearTimeout(watchdog);
      }
      if (closed) return;
      on.connected(false);
      await sleep(wait);
      wait = Math.min(wait * 2, 5000);
    }
  };
  void run();
  return {
    close() {
      closed = true;
      controller?.abort();
    },
    reconnect() {
      controller?.abort();
    },
  };
}
