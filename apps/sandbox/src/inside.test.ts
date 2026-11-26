/**
 * The program that runs inside a sandbox (image/entry.py), driven by the runner as it is
 * in a container, without one: the same pieces over the same standard input and output.
 * What Docker adds (no network, no privileges, the limits) is not tried here; what is
 * tried is that the two ends say the same thing: files in and out, what is printed as it
 * is printed, the connections passed out and answered, a run stopped.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { greeting } from "./egress.test.js";
import { serve } from "./index.js";
import { attachWith, Refused, Runner, type Start } from "./runner.js";

const python = spawnSync("python3", ["--version"]).status === 0;
const image = fileURLToPath(new URL("../image", import.meta.url));
const SPACE = "0193a5b0-0000-7000-8000-00000000e2e1";
const text = (value: string) => new TextEncoder().encode(value);

/** Docker, for everything but the run itself. */
const docker: Start = (args) => ({
  done: Promise.resolve({
    code: 0,
    stdout: text(args[0] === "info" ? '{"runsc":{}}' : args[0] === "image" ? "sha256:abc" : ""),
    stderr: "",
  }),
  kill() {},
});
/** The run: entry.py by itself, with a folder of its own in place of the container's. */
const inside = attachWith(() => {
  const at = mkdtempSync(join(tmpdir(), "inside-"));
  return spawn("python3", [join(image, "entry.py")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MUSTER_SANDBOX_WORK: join(at, "work"),
      MUSTER_SANDBOX_TMP: join(at, "tmp"),
      // Any port that is free: a container has its loopback to itself, a test does not.
      MUSTER_SANDBOX_PROXY_PORT: "0",
    },
  });
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
async function runner(options: ConstructorParameters<typeof Runner>[2] = {}) {
  const one = new Runner(mkdtempSync(join(tmpdir(), "spaces-")), image, {
    start: docker,
    attach: inside,
    log: () => {},
    ...options,
  });
  await one.prepare();
  return one;
}

describe.skipIf(!python)("a run, from the inside", () => {
  it("takes the files in, hands back what changed, and says what it used", async () => {
    const one = await runner();
    await one.put(SPACE, "数据/报告.txt", text("十二"));
    const ran = await one.run(SPACE, {
      language: "shell",
      code: 'cat "数据/报告.txt" > out.txt; echo done; echo careful >&2',
    });
    expect(ran).toMatchObject({
      exit: 0,
      timedOut: false,
      stdout: "done\n",
      stderr: "careful\n",
      changed: [{ name: "out.txt", size: 6 }],
      net: [],
    });
    // How long it took is this service's clock, and so is what the answer says it took.
    expect(ran.wall).toBeGreaterThan(0);
    expect(ran.seconds).toBe(ran.wall);
    expect(ran.cpus).toBe(2);
    expect(ran.bytesOut).toBeGreaterThan(0);
    expect(new TextDecoder().decode(await one.get(SPACE, "out.txt"))).toBe("十二");
    // And with no host to reach, the code is given no way out to try.
    const bare = await one.run(SPACE, {
      language: "shell",
      code: 'if [ -z "$HTTPS_PROXY" ]; then echo "[none]"; else echo "[set]"; fi',
    });
    expect(bare.stdout).toBe("[none]\n");
  });

  it("says what is printed while the code is still running", async () => {
    const one = await runner();
    const said: { stream: string; text: string; at: number }[] = [];
    const began = Date.now();
    const ran = await one.run(
      SPACE,
      { language: "shell", code: "echo first; sleep 0.6; echo second; echo oops >&2" },
      { said: (stream, words) => said.push({ stream, text: words, at: Date.now() - began }) },
    );
    const took = Date.now() - began;
    expect(said.map((one) => one.text).join("")).toContain("first\n");
    expect(
      said
        .filter((one) => one.stream === "out")
        .map((one) => one.text)
        .join(""),
    ).toBe("first\nsecond\n");
    expect(
      said
        .filter((one) => one.stream === "err")
        .map((one) => one.text)
        .join(""),
    ).toBe("oops\n");
    // The first word came well before the end, not with it.
    expect((said[0]?.at ?? took) + 400).toBeLessThan(took);
    // What the model is told is what it was always told: all of it, at the end.
    expect(ran.stdout).toBe("first\nsecond\n");
    expect(ran.stderr).toBe("oops\n");
  });

  it("shows no more than a run may show, and still hands back the beginning and the end", async () => {
    const one = await runner({ limits: { saidBytes: 1000 } });
    let shown = 0;
    const ran = await one.run(
      SPACE,
      { language: "shell", code: "head -c 50000 /dev/zero | tr '\\0' x; echo; echo end" },
      { said: (_stream, words) => (shown += words.length) },
    );
    expect(shown).toBe(1000);
    expect(ran.stdout.length).toBe(1000);
    expect(ran.exit).toBe(0);
  });

  it("ends when its time is up, and when it is stopped", async () => {
    const one = await runner();
    const late = await one.run(SPACE, { language: "shell", code: "echo a; sleep 3", seconds: 1 });
    expect(late).toMatchObject({ timedOut: true, stdout: "a\n" });
    const stop = new AbortController();
    const began = Date.now();
    const stopped = one
      .run(
        SPACE,
        { language: "shell", code: "echo started; sleep 3" },
        { signal: stop.signal, said: () => stop.abort() },
      )
      .catch((error) => error);
    const error = await stopped;
    expect(error).toBeInstanceOf(Refused);
    expect((error as Refused).code).toBe("stopped");
    expect(Date.now() - began).toBeLessThan(2500);
    // Stopped before it began: nothing is started.
    await expect(one.run(SPACE, { code: "x" }, { signal: stop.signal })).rejects.toMatchObject({
      code: "stopped",
    });
  });

  it("reaches a host it was given through the runner, and is refused any other", async () => {
    const got: Buffer[] = [];
    const out = createServer((socket) => {
      socket.on("data", (chunk) => {
        got.push(chunk);
        socket.write("answer");
      });
      socket.on("error", () => {});
    });
    servers.push(out);
    await new Promise<void>((resolve) => out.listen(0, "127.0.0.1", resolve));
    const port = (out.address() as { port: number }).port;
    const dialled: string[] = [];
    const one = await runner({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (address, to) => {
        dialled.push(`${address}:${to}`);
        return connect({ host: "127.0.0.1", port });
      },
    });
    const first = await greeting("pypi.org");
    await one.put(SPACE, "hello.bin", first);
    const ran = await one.run(SPACE, {
      language: "shell",
      hosts: ["pypi.org", "10.0.0.1", "not a host"],
      code: [
        // The proxy is on the run's own loopback; bash opens the connections itself.
        'port=$(echo "$HTTPS_PROXY" | sed "s/.*://")',
        "exec 3<>/dev/tcp/127.0.0.1/$port",
        "printf 'CONNECT evil.example:443 HTTP/1.1\\r\\n\\r\\n' >&3",
        'read -r line <&3; echo "$line"',
        "exec 3<&- 3>&-",
        "exec 4<>/dev/tcp/127.0.0.1/$port",
        "printf 'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n' >&4",
        'read -r line <&4; echo "$line"',
        "read -r blank <&4",
        "cat hello.bin >&4",
        "head -c 6 <&4; echo",
        'echo "pip goes to $(basename "$PYTHONUSERBASE")"',
      ].join("\n"),
    });
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toContain("HTTP/1.1 403 Forbidden");
    expect(ran.stdout).toContain("HTTP/1.1 200 Connection Established");
    expect(ran.stdout).toContain("answer\n");
    expect(ran.stdout).toContain("pip goes to .local");
    // What went out is what the code sent, to the address the name was found at.
    expect(Buffer.concat(got).equals(first)).toBe(true);
    expect(dialled).toEqual(["93.184.216.34:443"]);
    expect(ran.net).toMatchObject([
      { host: "evil.example", ok: false, times: 1 },
      { host: "pypi.org", ok: true, times: 1, up: first.length, down: 6 },
    ]);
  });

  it("is told about over the service a line at a time, and ends when whoever asked goes away", async () => {
    const one = await runner();
    const service = serve(one);
    servers.push(service as unknown as Server);
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(service.address() as { port: number }).port}/spaces/${SPACE}/run`;
    const ask = (code: string, signal?: AbortSignal) =>
      fetch(at, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "shell", code, live: true }),
        ...(signal ? { signal } : {}),
      });
    const lines = (await (await ask("echo one; sleep 0.4; echo two; exit 3")).text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { said?: { text: string }; ran?: { exit: number; stdout: string } },
      );
    expect(lines.slice(0, -1).every((line) => line.said)).toBe(true);
    expect(
      lines
        .slice(0, -1)
        .map((line) => line.said?.text)
        .join(""),
    ).toBe("one\ntwo\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)?.ran).toMatchObject({ exit: 3, stdout: "one\ntwo\n" });
    // What cannot be run is said in a last line too, not left unsaid.
    const refused = await ask("");
    expect(JSON.parse((await refused.text()).trim())).toMatchObject({ error: "bad_request" });

    // Whoever asked hangs up: the run does not go on without them.
    const gone = new AbortController();
    const reply = await ask("echo started; sleep 3", gone.signal);
    const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(one.state().running).toBe(1);
    const began = Date.now();
    gone.abort();
    await reader.read().catch(() => {});
    for (let i = 0; i < 100 && one.state().running > 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(one.state().running).toBe(0);
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("does not let one connection the code does not read hold up another", async () => {
    // The first connection is sent four megabytes it never reads; the second is answered.
    let n = 0;
    const out = createServer((socket) => {
      n += 1;
      const flood = n === 1;
      socket.on("data", () => {
        if (flood) socket.write(Buffer.alloc(4 * 1024 * 1024, 120));
        else socket.write("answer");
      });
      socket.on("error", () => {});
    });
    servers.push(out);
    await new Promise<void>((resolve) => out.listen(0, "127.0.0.1", resolve));
    const port = (out.address() as { port: number }).port;
    const one = await runner({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: () => connect({ host: "127.0.0.1", port }),
    });
    await one.put(SPACE, "hello.bin", await greeting("pypi.org"));
    const ran = await one.run(SPACE, {
      language: "shell",
      seconds: 20,
      hosts: ["pypi.org"],
      code: [
        'port=$(echo "$HTTPS_PROXY" | sed "s/.*://")',
        "exec 3<>/dev/tcp/127.0.0.1/$port",
        "printf 'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n' >&3",
        "read -r line <&3; read -r blank <&3",
        "cat hello.bin >&3",
        "sleep 0.5",
        "exec 4<>/dev/tcp/127.0.0.1/$port",
        "printf 'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n' >&4",
        "read -r line <&4; read -r blank <&4",
        "cat hello.bin >&4",
        "head -c 6 <&4; echo",
      ].join("\n"),
    });
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toBe("answer\n");
    expect(ran.timedOut).toBe(false);
  });

  it("slows a host down to the pace of code that reads slowly, and loses none of what it sent", async () => {
    // Twenty-four megabytes, sent as fast as they are taken, to code that does not begin
    // to read for a second and a half. Before, more than sixteen waiting ended the connection.
    const size = 24 * 1024 * 1024;
    const body = Buffer.alloc(size);
    for (let at = 0; at < size; at += 4) body.writeUInt32BE(at, at);
    // Looked at while the code still sleeps: what the runner has taken from the host by
    // then is one window and what is on its way, not the whole of it.
    let early = -1;
    let taking: import("node:net").Socket | null = null;
    const out = createServer((socket) => {
      socket.once("data", () => {
        socket.write(body);
        setTimeout(() => {
          early = taking?.bytesRead ?? -1;
        }, 800);
      });
      socket.on("error", () => {});
    });
    servers.push(out);
    await new Promise<void>((resolve) => out.listen(0, "127.0.0.1", resolve));
    const port = (out.address() as { port: number }).port;
    const one = await runner({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: () => {
        taking = connect({ host: "127.0.0.1", port });
        return taking;
      },
    });
    await one.put(SPACE, "hello.bin", await greeting("pypi.org"));
    const ran = await one.run(SPACE, {
      language: "shell",
      seconds: 60,
      hosts: ["pypi.org"],
      code: [
        'port=$(echo "$HTTPS_PROXY" | sed "s/.*://")',
        "exec 3<>/dev/tcp/127.0.0.1/$port",
        "printf 'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n' >&3",
        "read -r line <&3; read -r blank <&3",
        "cat hello.bin >&3",
        "sleep 1.5",
        // Whichever of the two this machine has: one of them reads it all and says its sum.
        `head -c ${size} <&3 | { command -v sha256sum >/dev/null && sha256sum || shasum -a 256; }`,
      ].join("\n"),
    });
    expect(ran.stderr).toBe("");
    expect(ran.timedOut).toBe(false);
    expect(ran.stdout.trim().split(/\s+/)[0]).toBe(createHash("sha256").update(body).digest("hex"));
    expect(ran.net).toMatchObject([{ host: "pypi.org", ok: true, down: size }]);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(size / 2);
  });

  it.skipIf(process.platform !== "linux")(
    "keeps the code out of the pipe its answer goes out on",
    async () => {
      const one = await runner();
      // The code runs as the same user as the program that packs its answer. It looks for
      // that program's open files and tries to write to each: none opens.
      const ran = await one.run(SPACE, {
        language: "shell",
        code: [
          "for f in /proc/$PPID/fd/*; do",
          '  if (echo forged > "$f") 2>/dev/null; then echo "wrote $f"; fi',
          "done",
          "ls /proc/$PPID/fd 2>/dev/null | wc -l",
          "echo end",
        ].join("\n"),
      });
      expect(ran.stdout).not.toContain("wrote");
      expect(ran.stdout.trim().split("\n")).toEqual(["0", "end"]);
      expect(ran.exit).toBe(0);
    },
  );
});
