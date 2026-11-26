import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Bench,
  changes,
  clip,
  describe as describeFolders,
  halt,
  jobsOf,
  newBench,
  runCode,
  stopJob,
  undo,
  undoable,
} from "./bench";
import { globToRegExp, LocalError } from "./local";

let web: string;
let api: string;
let bench: Bench;
const run = (tool: string, args: Record<string, unknown>, roots = [web, api]) =>
  runCode(roots, tool, args, bench);
/** Sets a file's time back, so a change a moment later is seen as a change. */
const age = (file: string) => utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "muster-bench-"));
  web = join(base, "web");
  api = join(base, "api");
  mkdirSync(join(web, "src"), { recursive: true });
  mkdirSync(api);
  writeFileSync(
    join(web, "src", "app.ts"),
    "export function greet() {\n  return 'hello';\n}\n\nexport function part() {\n  return 'hello';\n}\n",
  );
  writeFileSync(join(web, "README.md"), "# Web\n");
  writeFileSync(join(api, "server.py"), "def approve():\n    return 'ok'\n");
  bench = newBench();
});

describe("working on code in attached folders (CHA-273)", () => {
  it("runs a command in a folder and gives what it printed and how it ended", async () => {
    const ok = await run("exec", { command: "echo one && echo two 1>&2", in: "web" });
    expect(ok).toMatch(/^Exit code 0 after \d+ s, in web\.\n/);
    expect(ok).toMatch(/one\ntwo$/);
    expect(await run("exec", { command: "pwd", in: "api" })).toContain("/api");
    expect(await run("exec", { command: "exit 3" })).toMatch(/^Exit code 3 /);
    // Only in an attached folder, and only a folder.
    await expect(run("exec", { command: "ls", in: "elsewhere" })).rejects.toThrow(LocalError);
    await expect(run("exec", { command: "ls", in: "web/README.md" })).rejects.toThrow(/folder/);
    await expect(run("exec", { command: " " })).rejects.toThrow(/command/);
  });

  it("keeps a command that goes on as a job that can be read, waited for and stopped", async () => {
    const started = await run("exec", {
      command: "echo ready; sleep 30; echo never",
      in: "web",
      background: true,
    });
    expect(started).toMatch(/^Started as job j1, in web\./);
    expect(started).toContain("ready");
    expect(await run("job", {})).toMatch(/^Job j1 is running/);
    // The person sees it beside the conversation, with the last of what it printed.
    expect(jobsOf(bench)).toMatchObject([
      { id: "j1", where: "web", running: true, command: "echo ready; sleep 30; echo never" },
    ]);
    expect(jobsOf(bench)[0]?.tail).toContain("ready");
    // What it printed before is not said again.
    expect(await run("job", { id: "j1" })).toContain("(Nothing new was printed.)");
    const stopped = await run("job", { id: "j1", do: "stop" });
    expect(stopped).toMatch(/^Job j1 ended/);
    // The line after the one that names it is what it printed: not what came after the sleep.
    expect(stopped.split("\n").slice(1).join("\n")).not.toContain("never");
    // Once its end has been read it is gone.
    await expect(run("job", { id: "j1" })).rejects.toThrow(/no job/);

    // One that outlives its call's wait becomes a job by itself, and can be waited for.
    const slow = await run("exec", { command: "sleep 2; echo done", in: "api", wait: 1 });
    expect(slow).toMatch(/^Still running after 1 s as job j2/);
    expect(await run("job", { id: "j2", do: "wait", wait: 10 })).toMatch(
      /^Job j2 ended with exit code 0[^\n]*\ndone$/,
    );
  });

  it("ends the commands of a run that was stopped, and leaves jobs going", async () => {
    await run("exec", { command: "sleep 30", in: "web", background: true });
    const waiting = run("exec", { command: "sleep 30; echo late", in: "web", wait: 20 });
    await new Promise((done) => setTimeout(done, 300));
    const began = Date.now();
    halt(bench);
    const ended = await waiting;
    // It was ended, not waited out: it came back at once, without what came after the sleep.
    expect(Date.now() - began).toBeLessThan(4000);
    expect(ended).toMatch(/^Exit code /);
    expect(ended).not.toContain("late");
    expect(await run("job", {})).toMatch(/^Job j1 is running/);
    // The person stops it themselves.
    stopJob(bench, "j1");
    expect(await run("job", { id: "j1", do: "wait", wait: 10 })).toMatch(/^Job j1 ended/);
  });

  it("changes a file by an exact piece, only as the agent last saw it", async () => {
    const path = "web/src/app.ts";
    const once = {
      path,
      old: "export function greet() {\n  return 'hello';",
      new: "export function greet() {\n  return 'hi';",
    };
    // Not before it was read.
    await expect(run("edit", once)).rejects.toThrow(/Read web\/src\/app\.ts first/);
    await run("read", { path });
    // A piece that is there twice is not guessed at.
    await expect(run("edit", { path, old: "return 'hello';", new: "return 'x';" })).rejects.toThrow(
      /2 times/,
    );
    await expect(run("edit", { path, old: "nothing like this", new: "x" })).rejects.toThrow(
      /not in web\/src\/app\.ts/,
    );
    expect(await run("edit", once)).toBe("Changed web/src/app.ts: 1 place, 2 lines replaced by 2.");
    expect(readFileSync(join(web, "src", "app.ts"), "utf8")).toContain("return 'hi';");
    // Its own change is what it saw: the next one needs no reading again.
    expect(await run("edit", { path, old: "'hello'", new: "'bye'" })).toMatch(/^Changed/);
    // Spacing that differs is set aside when the lines are otherwise the piece, once.
    expect(
      await run("edit", {
        path,
        old: "export function part() {\nreturn 'bye';",
        new: "export function part() {\n  return 1;",
      }),
    ).toMatch(/^Changed/);
    expect(readFileSync(join(web, "src", "app.ts"), "utf8")).toContain("  return 1;");

    // The person saved the file in their editor meanwhile: nothing is written over it.
    age(join(web, "src", "app.ts"));
    await expect(run("edit", { path, old: "return 1;", new: "return 2;" })).rejects.toThrow(
      /has changed since you read it/,
    );
    await expect(run("write", { path, content: "gone" })).rejects.toThrow(/has changed/);
    expect(readFileSync(join(web, "src", "app.ts"), "utf8")).toContain("return 1;");
    // A new file needs no reading; one that is there does.
    expect(await run("write", { path: "web/src/new.ts", content: "x" })).toMatch(/^Created/);
    await expect(run("write", { path: "web/README.md", content: "x" })).rejects.toThrow(/first/);
    // Every one of them, when that is asked for.
    await run("read", { path });
    expect(await run("edit", { path, old: "return", new: "yield", all: true })).toContain(
      "2 places",
    );
  });

  it("does not replace a whole file after reading only a part of it", async () => {
    const lines = Array.from({ length: 50 }, (_, n) => `line ${n + 1}`).join("\n");
    writeFileSync(join(api, "long.txt"), lines);
    await run("read", { path: "api/long.txt", from: 1, lines: 5 });
    await expect(run("write", { path: "api/long.txt", content: "short" })).rejects.toThrow(
      /only a part/,
    );
    // A piece of it can still be changed, and that is still not having read it all.
    expect(await run("edit", { path: "api/long.txt", old: "line 3\n", new: "third\n" })).toMatch(
      /^Changed/,
    );
    await expect(run("write", { path: "api/long.txt", content: "short" })).rejects.toThrow(
      /only a part/,
    );
    await run("read", { path: "api/long.txt" });
    expect(await run("write", { path: "api/long.txt", content: "short" })).toMatch(/^Replaced/);
  });

  it("keeps a file's own line endings, and takes a piece with other spacing as one place only", async () => {
    writeFileSync(join(api, "win.txt"), "one\r\n  two\r\nthree\r\n");
    await run("read", { path: "api/win.txt" });
    await run("edit", { path: "api/win.txt", old: "one\ntwo", new: "1\n2" });
    expect(readFileSync(join(api, "win.txt"), "utf8")).toBe("1\r\n2\r\nthree\r\n");
    await expect(
      run("edit", { path: "api/win.txt", old: "  three", new: "3", all: true }),
    ).rejects.toThrow(/other spacing/);
  });

  it("does not follow a link a repository holds to somewhere else, in a search or as its instructions", async () => {
    const elsewhere = join(web, "..", "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "notes"), "SECRET_TOKEN=abc123\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: web,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    symlinkSync(join(elsewhere, "notes"), join(web, "docs.txt"));
    symlinkSync(join(elsewhere, "notes"), join(web, "AGENTS.md"));
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    expect(await run("search", { query: "SECRET_TOKEN" })).toMatch(/^Nothing matches/);
    expect((await describeFolders([web]))[0]?.instructions).toEqual([]);
  });

  it("does not try a pattern that could take for ever", async () => {
    for (const query of ["(a+)+$", "(a|aa)+$", "((a)*)*b"])
      await expect(run("search", { query, regex: true }), query).rejects.toThrow(/for ever/);
    await expect(run("find", { pattern: "*a*b*c*d*e*f*g*h*i*" })).rejects.toThrow(/too long/);
    // An ordinary pattern with a group is still taken.
    expect(await run("search", { query: "(greet|part)\\(", regex: true })).toContain("app.ts");
  });

  it("puts back what a reply changed, and leaves alone what was changed again since", async () => {
    const reply = "reply-1";
    const act = (tool: string, args: Record<string, unknown>) =>
      runCode([web, api], tool, args, bench, reply);
    await act("read", { path: "web/src/app.ts" });
    await act("read", { path: "web/README.md" });
    const before = readFileSync(join(web, "src", "app.ts"), "utf8");
    await act("edit", { path: "web/src/app.ts", old: "'hello'", new: "'x'", all: true });
    await act("edit", { path: "web/src/app.ts", old: "greet", new: "salute" });
    await act("write", { path: "web/src/made.ts", content: "new" });
    await act("write", { path: "web/README.md", content: "# Rewritten\n" });
    expect(undoable(bench)).toEqual([
      { reply, files: ["web/src/app.ts", "web/src/made.ts", "web/README.md"] },
    ]);
    // A folder that is no longer attached is not written in.
    const other = "reply-2";
    await runCode([web, api], "read", { path: "api/server.py" }, bench, other);
    await runCode(
      [web, api],
      "edit",
      { path: "api/server.py", old: "'ok'", new: "'no'" },
      bench,
      other,
    );
    expect(await undo(bench, other, [web])).toEqual([
      "api/server.py: left as it is, its folder is no longer attached.",
    ]);
    // The person changes one of them again before undoing. (What counts is what the file
    // holds, not when it was saved.)
    writeFileSync(join(web, "README.md"), "# The person's own\n");
    expect((await undo(bench, reply, [web, api])).sort()).toEqual([
      "web/README.md: left as it is, it was changed again since.",
      "web/src/app.ts: put back.",
      "web/src/made.ts: removed, it was not there before.",
    ]);
    // Two changes to one file are undone to what it held before the first.
    expect(readFileSync(join(web, "src", "app.ts"), "utf8")).toBe(before);
    expect(existsSync(join(web, "src", "made.ts"))).toBe(false);
    expect(readFileSync(join(web, "README.md"), "utf8")).toBe("# The person's own\n");
    expect(undoable(bench)).toEqual([]);
    expect(await undo(bench, reply, [web, api])).toEqual([]);
    // Having put a file back, the agent must read it again before changing it.
    await expect(act("edit", { path: "web/src/app.ts", old: "greet", new: "x" })).rejects.toThrow(
      /first/,
    );
  });

  it("reads a part of a file by lines", async () => {
    writeFileSync(
      join(api, "long.txt"),
      Array.from({ length: 50 }, (_, n) => `line ${n + 1}`).join("\n"),
    );
    expect(await run("read", { path: "api/long.txt", from: 10, lines: 3 })).toBe(
      "[Lines 10 to 12 of 50.]\nline 10\nline 11\nline 12",
    );
    await expect(run("read", { path: "api/long.txt", from: 99 })).rejects.toThrow(/50 lines/);
  });

  it("searches each folder with its own share and says what it covered", async () => {
    const found = await run("search", { query: "return" });
    expect(found).toContain("web/src/app.ts:2:");
    expect(found).toContain("api/server.py:2:");
    expect(found).toContain(
      "[web: 2 files looked through, 2 found. api: 1 file looked through, 1 found.]",
    );
    // By pattern, and only in files of a kind.
    const narrow = await run("search", { query: "def \\w+\\(", regex: true, glob: "*.py" });
    expect(narrow).toContain("api/server.py:1: def approve():");
    expect(narrow).toContain("web: 0 files looked through, 0 found");
    // Nothing found says where it looked.
    expect(await run("search", { query: "zzzz" })).toMatch(
      /^Nothing matches "zzzz"\.\n\[web: 2 files looked through, 0 found\. api: 1 file/,
    );
    await expect(run("search", { query: "((", regex: true })).rejects.toThrow(/pattern/);
    // By name.
    expect(await run("find", { pattern: "**/*.ts" })).toBe("web/src/app.ts");
    expect(await run("find", { pattern: "*.md", path: "web" })).toBe("web/README.md");
    expect(await run("find", { pattern: "*.rs" })).toMatch(/^No file/);
  });

  it("leaves out what a repository ignores, and says what a folder is", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: web,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    git("checkout", "-q", "-b", "main");
    writeFileSync(join(web, ".gitignore"), "dist/\n");
    mkdirSync(join(web, "dist"));
    writeFileSync(join(web, "dist", "bundle.js"), "return 'built';");
    writeFileSync(join(web, "AGENTS.md"), "Run pnpm test before you say it works.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(web, "README.md"), "# Web, changed\n");
    expect(await run("search", { query: "built" })).toMatch(/^Nothing matches/);
    expect(await describeFolders([web, api])).toEqual([
      {
        name: "web",
        repository: true,
        branch: "main",
        changed: 1,
        instructions: [{ file: "web/AGENTS.md", text: "Run pnpm test before you say it works.\n" }],
        checks: [],
      },
      { name: "api", repository: false, branch: null, changed: 0, instructions: [], checks: [] },
    ]);
    // What a repository says checks it.
    writeFileSync(
      join(web, "muster.json"),
      JSON.stringify({ checks: ["npm test", "", 3, "npm run lint"] }),
    );
    expect((await describeFolders([web]))[0]?.checks).toEqual(["npm test", "npm run lint"]);
    // What the person is shown beside the conversation: what changed, file by file.
    writeFileSync(join(web, "src", "fresh.ts"), "export const fresh = 1;\n");
    writeFileSync(join(web, ".env"), "KEY=secret");
    const changed = await changes([web, api]);
    expect(changed.map((repo) => repo.name)).toEqual(["web"]);
    expect(changed[0]).toMatchObject({ branch: "main", more: 0 });
    const files = Object.fromEntries((changed[0]?.files ?? []).map((file) => [file.path, file]));
    expect(files["README.md"]).toMatchObject({ state: "M", agent: false });
    expect(files["README.md"]?.diff).toContain("-# Web\n+# Web, changed");
    expect(files["src/fresh.ts"]).toMatchObject({
      state: "?",
      // The whole of the file, without a line for the line break that ends it.
      diff: "+export const fresh = 1;",
    });
    // A file that holds secrets is named and never shown.
    expect(files[".env"]).toMatchObject({ state: "?", diff: "" });
  });

  it("keeps the beginning and the end of something long, and reads name patterns", () => {
    const long = `${"a".repeat(50_000)}END`;
    const cut = clip(long, 1000);
    expect(cut.length).toBeLessThan(1100);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("END")).toBe(true);
    expect(cut).toContain("characters left out");
    expect(globToRegExp("src/**/*.test.ts").test("src/a/b/x.test.ts")).toBe(true);
    expect(globToRegExp("src/**/*.test.ts").test("src/x.test.ts")).toBe(true);
    expect(globToRegExp("*.{md,txt}").test("notes.txt")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
  });
});
