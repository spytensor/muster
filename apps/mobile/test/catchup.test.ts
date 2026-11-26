import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import { ranCode } from "../src/lib/code.ts";
import { madeFiles } from "../src/lib/files.ts";
import { type InboxNotice, opens, runsOf } from "../src/lib/inbox.ts";
import { hitRate, progressOf, toolLabel } from "../src/lib/tools.ts";
import type { FileItem, Step } from "../src/lib/types.ts";

test("a run-code step is read as its code, whole or as far as it was kept", () => {
  const asked = {
    why: "Totals",
    code: 'import pandas as pd\nprint("a\\tb")\n',
    language: "python",
    files: ["sales.csv"],
    keep: ["chart.png"],
  };
  assert.deepEqual(ranCode(JSON.stringify(asked)), {
    language: "python",
    code: asked.code,
    files: ["sales.csv"],
    keep: ["chart.png"],
    cut: false,
  });
  assert.equal(ranCode(JSON.stringify({ ...asked, language: "shell" }))?.language, "shell");
  // Cut short: shown as far as it was kept, with no half escape left in it.
  const whole = JSON.stringify({ why: "x", code: `${"print(1)\n".repeat(50)}print("end")` });
  for (const at of [60, 61, 62, 63, 200]) {
    const part = ranCode(whole.slice(0, at));
    assert.equal(part?.cut, true);
    assert.ok(part?.code.startsWith("print(1)\nprint(1)"));
    assert.ok(!part?.code.includes("\\"));
  }
  // Not a run of code at all.
  assert.equal(ranCode('{"title":"Notes"}'), null);
  assert.equal(ranCode("nothing"), null);
});

const file = (id: string, name: string): FileItem => ({
  id,
  name,
  kind: "image",
  size: 10,
  mime: "",
  source: "agent",
  conversationId: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const ran = (over: Partial<Step>): Step => ({
  id: "s",
  tool: "code.run",
  status: "ok",
  detail: "Totals",
  ms: 900,
  ...over,
});

test("the files a run of code kept are shown, each once, and none from a run that failed", () => {
  const files = [file("a", "chart.png"), file("b", "totals.xlsx"), file("c", "other.png")];
  assert.deepEqual(
    madeFiles([ran({ file: "b", files: ["a", "b"] })], files).map((item) => item.id),
    ["a", "b"],
  );
  // One file, said the older way.
  assert.deepEqual(
    madeFiles([ran({ file: "a" })], files).map((item) => item.id),
    ["a"],
  );
  // Kept by two runs: once. Deleted since: not offered. A failed run: nothing.
  assert.deepEqual(
    madeFiles([ran({ id: "1", files: ["a"] }), ran({ id: "2", files: ["a", "gone"] })], files).map(
      (item) => item.id,
    ),
    ["a"],
  );
  assert.deepEqual(madeFiles([ran({ status: "error", files: ["a"] })], files), []);
  // A run that kept nothing has no file, whatever its words were.
  assert.deepEqual(madeFiles([ran({ detail: "chart.png" })], files), []);
});

const notice = (
  id: string,
  kind: string,
  name: string,
  readAt: string | null = "x",
): InboxNotice => ({
  id,
  kind,
  detail: { name },
  link: "schedules",
  createdAt: `2026-11-2${id}T05:00:00Z`,
  readAt,
});

test("the inbox says the same thing once, with how often, in the order things happened", () => {
  const runs = runsOf([
    notice("4", "schedule_done", "Weekly report"),
    notice("3", "schedule_done", "Weekly report", null),
    notice("2", "schedule_failed", "Weekly report"),
    notice("1", "schedule_done", "Weekly report"),
    notice("0", "schedule_done", "Something else"),
  ]);
  assert.deepEqual(
    runs.map((run) => [run.notice.id, run.times]),
    [
      ["4", 2],
      ["2", 1],
      ["1", 1],
      ["0", 1],
    ],
  );
  // One unread among them marks the line.
  assert.equal(runs[0]?.notice.readAt, null);
  assert.deepEqual(runsOf([]), []);
});

test("a notice opens a conversation or a project, and nothing the phone has no screen for", () => {
  const id = "01a20bcd-dd0d-7c8e-9fe8-2325c21912c4";
  assert.deepEqual(opens(`c/${id}`), { screen: "conversation", id });
  assert.deepEqual(opens(`p/${id}`), { screen: "project", id });
  assert.deepEqual(opens(`#/p/${id}`), { screen: "project", id });
  for (const link of ["schedules", "admin/alerts", "market", "", "p/", "c/../../x", `x/${id}`])
    assert.equal(opens(link), null);
});

test("every notice the server sends has its sentence, in both languages", () => {
  const kinds = [
    "shared",
    "approved",
    "returned",
    "withdrawn",
    "schedule_paused",
    "skill_held",
    "taken_down",
    "handed_over",
    "project_added",
    "schedule_done",
    "schedule_failed",
    "followup_woken",
    "followup_failed",
    "followup_ended",
    "budget_near",
    "budget_reached",
    "alert",
  ];
  const detail = { name: "Launch", by: "Mo", role: "work", scope: "person", count: "2" };
  for (const messages of [en, zh])
    for (const kind of kinds) {
      const said = messages.app.notices.text[kind]?.(detail);
      assert.ok(said && !said.includes("undefined") && !said.includes("null"), `${kind}: ${said}`);
    }
  // One nobody has written a sentence for yet still says something.
  assert.ok(en.app.notices.other());
  // And a reply that a budget stopped says which.
  for (const messages of [en, zh])
    for (const ending of ["budget_person", "budget_department", "budget_company"]) {
      assert.ok(messages.app.ending[ending]);
      assert.ok(messages.errors[ending]);
    }
});

test("a tool is named in words: Muster's own from the language file, a connector's by its names", () => {
  const names = en.app.toolDone;
  assert.equal(toolLabel(names, "code.run", en.app.connectorTool), "Ran code");
  assert.equal(
    toolLabel(names, "project.step", en.app.connectorTool),
    "Updated the project's steps",
  );
  assert.equal(
    toolLabel(names, "company.plane-tracker.create_issue", en.app.connectorTool),
    "plane tracker: create issue",
  );
  assert.equal(toolLabel(names, "company.crm", en.app.connectorTool), "crm");
  assert.equal(toolLabel(zh.app.toolName, "company.crm.find", zh.app.connectorTool), "crm：find");
  // One nobody knows is shown as it is, not as nothing.
  assert.equal(toolLabel(names, "new.tool", en.app.connectorTool), "new.tool");
});

test("usage says how much of what went in was read from the cache", () => {
  assert.equal(hitRate({ inputTokens: 1000, cachedTokens: 900 }), "90%");
  assert.equal(hitRate({ inputTokens: 1000 }), "0%");
  assert.equal(hitRate({ inputTokens: 0, cachedTokens: 0 }), "–");
  assert.equal(hitRate({}), "–");
});

test("a project's progress is its steps done out of all of them", () => {
  assert.deepEqual(progressOf([]), { total: 0, done: 0, share: 0 });
  assert.deepEqual(
    progressOf([{ state: "done" }, { state: "doing" }, { state: "todo" }, { state: "done" }]),
    { total: 4, done: 2, share: 0.5 },
  );
});
