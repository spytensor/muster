import { describe, expect, it } from "vitest";
import { lastLines, ranCode } from "./ranCode";

describe("what a run-code step asked for", () => {
  const asked = {
    why: "Totals",
    code: 'import pandas as pd\nprint("a\\tb")\n',
    language: "python",
    files: ["sales.csv"],
    keep: ["chart.png"],
  };
  it("is the code as it was written, and the files that went in and were kept", () => {
    expect(ranCode(JSON.stringify(asked))).toEqual({
      language: "python",
      code: asked.code,
      files: ["sales.csv"],
      keep: ["chart.png"],
      cut: false,
    });
    expect(ranCode(JSON.stringify({ ...asked, language: "shell" }))?.language).toBe("shell");
  });

  it("is shown as far as it was kept when the request was cut short", () => {
    const whole = JSON.stringify({ why: "x", code: `${"print(1)\n".repeat(50)}print("end")` });
    for (const at of [60, 61, 62, 63, 200]) {
      const part = ranCode(whole.slice(0, at));
      expect(part?.cut).toBe(true);
      expect(part?.code.startsWith("print(1)\nprint(1)")).toBe(true);
      expect(part?.code).not.toContain("\\");
    }
    // Cut after the code ended: the code is whole.
    const late = JSON.stringify({ code: "ls -la", language: "shell", files: ["a", "b"] });
    expect(ranCode(late.slice(0, late.length - 6))).toMatchObject({
      code: "ls -la",
      language: "shell",
      cut: false,
    });
  });

  it("keeps a backslash the code holds when the cut falls right after it", () => {
    const whole = JSON.stringify({ code: 'print("a\\\\b")\nprint("c\\u00e9")' });
    // Every place it could be cut: never raw JSON, never a backslash that was not there.
    for (let at = 12; at < whole.length - 2; at++) {
      const part = ranCode(whole.slice(0, at));
      expect(part, `cut at ${at}`).not.toBeNull();
      expect(
        'print("a\\\\b")\nprint("c\\u00e9")'.startsWith(part?.code as string),
        `cut at ${at}`,
      ).toBe(true);
    }
  });

  it("is nothing for a step that ran no code", () => {
    expect(ranCode('{"name":"a.docx"}')).toBeNull();
    expect(ranCode("not json")).toBeNull();
  });
});

describe("what a running step prints", () => {
  it("is shown as its last lines, without the blank end", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines("one line")).toBe("one line");
    expect(
      lastLines(Array.from({ length: 20 }, (_, n) => `row ${n}`).join("\n")).split("\n"),
    ).toEqual(["row 14", "row 15", "row 16", "row 17", "row 18", "row 19"]);
  });
});
