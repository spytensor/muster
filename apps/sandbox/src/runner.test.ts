import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type Attach, type Ran, Refused, Runner, type Start } from "./runner.js";
import { serve } from "./index.js";
import { hello, piece, pieces } from "./wire.js";
import { type Entry, pack, unpack } from "./bundle.js";

const SPACE = "0193a5b0-0000-7000-8000-000000000001";
const text = (value: string) => new TextEncoder().encode(value);
const answer = (code: number, stdout: Uint8Array | string = "", stderr = "") => ({
  done: Promise.resolve({
    code,
    stdout: typeof stdout === "string" ? text(stdout) : stdout,
    stderr,
  }),
  kill() {},
});

/** Docker, as far as the runner uses it. `inside` stands for the code that ran. */
function fakeDocker(
  how: {
    runtimes?: string[];
    /** Containers Docker says there are: "name until", one to a line. */
    containers?: string[];
    inside?: (files: Entry[]) => Entry[] | Uint8Array | Promise<Entry[] | Uint8Array>;
    exit?: number;
  } = {},
) {
  const calls: string[][] = [];
  const start: Start = (args, input) => {
    calls.push(args);
    if (args[0] === "info")
      return answer(
        0,
        JSON.stringify(Object.fromEntries((how.runtimes ?? ["runc", "runsc"]).map((n) => [n, {}]))),
      );
    if (args[0] === "image") return answer(0, "sha256:abc");
    if (args[0] === "ps")
      return answer(
        0,
        (how.containers ?? [])
          .map((line) => (args.includes("-aq") ? line.split(" ")[0] : line))
          .join("\n"),
      );
    if (args[0] === "run") {
      const done = (async () => {
        const out = await (how.inside ?? (() => []))(unpack(pack0(input as Iterable<Uint8Array>)));
        const stdout =
          out instanceof Uint8Array
            ? out
            : pack([
                ...out,
                { name: ".result/stdout", bytes: text("printed\n") },
                { name: ".result/stderr", bytes: text("") },
                {
                  name: ".result/meta.json",
                  bytes: text(
                    JSON.stringify({
                      exit: 0,
                      timedOut: false,
                      seconds: 0.5,
                      deleted: ["old.txt"],
                      skipped: [],
                    }),
                  ),
                },
              ]);
        return { code: how.exit ?? 0, stdout, stderr: "" };
      })();
      return { done, kill() {} };
    }
    return answer(0);
  };
  return { start, calls };
}

/**
 * A run, as far as the runner sees one, made of the same fake: what is written to it is
 * read as the pieces it is (wire.ts), the files among them are handed to `docker run` as
 * the fake has it, and what that answers goes back as a result in pieces.
 */
const attachOf =
  (start: Start): Attach =>
  (args, on) => {
    const got: Buffer[] = [];
    let begun = false;
    let kill = () => {};
    let resolve: (value: { code: number; stderr: string }) => void = () => {};
    const done = new Promise<{ code: number; stderr: string }>((r) => {
      resolve = r;
    });
    const feed = () => {
      const all = Buffer.concat(got);
      const files: Buffer[] = [];
      for (let at = 4; at + 9 <= all.length; ) {
        const kind = String.fromCharCode(all[at] as number);
        const length = all.readUInt32BE(at + 5);
        if (at + 9 + length > all.length) return;
        if (kind === "I") files.push(all.subarray(at + 9, at + 9 + length));
        if (kind === "J" && !begun) {
          begun = true;
          const run = start(args, [Buffer.concat(files)]);
          kill = run.kill;
          void run.done.then(({ code, stdout, stderr }) => {
            if (stdout.length) {
              on.out(hello());
              for (const part of pieces("R", 0, stdout)) on.out(part);
              on.out(piece("Z", 0));
            }
            resolve({ code, stderr });
          });
        }
        at += 9 + length;
      }
    };
    return {
      done,
      write: async (chunk) => {
        got.push(Buffer.from(chunk));
        feed();
      },
      end() {},
      kill: () => kill(),
    };
  };

/** What was handed in piece by piece, as one block. */
function pack0(pieces: Iterable<Uint8Array>): Uint8Array {
  const all = [...pieces];
  const out = new Uint8Array(all.reduce((n, piece) => n + piece.length, 0));
  let at = 0;
  for (const piece of all) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

let root: string;
let image: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spaces-"));
  image = await mkdtemp(join(tmpdir(), "image-"));
  for (const name of ["Dockerfile", "entry.py", "look.py"])
    await writeFile(join(image, name), name);
});
const runner = (docker: ReturnType<typeof fakeDocker>, options = {}) =>
  new Runner(root, image, {
    start: docker.start,
    attach: attachOf(docker.start),
    log: () => {},
    ...options,
  });

describe("how code is kept apart", () => {
  it("uses gVisor when Docker has it, under whatever name", async () => {
    const one = runner(fakeDocker({ runtimes: ["runc", "custom-runsc"] }));
    expect(await one.prepare()).toMatchObject({
      ready: true,
      isolation: "gvisor",
      runtime: "custom-runsc",
    });
  });

  it("runs nothing without gVisor unless an ordinary container was allowed", async () => {
    const docker = fakeDocker({ runtimes: ["runc"] });
    const strict = runner(docker);
    expect(await strict.prepare()).toMatchObject({ ready: false, isolation: null });
    await expect(strict.run(SPACE, { code: "print(1)" })).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(docker.calls.some((call) => call[0] === "run")).toBe(false);
    const dev = runner(fakeDocker({ runtimes: ["runc"] }), { allowContainer: true });
    expect(await dev.prepare()).toMatchObject({
      ready: true,
      isolation: "container",
      runtime: null,
    });
  });

  it("starts each run with no network, no privileges and limits, and takes nothing from the request into the command", async () => {
    const docker = fakeDocker();
    const one = runner(docker);
    await one.prepare();
    await one.run(SPACE, {
      code: "print(1) # --privileged -v /:/host",
      language: "python",
      image: "evil",
      runtime: "runc",
    } as never);
    const args = docker.calls.find((call) => call[0] === "run") as string[];
    const has = (...pair: string[]) => args.join(" ").includes(pair.join(" "));
    expect(has("--runtime", "runsc")).toBe(true);
    expect(has("--network", "none")).toBe(true);
    expect(has("--read-only")).toBe(true);
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges")).toBe(true);
    expect(has("--user", "1000:1000")).toBe(true);
    expect(has("--memory", "2g") && has("--cpus", "2") && has("--pids-limit", "256")).toBe(true);
    expect(
      args.some((arg) => arg.includes("evil") || arg.includes("privileged") || arg === "-v"),
    ).toBe(false);
    expect(args.at(-1)).toMatch(/^muster-sandbox:[0-9a-f]{12}$/);
  });
});

describe("a workspace", () => {
  it("hands its files to the run and keeps what the run changed", async () => {
    let seen: Entry[] = [];
    const docker = fakeDocker({
      inside: (files) => {
        seen = files;
        return [
          { name: "out/chart.png", bytes: text("png") },
          { name: "data.csv", bytes: text("a,b\n9,9\n") },
        ];
      },
    });
    const one = runner(docker);
    await one.prepare();
    await one.put(SPACE, "data.csv", text("a,b\n1,2\n"));
    await one.put(SPACE, "old.txt", text("old"));
    const ran: Ran = await one.run(SPACE, { code: "import pandas", seconds: 20 });
    expect(seen.map((file) => file.name).sort()).toEqual([
      ".run/main.py",
      ".run/meta.json",
      "data.csv",
      "old.txt",
    ]);
    expect(new TextDecoder().decode(seen.find((f) => f.name === ".run/meta.json")?.bytes)).toBe(
      '{"language":"python","timeout":20,"net":false}',
    );
    expect(ran).toMatchObject({ exit: 0, stdout: "printed\n", deleted: ["old.txt"] });
    expect(ran.changed.map((file) => file.name)).toEqual(["out/chart.png", "data.csv"]);
    expect(ran.files.map((file) => file.name)).toEqual(["data.csv", "out/chart.png"]);
    expect(new TextDecoder().decode(await one.get(SPACE, "data.csv"))).toBe("a,b\n9,9\n");
    expect(await readFile(join(root, SPACE, "out/chart.png"), "utf8")).toBe("png");
  });

  it("writes nothing when what came out is not plain files", async () => {
    const hostile = pack([{ name: "ok.txt", bytes: text("x") }]);
    // The name, where it stands in the stream, turned into one that climbs out.
    hostile.set(text("../x.t"), 6);
    const one = runner(fakeDocker({ inside: () => hostile }));
    await one.prepare();
    await expect(one.run(SPACE, { code: "x" })).rejects.toMatchObject({ code: "broke" });
    expect(await one.list(SPACE)).toEqual([]);
  });

  it("says what happened when a run was ended from outside", async () => {
    const one = runner(fakeDocker({ inside: () => new Uint8Array(), exit: 137 }));
    await one.prepare();
    await expect(one.run(SPACE, { code: "x" })).rejects.toThrow(/memory|time/);
  });

  it("refuses names that leave it, files too large and more than it holds", async () => {
    const one = runner(fakeDocker(), { limits: { fileBytes: 10, spaceBytes: 15 } });
    for (const bad of ["../x", "/etc/passwd", ".run/main.py", ".result/meta.json", "a\\b"])
      await expect(one.put(SPACE, bad, text("x"))).rejects.toMatchObject({ code: "bad_name" });
    await expect(one.put("not-a-space", "a", text("x"))).rejects.toMatchObject({
      code: "bad_space",
    });
    await expect(one.put("../../etc", "a", text("x"))).rejects.toMatchObject({ code: "bad_space" });
    await expect(one.put(SPACE, "a", text("x".repeat(11)))).rejects.toMatchObject({
      code: "too_large",
    });
    await one.put(SPACE, "a", text("x".repeat(10)));
    await expect(one.put(SPACE, "b", text("x".repeat(6)))).rejects.toMatchObject({
      code: "space_full",
    });
    // The same file again takes the place of the first: it is not counted twice.
    await one.put(SPACE, "a", text("x".repeat(9)));
    await expect(one.get(SPACE, "missing")).rejects.toBeInstanceOf(Refused);
  });

  it("refuses a request that does not say what to run", async () => {
    const one = runner(fakeDocker());
    await one.prepare();
    for (const bad of [{}, { code: "" }, { code: 5 }, { code: "x", language: "ruby" }])
      await expect(one.run(SPACE, bad)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("runs one thing at a time in a workspace and tells a run that waited too long", async () => {
    let free: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      free = resolve;
    });
    const order: string[] = [];
    const docker = fakeDocker({
      inside: async (files) => {
        const code = new TextDecoder().decode(files.find((f) => f.name === ".run/main.py")?.bytes);
        order.push(`start ${code}`);
        if (code === "first") await held;
        order.push(`end ${code}`);
        return [];
      },
    });
    const one = runner(docker, { limits: { atOnce: 1, waitMs: 40 } });
    await one.prepare();
    const first = one.run(SPACE, { code: "first" });
    const second = one.run(SPACE, { code: "second" });
    // Another workspace waits for its turn, and is told when the turn does not come.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      one.run("0193a5b0-0000-7000-8000-000000000002", { code: "other" }),
    ).rejects.toMatchObject({
      code: "busy",
    });
    free();
    await Promise.all([first, second]);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("is forgotten when nobody has used it for longer than a workspace is kept", async () => {
    const one = runner(fakeDocker(), { limits: { idleMs: 7 * 24 * 3600 * 1000 } });
    await one.put(SPACE, "a", text("x"));
    const other = "0193a5b0-0000-7000-8000-000000000003";
    await one.put(other, "a", text("x"));
    const long = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await utimes(join(root, other), long, long);
    await mkdir(join(root, "not-a-space"));
    expect(await one.sweep()).toBe(1);
    expect((await one.list(SPACE)).length).toBe(1);
    expect(await one.list(other)).toEqual([]);
  });
  it("takes a long Chinese name in, and runs with it there", async () => {
    let seen: string[] = [];
    const docker = fakeDocker({
      inside: (files) => {
        seen = files.map((file) => file.name);
        return [];
      },
    });
    const one = runner(docker);
    await one.prepare();
    // 43 characters, 123 bytes: an ordinary name here, and more than a tar name holds.
    const name = "二〇二六年第三季度华东大区销售明细与回款情况汇总表（含退货与折让）最终版.csv";
    await one.put(SPACE, name, text("a\n"));
    await one.run(SPACE, { code: "x" });
    await one.run(SPACE, { code: "x" });
    expect(seen).toContain(name);
  });

  it("writes a file where a folder stood, and a folder where a file stood", async () => {
    const outs: Entry[][] = [
      [{ name: "x", bytes: text("now a file") }],
      [{ name: "x/y/z.txt", bytes: text("now a folder") }],
    ];
    const one = runner(fakeDocker({ inside: () => outs.shift() as Entry[] }));
    await one.prepare();
    await one.put(SPACE, "x/y", text("inside"));
    await one.run(SPACE, { code: "rm -r x; echo > x" });
    expect((await one.list(SPACE)).map((file) => file.name)).toEqual(["x"]);
    await one.run(SPACE, { code: "rm x; mkdir -p x/y" });
    expect((await one.list(SPACE)).map((file) => file.name)).toEqual(["x/y/z.txt"]);
  });

  it("takes away the folders a deleted file leaves empty", async () => {
    const one = runner(fakeDocker({ inside: () => [] }));
    await one.prepare();
    await one.put(SPACE, "old.txt", text("x"));
    await one.put(SPACE, "keep/a.txt", text("x"));
    // The stand-in run always says old.txt was deleted.
    await one.run(SPACE, { code: "x" });
    expect((await one.list(SPACE)).map((file) => file.name)).toEqual(["keep/a.txt"]);
  });

  it("passes on no more of what was printed than a run may hand back, whatever came", async () => {
    const flood = pack([
      { name: ".result/stdout", bytes: new Uint8Array(3_000_000).fill(97) },
      { name: ".result/stderr", bytes: new Uint8Array(3_000_000).fill(98) },
      { name: ".result/meta.json", bytes: text('{"exit":0}') },
    ]);
    const one = runner(fakeDocker({ inside: () => flood }));
    await one.prepare();
    const ran = await one.run(SPACE, { code: "x" });
    expect(ran.stdout.length).toBe(220_000);
    expect(ran.stderr.length).toBe(220_000);
  });

  it("ends containers left from before when it starts, and its own when it stops", async () => {
    const docker = fakeDocker({ containers: ["muster-sandbox-old1 1", "muster-sandbox-old2 1"] });
    const one = runner(docker);
    await one.prepare();
    expect(docker.calls).toContainEqual([
      "rm",
      "--force",
      "muster-sandbox-old1",
      "muster-sandbox-old2",
    ]);

    let free: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      free = resolve;
    });
    const slow = fakeDocker({
      inside: async () => {
        await held;
        return [];
      },
    });
    const two = runner(slow);
    await two.prepare();
    const going = two.run(SPACE, { code: "x" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await two.stop();
    const name = (slow.calls.find((call) => call[0] === "run") as string[])[4];
    expect(slow.calls).toContainEqual(["rm", "--force", name]);
    free();
    await going;
  });

  it("says when each container must have ended, and ends one that is past it", async () => {
    const docker = fakeDocker({
      containers: [
        `muster-sandbox-late ${Math.floor(Date.now() / 1000) - 60}`,
        `muster-sandbox-fine ${Math.floor(Date.now() / 1000) + 600}`,
      ],
    });
    const one = runner(docker);
    await one.prepare();
    docker.calls.length = 0;
    await one.run(SPACE, { code: "x", seconds: 10 });
    const args = docker.calls.find((call) => call[0] === "run") as string[];
    const until = Number(
      args.find((arg) => arg.startsWith("muster.sandbox.until="))?.split("=")[1],
    );
    expect(until).toBeGreaterThan(Date.now() / 1000 + 10);
    expect(until).toBeLessThan(Date.now() / 1000 + 200);
    await one.sweep();
    expect(docker.calls).toContainEqual(["rm", "--force", "muster-sandbox-late"]);
    expect(docker.calls).not.toContainEqual(["rm", "--force", "muster-sandbox-fine"]);
  });

  it("never runs more at once than it may, however the waiting goes", async () => {
    let now = 0;
    let most = 0;
    const docker = fakeDocker({
      inside: async () => {
        now += 1;
        most = Math.max(most, now);
        await new Promise((resolve) => setTimeout(resolve, 5));
        now -= 1;
        return [];
      },
    });
    const one = runner(docker, { limits: { atOnce: 2, waitMs: 5000 } });
    await one.prepare();
    const space = (n: number) => `0193a5b0-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;
    // Some start as others end: a place handed over must not be taken twice.
    const first = Array.from({ length: 6 }, (_, n) => one.run(space(n), { code: "x" }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const second = Array.from({ length: 6 }, (_, n) => one.run(space(n + 10), { code: "x" }));
    await Promise.all([...first, ...second]);
    expect(most).toBe(2);
    expect(one.state().running).toBe(0);
  });

  it("forgets the folders used longest ago when all together hold more than their disk", async () => {
    const one = runner(fakeDocker(), { limits: { diskBytes: 25 } });
    const spaces = [1, 2, 3].map((n) => `0193a5b0-0000-7000-8000-00000000020${n}`);
    for (const [i, space] of spaces.entries()) {
      await one.put(space, "a", text("x".repeat(10)));
      const at = new Date(Date.now() - (3 - i) * 3600 * 1000);
      await utimes(join(root, space), at, at);
    }
    expect(await one.sweep()).toBe(1);
    expect(await one.list(spaces[0] as string)).toEqual([]);
    expect((await one.list(spaces[2] as string)).length).toBe(1);
  });

  it("does not start a run that was stopped while it waited its turn", async () => {
    let free: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      free = resolve;
    });
    const docker = fakeDocker({
      inside: async () => {
        await held;
        return [];
      },
    });
    const one = runner(docker, { limits: { atOnce: 1, waitMs: 5000 } });
    await one.prepare();
    const first = one.run("0193a5b0-0000-7000-8000-000000000301", { code: "x" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = new AbortController();
    const second = one
      .run("0193a5b0-0000-7000-8000-000000000302", { code: "x" }, { signal: stop.signal })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Stopped while the other still has the one place there is.
    stop.abort();
    free();
    await first;
    const error = await second;
    expect(error).toBeInstanceOf(Refused);
    expect((error as Refused).code).toBe("stopped");
    // One container was started, not two; and the place was given back.
    expect(docker.calls.filter((call) => call[0] === "run").length).toBe(1);
    expect(one.state().running).toBe(0);
    // The same for one stopped while it waited for its own workspace.
    const again = new AbortController();
    again.abort();
    await expect(
      one.run("0193a5b0-0000-7000-8000-000000000301", { code: "x" }, { signal: again.signal }),
    ).rejects.toMatchObject({ code: "stopped" });
  });

  it("ends a run that asks for connections and never reads the answers, with little kept for it", async () => {
    // A run that opens a connection, closes it and opens the next, for ever, and reads
    // nothing it is handed: every answer would wait in this service for it.
    let handed = 0;
    let killed = false;
    const hostile: Attach = (_args, on) => {
      let finish: (value: { code: number; stderr: string }) => void = () => {};
      const done = new Promise<{ code: number; stderr: string }>((resolve) => {
        finish = resolve;
      });
      let begun = false;
      return {
        done,
        write: (chunk) => {
          // The files are taken; after them, nothing handed over is ever read.
          if (!begun) {
            if (String.fromCharCode(chunk[0] as number) === "J") {
              begun = true;
              setTimeout(() => {
                on.out(hello());
                for (let id = 1; id <= 50_000 && !killed; id++) {
                  on.out(piece("C", id));
                  on.out(piece("D", id, text("CONNECT evil.example:443 HTTP/1.1\r\n\r\n")));
                  on.out(piece("X", id));
                }
              }, 0);
            }
            return Promise.resolve();
          }
          handed += chunk.length;
          return new Promise<void>(() => {});
        },
        end() {},
        kill: () => {
          killed = true;
          finish({ code: 137, stderr: "" });
        },
      };
    };
    const docker = fakeDocker();
    const one = runner(docker, { attach: hostile, limits: { queueBytes: 64 * 1024, asks: 1000 } });
    await one.prepare();
    const error = await one
      .run(SPACE, { code: "x", hosts: ["pypi.org"] })
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(Refused);
    expect((error as Refused).code).toBe("broke");
    expect(killed).toBe(true);
    // No more was ever waiting for it than a run may have waiting.
    expect(handed).toBeLessThanOrEqual(64 * 1024);
    expect(one.state().running).toBe(0);
  });
});

describe("what an administrator is shown, and may do", () => {
  const A = "0193a5b0-0000-7000-8000-000000000401";
  const B = "0193a5b0-0000-7000-8000-000000000402";
  const C = "0193a5b0-0000-7000-8000-000000000403";
  /** A fake whose runs go on until `free` is called. */
  const holding = () => {
    let free: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      free = resolve;
    });
    const docker = fakeDocker({
      inside: async () => {
        await held;
        return [];
      },
    });
    return { docker, free: () => free() };
  };
  const soon = () => new Promise((resolve) => setTimeout(resolve, 15));

  it("lists every run in flight, the waiting ones among them, and none once they are over", async () => {
    const { docker, free } = holding();
    const one = runner(docker, { limits: { atOnce: 1, waitMs: 5000 } });
    await one.prepare();
    const first = one.run(A, { code: "x", seconds: 20 });
    await soon();
    const second = one.run(B, { code: "x", language: "shell" });
    await soon();
    const flying = one.flying();
    expect(flying.map((f) => [f.space, f.state, f.language, f.seconds])).toEqual([
      [A, "running", "python", 20],
      [B, "waiting", "shell", 60],
    ]);
    expect(flying[0]?.started).toBeGreaterThan(0);
    expect(flying[1]?.started).toBe(0);
    const status = await one.status();
    expect(status).toMatchObject({ ready: true, running: 1, waiting: 1, slots: 1 });
    free();
    await Promise.all([first, second]);
    expect(one.flying()).toEqual([]);
    expect((await one.status()).waiting).toBe(0);
  });

  it("ends a run for an administrator and says so, apart from one its own caller stopped", async () => {
    const { docker, free } = holding();
    const one = runner(docker, { limits: { atOnce: 1, waitMs: 5000 } });
    await one.prepare();
    const first = one.run(A, { code: "x" }).catch((error) => error);
    await soon();
    const waiting = one.run(B, { code: "x" }).catch((error) => error);
    await soon();
    // Nothing runs in a workspace nobody uses; and a name that is no workspace is refused.
    expect(one.end(C)).toBe(0);
    expect(() => one.end("../etc")).toThrow(Refused);
    expect(one.end(B)).toBe(1);
    expect(one.end(A)).toBe(1);
    free();
    const error = (await first) as Refused;
    expect(error).toBeInstanceOf(Refused);
    expect(error.code).toBe("ended");
    expect(error.message).toBe("An administrator stopped this run.");
    // The one that waited was never started.
    expect(((await waiting) as Refused).code).toBe("ended");
    expect(docker.calls.filter((call) => call[0] === "run").length).toBe(1);
    expect(docker.calls.some((call) => call[0] === "rm" && call[1] === "--force")).toBe(true);
    expect(one.state().running).toBe(0);
    expect(one.flying()).toEqual([]);
  });

  it("lists workspaces with what they hold and when they were used, and counts them in the status", async () => {
    const one = runner(fakeDocker());
    await one.prepare();
    await one.put(A, "a.txt", text("12345"));
    await one.put(A, "repo/app/main.py", text("123"));
    await one.put(B, "b.txt", text("1"));
    const long = new Date(Date.now() - 9 * 24 * 3600 * 1000);
    await utimes(join(root, B), long, long);
    await mkdir(join(root, "not-a-space"));
    const spaces = (await one.spaces()).sort((x, y) => x.space.localeCompare(y.space));
    expect(spaces.map((s) => [s.space, s.files, s.bytes, s.busy])).toEqual([
      [A, 2, 8, false],
      [B, 1, 1, false],
    ]);
    expect(Date.now() - (spaces[1]?.used as number)).toBeGreaterThan(8 * 24 * 3600 * 1000);
    const status = await one.status();
    expect(status.spaces).toEqual({ count: 2, bytes: 9 });
    expect(status.disk?.total).toBeGreaterThan(0);
    expect(status.limits).toMatchObject({ seconds: 60, maxSeconds: 300, idleDays: 90 });
    // The fake's word for when the image was built is no date: it is not passed on as one.
    expect(status.built).toBeNull();
  });

  it("says when the image was built, as Docker has it", async () => {
    const docker = fakeDocker();
    const start: Start = (args, input) =>
      args.includes("{{.Created}}")
        ? answer(0, "2026-11-20T08:00:00.123456789Z\n")
        : docker.start(args, input);
    const one = new Runner(root, image, { start, attach: attachOf(start), log: () => {} });
    await one.prepare();
    expect((await one.status()).built).toBe("2026-11-20T08:00:00.123Z");
  });

  it("releases a workspace, but never one something is running in", async () => {
    const { docker, free } = holding();
    const one = runner(docker);
    await one.prepare();
    await one.put(A, "a.txt", text("x"));
    await one.put(B, "b.txt", text("x"));
    const running = one.run(A, { code: "x" });
    await soon();
    expect((await one.spaces()).find((s) => s.space === A)?.busy).toBe(true);
    await expect(one.release(A)).rejects.toMatchObject({ code: "in_use" });
    await one.release(B);
    expect(await one.list(B)).toEqual([]);
    expect((await one.list(A)).length).toBe(1);
    free();
    await running;
    // Used since it was last looked at: kept.
    await expect(one.release(A, 1)).rejects.toMatchObject({ code: "in_use" });
    await one.release(A);
    expect(await one.spaces()).toEqual([]);
    // One that is not there is no error: it was released already.
    await one.release(A);
  });

  it("answers the same over HTTP", async () => {
    const { docker, free } = holding();
    const one = runner(docker);
    await one.prepare();
    await one.put(B, "b.txt", text("xyz"));
    const server = serve(one);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const at = (path: string) => `http://127.0.0.1:${address.port}${path}`;
    try {
      const run = fetch(at(`/spaces/${A}/run`), {
        method: "POST",
        body: JSON.stringify({ code: "x" }),
      });
      await soon();
      await soon();
      expect(await (await fetch(at("/running"))).json()).toMatchObject([
        { space: A, state: "running", language: "python" },
      ]);
      expect(await (await fetch(at("/status"))).json()).toMatchObject({
        ready: true,
        running: 1,
        spaces: { count: 2, bytes: 3 },
      });
      const spaces = (await (await fetch(at("/spaces"))).json()) as { space: string }[];
      expect(spaces.map((s) => s.space).sort()).toEqual([A, B]);
      // Released for being idle: refused while it runs, with a status that says why.
      const refused = await fetch(at(`/spaces/${A}?idle=1`), { method: "DELETE" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: "in_use" });
      const released = await fetch(at(`/spaces/${B}?idle=1`), { method: "DELETE" });
      expect(released.status).toBe(200);
      const stop = await fetch(at(`/spaces/${A}/stop`), { method: "POST" });
      expect(await stop.json()).toEqual({ ended: 1 });
      free();
      const ended = await run;
      expect(ended.status).toBe(499);
      expect(await ended.json()).toMatchObject({
        error: "ended",
        message: "An administrator stopped this run.",
      });
      expect((await fetch(at("/spaces/nope/stop"), { method: "POST" })).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
