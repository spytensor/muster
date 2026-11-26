// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { blocksOf } from "./markdown";

// The code block comes from the reply's module, which asks the browser for its colour scheme
// as it loads. This test environment has no such question to answer.
vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});

/** How a document's text is cut into what is shown when it is read. */
describe("blocksOf", () => {
  it("reads the Markdown agents are asked to write", () => {
    const text = [
      "# Plan",
      "",
      "Intro with **bold**.",
      "## Tables",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- one",
      "  goes on",
      "- two",
      "  - under two",
      "1. first",
      "> said",
      "```sql",
      "CREATE TABLE x (",
      "",
      "  id INT",
      ");",
      "```",
      "---",
    ].join("\n");
    expect(blocksOf(text)).toEqual([
      { kind: "heading", level: 1, text: "Plan" },
      { kind: "paragraph", text: "Intro with **bold**." },
      { kind: "heading", level: 2, text: "Tables" },
      { kind: "table", head: ["a", "b"], rows: [["1", "2"]] },
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "one\ngoes on", depth: 0, mark: "-" },
          { text: "two", depth: 0, mark: "-" },
          { text: "under two", depth: 1, mark: "-" },
        ],
      },
      { kind: "list", ordered: true, items: [{ text: "first", depth: 0, mark: "1." }] },
      { kind: "quote", text: "said" },
      { kind: "code", language: "sql", code: "CREATE TABLE x (\n\n  id INT\n);" },
      { kind: "rule" },
    ]);
  });

  it("keeps plain text as it was typed, and a line of = as a rule", () => {
    const text =
      "Title\nversion 1\n=====\n-- 1. Exchanges\nCREATE TABLE exchange (\n    code VARCHAR\n);";
    expect(blocksOf(text)).toEqual([
      { kind: "paragraph", text: "Title\nversion 1" },
      { kind: "rule" },
      { kind: "paragraph", text: "-- 1. Exchanges\nCREATE TABLE exchange (\n    code VARCHAR\n);" },
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(blocksOf("```\na\nb")).toEqual([{ kind: "code", language: undefined, code: "a\nb" }]);
  });
});

describe("names in running text", () => {
  it("knows a file by its language's ending and a commit by its digits and letters", async () => {
    const { inline } = await import("./markdown");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      inline(
        "cart.js and src/App.tsx in 1514d5d, not example.com, e.g. this, decade or 2026",
      ) as never,
    );
    expect(html).toContain('title="cart.js"');
    expect(html).toContain('title="src/App.tsx"');
    expect(html).toMatch(/<code[^>]*>1514d5d<\/code>/);
    expect(html).not.toContain('title="example.com"');
    expect(html).not.toMatch(/<code[^>]*>decade/);
    expect(html).not.toMatch(/<code[^>]*>2026/);
  });
});

describe("what a model writes that broke the first renderer (review, 2026-11-22)", () => {
  it("reads a heading with a long run of spaces at once", () => {
    const started = performance.now();
    expect(blocksOf(`# a${" ".repeat(20_000)}b ##`)).toEqual([
      { kind: "heading", level: 1, text: `a${" ".repeat(20_000)}b` },
    ]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("keeps the text after a fence that says more than its language", () => {
    expect(blocksOf("```js filename=app.js\nrun()\n```\nmore text")).toEqual([
      { kind: "code", language: "js", code: "run()" },
      { kind: "paragraph", text: "more text" },
    ]);
  });

  it("keeps the numbers an ordered list was written with, across a block between items", () => {
    const blocks = blocksOf("1. Install\n\n```\nnpm i\n```\n\n2. Run");
    expect(blocks.at(-1)).toEqual({
      kind: "list",
      ordered: true,
      items: [{ text: "Run", depth: 0, mark: "2." }],
    });
  });

  it("does not take a framework's name for a file, or a link of another scheme for a link", async () => {
    const { inline } = await import("./markdown");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      inline("Node.js and Next.js, 1e10000, [x](javascript:alert(1))") as never,
    );
    expect(html).not.toContain("title=");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<a ");
    const only = renderToStaticMarkup(inline("[x](/api/secret)") as never);
    expect(only).not.toContain("<a ");
  });
});
