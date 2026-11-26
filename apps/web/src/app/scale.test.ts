import { describe, expect, it } from "vitest";
import {
  fillOf,
  fold,
  hueOf,
  numbers,
  radiusOf,
  signOf,
  sparkPoints,
  ticks,
  toneOf,
  treemap,
  waterfall,
  withUnit,
} from "./scale";

describe("the colour and place of a number", () => {
  it("reads the sign of a change as it is written, and none where none is written", () => {
    expect(signOf("+2.1%")).toBe(1);
    expect(signOf("-0.7%")).toBe(-1);
    expect(signOf("−3")).toBe(-1);
    expect(signOf("▲ 4")).toBe(1);
    expect(signOf("+$1,200")).toBe(1);
    expect(signOf("12%")).toBe(0);
    expect(signOf("+0.0%")).toBe(0);
    expect(signOf("n/a")).toBe(0);
  });

  it("colours a rise red where that is the custom and green where it is not", () => {
    expect(hueOf(1, "red")).toBe("red");
    expect(hueOf(-1, "red")).toBe("green");
    expect(hueOf(1, "green")).toBe("green");
    expect(hueOf(-1, "green")).toBe("red");
    expect(hueOf(0, "red")).toBeNull();
    expect(hueOf(1, undefined)).toBeNull();
  });

  it("fills by how far a number moved, with grey and no hue at the midpoint", () => {
    const all = [9, 4.5, -1.2, 0];
    expect(toneOf(9, all, "red")).toEqual({ hue: "red", strength: 1 });
    expect(toneOf(4.5, all, "red")).toEqual({ hue: "red", strength: 0.5 });
    expect(toneOf(-1.2, all, "red").hue).toBe("green");
    expect(fillOf(toneOf(0, all, "red"))).toBe("var(--heat-mid)");
    expect(fillOf({ hue: "red", strength: 1 })).toContain("var(--pole-red) 100%");
    // Amounts, not changes: one hue from the least to the most.
    expect(toneOf(10, [10, 20, 30], undefined)).toEqual({ hue: "blue", strength: 0 });
    expect(toneOf(30, [10, 20, 30], undefined)).toEqual({ hue: "blue", strength: 1 });
    // Some below zero and no custom named: two hues that are not a rise and a fall.
    expect(toneOf(-5, [-5, 10], undefined)).toEqual({ hue: "orange", strength: 0.5 });
  });

  it("keeps only numbers", () => {
    expect(numbers([1, "2", null, "x", Number.NaN, 3])).toEqual([1, 2, 0, 3]);
    expect(numbers("no")).toEqual([]);
  });

  it("folds the small slices of a pie into one", () => {
    const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const folded = fold(labels, [8, 7, 6, 5, 4, 3, 2, 1], "Other");
    expect(folded.map((slice) => slice.name)).toEqual(["a", "b", "c", "d", "e", "Other"]);
    expect(folded.at(-1)?.value).toBe(6);
    expect(fold(["a", "b"], [1, 0], "Other")).toEqual([{ name: "a", value: 1 }]);
  });

  it("gives every weight a rectangle of its share, inside the box and apart from the others", () => {
    const weights = [6, 6, 4, 3, 2, 2, 1, 0];
    const rects = treemap(weights, 600, 400);
    const total = weights.reduce((a, b) => a + b, 0);
    rects.forEach((rect, index) => {
      expect(rect.w * rect.h).toBeCloseTo((600 * 400 * (weights[index] ?? 0)) / total, 3);
      expect(rect.x).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-6);
      expect(rect.x + rect.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(rect.y + rect.h).toBeLessThanOrEqual(400 + 1e-6);
    });
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const one = rects[a];
        const two = rects[b];
        if (!one || !two || !one.w || !two.w) continue;
        const across = Math.min(one.x + one.w, two.x + two.w) - Math.max(one.x, two.x);
        const down = Math.min(one.y + one.h, two.y + two.h) - Math.max(one.y, two.y);
        expect(across > 1e-6 && down > 1e-6).toBe(false);
      }
    // Near square, which is the point of it: no sliver in a set like this one.
    for (const rect of rects.filter((one) => one.w))
      expect(Math.max(rect.w / rect.h, rect.h / rect.w)).toBeLessThan(4);
    expect(treemap([], 100, 100)).toEqual([]);
    expect(treemap([1, 2], 0, 100).every((rect) => rect.w === 0)).toBe(true);
  });

  it("marks an axis at round numbers", () => {
    expect(ticks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(3, 3)).toEqual([3]);
    // Numbers so large a step no longer moves them: an answer, not a loop without end.
    expect(ticks(1e16, 10000000000000002).length).toBeLessThanOrEqual(12);
    expect(ticks(-1e300, 1e300).length).toBeLessThanOrEqual(12);
    expect(ticks(98.2, 104.9).every((n) => n >= 98.2 && n <= 104.9)).toBe(true);
  });

  it("puts a currency sign before the number and any other unit after it", () => {
    expect(withUnit("1,200", "$")).toBe("$1,200");
    expect(withUnit("1.2", "$M")).toBe("$1.2M");
    expect(withUnit("-3", "¥")).toBe("-¥3");
    expect(withUnit("38", "%")).toBe("38%");
    expect(withUnit("12", " USD")).toBe("12 USD");
    expect(withUnit("12")).toBe("12");
  });

  it("walks a waterfall from its opening amount through each change to a total it adds", () => {
    expect(waterfall([100, 30, -50, null, 20])).toEqual([
      { from: 0, to: 100, change: 100, kind: "open" },
      { from: 100, to: 130, change: 30, kind: "move" },
      { from: 130, to: 80, change: -50, kind: "move" },
      null,
      { from: 80, to: 100, change: 20, kind: "move" },
      { from: 0, to: 100, change: 100, kind: "total" },
    ]);
    expect(waterfall([])).toEqual([]);
    expect(waterfall([null])).toEqual([null]);
  });

  it("sizes a bubble by area and draws a figure's trend inside its box", () => {
    expect(radiusOf(undefined, [1, 4])).toBe(4);
    expect(radiusOf(4, [1, 4])).toBe(14);
    expect(radiusOf(1, [1, 4])).toBe(9);
    expect(radiusOf(-1, [1, 4])).toBe(4);
    const points = sparkPoints([1, 3, 2], 64, 20).split(" ");
    expect(points).toHaveLength(3);
    expect(points[0]).toBe("2.0,18.0");
    expect(points[1]).toBe("32.0,2.0");
    // All the same: a level line, not a division by nothing.
    expect(sparkPoints([5, 5], 64, 20)).toBe("2.0,10.0 62.0,10.0");
  });
});
