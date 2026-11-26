import { describe, expect, it } from "vitest";
import { type Done, toldOf, walkthroughGap } from "./walkthrough.js";

const ending = (changes: string, checks = "[]", left = "[]", summary = "Did it.") =>
  `root = Stack([w])\nw = Walkthrough(${JSON.stringify(summary)}, ${changes}, ${checks}, ${left})`;
const BOTH = '[{file: "app/src/a.ts", why: "x"}, {file: "./app/src/b.ts", why: "y"}]';
const check = (what: string, ok: boolean) =>
  `{what: ${JSON.stringify(what)}, result: "r", ok: ${ok}}`;
const empty = { unnamed: [], notRun: [], stale: [], wrong: [], unlisted: [], piped: [] };

/** How a reply that changed code must end, held against what its steps did (C1). */
describe("walkthroughGap", () => {
  const edits: Done[] = [{ change: "app/src/a.ts" }, { change: "app/src/b.ts" }];
  const tested: Done[] = [...edits, { run: "pnpm test", code: 0 }];

  it("asks nothing of a reply that changed nothing", () => {
    expect(
      walkthroughGap('root = Stack([t])\nt = Text("Hi.")', [{ run: "ls", code: 0 }]),
    ).toBeNull();
  });

  it("asks for a Walkthrough when there is none", () => {
    const gap = walkthroughGap('root = Stack([t])\nt = Text("Done.")', tested);
    expect(gap?.missing).toBe(true);
    expect(toldOf(gap ?? { ...empty })).toMatch(/does not end with a Walkthrough/);
  });

  it("passes one that names every file and lists the check that ran after the changes", () => {
    expect(walkthroughGap(ending(BOTH, `[${check("`pnpm test`", true)}]`), tested)).toBeNull();
  });

  it("names the files left out, taking a path without its folder or with a line", () => {
    const gap = walkthroughGap(
      ending('[{file: "src/a.ts:12", why: "x"}]', `[${check("pnpm test", true)}]`),
      tested,
    );
    expect(gap).toEqual({ ...empty, unnamed: ["app/src/b.ts"] });
  });

  it("refuses a check that was never run", () => {
    const gap = walkthroughGap(
      ending(BOTH, `[${check("pnpm test", true)}, ${check("pnpm lint", true)}]`),
      tested,
    );
    expect(gap).toEqual({ ...empty, notRun: ["pnpm lint"] });
    expect(toldOf(gap ?? { ...empty })).toMatch(
      /"pnpm lint" as a check, but no such command was run/,
    );
  });

  it("refuses a check that ran only before the last change", () => {
    const gap = walkthroughGap(ending(BOTH, `[${check("pnpm test", true)}]`), [
      { change: "app/src/a.ts" },
      { run: "pnpm test", code: 0 },
      { change: "app/src/b.ts" },
    ]);
    expect(gap?.stale).toEqual(["pnpm test"]);
    expect(gap?.noChecks).toBeUndefined();
  });

  it("holds passed and failed to the exit code of the latest run after the changes", () => {
    const failing: Done[] = [
      ...edits,
      { run: "pnpm test", code: 0 },
      { run: "pnpm test", code: 1 },
    ];
    expect(walkthroughGap(ending(BOTH, `[${check("pnpm test", true)}]`), failing)).toEqual({
      ...empty,
      wrong: [{ what: "pnpm test", code: 1, ok: true }],
    });
    expect(walkthroughGap(ending(BOTH, `[${check("pnpm test", false)}]`), failing)).toBeNull();
    // Marked failed though no run of it ever failed.
    expect(walkthroughGap(ending(BOTH, `[${check("pnpm test", false)}]`), tested)).toEqual({
      ...empty,
      wrong: [{ what: "pnpm test", code: 0, ok: false }],
    });
    // A job still going has no exit code to hold it to.
    const job: Done[] = [...edits, { run: "pnpm dev", code: null }];
    expect(walkthroughGap(ending(BOTH, `[${check("pnpm dev", true)}]`), job)).toBeNull();
  });

  it("takes the test that failed before the fix and passed after it, each as it was (found in a real run)", () => {
    const fixed: Done[] = [
      { run: "npm test", code: 1 },
      { change: "app/src/a.ts" },
      { change: "app/src/b.ts" },
      { run: "npm test", code: 0 },
    ];
    const both = `[${check("npm test（修复前）", false)}, ${check("npm test（修复后）", true)}]`;
    expect(walkthroughGap(ending(BOTH, both), fixed)).toBeNull();
    // The failure before the fix is no proof that the fix works.
    const before: Done[] = fixed.slice(0, 3);
    expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), before)).toMatchObject({
      stale: ["npm test"],
    });
  });

  it("takes a check that sums up a run of several commands (found in a real run)", () => {
    const ran: Done[] = [...edits, { run: "git status --short && git diff", code: 0 }];
    expect(
      walkthroughGap(ending(BOTH, `[${check("git status / git diff", true)}]`), ran),
    ).toBeNull();
    expect(walkthroughGap(ending(BOTH, `[${check("git diff", true)}]`), ran)).toBeNull();
    // A command the run did not hold is still one that was not run.
    expect(
      walkthroughGap(ending(BOTH, `[${check("git status / npm test", true)}]`), ran),
    ).toMatchObject({ notRun: ["git status / npm test"] });
  });

  it("does not take a pass from a command whose exit code was another's (found in a real run)", () => {
    for (const line of ["npm test 2>&1 | tail -60", 'npm test 2>&1; echo "EXIT=$?"']) {
      const ran: Done[] = [...edits, { run: line, code: 0 }];
      // Quotes the agent left out do not make it another command.
      const said = line.replace(/"/g, "");
      expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), ran), line).toEqual({
        ...empty,
        piped: ["npm test"],
      });
      expect(walkthroughGap(ending(BOTH, `[${check(said, true)}]`), ran), line).toEqual({
        ...empty,
        piped: [said],
      });
    }
    // With && a failure stops the line: its exit code is the check's.
    const chained: Done[] = [...edits, { run: "cd web && npm test", code: 0 }];
    expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), chained)).toBeNull();
    // Run on its own after the piped one, it counts.
    const plain: Done[] = [
      ...edits,
      { run: "npm test | tail", code: 0 },
      { run: "npm test", code: 0 },
    ];
    expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), plain)).toBeNull();
  });

  it("wants a project check that failed listed, not one that passed, which the agent never saw", () => {
    const passed = walkthroughGap(ending(BOTH, `[${check("pnpm test", true)}]`), [
      ...tested,
      { run: "npm run check", code: 0, project: true },
    ]);
    expect(passed).toBeNull();
    const failed = walkthroughGap(ending(BOTH, `[${check("pnpm test", true)}]`), [
      ...tested,
      { run: "npm run check", code: 1, project: true },
    ]);
    expect(failed).toEqual({ ...empty, unlisted: ["npm run check"] });
  });

  it("wants checks when commands ran after the changes, or a word under left", () => {
    expect(walkthroughGap(ending(BOTH), tested)).toMatchObject({ noChecks: "ran" });
    expect(walkthroughGap(ending(BOTH), edits)).toMatchObject({ noChecks: "none" });
    expect(walkthroughGap(ending(BOTH, "[]", '["Not checked: no tests here."]'), edits)).toBeNull();
    // Saying under left what was not checked is enough (a `git status` checks nothing).
    expect(walkthroughGap(ending(BOTH, "[]", '["Not checked."]'), tested)).toBeNull();
  });

  it("holds only commands: a check in words is what the agent says it looked at", () => {
    const both = `[${check("pnpm test", true)}, ${check("Opened http://localhost:5173 and the total shows 30", true)}]`;
    expect(walkthroughGap(ending(BOTH, both), tested)).toBeNull();
  });

  it("compares commands word for word, not as substrings", () => {
    const ran: Done[] = [
      ...edits,
      { run: "cat vitest.config.ts", code: 0 },
      { run: "pnpm test:e2e", code: 0 },
    ];
    expect(
      walkthroughGap(ending(BOTH, `[${check("vitest", true)}, ${check("npm test", true)}]`), ran),
    ).toMatchObject({
      notRun: ["vitest", "npm test"],
    });
    // Words set before it (PORT=…), words after it (--watch) and flags (curl -s) are the same command.
    const curl: Done[] = [
      ...edits,
      { run: 'curl -s "http://localhost:4310/orders?coupon=X"', code: 0 },
    ];
    expect(
      walkthroughGap(
        ending(BOTH, `[${check('curl "http://localhost:4310/orders?coupon=X"', true)}]`),
        curl,
      ),
    ).toBeNull();
    const env: Done[] = [...edits, { run: "PORT=4399 npm test --watch=false", code: 0 }];
    expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), env)).toBeNull();
  });

  it("does not take a pass whose code was lost to `||` or a second line, or that is unknown", () => {
    for (const line of ["npm test || true", "npm test⏎echo done"]) {
      const ran: Done[] = [...edits, { run: line, code: 0 }];
      expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), ran), line).toMatchObject(
        {
          piped: ["npm test"],
        },
      );
    }
    // A `cd` before it, or a | in quotes, does not lose the code.
    for (const line of ["cd shop; npm test", 'grep -q "a|b" x.txt']) {
      const ran: Done[] = [...edits, { run: line, code: 0 }];
      expect(walkthroughGap(ending(BOTH, `[${check(line, true)}]`), ran), line).toBeNull();
    }
    const unknown: Done[] = [...edits, { run: "npm test", code: -1 }];
    expect(walkthroughGap(ending(BOTH, `[${check("npm test", true)}]`), unknown)).toMatchObject({
      wrong: [{ what: "npm test", code: -1, ok: true }],
    });
  });

  it("names a file at a line range or anchor as the file", () => {
    const files = '[{file: "app/src/a.ts:4-9", why: "x"}, {file: "app/src/b.ts#L3-L5", why: "y"}]';
    expect(walkthroughGap(ending(files, `[${check("pnpm test", true)}]`), tested)).toBeNull();
  });
});

describe("writtenIn", () => {
  it("names the language only where the script names one", async () => {
    const { writtenIn } = await import("./runs.js");
    expect(writtenIn("walk-demo 里 npm test 失败了")).toBe("Chinese");
    expect(writtenIn("テストが失敗しました")).toBe("Japanese");
    expect(writtenIn("테스트 실패")).toBe("Korean");
    expect(writtenIn("npm test fails")).toBeNull();
  });
});
