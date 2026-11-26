/**
 * Runs an agent's code where it can reach nothing by itself: a container started for that
 * one run, with no network, a read-only system, no privileges, and a limit on processor,
 * memory, processes and time. Nothing of this machine is mounted into it. Its standard
 * input and output are the only way in or out (wire.ts): the workspace's files, what the
 * code prints as it prints it, and the connections it asks this service to make for it,
 * which are let through to the hosts the run was given and to nothing else (egress.ts).
 *
 * This process is the only thing in Muster that may start containers. The server asks it
 * for one of four things (keep a file, give a file, run code, forget a workspace) and
 * cannot ask for anything else: no image, no flag and no path is taken from a request.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { BadBundle, type Entry, frames, RESERVED, safePath, unpack } from "./bundle.js";
import {
  type Connect,
  Egress,
  hostList,
  type Lookup,
  type Reached,
  type Tunnel,
} from "./egress.js";
import { BadArchive, type Passed, untar } from "./untar.js";
import { go, gone, hello, PIECE, piece, pieces, Reader, WINDOW } from "./wire.js";

/** How many repositories are unpacked at once, over all workspaces. */
export const UNPACKS_AT_ONCE = 2;
/** The most files a repository may have to be worked on here. */
export const REPOSITORY_FILES = 20_000;
/** What git calls a file's content: the name a code host knows it by. */
export const blobSha = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export const LANGUAGES = ["python", "shell"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Limits {
  /** The longest a run may take, in seconds, and what it gets when it does not say. */
  maxSeconds: number;
  seconds: number;
  cpus: string;
  memory: string;
  processes: number;
  /** All the files of one workspace together. */
  spaceBytes: number;
  /** One file handed in. */
  fileBytes: number;
  /** Runs at once, over all workspaces. */
  atOnce: number;
  /** How long a run waits for its turn before it is told the sandbox is busy. */
  waitMs: number;
  /**
   * A workspace nobody used for this long is forgotten, whatever the server says. The
   * server releases them sooner, by each organization's own number of days (sandboxAdmin.ts):
   * this is the longest that number may be, for a workspace no server ever asks about.
   */
  idleMs: number;
  /** All working folders together. Past this, the ones used longest ago are forgotten. */
  diskBytes: number;
  /** How much of what a run printed is passed on, for each of its two streams. */
  saidBytes: number;
  /**
   * How much may wait here to be handed to a run that is not reading (answers to the
   * connections it opened), and how many connections it may ask for in all. Past either
   * the run is ended: one run does not get to fill this service's memory.
   */
  queueBytes: number;
  asks: number;
}

export const LIMITS: Limits = {
  maxSeconds: 300,
  seconds: 60,
  cpus: "2",
  memory: "2g",
  processes: 256,
  spaceBytes: 256 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  atOnce: 3,
  waitMs: 30_000,
  idleMs: 90 * 24 * 3600 * 1000,
  diskBytes: 20 * 1024 * 1024 * 1024,
  saidBytes: 220_000,
  queueBytes: 8 * 1024 * 1024,
  asks: 2000,
};

/** Something asked for that cannot be done, said in words the server can pass on. */
export class Refused extends Error {
  constructor(
    readonly code:
      | "not_ready"
      | "bad_space"
      | "bad_name"
      | "no_file"
      | "too_large"
      | "space_full"
      | "busy"
      | "bad_request"
      | "stopped"
      | "ended"
      | "in_use"
      | "broke",
    message: string,
    /** How long the run had gone on when it ended this way, by this service's clock. Absent for one that never started. */
    readonly wall?: number,
  ) {
    super(message);
  }
}

export interface Ran {
  exit: number;
  timedOut: boolean;
  seconds: number;
  stdout: string;
  stderr: string;
  /** Characters of what was printed that were left out of the middle. */
  cut: number;
  changed: { name: string; size: number }[];
  deleted: string[];
  /** Files the run made that could not be taken out: too large together, or a name no file may have. */
  skipped: string[];
  files: { name: string; size: number }[];
  /**
   * How long the run took by this service's clock, from starting its container to its end,
   * and how many processors it was allowed. What a day's allowance is counted from: the
   * run's own word for what it used is not taken, since the code could have written it.
   */
  wall: number;
  cpus: number;
  /** Bytes of files the run handed back. */
  bytesOut: number;
  /** What the run reached, and what it was refused, by host. */
  net: Reached[];
}

/** What a caller may be told while a run goes on, and how it ends one. */
export interface Watching {
  /** What the code printed, as it printed it: "out" or "err", and the text. */
  said?(stream: "out" | "err", text: string): void;
  /** Ends the run when it fires: the container is removed. */
  signal?: AbortSignal;
}

export interface Health {
  ready: boolean;
  /** How the code is kept apart: "gvisor", or "container" where that was allowed for development. */
  isolation: "gvisor" | "container" | null;
  runtime: string | null;
  image: string | null;
  reason: string;
  running: number;
}

/** One run that has been asked for and is not over: what an administrator is shown of it. */
export interface Flight {
  space: string;
  language: string;
  /** Waiting for its workspace or for a place, or running in its container. */
  state: "waiting" | "running";
  /** When it was asked for, and when its container started (0 while it waits), in ms. */
  asked: number;
  started: number;
  /** The time it may take, in seconds. */
  seconds: number;
  /** Bytes it has printed so far, and connections it has asked for. */
  printed: number;
  connections: number;
}

/** A workspace as it stands on the disk. */
export interface Space {
  space: string;
  files: number;
  bytes: number;
  /** When it was last used, in ms. */
  used: number;
  /** Something is being done there now: a run, or a file going in. */
  busy: boolean;
}

/** The whole of the service for the page an administrator reads. */
export interface Status extends Health {
  waiting: number;
  slots: number;
  /** When the image was built, as Docker has it; null when it could not be read. */
  built: string | null;
  spaces: { count: number; bytes: number };
  /** The disk the workspaces are on: bytes free and in all. Null where it cannot be asked. */
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

/** Starts a program and gives what it printed. Stands in for Docker in tests. */
export type Start = (
  args: string[],
  /** What the program is handed on its standard input, piece by piece. */
  input?: Iterable<Uint8Array>,
  most?: number,
) => { done: Promise<{ code: number; stdout: Uint8Array; stderr: string }>; kill(): void };

/**
 * Starts a run and stays with it: what it writes is handed on as it comes, and it can be
 * written to until it ends. Stands in for `docker run --interactive` in tests.
 */
export type Attach = (
  args: string[],
  on: { out(chunk: Uint8Array): void },
) => {
  done: Promise<{ code: number; stderr: string }>;
  /** Hands the run more; waits while it is not reading. */
  write(chunk: Uint8Array): Promise<void>;
  /** Nothing more will be handed to it. */
  end(): void;
  kill(): void;
};

/** A run as a program started some way: Docker's, here; the run's own program alone, in a test. */
export const attachWith =
  (begin: (args: string[]) => ChildProcess): Attach =>
  (args, on) => {
    const child = begin(args);
    let err = "";
    let dead = false;
    let waiting: (() => void) | null = null;
    child.stdout?.on("data", (chunk: Buffer) => on.out(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 8000) err += chunk.toString("utf8");
    });
    const stdin = child.stdin;
    stdin?.on("error", () => {});
    stdin?.on("drain", () => {
      waiting?.();
      waiting = null;
    });
    // One piece after another: two writers never have their pieces mixed.
    let chain: Promise<void> = Promise.resolve();
    return {
      done: new Promise((resolve) => {
        const over = (code: number, stderr: string) => {
          dead = true;
          waiting?.();
          waiting = null;
          resolve({ code, stderr });
        };
        child.on("error", (error) => over(127, String(error)));
        child.on("close", (code) => over(code ?? 1, err));
      }),
      write(chunk) {
        chain = chain.then(
          () =>
            new Promise<void>((resolve) => {
              if (dead || !stdin || stdin.destroyed || !stdin.writable) return resolve();
              if (stdin.write(chunk)) resolve();
              else waiting = resolve;
            }),
        );
        return chain;
      },
      end() {
        chain = chain.then(() => {
          stdin?.end();
        });
      },
      kill: () => child.kill("SIGKILL"),
    };
  };
export const attach: Attach = attachWith((args) =>
  spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] }),
);

const SPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const docker: Start = (args, input, most = 64 * 1024 * 1024) => {
  const child: ChildProcess = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  let size = 0;
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.length;
    // More than a workspace can hold is not an answer: stop listening and end it.
    if (size > most) child.kill("SIGKILL");
    else out.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (err.length < 8000) err += chunk.toString("utf8");
  });
  const stdin = child.stdin;
  stdin?.on("error", () => {});
  // Piece by piece, waiting when the program is not reading: nothing is copied to be sent.
  void (async () => {
    try {
      for (const piece of input ?? []) {
        if (!stdin || stdin.destroyed) break;
        const view = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
        if (!stdin.write(view)) await new Promise((resolve) => stdin.once("drain", resolve));
      }
    } catch {}
    stdin?.end();
  })();
  return {
    done: new Promise((resolve) => {
      child.on("error", (error) =>
        resolve({ code: 127, stdout: new Uint8Array(), stderr: String(error) }),
      );
      child.on("close", (code) =>
        resolve({
          code: size > most ? 125 : (code ?? 1),
          stdout: out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out),
          stderr: err,
        }),
      );
    }),
    kill: () => child.kill("SIGKILL"),
  };
};

export class Runner {
  private health: Health = {
    ready: false,
    isolation: null,
    runtime: null,
    image: null,
    reason: "starting",
    running: 0,
  };
  private running = 0;
  private waiting: (() => void)[] = [];
  /** One thing at a time in a workspace: two would each take out what the other was writing. */
  private busy = new Map<string, Promise<unknown>>();
  /** The containers started and not yet ended, to end them when this service stops. */
  private live = new Set<string>();
  /** The runs asked for and not over, and how each is ended from outside. */
  private flights = new Map<object, { flight: () => Flight; end: () => void }>();
  private built: string | null = null;
  private counted: { at: number; spaces: Space[] } | null = null;

  constructor(
    private readonly root: string,
    private readonly imageDir: string,
    private readonly options: {
      /** The runtime to use, when the choice is not left to what Docker has. */
      runtime?: string;
      /** For development on a machine without gVisor: run in an ordinary container. */
      allowContainer?: boolean;
      limits?: Partial<Limits>;
      start?: Start;
      attach?: Attach;
      /** How a name is looked up and an address connected to, for what a run reaches (egress.ts). */
      lookup?: Lookup;
      connect?: Connect;
      log?: (line: Record<string, unknown>) => void;
    } = {},
  ) {}

  private get limits(): Limits {
    return { ...LIMITS, ...this.options.limits };
  }
  private get start(): Start {
    return this.options.start ?? docker;
  }
  private log(line: Record<string, unknown>) {
    (this.options.log ?? ((one) => console.log(JSON.stringify(one))))({
      at: new Date().toISOString(),
      ...line,
    });
  }

  state(): Health {
    return { ...this.health, running: this.running };
  }

  /**
   * Finds how code will be kept apart and makes sure the image is there. Until this has
   * ended well nothing runs. gVisor is looked for among the runtimes Docker has; without
   * it, nothing runs unless an ordinary container was allowed by name.
   */
  async prepare(): Promise<Health> {
    try {
      const info = await this.start(["info", "--format", "{{json .Runtimes}}"]).done;
      if (info.code !== 0)
        throw new Error(`Docker did not answer: ${info.stderr.trim().slice(0, 300)}`);
      const runtimes = Object.keys(JSON.parse(new TextDecoder().decode(info.stdout)) as object);
      const asked = this.options.runtime;
      const gvisor = asked ?? runtimes.find((name) => /runsc|gvisor/i.test(name));
      if (asked && !runtimes.includes(asked))
        throw new Error(`Docker has no runtime called "${asked}".`);
      if (!gvisor && !this.options.allowContainer)
        throw new Error(
          "Docker has no gVisor runtime (runsc), and running without one was not allowed.",
        );
      await this.clear();
      const files = ["Dockerfile", "entry.py", "look.py"];
      const hash = createHash("sha256");
      for (const name of files) hash.update(await readFile(join(this.imageDir, name)));
      const image = `muster-sandbox:${hash.digest("hex").slice(0, 12)}`;
      const have = await this.start(["image", "inspect", "--format", "{{.Id}}", image]).done;
      if (have.code !== 0) {
        this.health = {
          ...this.health,
          reason: "building the image; this takes a few minutes the first time",
        };
        this.log({ event: "image.build", image });
        const built = await this.start(["build", "--quiet", "--tag", image, this.imageDir]).done;
        if (built.code !== 0)
          throw new Error(`The image could not be built: ${built.stderr.trim().slice(-600)}`);
      }
      // Images of earlier versions of the sandbox are no longer started: they only take room.
      const tags = await this.start(["image", "ls", "muster-sandbox", "--format", "{{.Tag}}"]).done;
      for (const tag of new TextDecoder().decode(tags.stdout).split("\n"))
        if (/^[0-9a-f]{12}$/.test(tag) && `muster-sandbox:${tag}` !== image)
          await this.start(["image", "rm", `muster-sandbox:${tag}`]).done;
      const made = await this.start(["image", "inspect", "--format", "{{.Created}}", image]).done;
      const when = Date.parse(new TextDecoder().decode(made.stdout).trim());
      this.built = made.code === 0 && Number.isFinite(when) ? new Date(when).toISOString() : null;
      this.health = {
        ready: true,
        isolation: gvisor ? "gvisor" : "container",
        runtime: gvisor ?? null,
        image,
        reason: "",
        running: 0,
      };
      this.log({
        event: "ready",
        isolation: this.health.isolation,
        runtime: gvisor ?? "default",
        image,
      });
    } catch (error) {
      this.health = {
        ready: false,
        isolation: null,
        runtime: null,
        image: null,
        reason: error instanceof Error ? error.message : String(error),
        running: 0,
      };
      this.log({ event: "not_ready", reason: this.health.reason });
    }
    return this.state();
  }

  /** Every run asked for and not over, the ones still waiting among them. */
  flying(): Flight[] {
    return [...this.flights.values()].map((one) => one.flight()).sort((a, b) => a.asked - b.asked);
  }

  /**
   * Ends what runs in a workspace, and what waits to: asked by an administrator, and told
   * to whoever asked for the run in those words. Gives how many were ended.
   */
  end(space: string): number {
    this.dir(space);
    let ended = 0;
    for (const one of this.flights.values())
      if (one.flight().space === space) {
        one.end();
        ended += 1;
      }
    if (ended) this.log({ event: "run.ended", space, runs: ended });
    return ended;
  }

  /** Every workspace there is. Counted again at most every few seconds unless asked fresh. */
  async spaces(fresh = true): Promise<Space[]> {
    if (!fresh && this.counted && Date.now() - this.counted.at < 15_000) return this.counted.spaces;
    const found: Space[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !SPACE.test(entry.name)) continue;
      const used = (await stat(join(this.root, entry.name)).catch(() => null))?.mtimeMs;
      if (used === undefined) continue;
      const files = await this.list(entry.name);
      found.push({
        space: entry.name,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        used: Math.floor(used),
        busy: this.busy.has(entry.name),
      });
    }
    this.counted = { at: Date.now(), spaces: found };
    return found;
  }

  /** The service as a whole: what `state` says, and how full it is. */
  async status(): Promise<Status> {
    const spaces = await this.spaces(false);
    const limits = this.limits;
    const disk = await statfs(this.root).then(
      (fs) => ({ free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize }),
      () => null,
    );
    return {
      ...this.state(),
      waiting: this.flying().filter((one) => one.state === "waiting").length,
      slots: limits.atOnce,
      built: this.built,
      spaces: { count: spaces.length, bytes: spaces.reduce((sum, one) => sum + one.bytes, 0) },
      disk,
      limits: {
        seconds: limits.seconds,
        maxSeconds: limits.maxSeconds,
        cpus: Number(limits.cpus) || 1,
        memory: limits.memory,
        spaceBytes: limits.spaceBytes,
        diskBytes: limits.diskBytes,
        idleDays: Math.round(limits.idleMs / 86_400_000),
      },
    };
  }

  /**
   * Gives a workspace's room back, unless something is being done there: a run in flight
   * is never released. (`forget` waits instead: it is for a conversation that is gone.)
   */
  async release(space: string, since?: number): Promise<void> {
    const root = this.dir(space);
    if (this.busy.has(space))
      throw new Refused("in_use", "Something is running in that workspace.");
    await this.alone(space, async () => {
      // Used since whoever asks last looked: what they decided on is no longer so.
      const used = (await stat(root).catch(() => null))?.mtimeMs;
      if (since !== undefined && used !== undefined && Math.floor(used) > since)
        throw new Refused("in_use", "That workspace was used a moment ago.");
      await rm(root, { recursive: true, force: true });
    });
    this.counted = null;
    this.log({ event: "released", space });
  }

  private dir(space: string): string {
    if (!SPACE.test(space)) throw new Refused("bad_space", "That is not a workspace.");
    return join(this.root, space);
  }
  private place(space: string, raw: string): { name: string; path: string } {
    const name = safePath(raw);
    if (!name || RESERVED.includes(name.split("/")[0] as string))
      throw new Refused("bad_name", `"${String(raw).slice(0, 80)}" is not a name a file may have.`);
    return { name, path: join(this.dir(space), name) };
  }

  /** Every file of a workspace, by name. */
  async list(space: string): Promise<{ name: string; size: number }[]> {
    const root = this.dir(space);
    const found: { name: string; size: number }[] = [];
    const walk = async (folder: string, under: string) => {
      let names: import("node:fs").Dirent[];
      try {
        names = await readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of names) {
        const name = under ? `${under}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(folder, entry.name), name);
        else if (entry.isFile())
          found.push({ name, size: (await stat(join(folder, entry.name))).size });
      }
    };
    await walk(root, "");
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async touch(space: string) {
    const now = new Date();
    await utimes(this.dir(space), now, now).catch(() => {});
  }

  /** Does one thing in a workspace after whatever was being done there has ended. */
  private async alone<T>(space: string, job: () => Promise<T>): Promise<T> {
    const earlier = this.busy.get(space) ?? Promise.resolve();
    let free: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      free = resolve;
    });
    this.busy.set(space, mine);
    await earlier.catch(() => {});
    try {
      return await job();
    } finally {
      free();
      if (this.busy.get(space) === mine) this.busy.delete(space);
    }
  }

  /** Ends every sandbox container there is: none outlives the service that watches its time. */
  async clear(): Promise<void> {
    const found = await this.start(["ps", "-aq", "--filter", "label=muster.sandbox=1"]).done;
    const ids = new TextDecoder().decode(found.stdout).split(/\s+/).filter(Boolean);
    if (ids.length) {
      await this.start(["rm", "--force", ...ids]).done;
      this.log({ event: "cleared", containers: ids.length });
    }
    this.live.clear();
  }

  async put(
    space: string,
    raw: string,
    bytes: Uint8Array,
  ): Promise<{ name: string; size: number }> {
    const { name } = this.place(space, raw);
    if (bytes.length > this.limits.fileBytes)
      throw new Refused("too_large", `"${name}" is larger than a sandbox takes in.`);
    return this.alone(space, async () => {
      const others = (await this.list(space)).filter((file) => file.name !== name);
      if (others.reduce((total, file) => total + file.size, bytes.length) > this.limits.spaceBytes)
        throw new Refused("space_full", "The workspace has no room left for that file.");
      await this.write(this.dir(space), name, bytes);
      await this.touch(space);
      return { name, size: bytes.length };
    });
  }

  async get(space: string, raw: string): Promise<Uint8Array> {
    const { name, path } = this.place(space, raw);
    return this.alone(space, async () => {
      try {
        return await readFile(path);
      } catch {
        throw new Refused("no_file", `There is no "${name}" in the workspace.`);
      }
    });
  }

  /**
   * Puts a repository's files into one folder of a workspace, in place of whatever that
   * folder held, and says what each is by git's own fingerprint: what the work is later
   * compared with. Links and the like are not made; they are named in `passed`.
   */
  async unpack(
    space: string,
    under: string,
    archive: Uint8Array,
  ): Promise<{
    files: { name: string; sha: string; size: number; runs: boolean }[];
    passed: Passed[];
  }> {
    const { name: folder } = this.place(space, under);
    if (folder.includes("/"))
      throw new Refused("bad_name", "A repository goes in a folder of the workspace itself.");
    // An archive is held whole, packed and unpacked, while its files are written: up to
    // about 330 MB for the largest. So only two at a time, and the rest wait their turn.
    const free = await this.unpackTurn();
    try {
      return await this.unpackNow(space, folder, archive);
    } finally {
      free();
    }
  }

  private unpacking = 0;
  private unpackWaiting: (() => void)[] = [];
  private async unpackTurn(): Promise<() => void> {
    const free = () => {
      this.unpacking -= 1;
      this.unpackWaiting.shift()?.();
    };
    if (this.unpacking < UNPACKS_AT_ONCE) {
      this.unpacking += 1;
      return free;
    }
    await new Promise<void>((resolve, reject) => {
      const mine = () => {
        clearTimeout(timer);
        this.unpacking += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        this.unpackWaiting = this.unpackWaiting.filter((one) => one !== mine);
        reject(
          new Refused(
            "busy",
            "The sandbox is putting other repositories in place. Try again in a moment.",
          ),
        );
      }, this.limits.waitMs);
      this.unpackWaiting.push(mine);
    });
    return free;
  }

  private async unpackNow(
    space: string,
    folder: string,
    archive: Uint8Array,
  ): Promise<{
    files: { name: string; sha: string; size: number; runs: boolean }[];
    passed: Passed[];
  }> {
    return this.alone(space, async () => {
      const root = this.dir(space);
      const others = (await this.list(space))
        .filter((file) => !file.name.startsWith(`${folder}/`))
        .reduce((total, file) => total + file.size, 0);
      let read: ReturnType<typeof untar>;
      try {
        read = untar(archive, {
          bytes: this.limits.spaceBytes - others,
          fileBytes: this.limits.fileBytes,
          files: REPOSITORY_FILES,
          strip: 1,
        });
      } catch (error) {
        if (error instanceof BadArchive) throw new Refused("too_large", error.message);
        throw error;
      }
      await rm(join(root, folder), { recursive: true, force: true });
      const files: { name: string; sha: string; size: number; runs: boolean }[] = [];
      for (const file of read.files) {
        await this.write(root, `${folder}/${file.name}`, file.bytes);
        files.push({
          name: file.name,
          sha: blobSha(file.bytes),
          size: file.bytes.length,
          runs: file.runs,
        });
      }
      await this.touch(space);
      this.log({ event: "unpacked", space, files: files.length, passed: read.passed.length });
      return { files, passed: read.passed };
    });
  }

  /** The files of one folder of a workspace as they stand, each with git's fingerprint of it. */
  async tree(space: string, under: string): Promise<{ name: string; sha: string; size: number }[]> {
    const { name: folder } = this.place(space, under);
    return this.alone(space, async () => {
      const root = this.dir(space);
      const found: { name: string; sha: string; size: number }[] = [];
      for (const file of await this.list(space)) {
        if (!file.name.startsWith(`${folder}/`)) continue;
        const bytes = await readFile(join(root, file.name));
        found.push({
          name: file.name.slice(folder.length + 1),
          sha: blobSha(bytes),
          size: bytes.length,
        });
      }
      return found;
    });
  }

  /** Takes one file out of a workspace. One that is not there is no error. */
  async drop(space: string, raw: string): Promise<void> {
    const { name } = this.place(space, raw);
    await this.alone(space, () => this.remove(this.dir(space), name));
  }

  async forget(space: string): Promise<void> {
    const root = this.dir(space);
    await this.alone(space, () => rm(root, { recursive: true, force: true }));
  }

  /**
   * Writes a file where it belongs, whatever stood there: a folder in the file's place,
   * or a file where one of its folders must be, is taken away first.
   */
  private async write(root: string, name: string, bytes: Uint8Array) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = join(root, ...parts.slice(0, i));
      const there = await lstat(folder).catch(() => null);
      if (there && !there.isDirectory()) await rm(folder, { force: true });
    }
    const path = join(root, name);
    const there = await lstat(path).catch(() => null);
    if (there && !there.isFile()) await rm(path, { recursive: true, force: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  /** Takes a file away, and the folders it leaves empty. */
  private async remove(root: string, name: string) {
    await rm(join(root, name), { force: true });
    const parts = name.split("/");
    for (let i = parts.length - 1; i > 0; i--)
      if (
        !(await rmdir(join(root, ...parts.slice(0, i))).then(
          () => true,
          () => false,
        ))
      )
        break;
  }

  /**
   * Housekeeping, every few minutes: ends a container that is past its time, forgets the
   * workspaces nobody has used for longer than any organization may keep one, and, when
   * all of them together hold more than the disk they are given, the ones used longest ago.
   */
  async sweep(now = Date.now()): Promise<number> {
    const running = await this.start([
      "ps",
      "--filter",
      "label=muster.sandbox=1",
      "--format",
      '{{.Names}} {{.Label "muster.sandbox.until"}}',
    ]).done;
    for (const line of new TextDecoder().decode(running.stdout).split("\n")) {
      const [name, until] = line.trim().split(" ");
      if (name && Number(until) > 0 && Number(until) * 1000 < now) {
        await this.start(["rm", "--force", name]).done;
        this.log({ event: "ended_late", container: name });
      }
    }
    let gone = 0;
    const kept: { name: string; used: number; bytes: number }[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !SPACE.test(entry.name)) continue;
      // After whatever is running there: a run that began meanwhile has made it used again.
      await this.alone(entry.name, async () => {
        const used = (await stat(join(this.root, entry.name)).catch(() => null))?.mtimeMs;
        if (used === undefined) return;
        if (now - used > this.limits.idleMs) {
          await rm(join(this.root, entry.name), { recursive: true, force: true });
          gone += 1;
        } else {
          const bytes = (await this.list(entry.name)).reduce((sum, file) => sum + file.size, 0);
          kept.push({ name: entry.name, used, bytes });
        }
      });
    }
    let total = kept.reduce((sum, one) => sum + one.bytes, 0);
    for (const one of kept.sort((a, b) => a.used - b.used)) {
      if (total <= this.limits.diskBytes) break;
      if (this.busy.has(one.name)) continue;
      await this.alone(one.name, () =>
        rm(join(this.root, one.name), { recursive: true, force: true }),
      );
      total -= one.bytes;
      gone += 1;
    }
    if (gone) this.log({ event: "sweep", forgotten: gone, bytes: total });
    return gone;
  }

  private async turn(): Promise<() => void> {
    if (this.running >= this.limits.atOnce) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter((one) => one !== go);
          reject(new Refused("busy", "The sandbox is busy. Try again in a moment."));
        }, this.limits.waitMs);
        this.waiting.push(go);
      });
      // The place was handed over by the run that ended: it was never given up.
    } else this.running += 1;
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    };
  }

  /** Runs code in a workspace and keeps what it changed there. */
  async run(
    space: string,
    asked: { language?: unknown; code?: unknown; seconds?: unknown; hosts?: unknown },
    watching: Watching = {},
  ): Promise<Ran> {
    const root = this.dir(space);
    if (!this.health.ready || !this.health.image)
      throw new Refused("not_ready", this.health.reason || "The sandbox is not ready.");
    const image = this.health.image;
    const language = asked.language === undefined ? "python" : asked.language;
    if (!LANGUAGES.includes(language as Language))
      throw new Refused("bad_request", 'language is "python" or "shell".');
    const code = asked.code;
    if (typeof code !== "string" || !code.trim() || code.length > 200_000)
      throw new Refused("bad_request", "code is the text to run, up to 200,000 characters.");
    const seconds =
      asked.seconds === undefined
        ? this.limits.seconds
        : Math.min(this.limits.maxSeconds, Math.max(1, Math.floor(Number(asked.seconds)) || 0));
    if (!Number.isFinite(seconds) || seconds < 1)
      throw new Refused("bad_request", "seconds is a whole number.");
    // The hosts this run may reach: named by the server for each run, never kept here.
    const egress = new Egress({
      hosts: hostList(asked.hosts),
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      ...(this.options.connect ? { connect: this.options.connect } : {}),
    });
    // Ended by whoever asked (the person stopped the reply) or by an administrator: the
    // two are told apart, since the second is said to the person in a sentence.
    const admin = new AbortController();
    const signal = watching.signal
      ? AbortSignal.any([watching.signal, admin.signal])
      : admin.signal;
    const stopped = (took?: number) =>
      admin.signal.aborted
        ? new Refused("ended", "An administrator stopped this run.", took)
        : new Refused("stopped", "It was stopped.", took);
    if (signal.aborted) throw stopped();
    const asking = Date.now();
    let began = 0;
    let shown = 0;
    let asks = 0;
    const key = {};
    this.flights.set(key, {
      flight: () => ({
        space,
        language: language as string,
        state: began ? "running" : "waiting",
        asked: asking,
        started: began,
        seconds,
        printed: shown,
        connections: asks,
      }),
      end: () => admin.abort(),
    });

    return this.alone(space, async () => {
      const started = Date.now();
      // Stopped while it waited for the workspace: a signal that has fired does not fire again.
      if (signal.aborted) throw stopped();
      const release = await this.turn();
      const name = `muster-sandbox-${randomBytes(6).toString("hex")}`;
      const wall = () => (began ? Math.round((Date.now() - began) / 10) / 100 : 0);
      try {
        // Or while it waited for its turn. Nothing is started for a run nobody waits for.
        if (signal.aborted) throw stopped();
        await mkdir(root, { recursive: true });
        const held = await this.list(space);
        const limits = this.limits;
        // Read one at a time as they are sent: the folder is never all in memory to go in.
        const files = function* (): Generator<Entry> {
          for (const file of held)
            yield { name: file.name, bytes: readFileSync(join(root, file.name)) };
          yield {
            name: `.run/${language === "python" ? "main.py" : "main.sh"}`,
            bytes: new TextEncoder().encode(code),
          };
          yield {
            name: ".run/meta.json",
            bytes: new TextEncoder().encode(
              JSON.stringify({ language, timeout: seconds, net: egress.any }),
            ),
          };
        };
        const args = [
          "run",
          "--rm",
          "--interactive",
          "--name",
          name,
          ...(this.health.runtime ? ["--runtime", this.health.runtime] : []),
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "1000:1000",
          "--pids-limit",
          String(limits.processes),
          "--memory",
          limits.memory,
          "--memory-swap",
          limits.memory,
          "--cpus",
          limits.cpus,
          "--tmpfs",
          "/work:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0700",
          "--tmpfs",
          "/tmp:rw,exec,nosuid,size=512m,mode=1777",
          "--workdir",
          "/work",
          "--label",
          "muster.sandbox=1",
          // When it must have ended by, for the sweep to end it if this service did not.
          "--label",
          `muster.sandbox.until=${Math.ceil(started / 1000) + seconds + limits.waitMs / 1000 + 120}`,
          "--log-driver",
          "none",
          image,
        ];
        this.live.add(name);
        const most = limits.spaceBytes + 8 * 1024 * 1024;
        const answer: Buffer[] = [];
        let bytesOut = 0;
        let tooMuch = false;
        let garbled: string | null = null;
        // What waits to be handed to the run. A run that opens connections and reads no
        // answers would otherwise have every answer kept here for it.
        let queued = 0;
        let flooded = false;
        const toRun = (bytes: Uint8Array): Promise<void> => {
          if (flooded) return Promise.resolve();
          queued += bytes.length;
          if (queued > limits.queueBytes) {
            flooded = true;
            container.kill();
            return Promise.resolve();
          }
          return container.write(bytes).finally(() => {
            queued -= bytes.length;
          });
        };
        const tunnels = new Map<number, Tunnel>();
        /**
         * How many more bytes of each connection the run may be sent, and who waits to be
         * told there is room again (wire.ts, `WINDOW`). A host's bytes are handed on only
         * as the code inside takes them; the host's socket rests meanwhile (egress.ts).
         */
        const room = new Map<number, { left: number; waiting: (() => void)[] }>();
        const wake = (id: number) => {
          const one = room.get(id);
          if (one) for (const next of one.waiting.splice(0)) next();
        };
        const text = { O: new TextDecoder(), E: new TextDecoder() };
        const reader = new Reader((kind, id, bytes) => {
          if (kind === "O" || kind === "E") {
            // No more than a run may show, whatever it sends.
            const part = bytes.subarray(0, Math.max(0, limits.saidBytes - shown));
            shown += part.length;
            if (part.length)
              watching.said?.(
                kind === "O" ? "out" : "err",
                text[kind].decode(part, { stream: true }),
              );
          } else if (kind === "C") {
            asks += 1;
            if (asks > limits.asks) {
              flooded = true;
              return void container.kill();
            }
            if (tunnels.has(id) || tunnels.size >= 64) return void toRun(piece("X", id));
            room.set(id, { left: WINDOW, waiting: [] });
            tunnels.set(
              id,
              egress.tunnel(
                async (data) => {
                  for (let at = 0; at < data.length; ) {
                    const one = room.get(id);
                    // Over meanwhile: nobody is there to take the rest.
                    if (!one) return;
                    if (one.left <= 0) {
                      await new Promise<void>((resolve) => one.waiting.push(resolve));
                      continue;
                    }
                    const part = data.subarray(at, at + Math.min(PIECE, one.left));
                    one.left -= part.length;
                    at += part.length;
                    await toRun(piece("D", id, part));
                  }
                },
                () => {
                  const waiting = room.get(id)?.waiting.splice(0) ?? [];
                  room.delete(id);
                  for (const next of waiting) next();
                  if (tunnels.delete(id)) void toRun(piece("X", id));
                },
                // What the run sent has gone on to the host: it may send that much more.
                (count) => {
                  if (tunnels.has(id)) void toRun(go(id, count));
                },
              ),
            );
          } else if (kind === "D") tunnels.get(id)?.data(bytes);
          else if (kind === "W") {
            // Never more than a window, whatever is said: what the run has not taken is
            // its own to hold, and no more is kept here for it than that.
            const one = room.get(id);
            if (one) {
              one.left = Math.min(WINDOW, one.left + gone(bytes));
              wake(id);
            }
          } else if (kind === "X") {
            const tunnel = tunnels.get(id);
            tunnels.delete(id);
            const waiting = room.get(id)?.waiting.splice(0) ?? [];
            room.delete(id);
            for (const next of waiting) next();
            tunnel?.end();
          } else if (kind === "R") {
            bytesOut += bytes.length;
            if (bytesOut > most) {
              tooMuch = true;
              container.kill();
            } else answer.push(Buffer.from(bytes));
          } else container.end();
        });
        began = Date.now();
        const container = (this.options.attach ?? attach)(args, {
          out: (chunk) => {
            if (garbled || tooMuch || flooded) return;
            try {
              reader.push(chunk);
            } catch (error) {
              // Not what a run writes: it is not listened to further.
              garbled = error instanceof Error ? error.message : String(error);
              container.kill();
            }
          },
        });
        // The files go in piece by piece, read as they are sent.
        void (async () => {
          await container.write(hello());
          for (const frame of frames(files()))
            for (const part of pieces("I", 0, frame)) await container.write(part);
          await container.write(piece("J", 0));
          // A run that reaches nothing is handed nothing more.
          if (!egress.any) container.end();
        })().catch(() => container.kill());
        const end = () => {
          container.kill();
          void this.start(["rm", "--force", name]).done;
        };
        // The run ends itself when its time is up. This is for one that does not.
        const guard = setTimeout(end, (seconds + 30) * 1000);
        signal.addEventListener("abort", end, { once: true });
        const ended = await container.done.finally(() => {
          clearTimeout(guard);
          signal.removeEventListener("abort", end);
          egress.end();
        });
        // How long the container was there, by this service's clock: read once, as it ends.
        const took = wall();
        if (signal.aborted) {
          this.log({ event: "run.stopped", space, ms: Date.now() - started });
          throw stopped(took);
        }
        let out: Entry[];
        try {
          if (garbled) throw new BadBundle(garbled);
          if (flooded)
            throw new BadBundle("it asked for connections faster than it read their answers");
          if (tooMuch) throw new BadBundle("more than a workspace holds");
          if (!reader.ended) throw new BadBundle("the answer stops short");
          out = unpack(answer.length === 1 ? (answer[0] as Buffer) : Buffer.concat(answer));
        } catch (error) {
          if (!(error instanceof BadBundle)) throw error;
          // No answer, or not one that can be read: out of memory, ended, or code that wrote over it.
          this.log({
            event: "run.broke",
            space,
            code: ended.code,
            ms: Date.now() - started,
            why: error.message,
            said: ended.stderr.trim().slice(-300),
          });
          // Whatever is left of it goes: an answer that cannot be read may come from a run that is not over.
          void this.start(["rm", "--force", name]).done;
          throw new Refused(
            "broke",
            ended.code === 137
              ? "It was ended: it used more memory than a sandbox has, or ran past its time."
              : tooMuch
                ? "It made more than a workspace can hold."
                : flooded
                  ? "It was ended: it opened connections faster than it read their answers, or more than a run may open."
                  : "The run gave no answer that could be read. Nothing it wrote was kept.",
            took,
          );
        }
        const result = new Map(
          out.filter((one) => one.name.startsWith(".result/")).map((one) => [one.name, one.bytes]),
        );
        // No more of what was printed than a run is allowed to hand back, whatever came.
        const decode = (bytes?: Uint8Array) =>
          new TextDecoder().decode((bytes ?? new Uint8Array()).subarray(0, limits.saidBytes));
        let meta: {
          exit?: unknown;
          timedOut?: unknown;
          seconds?: unknown;
          deleted?: unknown;
          skipped?: unknown;
          more?: unknown;
          cut?: unknown;
        };
        try {
          meta = JSON.parse(decode(result.get(".result/meta.json")));
        } catch {
          throw new Refused(
            "broke",
            "The run gave no answer that could be read. Nothing it wrote was kept.",
            took,
          );
        }
        const names = (value: unknown) =>
          Array.isArray(value)
            ? value
                .flatMap((one) => (typeof one === "string" ? [one.slice(0, 200)] : []))
                .slice(0, 200)
            : [];
        // What changed is what came out, not what the answer says came out.
        const changed = out.filter((one) => !RESERVED.includes(one.name.split("/")[0] as string));
        const deleted = names(meta.deleted).filter(
          (one) => safePath(one) && held.some((file) => file.name === one),
        );
        for (const one of deleted) await this.remove(root, one);
        const skipped = names(meta.skipped);
        let total = held
          .filter(
            (file) =>
              !deleted.includes(file.name) && !changed.some((one) => one.name === file.name),
          )
          .reduce((sum, file) => sum + file.size, 0);
        const kept: { name: string; size: number }[] = [];
        for (const one of changed) {
          if (total + one.bytes.length > limits.spaceBytes) {
            skipped.push(one.name);
            continue;
          }
          total += one.bytes.length;
          await this.write(root, one.name, one.bytes);
          kept.push({ name: one.name, size: one.bytes.length });
        }
        await this.touch(space);
        const ran: Ran = {
          exit: typeof meta.exit === "number" ? meta.exit : 1,
          timedOut: meta.timedOut === true,
          // By this service's clock, not the run's: what the run says of itself is the code's to write.
          seconds: took,
          stdout: decode(result.get(".result/stdout")),
          stderr: decode(result.get(".result/stderr")),
          cut: typeof meta.cut === "number" ? meta.cut : 0,
          changed: kept,
          deleted,
          skipped,
          files: (await this.list(space)).slice(0, 500),
          wall: took,
          cpus: Number(limits.cpus) || 1,
          bytesOut,
          net: egress.reached(),
        };
        this.log({
          event: "run",
          space,
          language,
          exit: ran.exit,
          timedOut: ran.timedOut,
          ms: Date.now() - started,
          in: held.length,
          changed: kept.length,
          bytes: total,
          wall: ran.wall,
          reached: ran.net.filter((one) => one.ok).length,
          refused: ran.net.filter((one) => !one.ok).length,
        });
        return ran;
      } finally {
        this.live.delete(name);
        release();
      }
    }).finally(() => this.flights.delete(key));
  }

  /** Ends what is running: called when the service is told to stop. */
  async stop(): Promise<void> {
    const names = [...this.live];
    if (names.length) await this.start(["rm", "--force", ...names]).done;
    this.live.clear();
  }
}
