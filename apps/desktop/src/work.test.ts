import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { newBench } from "./bench";
import { memoryStore, rootsFor } from "./task";
import { doCall, undoableFor, undoFor, type Work } from "./work";

const CONVERSATION = "01a20bc2-dede-747f-b7fd-1d9b455d51e0";
const BRANCH = "muster/fix-the-cart-total-5d51e0";
let base: string;
let repo: string;
let notes: string;
let work: Work;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dana",
      GIT_AUTHOR_EMAIL: "dana@acme.test",
      GIT_COMMITTER_NAME: "Dana",
      GIT_COMMITTER_EMAIL: "dana@acme.test",
    },
  }).trim();
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "muster-work-")));
  repo = join(base, "web");
  notes = join(base, "notes");
  mkdirSync(repo);
  mkdirSync(notes);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "cart.js"), "export const total = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(join(notes, "todo.txt"), "one\n");
  work = {
    store: memoryStore(),
    home: join(base, "copies"),
    server: "https://muster.test",
    conversation: CONVERSATION,
    title: "Fix the cart total",
    folders: [repo, notes],
    bench: newBench(),
    env: process.env,
  };
});

describe("a call done as part of a conversation's work", () => {
  it("leaves the repository alone while the agent only looks", async () => {
    await doCall(work, { tool: "read", args: { path: "web/cart.js" }, reply: "r1" });
    const looked = await doCall(work, {
      tool: "exec",
      args: { command: "git status --short", in: "web" },
      reply: "r1",
      changes: false,
    });
    expect(looked).not.toContain("From Muster");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(work.store.all()).toEqual([]);
    expect(await undoableFor(work.folders, work.bench)).toEqual([]);
  });

  it("does not move the work for a command alone, and can still put back what the command changed", async () => {
    // The person's own unfinished work is in the folder: their tests are run there.
    writeFileSync(join(repo, "cart.js"), "export const total = 1; // mine, unfinished\n");
    const ran = await doCall(work, {
      tool: "exec",
      args: { command: "cat cart.js && printf 'report\\n' > report.txt", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(ran).toContain("mine, unfinished");
    expect(ran).not.toContain("From Muster");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(work.store.all()).toEqual([]);
    expect(await undoableFor(work.folders, work.bench)).toEqual([
      { reply: "r1", files: ["web/report.txt"] },
    ]);
    await undoFor(work.folders, work.bench, "r1");
    expect(existsSync(join(repo, "report.txt"))).toBe(false);
    expect(read(repo, "cart.js")).toContain("mine, unfinished");
  });

  it("says where the work was moved to when the change itself is refused there", async () => {
    writeFileSync(join(repo, "cart.js"), "export const total = 1; // mine, unfinished\n");
    await doCall(work, { tool: "read", args: { path: "web/cart.js" }, reply: "r1" });
    // Read in the person's folder; the edit lands in the copy, where it was not read yet.
    const refused = await doCall(work, {
      tool: "edit",
      args: { path: "web/cart.js", old: "total = 1", new: "total = 2" },
      reply: "r1",
    }).catch((error) => String(error.message));
    expect(refused).toContain("[From Muster, about where this work is done]");
    expect(refused).toContain("copy of the repository");
    expect(read(repo, "cart.js")).toContain("mine, unfinished");
  });

  it("gives the first change a branch, says so once, and can put back what a command and an edit did", async () => {
    await doCall(work, { tool: "read", args: { path: "web/cart.js" }, reply: "r1" });
    const first = await doCall(work, {
      tool: "edit",
      args: { path: "web/cart.js", old: "total = 1", new: "total = 2" },
      reply: "r1",
    });
    expect(first).toContain("Changed web/cart.js");
    expect(first).toContain(`[From Muster, about where this work is done]`);
    expect(first).toContain(BRANCH);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
    const second = await doCall(work, {
      tool: "exec",
      args: { command: "printf 'built\\n' > out.txt; exit 3", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(second).toContain("Exit code 3");
    expect(second).not.toContain("From Muster");
    // A later reply's change is its own.
    await doCall(work, {
      tool: "write",
      args: { path: "web/new.js", content: "export const n = 1;\n" },
      reply: "r2",
    });
    const list = await undoableFor(work.folders, work.bench);
    expect(list.map((one) => [one.reply, [...one.files].sort()])).toEqual([
      ["r1", ["web/cart.js", "web/out.txt"]],
      ["r2", ["web/new.js"]],
    ]);
    // Put back by a bench that knows nothing: as after the app was started again.
    const said = await undoFor(work.folders, newBench(), "r1");
    expect([...said].sort()).toEqual([
      "web/cart.js: put back.",
      "web/out.txt: removed, it was not there before.",
    ]);
    expect(read(repo, "cart.js")).toBe("export const total = 1;\n");
    expect(existsSync(join(repo, "new.js"))).toBe(true);
    expect((await undoableFor(work.folders, work.bench)).map((one) => one.reply)).toEqual(["r2"]);
  });

  it("works in a copy when the person's own work is in the folder, and reads there from then on", async () => {
    writeFileSync(join(repo, "cart.js"), "export const total = 1; // mine, unfinished\n");
    const made = await doCall(work, {
      tool: "write",
      args: { path: "web/tax.js", content: "export const tax = 1;\n" },
      reply: "r1",
    });
    expect(made).toContain("left exactly as it is");
    const [copy] = rootsFor(work.store, work.server, CONVERSATION, work.folders);
    expect(copy).not.toBe(repo);
    expect(existsSync(join(repo, "tax.js"))).toBe(false);
    expect(read(copy as string, "tax.js")).toBe("export const tax = 1;\n");
    expect(read(repo, "cart.js")).toContain("mine, unfinished");
    // The same name, the conversation's own folder.
    expect(await doCall(work, { tool: "read", args: { path: "web/cart.js" }, reply: "r1" })).toBe(
      "export const total = 1;\n",
    );
    // Another conversation still sees the person's folder.
    expect(
      await doCall(
        { ...work, conversation: "02b30bc2-dede-747f-b7fd-1d9b455d51e1" },
        { tool: "read", args: { path: "web/cart.js" } },
      ),
    ).toContain("mine, unfinished");
    await undoFor(work.folders, work.bench, "r1");
    expect(existsSync(join(copy as string, "tax.js"))).toBe(false);
    expect(read(repo, "cart.js")).toContain("mine, unfinished");
  });

  it("keeps the way back it had for a folder that is not a repository", async () => {
    await doCall(work, { tool: "read", args: { path: "notes/todo.txt" }, reply: "r1" });
    const said = await doCall(work, {
      tool: "edit",
      args: { path: "notes/todo.txt", old: "one", new: "two" },
      reply: "r1",
    });
    expect(said).not.toContain("From Muster");
    expect(await undoableFor(work.folders, work.bench)).toEqual([
      { reply: "r1", files: ["notes/todo.txt"] },
    ]);
    expect(await undoFor(work.folders, work.bench, "r1")).toEqual(["notes/todo.txt: put back."]);
    expect(read(notes, "todo.txt")).toBe("one\n");
  });

  it("gives a command that changes something a branch too, and takes the branch back after one that changed nothing", async () => {
    // A test run in a clean folder: afterwards the folder is where it was.
    const ran = await doCall(work, {
      tool: "exec",
      args: { command: "cat cart.js", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(ran).not.toContain("From Muster");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo, "branch", "--list", "muster/*")).toBe("");
    expect(work.store.all()).toEqual([]);
    // A formatter, a generator: what it changed is on the work's branch, and said so.
    const changed = await doCall(work, {
      tool: "exec",
      args: { command: "printf 'export const total = 2;\\n' > cart.js", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(changed).toContain(BRANCH);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
    expect(await undoableFor(work.folders, work.bench)).toEqual([
      { reply: "r1", files: ["web/cart.js"] },
    ]);
  });

  it("refuses a change it cannot give a place of its own, and changes nothing", async () => {
    writeFileSync(join(repo, "cart.js"), "export const total = 1; // mine, unfinished\n");
    // Where copies would go cannot be made.
    writeFileSync(work.home, "in the way");
    const refused = await doCall(work, {
      tool: "write",
      args: { path: "web/tax.js", content: "export const tax = 1;\n" },
      reply: "r1",
    }).catch((error) => String(error.message));
    expect(refused).toContain("Nothing was changed.");
    expect(existsSync(join(repo, "tax.js"))).toBe(false);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(read(repo, "cart.js")).toContain("mine, unfinished");
    expect(await undoableFor(work.folders, work.bench)).toEqual([]);
  });

  it("can still put back a file git ignores, and one inside a repository within the repository", async () => {
    writeFileSync(join(repo, ".gitignore"), "local/\n");
    mkdirSync(join(repo, "local"));
    writeFileSync(join(repo, "local", "settings.json"), '{"a":1}\n');
    const inner = join(repo, "vendor");
    mkdirSync(inner);
    git(inner, "init", "-q", "-b", "main");
    writeFileSync(join(inner, "lib.js"), "export const v = 1;\n");
    git(inner, "add", "-A");
    git(inner, "commit", "-q", "-m", "inner");
    // Known to the outer repository as a repository of its own, so the folder is clean.
    execFileSync("git", ["add", ".gitignore", "vendor"], { cwd: repo, stdio: "ignore" });
    git(repo, "commit", "-q", "-m", "ignore");
    for (const path of ["web/local/settings.json", "web/vendor/lib.js"])
      await doCall(work, { tool: "read", args: { path }, reply: "r1" });
    await doCall(work, {
      tool: "edit",
      args: { path: "web/local/settings.json", old: '"a":1', new: '"a":2' },
      reply: "r1",
    });
    await doCall(work, {
      tool: "edit",
      args: { path: "web/vendor/lib.js", old: "v = 1", new: "v = 2" },
      reply: "r1",
    });
    const [listed] = await undoableFor(work.folders, work.bench);
    expect(listed?.reply).toBe("r1");
    expect([...(listed?.files ?? [])].sort()).toEqual([
      "web/local/settings.json",
      "web/vendor/lib.js",
    ]);
    const said = await undoFor(work.folders, work.bench, "r1");
    expect([...said].sort()).toEqual([
      "web/local/settings.json: put back.",
      "web/vendor/lib.js: put back.",
    ]);
    expect(read(repo, "local/settings.json")).toBe('{"a":1}\n');
    expect(read(inner, "lib.js")).toBe("export const v = 1;\n");
  });

  it("says once which large files undo does not cover", async () => {
    writeFileSync(join(repo, "dump.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    const first = await doCall(work, {
      tool: "exec",
      args: { command: "printf 'x\\n' > x.txt", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(first).toContain("Not covered by undo");
    expect(first).toContain("dump.bin");
    const second = await doCall(work, {
      tool: "exec",
      args: { command: "printf 'y\\n' > y.txt", in: "web" },
      reply: "r1",
      changes: true,
    });
    expect(second).not.toContain("Not covered by undo");
  });

  it("answers a pull request call only for a conversation's work", async () => {
    await expect(doCall(work, { tool: "pr", args: { do: "look", in: "web" } })).rejects.toThrow(
      "no branch",
    );
    await expect(doCall(work, { tool: "pr", args: { do: "merge" } })).rejects.toThrow('"do"');
    await expect(
      doCall({ ...work, conversation: null }, { tool: "pr", args: { do: "look" } }),
    ).rejects.toThrow("conversation");
  });
});
