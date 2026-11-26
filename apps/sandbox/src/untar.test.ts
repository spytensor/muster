import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { blobSha, Refused, Runner } from "./runner.js";
import { BadArchive, untar } from "./untar.js";

const encoder = new TextEncoder();

/** One entry of a tar archive, written the way `git archive` and a code host write it. */
function entry(name: string, content: string | Uint8Array, kind = "0", mode = 0o644): Uint8Array {
  const body = typeof content === "string" ? encoder.encode(content) : content;
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(encoder.encode(text), at);
  put(name.slice(0, 100), 0);
  put(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  put(kind, 156);
  put("ustar\0", 257);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return Buffer.concat([header, padded]);
}
/** An extended header naming the next entry: how a path of more than 100 bytes is written. */
const named = (path: string) => {
  const record = (length: number) => `${length} path=${path}\n`;
  let length = record(0).length;
  while (record(length).length !== length) length = record(length).length;
  return entry("pax", record(length), "x");
};
const archive = (...entries: Uint8Array[]) =>
  gzipSync(
    Buffer.concat([
      entry("pax_global_header", "52 comment=abc\n", "g"),
      ...entries,
      new Uint8Array(1024),
    ]),
  );

const limits = { bytes: 1024 * 1024, fileBytes: 64 * 1024, files: 100, strip: 1 };

describe("a repository's archive", () => {
  it("is read into its files, with their names under the folder a code host puts them in", () => {
    const long = `acme-web-abc123/${"deep/".repeat(30)}file.ts`;
    const read = untar(
      archive(
        entry("acme-web-abc123/", "", "5"),
        entry("acme-web-abc123/README.md", "# Web\n"),
        entry("acme-web-abc123/bin/run.sh", "#!/bin/sh\n", "0", 0o755),
        named(long),
        entry("acme-web-abc123/short", "long one\n"),
        entry("acme-web-abc123/文档/说明.md", "你好\n"),
      ),
      limits,
    );
    expect(read.files.map((file) => [file.name, file.runs])).toEqual([
      ["README.md", false],
      ["bin/run.sh", true],
      [`${"deep/".repeat(30)}file.ts`, false],
      ["文档/说明.md", false],
    ]);
    expect(new TextDecoder().decode(read.files[0]?.bytes)).toBe("# Web\n");
    expect(read.passed).toEqual([]);
  });

  it("makes nothing but files: a link, a way out of the folder or an oversized file is passed over and named", () => {
    const read = untar(
      archive(
        entry("r/ok.txt", "fine"),
        entry("r/link", "", "2"),
        entry("r/hard", "", "1"),
        entry("r/device", "", "3"),
        named("r/../../etc/passwd"),
        entry("r/x", "out"),
        entry("r/ok.txt", "twice"),
        entry("r/big.bin", new Uint8Array(70 * 1024)),
      ),
      limits,
    );
    expect(read.files.map((file) => file.name)).toEqual(["ok.txt"]);
    expect(read.passed).toEqual([
      { name: "link", why: "link" },
      { name: "hard", why: "link" },
      { name: "device", why: "kind" },
      { name: "../../etc/passwd", why: "name" },
      { name: "ok.txt", why: "name" },
      { name: "big.bin", why: "large" },
    ]);
  });

  it("leaves alone a file whose name is not text, and says which", () => {
    // Latin-1 bytes in a name: not UTF-8, so it could not be written back as it was.
    const odd = entry("r/placeholder", "x");
    odd.set([0x72, 0x2f, 0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74, 0, 0, 0], 0);
    const read = untar(archive(entry("r/ok.txt", "fine"), odd), limits);
    expect(read.files.map((file) => file.name)).toEqual(["ok.txt"]);
    expect(read.passed).toEqual([{ name: "caf\ufffd.txt", why: "name" }]);
  });

  it("is refused whole when it holds more than a workspace does, or is not an archive", () => {
    const many = Array.from({ length: 30 }, (_, at) =>
      entry(`r/${at}.bin`, new Uint8Array(60_000)),
    );
    expect(() => untar(archive(...many), limits)).toThrow(BadArchive);
    expect(() =>
      untar(archive(...Array.from({ length: 101 }, (_, at) => entry(`r/${at}`, "x"))), limits),
    ).toThrow(BadArchive);
    expect(() => untar(encoder.encode("not an archive"), limits)).toThrow(BadArchive);
    // Cut short: its last file runs past the end.
    const cut = gzipSync(entry("r/a", "x".repeat(2000)).subarray(0, 700));
    expect(() => untar(cut, limits)).toThrow(BadArchive);
  });
});

describe("a repository in a workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "muster-untar-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const runner = new Runner(root, root, { log: () => {} });
  const space = "01a20bcd-dd0d-7c8e-9fe8-2325c21912c4";

  it("is put into a folder in place of what was there, and listed with git's own fingerprints", async () => {
    await runner.put(space, "notes.txt", encoder.encode("mine"));
    await runner.put(space, "web/stale.txt", encoder.encode("from before"));
    const put = await runner.unpack(
      space,
      "web",
      archive(
        entry("x/README.md", "# Web\n"),
        entry("x/src/a.ts", "export const a = 1;\n", "0", 0o755),
        entry("x/link", "", "2"),
      ),
    );
    // What `git hash-object` says of the same bytes.
    expect(put.files).toEqual([
      { name: "README.md", sha: blobSha(encoder.encode("# Web\n")), size: 6, runs: false },
      {
        name: "src/a.ts",
        sha: blobSha(encoder.encode("export const a = 1;\n")),
        size: 20,
        runs: true,
      },
    ]);
    expect(blobSha(encoder.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(put.passed).toEqual([{ name: "link", why: "link" }]);
    expect((await runner.list(space)).map((file) => file.name)).toEqual([
      "notes.txt",
      "web/README.md",
      "web/src/a.ts",
    ]);

    // Changed, added and taken out: the folder as it stands says so.
    await runner.put(space, "web/src/a.ts", encoder.encode("export const a = 2;\n"));
    await runner.put(space, "web/src/b.ts", encoder.encode("b"));
    await runner.drop(space, "web/README.md");
    await runner.drop(space, "web/README.md");
    expect(await runner.tree(space, "web")).toEqual([
      { name: "src/a.ts", sha: blobSha(encoder.encode("export const a = 2;\n")), size: 20 },
      { name: "src/b.ts", sha: blobSha(encoder.encode("b")), size: 1 },
    ]);
    expect(await runner.tree(space, "nothing")).toEqual([]);
  });

  it("unpacks two at a time: a third waits its turn, and is told to try again when none comes", async () => {
    const waiting = new Runner(root, root, { log: () => {}, limits: { waitMs: 40 } });
    const turn = () => (waiting as unknown as { unpackTurn(): Promise<() => void> }).unpackTurn();
    const first = await turn();
    const second = await turn();
    await expect(turn()).rejects.toMatchObject({ code: "busy" });
    // One ends: the next in line goes, and no turn is lost to the one that gave up.
    const third = turn();
    first();
    (await third)();
    second();
    (await turn())();
    (await turn())();
  });

  it("refuses a folder below another, a reserved one, and an archive larger than the room left", async () => {
    await expect(runner.unpack(space, "a/b", archive(entry("x/a", "a")))).rejects.toThrow(Refused);
    await expect(runner.unpack(space, ".result", archive(entry("x/a", "a")))).rejects.toThrow(
      Refused,
    );
    const small = new Runner(root, root, { log: () => {}, limits: { spaceBytes: 100 } });
    await expect(
      small.unpack(space, "big", archive(entry("x/a", "a".repeat(500)))),
    ).rejects.toMatchObject({ code: "too_large" });
    // Refused before anything was taken away.
    expect((await runner.tree(space, "web")).length).toBe(2);
  });
});
