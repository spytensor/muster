import assert from "node:assert/strict";
import { test } from "node:test";
import { carried, clock, daysWith, hours, signed, taken, zones } from "../src/lib/profile.ts";

test("only what the phone really chose is sent up the first time", () => {
  assert.deepEqual(carried({ locale: "zh", appearance: "dark", agent: "a1" }), {
    locale: "zh",
    theme: "dark",
    defaultAgent: "a1",
  });
  // Following the system, or nothing stored, is not a choice to carry.
  assert.deepEqual(carried({ locale: null, appearance: "system", agent: null }), {});
  assert.deepEqual(carried({ locale: "fr", appearance: "sepia", agent: "" }), {});
});

test("what the server holds is taken; what was never chosen leaves the phone as it is", () => {
  assert.deepEqual(taken({ locale: "en", theme: "system", defaultAgent: "a2" }), {
    locale: "en",
    appearance: "system",
    agent: "a2",
  });
  assert.deepEqual(taken({ locale: null, theme: null, defaultAgent: null }), {});
  assert.deepEqual(taken(null), {});
});

test("a time is kept as the server keeps it, and what is not a time is not sent", () => {
  assert.equal(clock("9:30"), "09:30");
  assert.equal(clock(" 0930 "), "09:30");
  assert.equal(clock("9.30"), "09:30");
  assert.equal(clock("18：00"), "18:00");
  for (const not of ["9", "9:5", "24:00", "12:60", "nine", ""]) assert.equal(clock(not), null);
});

test("working hours come as a pair; a day ending before it starts is a night shift", () => {
  assert.deepEqual(hours("9:00", "18:00"), { workStart: "09:00", workEnd: "18:00" });
  assert.deepEqual(hours("22:00", "06:00"), { workStart: "22:00", workEnd: "06:00" });
  assert.equal(hours("09:00", "9:00"), null);
  assert.equal(hours("09:00", ""), null);
});

test("a working day is switched on or off, never the last one off", () => {
  assert.deepEqual(daysWith([1, 2, 3], 5), [1, 2, 3, 5]);
  assert.deepEqual(daysWith([1, 2, 3], 2), [1, 3]);
  assert.deepEqual(daysWith([4], 4), [4]);
});

test("the zones offered include the one already fixed and the phone's own, once each", () => {
  const offered = zones("America/Bogota", "Asia/Dubai");
  assert.deepEqual(offered.slice(0, 2), ["America/Bogota", "Asia/Dubai"]);
  assert.equal(offered.filter((zone) => zone === "Asia/Dubai").length, 1);
  assert.ok(zones(null, "").includes("Asia/Shanghai"));
});

test("a mail is shown with the person's signature under it, once", () => {
  assert.equal(signed("Hello.\n", "Mia Chen"), "Hello.\n\nMia Chen");
  assert.equal(signed("Hello.\n\nMia Chen", "Mia Chen"), "Hello.\n\nMia Chen");
  assert.equal(signed("Hello.", null), "Hello.");
});
