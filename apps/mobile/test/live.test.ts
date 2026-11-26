import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  dayGroup,
  doneOf,
  duration,
  idle,
  type Live,
  mergeMessages,
} from "../src/lib/live.ts";
import { riskOf } from "../src/lib/risk.ts";
import type { Approval, LiveEvent, Message, PlanItem, Step } from "../src/lib/types.ts";

const message = (id: string, seq: number, status: Message["status"] = "complete"): Message => ({
  id,
  seq,
  role: seq % 2 ? "user" : "assistant",
  content: id,
  status,
  traceId: null,
  createdAt: "2026-01-01T00:00:00Z",
  steps: [],
  plan: [],
  attachments: [],
});
const step = (id: string, tool: string, status: Step["status"]): Step => ({
  id,
  tool,
  status,
  detail: "",
  ms: status === "running" ? null : 12,
});
const approval: Approval = {
  id: "p1",
  tool: "web.send",
  level: "A3",
  summary: {
    destination: "https://example.com/hook?x=1",
    method: "POST",
    contentType: "application/json",
    bytes: 16,
    preview: "{}",
  },
  status: "pending",
  requestedAt: "2026-01-01T00:00:00Z",
};
const plan: PlanItem[] = [
  { title: "Read the note", status: "done" },
  { title: "Write the summary", status: "in_progress" },
  { title: "Save it", status: "pending" },
];

test("text is appended and marks the run as running", () => {
  let live: Live = idle;
  live = applyEvent(live, { type: "text", delta: "Hel" }).live;
  live = applyEvent(live, { type: "text", delta: "lo" }).live;
  assert.deepEqual(live, { running: true, text: "Hello", steps: [], plan: [], approval: null });
});

test("a step is added once and then updated in place", () => {
  let live = applyEvent(idle, { type: "step", step: step("s1", "docs.list", "running") }).live;
  live = applyEvent(live, { type: "step", step: step("s2", "web.send", "running") }).live;
  live = applyEvent(live, { type: "step", step: step("s1", "docs.list", "ok") }).live;
  assert.deepEqual(
    live.steps.map((item) => `${item.id}:${item.status}:${item.ms}`),
    ["s1:ok:12", "s2:running:null"],
  );
});

test("a plan event replaces the plan whole and keeps everything else", () => {
  const before: Live = { ...idle, running: true, text: "so far", steps: [step("s1", "x", "ok")] };
  const first = applyEvent(before, { type: "plan", plan }).live;
  assert.equal(first.plan.length, 3);
  assert.equal(first.text, "so far");
  assert.equal(first.steps.length, 1);
  const next = applyEvent(first, {
    type: "plan",
    plan: plan.map((item) => ({ ...item, status: "done" as const })),
  }).live;
  assert.equal(doneOf(first.plan), 1);
  assert.equal(doneOf(next.plan), 3);
  assert.equal(applyEvent(idle, { type: "plan", plan }).live.running, true);
});

test("a state event replaces everything, the plan included: this is how a reconnect catches up", () => {
  const before: Live = { ...idle, running: true, text: "stale" };
  const applied = applyEvent(before, {
    type: "state",
    running: true,
    text: "fresh and longer",
    steps: [step("s1", "web.fetch", "ok")],
    plan,
    approval,
  });
  assert.equal(applied.live.text, "fresh and longer");
  assert.equal(applied.live.plan.length, 3);
  assert.equal(applied.live.approval?.id, "p1");
  assert.equal(applied.reload, false);
});

test("a state event saying no run is going asks for a reload", () => {
  const ended: LiveEvent = {
    type: "state",
    running: false,
    text: "",
    steps: [],
    plan: [],
    approval: null,
  };
  assert.equal(applyEvent({ ...idle, running: true, text: "half" }, ended).reload, true);
  assert.equal(applyEvent(idle, ended).reload, true);
  assert.deepEqual(applyEvent({ ...idle, running: true, plan }, ended).live, idle);
});

test("an approval appears and is cleared", () => {
  const asked = applyEvent(idle, { type: "approval", approval }).live;
  assert.equal(asked.approval?.id, "p1");
  assert.equal(applyEvent(asked, { type: "approval", approval: null }).live.approval, null);
});

test("done returns to idle and hands over the stored message with its steps and plan", () => {
  const live: Live = { ...idle, running: true, text: "answer", plan };
  const stored = { ...message("m2", 2), steps: [step("s1", "docs.read", "ok")], plan };
  const applied = applyEvent(live, { type: "done", message: stored, title: "Title" });
  assert.deepEqual(applied.live, idle);
  assert.equal(applied.finished?.title, "Title");
  assert.equal(applied.finished?.message.steps.length, 1);
  assert.equal(applied.finished?.message.plan.length, 3);
});

test("a ping changes nothing", () => {
  const live: Live = { ...idle, running: true, text: "x" };
  assert.equal(applyEvent(live, { type: "ping" }).live, live);
});

test("messages merge by id and stay in order", () => {
  const merged = mergeMessages(
    [message("a", 1), message("b", 2, "running")],
    message("c", 3),
    message("b", 2, "complete"),
  );
  assert.deepEqual(
    merged.map((item) => `${item.id}:${item.status}`),
    ["a:complete", "b:complete", "c:complete"],
  );
});

test("sending a second message merges the two full rows the server returns", () => {
  const before = [message("u1", 1), message("a1", 2)];
  const sent = {
    userMessage: { ...message("u2", 3), content: "and again" },
    assistantMessage: { ...message("a2", 4, "running"), content: "" },
  };
  // The reply may already have finished and been stored by a `done` event: the finished one wins.
  const finished = { ...message("a2", 4), content: "root = Stack([])" };
  const merged = mergeMessages([sent.userMessage, sent.assistantMessage], ...before, finished);
  assert.deepEqual(
    merged.map((item) => `${item.role}:${item.id}:${item.status}`),
    ["user:u1:complete", "assistant:a1:complete", "user:u2:complete", "assistant:a2:complete"],
  );
  assert.equal(merged[2]?.content, "and again");
  assert.deepEqual(merged[3]?.steps, []);
});

test("a row that is not a whole message never reaches the screen", () => {
  const bare = { id: "x", seq: 9 } as unknown as Message;
  assert.deepEqual(
    mergeMessages([message("a", 1), bare], bare).map((item) => item.id),
    ["a"],
  );
});

test("durations read like the web app's", () => {
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(4200), "4.2 s");
  assert.equal(duration(80_000), "1 min 20 s");
});

test("conversations group by calendar day", () => {
  const now = new Date(2026, 10, 14, 9, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
  assert.equal(dayGroup(at(14, 0), now), "today");
  assert.equal(dayGroup(at(14, 8), now), "today");
  assert.equal(dayGroup(at(13, 23), now), "yesterday");
  assert.equal(dayGroup(at(13, 0), now), "yesterday");
  assert.equal(dayGroup(at(12, 23), now), "earlier");
});

test("an agent is as risky as its furthest-reaching tool", () => {
  assert.equal(riskOf([]), "R1");
  assert.equal(riskOf([{ level: "A0" }]), "R1");
  assert.equal(riskOf([{ level: "A0" }, { level: "A1" }]), "R2");
  assert.equal(riskOf([{ level: "A1" }, { level: "A2" }]), "R3");
  assert.equal(riskOf([{ level: "A1" }, { level: "A3" }]), "R3");
  assert.equal(riskOf([{ level: "A4" }]), "R4");
});
