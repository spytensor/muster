import assert from "node:assert/strict";
import { test } from "node:test";
import { generalOf, isGeneral, shownName } from "../src/lib/types.ts";

test("the general agent is shown as Muster, by what its row says it is", () => {
  assert.equal(shownName({ name: "Assistant", source: "platform" }), "Muster");
  assert.equal(shownName({ name: "Anything", general: true }), "Muster");
  assert.equal(shownName({ name: "Researcher", source: "platform" }), "Researcher");
  // A person's own agent of that name, from before the name was kept, is theirs.
  assert.equal(shownName({ name: "Assistant", source: "user" }), "Assistant");
  assert.equal(shownName({ name: "Assistant", source: "org" }), "Assistant");
  assert.equal(shownName({ name: "Assistant" }), "Assistant");
  assert.equal(isGeneral({ name: "Muster", source: "user" }), false);
});

test("a new conversation starts with the general agent, before a person's own of the same name", () => {
  const mine = { name: "Assistant", source: "user" };
  const general = { name: "Assistant", source: "platform" };
  assert.equal(generalOf([{ name: "Researcher", source: "platform" }, mine, general]), general);
  assert.equal(generalOf([{ name: "Researcher", source: "platform" }]), undefined);
});
