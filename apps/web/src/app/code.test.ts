// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The pane imports the app around it, which asks the browser for its colour scheme as it loads.
vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});

const { paneWidth, rowsOf, served, tally } = await import("./code");

describe("the work pane (CHA-274)", () => {
  it("reads a difference into lines with their numbers in the old file and the new", () => {
    const diff = [
      "diff --git a/src/price.js b/src/price.js",
      "index f832ac4..f05d322 100644",
      "--- a/src/price.js",
      "+++ b/src/price.js",
      "@@ -3,4 +3,4 @@ function total(lines) {",
      "   let sum = 0;",
      "-  sum += a + b;",
      "+  sum += a * b;",
      "   return sum;",
      "@@ -20,2 +20,3 @@",
      " }",
      "+",
      " module.exports = { total };",
      "",
    ].join("\n");
    const { rows, added, removed } = rowsOf(diff);
    expect([added, removed]).toEqual([2, 1]);
    expect(rows.map((row) => [row.kind, row.old, row.now, row.text])).toEqual([
      ["same", 3, 3, "  let sum = 0;"],
      ["del", 4, null, "  sum += a + b;"],
      ["add", null, 4, "  sum += a * b;"],
      ["same", 5, 5, "  return sum;"],
      // Between two pieces lies what did not change.
      ["skip", null, null, ""],
      ["same", 20, 20, "}"],
      ["add", null, 21, ""],
      ["same", 21, 22, "module.exports = { total };"],
    ]);
    // A new file is given whole, as added lines, and is told to be one.
    expect(rowsOf("+one\n+two", true)).toMatchObject({ added: 2, removed: 0 });
    expect(rowsOf("+one\n+two", true).rows.map((row) => [row.kind, row.now, row.text])).toEqual([
      ["add", 1, "one"],
      ["add", 2, "two"],
    ]);
    expect(rowsOf("")).toEqual({ rows: [], added: 0, removed: 0 });
    // What git says of a file that is not text, or whose mode alone changed, is not its content.
    for (const said of [
      "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n",
      "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n",
    ])
      expect(rowsOf(said)).toEqual({ rows: [], added: 0, removed: 0 });
    // A removed line that begins with dashes is a line, not a header; a note about the last line break is not one.
    expect(
      rowsOf(
        "--- a/a\n+++ b/a\n@@ -1 +1 @@\n--- old\n+++ new\n\\ No newline at end of file\n",
      ).rows.map((row) => [row.kind, row.old, row.now, row.text]),
    ).toEqual([
      ["del", 1, null, "-- old"],
      ["add", null, 1, "++ new"],
    ]);
  });

  it("holds a dragged width to what the window allows", () => {
    expect(paneWidth(500.4, 1400)).toBe(500);
    expect(paneWidth(10, 1400)).toBe(240);
    expect(paneWidth(5000, 1400)).toBe(980);
    // A window too small for both: the pane keeps its least, the page's own rule hides it.
    expect(paneWidth(300, 500)).toBe(240);
  });

  it("counts the lines a difference adds and takes away, not its headers", () => {
    expect(tally("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three\n")).toEqual({
      added: 2,
      removed: 1,
    });
    expect(tally("")).toEqual({ added: 0, removed: 0 });
  });

  it("takes only an address on this computer from what a command printed", () => {
    expect(served("  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
    expect(served("listening on http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(served("see http://localhost:3000@evil.example/x")).toBe("http://localhost:3000");
    expect(served("see http://localhost.evil.example/")).toBe("http://localhost");
    expect(served("docs at https://example.com")).toBeNull();
  });
});
