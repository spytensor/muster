/**
 * The one way out of a run, and who it lets through.
 *
 * A run has no network of its own: `--network none`, as before. Inside it, a small
 * program listens on the run's own loopback and passes every connection made to it down
 * the run's standard output (wire.ts), to here. Here each is read as what a proxy is
 * asked: `CONNECT name:443`. It is let through only if
 *
 *   - the name is on the list this run was given (the package indexes, and what an
 *     administrator added), and is a name, not an address;
 *   - the port is 443;
 *   - every address the name has is a public one (no loopback, no private range, no
 *     link-local or metadata address, nothing of this machine's networks), and the
 *     connection is then made to the address that was looked at, not to the name again,
 *     so a name that answers differently a moment later gains nothing;
 *   - the first thing sent through it is a TLS greeting that names the same host. A
 *     connection opened to an allowed name and then used to reach another site that
 *     shares its address is ended there.
 *
 * Everything else is answered 403 and counted. Nothing is decrypted: what is said inside
 * an allowed connection is between the code and that host. So an allowed host is a place
 * data can be sent to, which is why the list is the administrator's and why what a run
 * may send up is small.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";

/** What a run reaches when nobody has said otherwise: where Python and Node packages come from. */
export const DEFAULT_HOSTS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"];

export interface EgressLimits {
  /** Connections open at once, and in all, in one run. */
  atOnce: number;
  inAll: number;
  /** Bytes a run may send out, and take in, over all its connections. */
  up: number;
  down: number;
  /** How long a connection may take to be made, and to stay silent. */
  connectMs: number;
  idleMs: number;
}
export const EGRESS: EgressLimits = {
  atOnce: 16,
  inAll: 500,
  up: 32 * 1024 * 1024,
  down: 1024 * 1024 * 1024,
  connectMs: 15_000,
  idleMs: 120_000,
};

/** What a run reached or was refused, by host. */
export interface Reached {
  host: string;
  ok: boolean;
  /** Why not, in a few words. */
  why?: string;
  times: number;
  up: number;
  down: number;
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export type Connect = (address: string, port: number) => Duplex;

const NAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A host as a list may hold it: a name in small letters, or `*.` and a name for every
 * host under it. Null for anything else: an address, a port, a path, a single label.
 */
export function hostEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/\.$/, "");
  const name = text.startsWith("*.") ? text.slice(2) : text;
  if (!NAME.test(name) || isIP(name) || /^\d+$/.test(name.split(".").at(-1) as string)) return null;
  return text.startsWith("*.") ? `*.${name}` : name;
}

/** The list as it will be gone by: what is not a host is left out, no host twice, fifty at most. */
export function hostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((one) => hostEntry(one) ?? []))].slice(0, 50);
}

const onList = (host: string, list: readonly string[]) =>
  list.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );

/** This machine's own addresses, on whatever network: looked at when asked, they can change. */
const own = (): Set<string> =>
  new Set(
    Object.values(networkInterfaces())
      .flat()
      .flatMap((one) => (one ? [one.address.toLowerCase().split("%")[0] as string] : [])),
  );

/**
 * Whether an address is one out on the internet: not this machine, not a network of its
 * own, and not an IPv4 address written as an IPv6 one, whose real destination would be
 * judged by nobody. For IPv6 only what is handed out to the world (2000::/3) passes, less
 * the parts of it set aside for tunnels, examples and tests.
 */
export function isPublic(address: string, mine: ReadonlySet<string> = own()): boolean {
  const kind = isIP(address);
  if (mine.has(address.toLowerCase().split("%")[0] as string)) return false;
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this host, private, loopback, to many, kept back
    if (a === 100 && b >= 64 && b <= 127) return false; // shared by a carrier
    if (a === 169 && b === 254) return false; // one link's; where metadata is served
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol use; examples
    if (a === 192 && b === 88 && c === 99) return false; // 6to4 relays
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // examples
    if (a === 203 && b === 0 && c === 113) return false; // examples
    return true;
  }
  if (kind === 6) {
    let text = address.toLowerCase().split("%")[0] as string;
    // An IPv4 address at the end, written with dots, is two groups like any other.
    const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (dotted) {
      const [w, x, y, z] = dotted.slice(2).map(Number) as [number, number, number, number];
      if ([w, x, y, z].some((part) => part > 255)) return false;
      text = `${dotted[1]}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
    }
    // Written out in full, so that a short way of writing an address hides nothing.
    if (text.split("::").length > 2) return false;
    const [head, tail = ""] = text.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = text.includes("::")
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
      : left;
    if (groups.length !== 8) return false;
    const words = groups.map((group) =>
      /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1,
    );
    if (words.some((word) => word < 0)) return false;
    const [first, second, third] = words as [number, number, number];
    // Only what is handed out to the world. This leaves out, among the rest: :: and ::1,
    // IPv4 addresses written as IPv6 ones (::a.b.c.d, ::ffff:a.b.c.d, 64:ff9b::/96 and
    // 64:ff9b:1::/48), a network's own (fc00::/7), one link's (fe80::/10), to many (ff00::/8).
    if ((first & 0xe000) !== 0x2000) return false;
    if (first === 0x2001 && second === 0) return false; // 2001::/32, Teredo: an IPv4 address inside
    if (first === 0x2001 && second === 2 && third === 0) return false; // 2001:2::/48, benchmarking
    if (first === 0x2001 && second >= 0x10 && second <= 0x2f) return false; // 2001:10::/28 and 2001:20::/28, not addresses of hosts
    if (first === 0x2001 && second === 0xdb8) return false; // 2001:db8::/32, examples
    if (first === 0x2002) return false; // 2002::/16, 6to4: an IPv4 address inside
    if (first === 0x3fff && second <= 0xfff) return false; // 3fff::/20, examples
    return true;
  }
  return false;
}

/**
 * The host a TLS greeting names, from the first bytes of a connection. `null` while
 * there are too few bytes to tell, `false` when it is not a greeting that names one.
 */
export function greetingHost(bytes: Uint8Array): string | null | false {
  if (bytes.length < 5) return null;
  if (bytes[0] !== 0x16 || bytes[1] !== 0x03) return false;
  const length = ((bytes[3] as number) << 8) | (bytes[4] as number);
  if (length > 16_384 + 256) return false;
  if (bytes.length < 5 + length) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset + 5, length);
  try {
    if (view[0] !== 0x01) return false;
    const hello = view.readUIntBE(1, 3);
    if (hello + 4 > view.length) return false; // a greeting in more than one piece is not waited for
    let at = 4 + 2 + 32;
    at += 1 + view.readUInt8(at);
    at += 2 + view.readUInt16BE(at);
    at += 1 + view.readUInt8(at);
    const end = at + 2 + view.readUInt16BE(at);
    at += 2;
    while (at + 4 <= end) {
      const type = view.readUInt16BE(at);
      const size = view.readUInt16BE(at + 2);
      at += 4;
      if (type === 0) {
        if (view.readUInt8(at + 2) !== 0) return false;
        const named = view.readUInt16BE(at + 3);
        return view
          .subarray(at + 5, at + 5 + named)
          .toString("latin1")
          .toLowerCase();
      }
      at += size;
    }
  } catch {}
  return false;
}

const refusal = (why: string) =>
  Buffer.from(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nMuster: ${why}\n`,
  );

/** One connection a run asked for, from this side. */
export interface Tunnel {
  /** Bytes the run sent. */
  data(bytes: Uint8Array): void;
  /** The run closed it, or the run is over. */
  end(): void;
}

export class Egress {
  private readonly hosts: string[];
  private readonly limits: EgressLimits;
  private readonly lookup: Lookup;
  private readonly connect: Connect;
  private readonly seen = new Map<string, Reached>();
  private readonly open = new Set<() => void>();
  private made = 0;
  /** Connections being made or open now. */
  private active = 0;
  private up = 0;
  private down = 0;

  constructor(options: {
    hosts: readonly string[];
    lookup?: Lookup;
    connect?: Connect;
    limits?: Partial<EgressLimits>;
  }) {
    this.hosts = hostList(options.hosts);
    this.limits = { ...EGRESS, ...options.limits };
    this.lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
    this.connect =
      options.connect ??
      ((address, port) => netConnect({ host: address, port, family: isIP(address) }));
  }

  /** Whether a run given this list reaches anything at all. */
  get any(): boolean {
    return this.hosts.length > 0;
  }

  /** What was reached and what was refused, the refused first, forty hosts at most. */
  reached(): Reached[] {
    return [...this.seen.values()].sort((a, b) => Number(a.ok) - Number(b.ok)).slice(0, 40);
  }

  private note(host: string, ok: boolean, why?: string): Reached {
    // A line for each host and each reason: two different refusals of one host are two things to know.
    const key = `${ok ? "+" : "-"}${host}|${why ?? ""}`;
    let one = this.seen.get(key);
    if (!one) {
      one = { host: host.slice(0, 120), ok, ...(why ? { why } : {}), times: 0, up: 0, down: 0 };
      // A run that asks for a thousand names is not given a thousand lines.
      if (this.seen.size < 200) this.seen.set(key, one);
    }
    one.times += 1;
    return one;
  }

  /** Ends every connection: the run is over. */
  end(): void {
    for (const close of [...this.open]) close();
  }

  /**
   * A connection the run opened. `send` hands bytes back to the run and is waited for,
   * so that a fast host does not fill this process with what a slow run has not read;
   * `close` tells the run the connection is over. `took` is told how many of the run's
   * bytes have been passed on (to the host, once it has taken them) or used up here (the
   * asking, the greeting): the run is let send that many more (wire.ts, `WINDOW`).
   */
  tunnel(
    send: (bytes: Uint8Array) => Promise<void>,
    close: () => void,
    took: (count: number) => void = () => {},
  ): Tunnel {
    let state: "asking" | "refused" | "connecting" | "greeting" | "open" | "over" = "asking";
    /** Whether this one counts among those being made or open: one asked for and refused does not. */
    let counted = false;
    let held: Buffer = Buffer.alloc(0);
    let upstream: Duplex | null = null;
    let line: Reached | null = null;
    let host = "";
    let timer: NodeJS.Timeout | null = null;
    const over = () => {
      if (state === "over") return;
      state = "over";
      if (timer) clearTimeout(timer);
      this.open.delete(over);
      if (counted) this.active -= 1;
      upstream?.destroy();
      close();
    };
    const refuse = (name: string, why: string) => {
      // Refused is the end of it: nothing more that arrives on it is read as another asking.
      if (state === "refused" || state === "over") return;
      state = "refused";
      held = Buffer.alloc(0);
      this.note(name || "(no host)", false, why);
      void send(refusal(why))
        .catch(() => {})
        .finally(over);
    };
    const quiet = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(over, this.limits.idleMs);
      timer.unref?.();
    };
    const up = (bytes: Buffer, tell = true) => {
      this.up += bytes.length;
      if (line) line.up += bytes.length;
      if (this.up > this.limits.up) {
        // Said once, on the host's line, and the connection ends: no more goes out.
        if (line && !line.why) line.why = "more was sent out than a run may send";
        return over();
      }
      // Told once the host has taken them: a host that takes slowly is sent slowly.
      upstream?.write(bytes, () => {
        if (tell && state !== "over") took(bytes.length);
      });
      quiet();
    };
    const begin = async () => {
      const head = held.subarray(0, held.indexOf("\r\n\r\n")).toString("latin1");
      const rest = held.subarray(held.indexOf("\r\n\r\n") + 4);
      held = Buffer.from(rest);
      const asked = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/i.exec(
        head.split("\r\n")[0] ?? "",
      );
      if (!asked) {
        const plain = /^[A-Z]+ http:\/\/([^/\s:]+)/i.exec(head.split("\r\n")[0] ?? "");
        return refuse(plain?.[1]?.toLowerCase() ?? "", "only https is passed on");
      }
      host = hostEntry(asked[1]) ?? "";
      if (!host || host.startsWith("*."))
        return refuse(String(asked[1]).toLowerCase(), "an address is not passed on, only a name");
      if (!onList(host, this.hosts))
        return refuse(host, "this host is not on the organization's list");
      if (asked[2] !== "443") return refuse(host, "only port 443 is passed on");
      if (this.made >= this.limits.inAll) return refuse(host, "too many connections in one run");
      if (this.active >= this.limits.atOnce) return refuse(host, "too many connections at once");
      this.made += 1;
      this.active += 1;
      counted = true;
      state = "connecting";
      let addresses: { address: string; family: number }[];
      try {
        addresses = await this.lookup(host);
      } catch {
        return refuse(host, "the name could not be looked up");
      }
      if (state !== "connecting") return;
      if (!addresses.length) return refuse(host, "the name has no address");
      // One private address among them is enough: a name that points inward is not followed at all.
      const mine = own();
      if (addresses.some((one) => !isPublic(one.address, mine)))
        return refuse(host, "the name leads to a private address");
      const target =
        addresses.find((one) => one.family === 4) ?? (addresses[0] as { address: string });
      const socket = this.connect(target.address, 443);
      upstream = socket;
      const late = setTimeout(() => {
        if (state === "connecting") refuse(host, "the host did not answer");
      }, this.limits.connectMs);
      late.unref?.();
      socket.once("error", () => {
        clearTimeout(late);
        if (state === "connecting") refuse(host, "the host could not be reached");
        else over();
      });
      socket.once("close", () => {
        clearTimeout(late);
        over();
      });
      socket.once("connect", () => {
        clearTimeout(late);
        if (state !== "connecting") return socket.destroy();
        state = "greeting";
        quiet();
        void send(Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n")).catch(over);
        if (held.length) greet();
      });
      socket.on("data", (chunk: Buffer) => {
        this.down += chunk.length;
        if (line) line.down += chunk.length;
        if (this.down > this.limits.down) {
          if (line && !line.why) line.why = "more came in than a run may take";
          return over();
        }
        quiet();
        socket.pause();
        send(chunk).then(
          () => {
            if (state !== "over") socket.resume();
          },
          () => over(),
        );
      });
    };
    const greet = () => {
      const named = greetingHost(held);
      if (named === null) {
        if (held.length > 20_000) refuse(host, "what was sent is not a TLS greeting");
        return;
      }
      if (named !== host) {
        upstream?.destroy();
        upstream = null;
        // The run was already told 200: there is nothing left to say but the end.
        this.note(host, false, "the connection was used for another host than the one asked for");
        return over();
      }
      line = this.note(host, true);
      state = "open";
      const first = held;
      held = Buffer.alloc(0);
      // Already answered for when it arrived.
      up(first, false);
    };

    this.open.add(over);
    quiet();
    return {
      data: (bytes) => {
        if (state === "over") return;
        if (state === "open") return up(Buffer.from(bytes));
        // What is read here and not passed on as it comes is used up at once.
        took(bytes.length);
        held = Buffer.concat([held, bytes]);
        if (state === "asking") {
          if (held.indexOf("\r\n\r\n") >= 0) void begin().catch(() => over());
          else if (held.length > 8192) refuse("", "what was asked could not be read");
        } else if (state === "greeting") greet();
        else if (state === "refused") held = Buffer.alloc(0);
        else if (held.length > 20_000) over();
      },
      end: over,
    };
  }
}
