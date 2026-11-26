import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columnsFor,
  fraction,
  mix,
  movedColour,
  numberOr,
  PALETTE,
  radarPath,
  signOf,
  slices,
  span,
  stackSums,
  tones,
  treemap,
  upOf,
} from "../src/lib/visuals.ts";

const light = PALETTE.light;

test("a colour between two is theirs at the ends and never outside them", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#000000", "#ffffff", 7), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", Number.NaN), "#000000");
});

test("where a rise is red, rises are red and falls green, stronger the further from zero", () => {
  const [big, small, none, fall] = tones([9, 1, 0, -9], "red", light);
  assert.equal(big?.fill, mix(light.mid, light.red, 1));
  assert.equal(big?.strong, true);
  assert.equal(small?.strong, false);
  assert.notEqual(small?.fill, light.mid);
  // Nothing moved: the neutral middle, never a faint red or green.
  assert.equal(none?.fill, light.mid);
  assert.equal(fall?.fill, mix(light.mid, light.green, 1));
});

test("where a rise is green the two colours change places", () => {
  const [rise, fall] = tones([5, -5], "green", light);
  assert.equal(rise?.fill, mix(light.mid, light.green, 1));
  assert.equal(fall?.fill, mix(light.mid, light.red, 1));
});

test("numbers that are not rises and falls wear one hue, light to dark", () => {
  const [low, mid, high] = tones([10, 20, 30], undefined, light);
  assert.equal(high?.fill, mix(light.mid, light.blue, 1));
  assert.equal(low?.fill, mix(light.mid, light.blue, 0.14));
  assert.equal(low?.strong, false);
  assert.equal(high?.strong, true);
  assert.ok(mid && mid.fill !== low?.fill && mid.fill !== high?.fill);
  // Some below zero: blue above it, orange below, and neither red nor green.
  const [above, below] = tones([4, -4], undefined, light);
  assert.equal(above?.fill, mix(light.mid, light.blue, 1));
  assert.equal(below?.fill, mix(light.mid, light.orange, 1));
});

test("what is not a number has the neutral colour and changes no other", () => {
  const [gap, only] = tones([Number.NaN, 3], "red", light);
  assert.equal(gap?.fill, light.mid);
  assert.equal(only?.fill, mix(light.mid, light.red, 1));
  assert.deepEqual(tones([], "red", light), []);
});

test("a written change is a rise or a fall by the sign it begins with", () => {
  assert.equal(signOf("+2.1%"), 1);
  // As the web reads it: an arrow is a mark, and a sign need not be the first character.
  assert.equal(signOf("▲ 2.1%"), 1);
  assert.equal(signOf("▼ 0.4"), -1);
  assert.equal(signOf("12%"), 0);
  assert.equal(signOf(" -0.7%"), -1);
  assert.equal(signOf("−12"), -1);
  assert.equal(signOf("3.9%"), 0);
  assert.equal(signOf("-0.0%"), 0);
  assert.equal(signOf("+"), 0);
  assert.equal(signOf(""), 0);
  assert.equal(signOf("- none"), 0);
});

test("a rise or a fall has a colour only where the reply said which a rise wears", () => {
  const colours = { red: "R", green: "G" };
  assert.equal(movedColour(1, "red", colours), "R");
  assert.equal(movedColour(-1, "red", colours), "G");
  assert.equal(movedColour(1, "green", colours), "G");
  assert.equal(movedColour(-1, "green", colours), "R");
  assert.equal(movedColour(1, undefined, colours), null);
  assert.equal(movedColour(0, "red", colours), null);
  assert.equal(upOf("red"), "red");
  assert.equal(upOf("blue"), undefined);
  assert.equal(upOf(undefined), undefined);
});

test("a market map fills its box, each tile as large as its weight", () => {
  const weights = [6, 6, 4, 3, 2, 2, 1];
  const tiles = treemap(weights, 600, 400);
  assert.equal(tiles.length, weights.length);
  const total = weights.reduce((a, b) => a + b, 0);
  for (const tile of tiles) {
    const share = (weights[tile.index] ?? 0) / total;
    assert.ok(Math.abs(tile.width * tile.height - share * 600 * 400) < 1e-6);
    assert.ok(tile.x >= -1e-9 && tile.y >= -1e-9);
    assert.ok(tile.x + tile.width <= 600 + 1e-6 && tile.y + tile.height <= 400 + 1e-6);
  }
  // No two tiles share ground.
  for (const a of tiles)
    for (const b of tiles) {
      if (a === b) continue;
      const overlap =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-6 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-6;
      assert.equal(overlap, false);
    }
  // Near to square: none is a sliver.
  for (const tile of tiles)
    assert.ok(Math.max(tile.width / tile.height, tile.height / tile.width) < 4);
});

test("a market map leaves out what has no weight and is nothing without room", () => {
  const tiles = treemap([5, 0, Number.NaN, -2, 5], 100, 100);
  assert.deepEqual(tiles.map((tile) => tile.index).sort(), [0, 4]);
  assert.deepEqual(treemap([1, 2], 0, 100), []);
  assert.deepEqual(treemap([], 100, 100), []);
  assert.deepEqual(treemap([0, 0], 100, 100), []);
});

test("tiles of one size go as many across as the width has room for", () => {
  assert.equal(columnsFor(12, 340), 4);
  assert.equal(columnsFor(3, 340), 3);
  assert.equal(columnsFor(12, 100), 2);
  assert.equal(columnsFor(1, 340), 1);
});

test("a pie's shares add up to the whole, and the smallest fold into one once there are too many", () => {
  const few = slices([50, 30, 20], 50, 50, 49, 25);
  assert.deepEqual(
    few.map((part) => part.index),
    [0, 1, 2],
  );
  assert.ok(Math.abs(few.reduce((sum, part) => sum + part.share, 0) - 1) < 1e-9);
  const many = slices([30, 5, 20, 4, 15, 3, 12, 2, 9], 50, 50, 49, 25);
  assert.equal(many.length, 6);
  assert.equal(many[many.length - 1]?.index, -1);
  // The five largest keep their places; the rest are one share.
  assert.deepEqual(
    many.slice(0, 5).map((part) => part.index),
    [0, 2, 4, 6, 8],
  );
  assert.equal(many[5]?.value, 5 + 4 + 3 + 2);
  assert.ok(Math.abs(many.reduce((sum, part) => sum + part.share, 0) - 1) < 1e-9);
});

test("a pie leaves out what is not an amount, and one slice is still a ring", () => {
  assert.deepEqual(slices([0, -4, Number.NaN], 50, 50, 49, 25), []);
  const one = slices([7], 50, 50, 49, 25);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.share, 1);
  assert.ok(!one[0]?.path.includes("NaN"));
  const kept = slices([3, -1, 1], 50, 50, 49, 25);
  assert.deepEqual(
    kept.map((part) => part.index),
    [0, 2],
  );
});

test("a radar's outline has a corner on every spoke, and none without three", () => {
  const path = radarPath([10, 5, 0], 3, 100, 100, 50, 10);
  // The first spoke points up; a value of nothing sits at the middle.
  assert.ok(path.startsWith("M100.0 50.0 L"));
  assert.ok(path.endsWith("L100.0 100.0 Z"));
  assert.equal(radarPath([1, 2], 2, 100, 100, 50, 10), "");
  assert.equal(radarPath([1, 2, 3], 3, 100, 100, 50, 0), "");
  assert.ok(!radarPath([Number.NaN, 99, -4], 3, 100, 100, 50, 10).includes("NaN"));
});

test("a scale that need not start at zero stays near its values, in round steps", () => {
  const scale = span([182.4, 190.1, 176.9]);
  assert.ok(scale.min <= 176.9 && scale.min > 150);
  assert.ok(scale.max >= 190.1 && scale.max < 220);
  assert.equal(scale.ticks[0], scale.min);
  assert.equal(scale.ticks[scale.ticks.length - 1], scale.max);
  const flat = span([5, 5]);
  assert.ok(flat.min < 5 && flat.max > 5);
  assert.deepEqual(span([]).ticks, [0, 1]);
  assert.ok(span([0, 0]).max > span([0, 0]).min);
});

test("stacked parts add up above zero and below it apart", () => {
  const sums = stackSums([{ values: [1, -2, 3] }, { values: [4, 5, Number.NaN] }], 3);
  assert.deepEqual(sums.above, [5, 5, 3]);
  assert.deepEqual(sums.below, [0, -2, 0]);
});

test("progress is a share of its target, never less than none or more than all", () => {
  assert.equal(fraction(30, 120), 0.25);
  assert.equal(fraction(150, 120), 1);
  assert.equal(fraction(-5, 120), 0);
  assert.equal(fraction(5, 0), 0);
  assert.equal(fraction(Number.NaN, 10), 0);
});

test("only a number is a number", () => {
  assert.equal(numberOr(3.5), 3.5);
  assert.ok(Number.isNaN(numberOr("3.5")));
  assert.ok(Number.isNaN(numberOr(null)));
  assert.ok(Number.isNaN(numberOr(Number.POSITIVE_INFINITY)));
});
