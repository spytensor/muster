import { describe, expect, it } from "vitest";
import { bandPath, FLOWS_MOST, layoutFlows } from "./flows.js";

describe("the layout of a flow diagram", () => {
  const flows = [
    { from: "销售收入", to: "运营", value: 1200 },
    { from: "销售收入", to: "研发", value: 400 },
    { from: "融资", to: "运营", value: 400 },
    { from: "融资", to: "偿债", value: 600 },
  ];

  it("puts sources at the left and uses at the right, each as tall as what passes through", () => {
    const laid = layoutFlows(flows, 600, 300);
    expect(laid.columns).toBe(2);
    const node = (name: string) => laid.nodes.find((one) => one.name === name);
    expect(node("销售收入")?.column).toBe(0);
    expect(node("运营")?.column).toBe(1);
    expect(node("运营")?.x).toBe(590);
    const unit = (node("销售收入")?.height ?? 0) / 1600;
    expect(node("运营")?.height).toBeCloseTo(1600 * unit, 6);
    expect(node("偿债")?.height).toBeCloseTo(600 * unit, 6);
    // Nothing leaves the box, and no two boxes of a column overlap.
    for (const one of laid.nodes) {
      expect(one.y).toBeGreaterThanOrEqual(0);
      expect(one.y + one.height).toBeLessThanOrEqual(300 + 1e-6);
    }
    const right = laid.nodes.filter((one) => one.column === 1).sort((a, b) => a.y - b.y);
    for (let at = 1; at < right.length; at += 1)
      expect(right[at]?.y).toBeGreaterThanOrEqual(
        (right[at - 1]?.y ?? 0) + (right[at - 1]?.height ?? 0),
      );
    // A band is as thick as its amount and ends inside its two boxes.
    for (const band of laid.bands) {
      const from = node(band.from);
      const to = node(band.to);
      expect(band.thickness).toBeCloseTo(band.value * unit, 6);
      expect(band.y0).toBeGreaterThanOrEqual((from?.y ?? 0) - 1e-6);
      expect(band.y0).toBeLessThanOrEqual((from?.y ?? 0) + (from?.height ?? 0) + 1e-6);
      expect(band.y1).toBeGreaterThanOrEqual((to?.y ?? 0) - 1e-6);
      expect(band.y1).toBeLessThanOrEqual((to?.y ?? 0) + (to?.height ?? 0) + 1e-6);
      expect(bandPath(band)).toMatch(/^M[\d.]+,[\d.]+ C/);
    }
  });

  it("stands what passes on in the middle, and what nothing leaves at the right", () => {
    const laid = layoutFlows(
      [
        { from: "A", to: "B", value: 5 },
        { from: "B", to: "C", value: 3 },
        { from: "A", to: "D", value: 2 },
      ],
      400,
      200,
    );
    const column = Object.fromEntries(laid.nodes.map((one) => [one.name, one.column]));
    expect(column).toEqual({ A: 0, B: 1, C: 2, D: 2 });
  });

  it("leaves out what is not a flow, and a flow that would close a circle", () => {
    const laid = layoutFlows(
      [
        { from: "A", to: "B", value: 5 },
        { from: "B", to: "A", value: 5 },
        { from: "B", to: "B", value: 1 },
        { from: "B", to: "C", value: -2 },
        { from: "", to: "C", value: 2 },
        { from: "B", to: "C", value: Number.NaN },
        null as never,
      ],
      400,
      200,
    );
    expect(laid.bands.map((band) => `${band.from}>${band.to}`)).toEqual(["A>B"]);
    expect(layoutFlows([], 400, 200).nodes).toEqual([]);
    expect(layoutFlows([{ from: "A", to: "B", value: 1 }], 0, 200).nodes).toEqual([]);
  });

  it("holds no more than a drawing can show, however many it is given", () => {
    const many = Array.from({ length: 500 }, (_, at) => ({
      from: `s${at}`,
      to: `t${at}`,
      value: 1,
    }));
    const laid = layoutFlows(many, 600, 300);
    expect(laid.nodes.length).toBeLessThanOrEqual(FLOWS_MOST.nodes);
    expect(laid.bands.length).toBeLessThanOrEqual(FLOWS_MOST.flows);
    for (const one of laid.nodes) expect(Number.isFinite(one.y + one.height)).toBe(true);
  });
});
