import { describe, expect, it } from "vitest";
import {
  capOf,
  capText,
  cpuTime,
  GB,
  idleOnes,
  keptFor,
  releasedIn,
  runningFor,
  sorted,
  whole,
} from "./sandboxLogic";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const space = (days: number, bytes: number, more: { busy?: boolean; proposal?: boolean } = {}) => ({
  usedAt: ago(days),
  bytes,
  busy: false,
  proposal: false,
  ...more,
});

describe("the Sandbox page", () => {
  it("says in how many days a workspace is released, and 0 once it is due", () => {
    expect(releasedIn(ago(0), 7, NOW)).toBe(7);
    expect(releasedIn(ago(6.5), 7, NOW)).toBe(1);
    expect(releasedIn(ago(7), 7, NOW)).toBe(0);
    expect(releasedIn(ago(30), 7, NOW)).toBe(0);
    expect(releasedIn(ago(2), 1, NOW)).toBe(0);
  });

  it("counts what releasing all idle would release: old enough, and not kept", () => {
    const all = [
      space(3, 100),
      space(0.5, 200),
      space(9, 400, { busy: true }),
      space(9, 800, { proposal: true }),
      space(1, 1600),
    ];
    const idle = idleOnes(all, 1, NOW);
    expect(idle.ones.map((one) => one.bytes)).toEqual([100, 1600]);
    expect(idle.bytes).toBe(1700);
    expect(idleOnes(all, 0, NOW).ones).toHaveLength(3);
    expect(idleOnes([], 1, NOW)).toEqual({ ones: [], bytes: 0 });
    expect(keptFor({ busy: true, proposal: true })).toBe("running");
    expect(keptFor({ busy: false, proposal: true })).toBe("proposal");
    expect(keptFor({ busy: false, proposal: false })).toBeNull();
  });

  it("sorts workspaces largest first or longest idle first, and leaves the list as it was", () => {
    const all = [space(1, 300), space(5, 100), space(3, 900)];
    expect(sorted(all, "size").map((one) => one.bytes)).toEqual([900, 300, 100]);
    expect(sorted(all, "used").map((one) => one.bytes)).toEqual([100, 900, 300]);
    expect(all.map((one) => one.bytes)).toEqual([300, 100, 900]);
  });

  it("reads numbers as typed, and nothing else as a number", () => {
    expect(whole(" 7 ", 90)).toBe(7);
    expect(whole("0", 90)).toBe(0);
    for (const not of ["", "91", "-1", "1.5", "seven", "1e3"]) expect(whole(not, 90)).toBeNull();
    expect(capOf("")).toBeNull();
    expect(capOf("2")).toBe(2 * GB);
    expect(capOf("0.5")).toBe(GB / 2);
    for (const not of ["0", "0.01", "abc", "-2", "1.234"]) expect(capOf(not)).toBeUndefined();
    expect(capText(null)).toBe("");
    expect(capText(2 * GB)).toBe("2");
    expect(capText(GB / 2)).toBe("0.5");
    expect(capOf(capText(1.25 * GB))).toBe(1.25 * GB);
  });

  it("says how long in words a row has room for", () => {
    const units = { s: "s", min: "min", h: "h" };
    expect(runningFor(null, NOW)).toBe(0);
    expect(runningFor(new Date(NOW - 42_400).toISOString(), NOW)).toBe(42);
    expect(cpuTime(30, units)).toBe("30 s");
    expect(cpuTime(600, units)).toBe("10 min");
    expect(cpuTime(7200, units)).toBe("2.0 h");
  });
});
