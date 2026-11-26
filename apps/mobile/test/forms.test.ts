import assert from "node:assert/strict";
import { test } from "node:test";
import { asDay, formPlace, formState, rangeOf } from "../src/lib/forms.ts";
import type { Message } from "../src/lib/types.ts";

const FORM = `root = Stack([t, f])
t = Text("I need a few details.")
f = Form("purchase", "Purchase request", "Use these", [item, amount])
item = TextField("item", "Item", "Monitor", true)
amount = NumberField("amount", "Amount", null, true, 0, 5000, "USD")`;

const message = (over: Partial<Message>): Message => ({
  id: "reply",
  seq: 1,
  role: "assistant",
  content: FORM,
  status: "complete",
  traceId: null,
  createdAt: "2026-11-16T10:00:00.000Z",
  steps: [],
  plan: [],
  attachments: [],
  ...over,
});
const asked = message({ id: "asked", seq: 0, role: "user", content: "A monitor please" });

test("a form is live while its reply is the last thing said", () => {
  const reply = message({});
  const place = formPlace(reply, [asked, reply], "Assistant");
  assert.deepEqual([...place.forms.keys()], ["purchase"]);
  assert.equal(place.last, true);
  assert.equal(formState(false, place, "purchase"), "live");
  // Nothing can be entered while the reply is arriving, whatever else is known.
  assert.equal(formState(true, place, "purchase"), "arriving");
  assert.equal(formState(true, null, undefined), "arriving");
});

test("a form is closed once anything is said after it, and answered when that answers it", () => {
  const reply = message({});
  const typed = message({ id: "later", seq: 2, role: "user", content: "Never mind" });
  assert.equal(
    formState(false, formPlace(reply, [asked, reply, typed], "Assistant"), "purchase"),
    "closed",
  );

  const answer = message({
    id: "answer",
    seq: 2,
    role: "user",
    content: "Purchase request\nItem: Monitor (as suggested)\nAmount: 300 USD",
    createdAt: "2026-11-16T10:05:00.000Z",
    action: {
      messageId: "reply",
      form: "purchase",
      title: "Purchase request",
      answers: [
        { name: "item", label: "Item", value: "Monitor", suggested: true },
        { name: "amount", label: "Amount", value: 300, unit: "USD", suggested: false },
      ],
    },
  });
  const place = formPlace(reply, [asked, reply, answer], "Assistant");
  assert.equal(formState(false, place, "purchase"), "answered");
  assert.equal(place.answered?.at, "2026-11-16T10:05:00.000Z");
  assert.equal(place.answered?.action.answers[1]?.value, 300);
  // An answer to another reply's form is not an answer to this one.
  const other = { ...answer, action: { ...(answer.action as object), messageId: "another" } };
  assert.equal(
    formState(false, formPlace(reply, [asked, reply, other], "Assistant"), "purchase"),
    "closed",
  );
});

test("a form in a reply that did not finish cannot be answered", () => {
  for (const status of ["failed", "stopped"] as const) {
    const reply = message({ status });
    const place = formPlace(reply, [asked, reply], "Assistant");
    assert.equal(place.forms.size, 0);
    assert.equal(formState(false, place, "purchase"), "unfinished");
  }
  assert.equal(formState(false, null, "purchase"), "closed");
});

test("a day is set out as YYYY-MM-DD as its digits are typed", () => {
  assert.equal(asDay("2026"), "2026");
  assert.equal(asDay("202612"), "2026-12");
  assert.equal(asDay("20261201"), "2026-12-01");
  assert.equal(asDay("2026-12-01"), "2026-12-01");
  assert.equal(asDay("2026/12/01 and more 99"), "2026-12-01");
  assert.equal(asDay(""), "");
});

test("a form in a reply cut off at its longest is unfinished, though the reply is stored as complete", () => {
  const reply = message({ ending: "length" });
  const place = formPlace(reply, [asked, reply], "Assistant");
  assert.equal(place.forms.size, 0);
  assert.equal(formState(false, place, "purchase"), "unfinished");
});

test("a form says the agent that asked, which may be one invited into the conversation", () => {
  const invited = message({ agentName: "Writer" });
  assert.equal(formPlace(invited, [asked, invited], "Assistant").agent, "Writer");
  const own = message({});
  assert.equal(formPlace(own, [asked, own], "Assistant").agent, "Assistant");
});

test("what a number may be is said in one of three ways, or not at all", () => {
  assert.equal(rangeOf({ min: 0, max: 9 }), "between");
  assert.equal(rangeOf({ min: 0 }), "atLeast");
  assert.equal(rangeOf({ max: 9 }), "atMost");
  assert.equal(rangeOf({}), null);
});
