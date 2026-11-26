import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BIG_BYTES, covers, mark, record, undoableIn, undoIn } from "./undo";

let base: string;
let repo: string;
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
const write = (dir: string, name: string, text: string) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), text);
};
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
/** One call of a reply: the repository written down, the call done, what it changed taken down. */
const call = async (reply: string, does: () => void, only?: string, dir = repo) => {
  const before = await mark(dir);
  if (!before) throw new Error("no mark");
  does();
  return record(dir, reply, before, only);
};
const sorted = (list: { reply: string; files: string[] }[]) =>
  list.map((one) => ({ ...one, files: [...one.files].sort() }));

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "muster-undo-")));
  repo = join(base, "web");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "cart.js", "export const total = 1;\n");
  write(repo, "tax.js", "export const tax = 1;\n");
  write(repo, ".gitignore", "node_modules\n.env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});

describe("the way back from what a reply changed", () => {
  it("covers what a command did as well as a file tool, new files included, and outlives the app", async () => {
    // The person's own uncommitted work, there before the reply.
    write(repo, "mine.txt", "mine\n");
    expect(
      await call(
        "reply-1",
        () => write(repo, "cart.js", "export const total = 2;\n"),
        join(repo, "cart.js"),
      ),
    ).toEqual(["cart.js"]);
    await call("reply-1", () =>
      execFileSync("sh", ["-c", "printf 'made\\n' > built.txt && mv cart.js basket.js"], {
        cwd: repo,
      }),
    );
    // Nothing here is in memory: the list is read afresh, as after a restart.
    expect(sorted(await undoableIn([repo]))).toEqual([
      { reply: "reply-1", files: ["web/basket.js", "web/built.txt", "web/cart.js"] },
    ]);
    const { said, touched, left } = await undoIn([repo], "reply-1");
    expect([...said].sort()).toEqual([
      "web/basket.js: removed, it was not there before.",
      "web/built.txt: removed, it was not there before.",
      "web/cart.js: put back.",
    ]);
    expect(left).toBe(0);
    expect(touched).toContain(join(repo, "cart.js"));
    expect(read(repo, "cart.js")).toBe("export const total = 1;\n");
    // The person's own work is untouched, and so are their HEAD, index and stash.
    expect(read(repo, "mine.txt")).toBe("mine\n");
    expect(git(repo, "status", "--porcelain")).toBe("?? mine.txt");
    expect(git(repo, "stash", "list")).toBe("");
    // Everything was put back: nothing of it is kept.
    expect(await undoableIn([repo])).toEqual([]);
    expect(git(repo, "for-each-ref", "refs/muster/")).toBe("");
    expect((await undoIn([repo], "reply-1")).said).toEqual([]);
  });

  it("puts back only what the reply did: what the person changed before, between and after its calls is theirs", async () => {
    // Before the reply's first change: the person edits tax.js. Not the reply's.
    await call("reply-1", () => write(repo, "cart.js", "export const total = 2;\n"));
    // Between two of the reply's calls: the person edits tax.js and adds a file.
    write(repo, "tax.js", "export const tax = 2; // the person, meanwhile\n");
    write(repo, "theirs.txt", "the person's\n");
    await call("reply-1", () => write(repo, "new.js", "export const n = 1;\n"));
    // After the reply: the person changes what the reply made.
    write(repo, "new.js", "export const n = 2; // the person, afterwards\n");
    expect(sorted(await undoableIn([repo]))).toEqual([
      { reply: "reply-1", files: ["web/cart.js", "web/new.js"] },
    ]);
    const { said, left } = await undoIn([repo], "reply-1");
    expect([...said].sort()).toEqual([
      "web/cart.js: put back.",
      "web/new.js: left as it is, it was changed again since.",
    ]);
    expect(read(repo, "tax.js")).toContain("the person, meanwhile");
    expect(read(repo, "theirs.txt")).toBe("the person's\n");
    expect(read(repo, "new.js")).toContain("the person, afterwards");
    // Not everything was put back: what was not is kept, and can be tried again.
    expect(left).toBe(1);
    expect(await undoableIn([repo])).toEqual([{ reply: "reply-1", files: ["web/new.js"] }]);
    write(repo, "new.js", "export const n = 1;\n");
    expect((await undoIn([repo], "reply-1")).said).toEqual([
      "web/new.js: removed, it was not there before.",
    ]);
    expect(await undoableIn([repo])).toEqual([]);
  });

  it("leaves alone a file somebody else changed between two of the reply's own changes to it", async () => {
    await call("reply-1", () => write(repo, "cart.js", "export const total = 2;\n"));
    write(repo, "cart.js", "export const total = 2; // and the person added this\n");
    await call("reply-1", () => write(repo, "cart.js", "export const total = 3;\n"));
    const { said, left } = await undoIn([repo], "reply-1");
    expect(said).toEqual([
      "web/cart.js: left as it is, someone else changed it while the reply worked.",
    ]);
    expect(left).toBe(1);
    expect(read(repo, "cart.js")).toBe("export const total = 3;\n");
  });

  it("takes for a file tool only the file it wrote, and nothing of a reply that put things back itself", async () => {
    // While the tool wrote cart.js, something else moved: not the reply's.
    expect(
      await call(
        "reply-1",
        () => {
          write(repo, "cart.js", "export const total = 2;\n");
          write(repo, "tax.js", "export const tax = 9;\n");
        },
        join(repo, "cart.js"),
      ),
    ).toEqual(["cart.js"]);
    // The reply changes it back: nothing is left to undo.
    await call(
      "reply-1",
      () => write(repo, "cart.js", "export const total = 1;\n"),
      join(repo, "cart.js"),
    );
    expect(await undoableIn([repo])).toEqual([]);
    // A reply that changed nothing leaves nothing.
    expect(await call("reply-2", () => undefined)).toEqual([]);
    expect(await undoableIn([repo])).toEqual([]);
    // A name that is not a reply's is nothing.
    expect(await call("../../heads/main", () => write(repo, "x.txt", "x\n"))).toEqual([]);
    expect(git(repo, "for-each-ref", "refs/muster/")).not.toContain("heads");
  });

  it("says which files it covers: not what git ignores, not what is in a repository inside this one", async () => {
    const inner = join(repo, "vendor", "lib");
    mkdirSync(inner, { recursive: true });
    git(inner, "init", "-q", "-b", "main");
    write(inner, "a.js", "a\n");
    expect(await covers(repo, join(repo, "cart.js"))).toBe(true);
    expect(await covers(repo, join(repo, "src", "deep", "new.js"))).toBe(true);
    expect(await covers(repo, join(repo, ".env"))).toBe(false);
    expect(await covers(repo, join(repo, "node_modules", "x", "index.js"))).toBe(false);
    expect(await covers(repo, join(inner, "a.js"))).toBe(false);
    expect(await covers(base, join(base, "plain.txt"))).toBe(false);
  });

  it("does not write down an untracked file over 5 MB, and says which", async () => {
    writeFileSync(join(repo, "dump.bin"), Buffer.alloc(BIG_BYTES + 1, 1));
    const before = await mark(repo);
    expect(before?.skipped).toEqual(["dump.bin"]);
    writeFileSync(join(repo, "dump.bin"), Buffer.alloc(BIG_BYTES + 2, 2));
    write(repo, "small.txt", "s\n");
    expect(await record(repo, "reply-1", before as NonNullable<typeof before>)).toEqual([
      "small.txt",
    ]);
    // Nothing a checkpoint says tells where on the computer it was taken.
    const kept = git(repo, "log", "-1", "--format=%B", "refs/muster/undo/reply-1");
    expect(kept.trim()).toBe("Muster checkpoint");
    expect(kept).not.toContain(base);
  });

  it("writes one repository down once, whichever of its folders is attached", async () => {
    write(repo, "packages/a/a.js", "a\n");
    write(repo, "packages/b/b.js", "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "packages");
    const a = join(repo, "packages", "a");
    const b = join(repo, "packages", "b");
    // Two folders of the same repository, written down at the same moment.
    const [first, second] = await Promise.all([mark(a), mark(b)]);
    expect(first?.gitDir).toBe(second?.gitDir);
    write(repo, "packages/a/a.js", "a2\n");
    write(repo, "packages/b/b.js", "b2\n");
    await Promise.all([
      record(a, "reply-1", first as NonNullable<typeof first>, join(a, "a.js")),
      record(b, "reply-1", second as NonNullable<typeof second>, join(b, "b.js")),
    ]);
    // Each under the name of the folder it is in, once.
    expect(sorted(await undoableIn([a, b]))).toEqual([
      { reply: "reply-1", files: ["a/a.js", "packages/b/b.js"] },
    ]);
    const { said } = await undoIn([a, b], "reply-1");
    expect(said).toHaveLength(2);
    expect(read(repo, "packages/a/a.js")).toBe("a\n");
    expect(read(repo, "packages/b/b.js")).toBe("b\n");
    expect(
      readdirSync(join(repo, ".git")).filter((name) => name.startsWith("muster-index")),
    ).toEqual(["muster-index"]);
  });

  it("puts a file back as it was: one that can be run stays one", async () => {
    write(repo, "run.sh", "#!/bin/sh\necho 1\n");
    execFileSync("chmod", ["+x", join(repo, "run.sh")]);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "script");
    await call("reply-1", () => execFileSync("rm", [join(repo, "run.sh")]));
    expect(existsSync(join(repo, "run.sh"))).toBe(false);
    expect((await undoIn([repo], "reply-1")).said).toEqual(["web/run.sh: put back."]);
    expect(execFileSync("sh", ["-c", "./run.sh"], { cwd: repo, encoding: "utf8" })).toBe("1\n");
  });

  it("keeps the way back for the last forty replies", async () => {
    for (let n = 0; n < 43; n++)
      await call(`reply-${n}`, () => write(repo, "cart.js", `export const total = ${n + 2};\n`));
    const kept = (await undoableIn([repo])).map((one) => one.reply);
    expect(kept).toHaveLength(40);
    expect(kept).toContain("reply-42");
    expect(kept).not.toContain("reply-0");
    expect(
      git(repo, "for-each-ref", "--format=%(refname)", "refs/muster/undo/").split("\n"),
    ).toHaveLength(40);
  }, 240_000);
});
