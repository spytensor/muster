import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { attachable, LocalError, rootNames, runLocal } from "./local";

let work: string;
let other: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "muster-local-"));
  work = join(base, "a", "Reports");
  other = join(base, "b", "Reports");
  outside = join(base, "outside");
  for (const folder of [work, other, outside, join(work, "q3"), join(work, "node_modules", "x")])
    mkdirSync(folder, { recursive: true });
  writeFileSync(join(work, "plan.md"), "# Plan\nShip on Friday.\n季度目标\n");
  writeFileSync(join(work, "q3", "notes.txt"), "Revenue grew 12%.\n");
  writeFileSync(join(work, "node_modules", "x", "index.js"), "Friday");
  writeFileSync(join(work, ".env"), "KEY=secret-friday");
  writeFileSync(join(work, "deck.pptx"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
  writeFileSync(join(outside, "private.txt"), "not yours");
  symlinkSync(outside, join(work, "way-out"));
});

describe("working in the folders a person attached", () => {
  it("names folders by their own name, and tells two of the same name apart", () => {
    expect([...rootNames([work, other]).keys()]).toEqual(["Reports", "Reports (2)"]);
  });

  it("lists, reads and searches inside them", async () => {
    expect(await runLocal([work], "list", {})).toBe("Attached folders:\nReports/");
    const listing = await runLocal([work], "list", { path: "Reports" });
    expect(listing).toContain("q3/");
    expect(listing).toContain("plan.md  (");
    // What is never useful to an agent is not shown.
    expect(listing).not.toContain("node_modules");
    expect(await runLocal([work], "read", { path: "Reports/q3/notes.txt" })).toBe(
      "Revenue grew 12%.\n",
    );
    const found = await runLocal([work], "search", { query: "friday" });
    expect(found).toContain("Reports/plan.md:2: Ship on Friday.");
    // Neither the secrets file nor dependencies are searched.
    expect(found).not.toContain(".env");
    expect(found).not.toContain("node_modules");
    expect(await runLocal([work], "search", { query: "notes" })).toContain(
      "Reports/q3/notes.txt  (name)",
    );
    expect(await runLocal([work], "search", { query: "季度" })).toContain("plan.md:3");
  });

  it("writes a new file and replaces an old one, inside the folder only", async () => {
    expect(
      await runLocal([work], "write", { path: "Reports/q3/summary.md", content: "Done." }),
    ).toBe("Created Reports/q3/summary.md (5 bytes).");
    expect(readFileSync(join(work, "q3", "summary.md"), "utf8")).toBe("Done.");
    expect(
      await runLocal([work], "write", { path: "Reports/q3/summary.md", content: "Again" }),
    ).toMatch(/^Replaced/);
    await expect(
      runLocal([work], "write", { path: "Reports/nowhere/x.md", content: "x" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses to leave the folder, by any road", async () => {
    for (const path of [
      "Reports/../outside/private.txt",
      "Reports/way-out/private.txt",
      "/etc/passwd",
      "Elsewhere/file.txt",
    ])
      await expect(runLocal([work], "read", { path }), path).rejects.toThrow(LocalError);
    await expect(
      runLocal([work], "write", { path: "Reports/way-out/planted.txt", content: "x" }),
    ).rejects.toThrow(/outside/);
  });

  it("does not open files that hold secrets, or files that are not text", async () => {
    await expect(runLocal([work], "read", { path: "Reports/.env" })).rejects.toThrow(/protected/);
    await expect(
      runLocal([work], "write", { path: "Reports/id_rsa", content: "x" }),
    ).rejects.toThrow(/protected/);
    await expect(runLocal([work], "read", { path: "Reports/deck.pptx" })).rejects.toThrow(
      /attach it/,
    );
  });

  it("does not write through a link, even one to a file that does not exist yet", async () => {
    symlinkSync(join(outside, "planted.txt"), join(work, "dangling"));
    symlinkSync(join(outside, "private.txt"), join(work, "alias.txt"));
    for (const path of ["Reports/dangling", "Reports/alias.txt"])
      await expect(runLocal([work], "write", { path, content: "x" })).rejects.toBeInstanceOf(
        LocalError,
      );
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("not yours");
  });

  it("is not fooled by a link that gives a secret an innocent name", async () => {
    symlinkSync(join(work, ".env"), join(work, "notes-link.txt"));
    await expect(runLocal([work], "read", { path: "Reports/notes-link.txt" })).rejects.toThrow(
      /protected/,
    );
  });

  it("stays out of .git and node_modules, and writes nothing where tools run things", async () => {
    mkdirSync(join(work, ".git", "hooks"), { recursive: true });
    mkdirSync(join(work, ".vscode"), { recursive: true });
    for (const path of ["Reports/.git/hooks/pre-commit", "Reports/.vscode/tasks.json"])
      await expect(runLocal([work], "write", { path, content: "x" })).rejects.toBeInstanceOf(
        LocalError,
      );
    await expect(
      runLocal([work], "read", { path: "Reports/node_modules/x/index.js" }),
    ).rejects.toBeInstanceOf(LocalError);
    expect(existsSync(join(work, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("does not let the home folder, the disk or the app's own records be attached", () => {
    const home = "/Users/ada";
    const data = "/Users/ada/Library/Application Support/Muster";
    for (const path of ["/", "/Users", home, "/Users/ada/Library", data, `${data}/x`])
      expect(attachable(path, home, data)).toBe(false);
    for (const path of ["/Users/ada/Documents", "/Users/ada/Work/Q4", "/Volumes/Shared/Team"])
      expect(attachable(path, home, data)).toBe(true);
  });

  it("says so when nothing is attached", async () => {
    await expect(runLocal([], "list", {})).rejects.toThrow(/No folder/);
  });
});
