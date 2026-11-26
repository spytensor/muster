import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bars,
  compact,
  fitLabel,
  layout,
  linePath,
  textWidth,
  withUnit,
} from "../src/lib/chart.ts";
import {
  bubbleRadii,
  comboSplit,
  flowBox,
  groupsOf,
  kept,
  limitOf,
  MOST,
  PALETTE,
  span,
  spark,
  tones,
  waterfall,
} from "../src/lib/visuals.ts";

test("an axis says large numbers in a larger unit, in the reader's own", () => {
  assert.equal(compact(9999, false), "9,999");
  assert.equal(compact(12_000, false), "12K");
  assert.equal(compact(1_250_000, false), "1.25M");
  assert.equal(compact(1_200_000_000, false), "1.2B");
  assert.equal(compact(-45_600, false), "-45.6K");
  assert.equal(compact(12_000, true), "1.2万");
  assert.equal(compact(34_000_000, true), "3400万");
  assert.equal(compact(120_000_000, true), "1.2亿");
  assert.equal(compact(1_234_567_890, true), "12.3亿");
  assert.equal(compact(0.25, true), "0.25");
  assert.equal(compact(Number.NaN, true), "");
});

test("a sign of money leads the number and the rest of the unit follows", () => {
  assert.equal(withUnit("1,200", "$"), "$1,200");
  assert.equal(withUnit("1.2", "$M"), "$1.2M");
  assert.equal(withUnit("-3.5", "¥"), "-¥3.5");
  assert.equal(withUnit("+3.5", " €"), "+€3.5");
  assert.equal(withUnit("12", "%"), "12%");
  assert.equal(withUnit("12", " USD"), "12 USD");
  assert.equal(withUnit("12", ""), "12");
  assert.equal(withUnit("", "$"), "");
});

test("a label is cut by the room it has, a Chinese character counting for two", () => {
  assert.equal(textWidth("ab"), textWidth("中"));
  assert.equal(fitLabel("Q1", 40), "Q1");
  assert.equal(fitLabel("2026年第一季度", 200), "2026年第一季度");
  const cut = fitLabel("2026年第一季度", 50);
  assert.ok(cut.endsWith("…"));
  assert.ok(textWidth(cut) <= 50);
  assert.ok(cut.length < "2026年第一季度".length);
  assert.equal(fitLabel("abcdef", 1), "");
});

test("a chart keeps the latest of a run and the first of a ranking, numbers under their labels", () => {
  assert.deepEqual(limitOf("bar"), { most: MOST.columns, latest: true });
  assert.deepEqual(limitOf("line"), { most: MOST.line, latest: true });
  assert.deepEqual(limitOf("hbar"), { most: MOST.bars, latest: false });
  assert.deepEqual(limitOf("radar"), { most: MOST.spokes, latest: false });
  const labels = Array.from({ length: 70 }, (_, index) => `d${index}`);
  const series = [{ name: "a", values: labels.map((_, index) => index) }];
  const run = kept("bar", labels, series);
  assert.equal(run.labels.length, 60);
  assert.equal(run.labels[0], "d10");
  assert.equal(run.series[0]?.values[0], 10);
  assert.equal(run.series[0]?.name, "a");
  const ranking = kept("hbar", labels, series);
  assert.equal(ranking.labels.length, 30);
  assert.equal(ranking.labels[0], "d0");
  assert.equal(ranking.series[0]?.values[29], 29);
  assert.equal(kept("line", labels, series).labels.length, 70);
  assert.equal(kept("combo", labels, series).labels[59], "d69");
  assert.equal(kept("waterfall", labels, series).labels.length, 60);
});

test("a waterfall opens from nothing, floats each change and closes with the total", () => {
  const steps = waterfall([100, 30, -50, Number.NaN, 20]);
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["open", "change", "change", "change", "change", "close"],
  );
  assert.deepEqual(steps[0], { index: 0, kind: "open", from: 0, to: 100, change: 100, total: 100 });
  assert.deepEqual(steps[1], {
    index: 1,
    kind: "change",
    from: 100,
    to: 130,
    change: 30,
    total: 130,
  });
  assert.deepEqual(steps[2], {
    index: 2,
    kind: "change",
    from: 130,
    to: 80,
    change: -50,
    total: 80,
  });
  // A place without a number keeps its place and moves nothing.
  assert.equal(steps[3]?.from, 80);
  assert.equal(steps[3]?.to, 80);
  assert.ok(Number.isNaN(steps[3]?.change));
  assert.deepEqual(steps[5], {
    index: -1,
    kind: "close",
    from: 0,
    to: 100,
    change: 100,
    total: 100,
  });
  assert.deepEqual(waterfall([]), []);
  assert.deepEqual(waterfall([Number.NaN]), []);
  // The first number there is opens it, wherever it stands.
  assert.equal(waterfall([Number.NaN, 5, 1])[1]?.kind, "open");
});

test("a combo's first series is its bars and the others its lines", () => {
  assert.deepEqual(comboSplit(["a", "b", "c"]), { bars: ["a"], lines: ["b", "c"] });
  assert.deepEqual(comboSplit(["a"]), { bars: ["a"], lines: [] });
  assert.deepEqual(comboSplit([]), { bars: [], lines: [] });
});

test("a missing number keeps its place: no bar there, and the line breaks", () => {
  const at = layout({ left: 0, top: 0, width: 300, height: 100 }, 3, [
    { values: [1, Number.NaN, 3] },
  ]);
  const drawn = bars(at, [1, Number.NaN, 3], 0, 1, 100);
  assert.equal(drawn[1], null);
  assert.ok(drawn[0] && drawn[2]);
  assert.ok((drawn[2]?.x ?? 0) > 200);
  assert.equal((linePath(at, [1, Number.NaN, 3]).match(/M/g) ?? []).length, 2);
});

test("a dot's area follows its third measure, between the smallest and the largest", () => {
  assert.deepEqual(bubbleRadii([undefined, undefined]), [4.5, 4.5]);
  const radii = bubbleRadii([100, 25, undefined, 0, Number.NaN]);
  assert.equal(radii[0], 14);
  assert.equal(radii[1], 4 + 10 * 0.5);
  assert.deepEqual(radii.slice(2), [4, 4, 4]);
});

test("dots are of at most four kinds, in the order the kinds appear", () => {
  const kinds = groupsOf(["a", "b", undefined, "a", "c", "d", "e"]);
  assert.deepEqual(kinds.names, ["a", "b", "c", "d"]);
  assert.deepEqual(kinds.of, [0, 1, -1, 0, 2, 3, -1]);
  assert.deepEqual(groupsOf([undefined, ""]).names, []);
});

test("a trend is a small line inside its box, and needs two numbers", () => {
  assert.equal(spark([5], 64, 20), null);
  assert.equal(spark([Number.NaN, 5], 64, 20), null);
  const line = spark([1, 3, 2], 64, 20);
  assert.ok(line);
  assert.ok(line.path.startsWith("M2.0 18.0"));
  assert.equal(line.end.x, 62);
  assert.ok(line.end.y > 2 && line.end.y < 18);
  // Flat is a level line, not a division by nothing.
  assert.equal(spark([4, 4, 4], 64, 20)?.end.y, 10);
});

test("what is written on a fill is white only once the fill is well past the middle", () => {
  const toned = tones([10, 6.5, 5, -10], "red", PALETTE.light);
  assert.deepEqual(
    toned.map((tone) => tone.strong),
    [true, true, false, true],
  );
  assert.equal(tones([10, 6, 0], "red", PALETTE.light)[1]?.strong, false);
});

test("lines whose movement is the point sit on a scale that starts near them, not at zero", () => {
  const box = { left: 0, top: 0, width: 300, height: 100 };
  const values = [31, 33, 36];
  const zeroed = layout(box, 3, [{ values }]);
  assert.equal(zeroed.scale.min, 0);
  const free = layout(box, 3, [{ values }], 44, span(values, 3));
  assert.ok(free.scale.min >= 28 && free.scale.min <= 31);
  assert.ok(free.scale.max >= 36);
  // The same three points now use most of the height.
  assert.ok(free.y(31) - free.y(36) > (zeroed.y(31) - zeroed.y(36)) * 3);
});

test("a flow diagram is as tall as its names need and leaves room for them at both edges", () => {
  assert.deepEqual(flowBox(3, 360), { height: 200, side: 90 });
  assert.deepEqual(flowBox(12, 360), { height: 312, side: 90 });
  assert.deepEqual(flowBox(40, 1000), { height: 420, side: 140 });
  assert.deepEqual(flowBox(0, 0), { height: 200, side: 76 });
});
