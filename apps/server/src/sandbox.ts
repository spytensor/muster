/**
 * Where an agent's code runs: a service beside the server (apps/sandbox) that starts a
 * container for each run, with no network of its own and nothing of the server's in it:
 * what a run reaches, it reaches through that service, which lets through only the hosts
 * named with the run. The server never runs anything itself. It hands files to a workspace, asks for code to be run
 * there and takes back what the run made. A conversation has one workspace, so what one
 * step made is there for the next.
 */
import type { Config } from "./config.js";

export interface SandboxRun {
  exit: number;
  timedOut: boolean;
  seconds: number;
  stdout: string;
  stderr: string;
  cut: number;
  changed: { name: string; size: number }[];
  deleted: string[];
  skipped: string[];
  files: { name: string; size: number }[];
  /**
   * How long it took by the sandbox service's clock, and how many processors it was
   * allowed: what a day's allowance is counted from. (`seconds` is the same clock.)
   */
  wall?: number;
  cpus?: number;
  /** The bytes of files it handed back. */
  bytesOut?: number;
  /** What the run reached and what it was refused, by host. */
  net?: SandboxReached[];
}
export interface SandboxReached {
  host: string;
  ok: boolean;
  why?: string;
  times: number;
  up: number;
  down: number;
}
/** What is asked of a run. */
export interface SandboxAsked {
  language: "python" | "shell";
  code: string;
  seconds?: number;
  /** The hosts this run may reach. None: it reaches nothing. */
  hosts?: string[];
}
export interface SandboxHealth {
  ready: boolean;
  isolation: "gvisor" | "container" | null;
  reason: string;
  running: number;
}
/** The sandbox service as a whole, for the page an administrator reads (apps/sandbox, `Status`). */
export interface SandboxStatus extends SandboxHealth {
  runtime: string | null;
  image: string | null;
  waiting: number;
  slots: number;
  built: string | null;
  spaces: { count: number; bytes: number };
  disk: { free: number; total: number } | null;
  limits: {
    seconds: number;
    maxSeconds: number;
    cpus: number;
    memory: string;
    spaceBytes: number;
    diskBytes: number;
    idleDays: number;
  };
}
/** A run asked for and not over. */
export interface SandboxFlight {
  space: string;
  language: string;
  state: "waiting" | "running";
  asked: number;
  started: number;
  seconds: number;
  printed: number;
  connections: number;
}
/** A workspace as it stands on the sandbox's disk. */
export interface SandboxSpace {
  space: string;
  files: number;
  bytes: number;
  used: number;
  busy: boolean;
}
export interface Sandbox {
  /** Whether code can be run now. Asked often, answered from a moment ago. */
  health(fresh?: boolean): Promise<SandboxHealth>;
  put(space: string, name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(space: string, name: string, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Runs code. `said` is told what it prints while it runs; ending `signal` ends the run
   * (its container is removed).
   */
  run(
    space: string,
    asked: SandboxAsked,
    signal?: AbortSignal,
    said?: (stream: "out" | "err", text: string) => void,
  ): Promise<SandboxRun>;
  forget(space: string): Promise<void>;
  /**
   * A repository in a workspace (codeHost.ts): its archive put into one folder, that
   * folder's files as they stand with git's fingerprint of each, and one file taken out.
   * A stand-in for the sandbox may leave these out; work on a repository is then not offered.
   */
  unpack?(
    space: string,
    folder: string,
    archive: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    files: { name: string; sha: string; size: number; runs: boolean }[];
    passed: { name: string; why: string }[];
  }>;
  tree?(space: string, folder: string): Promise<{ name: string; sha: string; size: number }[]>;
  drop?(space: string, name: string): Promise<void>;
  /**
   * What an administrator sees and does (sandboxAdmin.ts): the service as a whole, every
   * run in flight, every workspace; ending what runs in one (how many were ended), and
   * giving one's room back, which is refused ("in_use") while something runs there.
   * A stand-in may leave these out; the page then says less and nothing is reclaimed.
   */
  status?(): Promise<SandboxStatus | null>;
  running?(): Promise<SandboxFlight[]>;
  spaces?(): Promise<SandboxSpace[]>;
  stop?(space: string): Promise<number>;
  release?(space: string, since?: number): Promise<void>;
}

/** What the sandbox would not do, in words an agent can act on. */
export class SandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** How long the run had gone on when it ended this way, by the sandbox service's clock. Absent for one that never started. */
    readonly wall?: number,
  ) {
    super(message);
  }
}

const DOWN: SandboxHealth = {
  ready: false,
  isolation: null,
  reason: "The sandbox cannot be reached.",
  running: 0,
};

export function createSandbox(config: Pick<Config, "sandbox">): Sandbox | null {
  if (!config.sandbox) return null;
  const base = config.sandbox.url.replace(/\/+$/, "");
  const path = (space: string, name?: string) =>
    `${base}/spaces/${encodeURIComponent(space)}${
      name === undefined ? "" : `/files/${name.split("/").map(encodeURIComponent).join("/")}`
    }`;
  const ask = async (url: string, init: RequestInit, wait: number): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(wait)])
          : AbortSignal.timeout(wait),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new SandboxError("unreachable", "The sandbox did not answer. Try once more.");
    }
    if (response.ok) return response;
    const said = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      wall?: number;
    };
    throw new SandboxError(
      said.error ?? "failed",
      said.message ?? "The sandbox failed.",
      typeof said.wall === "number" ? said.wall : undefined,
    );
  };
  let last: { at: number; health: SandboxHealth } | null = null;
  return {
    async health(fresh = false) {
      if (!fresh && last && Date.now() - last.at < 20_000) return last.health;
      let health = DOWN;
      try {
        health = (await (await ask(`${base}/health`, {}, 3000)).json()) as SandboxHealth;
      } catch {}
      last = { at: Date.now(), health };
      return health;
    },
    async put(space, name, bytes, signal) {
      await ask(path(space, name), { method: "PUT", body: Buffer.from(bytes), signal }, 60_000);
    },
    async get(space, name, signal) {
      return new Uint8Array(await (await ask(path(space, name), { signal }, 60_000)).arrayBuffer());
    },
    async run(space, asked, signal, said) {
      const response = await ask(
        `${path(space)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(said ? { ...asked, live: true } : asked),
          signal,
        },
        // Its turn, its time, and what it takes to hand the files over and back.
        ((asked.seconds ?? 60) + 90) * 1000,
      );
      if (!said || !response.body) return (await response.json()) as SandboxRun;
      // Told as it goes: a line for what was printed, and a last one with how it ended.
      const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let held = "";
      let ran: SandboxRun | null = null;
      const take = (line: string) => {
        if (!line.trim()) return;
        const one = JSON.parse(line) as {
          said?: { stream: "out" | "err"; text: string };
          ran?: SandboxRun;
          error?: string;
          message?: string;
          wall?: number;
        };
        if (one.said) said(one.said.stream === "err" ? "err" : "out", String(one.said.text));
        else if (one.ran) ran = one.ran;
        else if (one.error)
          throw new SandboxError(
            one.error,
            one.message ?? "The sandbox failed.",
            typeof one.wall === "number" ? one.wall : undefined,
          );
      };
      try {
        for (;;) {
          const { done, value } = await lines.read();
          if (done) break;
          held += value;
          for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
            take(held.slice(0, at));
            held = held.slice(at + 1);
          }
        }
        take(held);
      } catch (error) {
        if (error instanceof SandboxError || signal?.aborted) throw error;
        throw new SandboxError("unreachable", "The sandbox stopped answering. Try once more.");
      }
      if (!ran)
        throw new SandboxError("unreachable", "The sandbox stopped answering. Try once more.");
      return ran;
    },
    async forget(space) {
      await ask(path(space), { method: "DELETE" }, 10_000).catch(() => {});
    },
    async unpack(space, folder, archive, signal) {
      const response = await ask(
        `${path(space)}/unpack/${encodeURIComponent(folder)}`,
        // Handed on as it is: a copy of up to 64 MB is not made for the sake of a type.
        { method: "PUT", body: archive as unknown as RequestInit["body"], signal },
        240_000,
      );
      return (await response.json()) as Awaited<ReturnType<NonNullable<Sandbox["unpack"]>>>;
    },
    async tree(space, folder) {
      const response = await ask(`${path(space)}/tree/${encodeURIComponent(folder)}`, {}, 60_000);
      return (await response.json()) as { name: string; sha: string; size: number }[];
    },
    async drop(space, name) {
      await ask(path(space, name), { method: "DELETE" }, 20_000);
    },
    async status() {
      try {
        return (await (await ask(`${base}/status`, {}, 10_000)).json()) as SandboxStatus;
      } catch {
        return null;
      }
    },
    async running() {
      return (await (await ask(`${base}/running`, {}, 5000)).json()) as SandboxFlight[];
    },
    async spaces() {
      return (await (await ask(`${base}/spaces`, {}, 60_000)).json()) as SandboxSpace[];
    },
    async stop(space) {
      const said = (await (
        await ask(`${path(space)}/stop`, { method: "POST" }, 10_000)
      ).json()) as {
        ended?: number;
      };
      return Number(said.ended) || 0;
    },
    async release(space, since) {
      await ask(
        `${path(space)}?idle=1${since ? `&since=${Math.floor(since)}` : ""}`,
        { method: "DELETE" },
        30_000,
      );
    },
  };
}
