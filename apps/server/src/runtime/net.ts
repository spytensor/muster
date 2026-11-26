import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Network access for agents. An agent may reach public web addresses only: never this
 * machine, the private network it sits in, or a cloud metadata service. The address is
 * checked when the connection is made, not just when the name is first resolved, so a
 * name that resolves to a public address once and a private one later gains nothing.
 */

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const PORTS = new Set(["", "80", "443", "8080", "8443"]);

export class NetError extends Error {}

function ipv4Public(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** Whether an IP address is one on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Public(ip);
  if (kind !== 6) return false;
  const lower = ip.toLowerCase();
  // IPv4 carried inside IPv6, in dotted or hex form.
  const dotted = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return ipv4Public(dotted);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1] ?? "0", 16);
    const lo = Number.parseInt(hex[2] ?? "0", 16);
    return ipv4Public(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower === "::" || lower === "::1") return false;
  // Forms that carry an IPv4 address in other ways (IPv4-compatible, 6to4) are refused
  // outright: nothing public needs them, and each is a way to name a private address.
  if (/^::[0-9a-f]/.test(lower) || lower.startsWith("2002:")) return false;
  if (/^f[cd]/.test(lower)) return false; // unique local
  if (/^fe[89ab]/.test(lower)) return false; // link-local
  if (lower.startsWith("ff")) return false; // multicast
  if (lower.startsWith("64:ff9b:")) return false; // NAT64 can reach private IPv4
  return true;
}

// Every connection resolves through here, so the check applies to the address actually used.
const guarded = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "", 0);
        const list = addresses as { address: string; family: number }[];
        if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
          return callback(new NetError(`${hostname} is not a public address`), "", 0);
        }
        // biome-ignore lint/suspicious/noExplicitAny: the callback's type differs between the single and "all" forms
        (callback as any)(
          null,
          (options as { all?: boolean }).all ? list : list[0]?.address,
          list[0]?.family,
        );
      });
    },
  },
});

/** Checks an address before any request is made. Returns the parsed URL or throws a NetError saying why not. */
export function checkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetError("That is not a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new NetError("Only http and https addresses can be reached.");
  if (url.username || url.password)
    throw new NetError("Addresses with a username or password are not allowed.");
  if (!PORTS.has(url.port)) throw new NetError(`Port ${url.port} is not allowed.`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new NetError(`${host} is not a public address.`);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new NetError(`${host} is not a public address.`);
  }
  return url;
}

export interface NetResponse {
  status: number;
  contentType: string;
  /** The body as text, cut off at one megabyte. */
  text: string;
  truncated: boolean;
  /** The address finally reached, after redirects. */
  url: string;
  /** What the answer was headed with, names in lower case. A stand-in may leave it out. */
  headers?: Record<string, string>;
}

export interface Net {
  request(
    url: string,
    init?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /** Headers of the caller's own, such as a connector's credential. */
      headers?: Record<string, string>;
      /** Do not follow any redirect: what is sent is for the address asked and no other. */
      noRedirect?: boolean;
      body?: string;
      contentType?: string;
      signal?: AbortSignal;
      /** Do not follow a redirect that leaves the site first asked for. */
      sameSite?: boolean;
      /**
       * The only sites that may be reached, each hop of the way: a host named here, or one
       * under it. For an agent its organization holds to a list (toolPolicy.ts).
       */
      onlyHosts?: readonly string[];
      /** How long to wait for the whole answer, for a caller that knows it may be slow. A minute at most. */
      timeoutMs?: number;
    },
  ): Promise<NetResponse>;
}

/** Whether an address is on a list of sites: one of the hosts, or under one of them. */
export const onHosts = (hosts: readonly string[], address: string): boolean => {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return hosts.some((one) => host === one || host.endsWith(`.${one}`));
  } catch {
    return false;
  }
};

/** The real network, guarded. Redirects are followed by hand so every hop is checked. */
export const publicNet: Net = {
  async request(address, init = {}) {
    let url = checkUrl(address);
    let method = init.method ?? "GET";
    let body = init.body;
    const wait = Math.min(Math.max(init.timeoutMs ?? TIMEOUT_MS, 1_000), 60_000);
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(wait)])
      : AbortSignal.timeout(wait);
    for (let hop = 0; ; hop++) {
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(url, {
          method,
          body,
          signal,
          redirect: "manual",
          dispatcher: guarded,
          headers: {
            "user-agent": "Muster-Agent/1",
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            ...(body !== undefined
              ? { "content-type": init.contentType ?? "application/json" }
              : {}),
            ...init.headers,
          },
        });
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        if (cause instanceof NetError) throw cause;
        throw new NetError(
          signal.aborted
            ? "The address took too long to answer."
            : "The address could not be reached.",
        );
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (init.noRedirect)
          throw new NetError("The address redirected elsewhere; nothing was sent there.");
        if (hop >= MAX_REDIRECTS) throw new NetError("The address redirected too many times.");
        // A redirect is followed as a plain read, and never carries what was being sent.
        if (method !== "GET")
          throw new NetError("The address redirected; nothing was sent to the new address.");
        const next = checkUrl(new URL(location, url).toString());
        // A site the person allowed is that site only: a link on it that forwards elsewhere
        // would carry whatever the agent put in the address to a place nobody allowed.
        if (init.sameSite && new URL(next).origin !== new URL(url).origin)
          throw new NetError("The page forwards to another site, which was not allowed.");
        if (init.onlyHosts && !onHosts(init.onlyHosts, String(next)))
          throw new NetError(
            "The page forwards to a site the organization does not let this agent reach.",
          );
        url = next;
        method = "GET";
        body = undefined;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (size + chunk.length > MAX_BYTES) {
            chunks.push(chunk.subarray(0, MAX_BYTES - size));
            truncated = true;
            break;
          }
          chunks.push(chunk);
          size += chunk.length;
        }
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        text: new TextDecoder().decode(Buffer.concat(chunks)),
        truncated,
        url: url.toString(),
        headers: Object.fromEntries(response.headers),
      };
    }
  },
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The readable text of an HTML page: no scripts, styles or tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 32);
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)) || 32);
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n\s*/g, "\n")
    .trim();
}

/** Fetches a file that is not text, whole, from a public address: a repository's archive. */
export type Download = (
  url: string,
  init: { headers?: Record<string, string>; maxBytes: number; signal?: AbortSignal },
) => Promise<Uint8Array>;

/**
 * The real one, guarded like every other request. A code host answers a request for an
 * archive by sending the asker on to where archives are served: that is followed, but
 * what was sent to the first address (a key) is not sent to another site.
 */
export const publicDownload: Download = async (address, init) => {
  let url = checkUrl(address);
  if (url.protocol !== "https:") throw new NetError("Only an https address is fetched from.");
  const first = url.origin;
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  for (let hop = 0; ; hop++) {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        signal,
        redirect: "manual",
        dispatcher: guarded,
        headers: {
          "user-agent": "Muster-Agent/1",
          ...(url.origin === first ? init.headers : {}),
        },
      });
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (cause instanceof NetError) throw cause;
      throw new NetError(
        signal.aborted
          ? "The address took too long to answer."
          : "The address could not be reached.",
      );
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new NetError("The address redirected too many times.");
      url = checkUrl(new URL(location, url).toString());
      if (url.protocol !== "https:") throw new NetError("Only an https address is fetched from.");
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NetError(`The address answered ${response.status}.`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of (response.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > init.maxBytes) throw new NetError("What the address sent is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
};
