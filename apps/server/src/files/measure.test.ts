import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFile } from "./make.js";
import { hasSquare, linesOf, textWide } from "./measure.js";

describe("measuring text", () => {
  it("knows the widths of letters, and that bold and Chinese are wider", () => {
    // Ten digits of Arial at 72 points are 5.56 inches.
    expect(textWide("0123456789", 72)).toBeCloseTo(5.56, 2);
    expect(textWide("illicit", 20)).toBeLessThan(textWide("WWWWWWW", 20));
    expect(textWide("Revenue", 20, true)).toBeGreaterThan(textWide("Revenue", 20));
    expect(textWide("营业收入", 72, false, true)).toBeCloseTo(4, 5);
    expect(hasSquare("Q3 营收")).toBe(true);
    expect(hasSquare("Q3 revenue")).toBe(false);
  });

  it("counts lines: words kept whole, long words broken, Chinese broken anywhere", () => {
    expect(linesOf("short", 18, 5)).toBe(1);
    expect(linesOf("", 18, 5)).toBe(1);
    expect(linesOf("one\ntwo\nthree", 18, 5)).toBe(3);
    const sentence = "A fairly long sentence that is certain to wrap onto a second line";
    const one = textWide(sentence, 18);
    expect(linesOf(sentence, 18, one * 1.1)).toBe(1);
    expect(linesOf(sentence, 18, one / 2)).toBeGreaterThanOrEqual(2);
    expect(linesOf(sentence, 18, one / 2)).toBeLessThanOrEqual(3);
    // A word longer than the line takes the lines its letters need.
    expect(linesOf("Internationalisation", 20, 1)).toBeGreaterThanOrEqual(3);
    // Forty Chinese characters of 18 points are ten inches: three lines of four.
    expect(linesOf("字".repeat(40), 18, 4, false, true)).toBe(3);
    // A closing mark does not begin a line: the character before it comes down too, so
    // five characters and a comma in a box of five take two lines, the second of two.
    expect(linesOf("一二三四五，六", 72, 5.2, false, true)).toBe(2);
    // An address breaks after its slashes, not only where the line is full.
    const address = "https://example.com/a-very-long/path/to/some/page?with=a&query=string";
    expect(linesOf(address, 18, 3)).toBeGreaterThanOrEqual(Math.ceil(textWide(address, 18) / 3));
    // What is not known is taken wide: Cyrillic capitals, an en dash, an arrow.
    expect(textWide("ЖШЩЮ", 72)).toBeGreaterThanOrEqual(3.6);
    expect(textWide("–", 72)).toBeGreaterThanOrEqual(0.55);
    expect(textWide("→①★", 72, false, true)).toBe(3);
    // A narrower box never takes fewer lines.
    for (const wide of [8, 6, 4, 3, 2, 1.5])
      expect(linesOf(sentence, 18, wide)).toBeGreaterThanOrEqual(linesOf(sentence, 18, wide + 1));
  });
});

/** Every text box of every slide: where it is and how large, in inches. */
function boxes(bytes: Uint8Array) {
  const parts = unzipSync(bytes);
  const slides: { x: number; y: number; w: number; h: number; text: string }[][] = [];
  for (let n = 1; parts[`ppt/slides/slide${n}.xml`]; n++) {
    const xml = strFromU8(parts[`ppt/slides/slide${n}.xml`] as Uint8Array);
    const found: (typeof slides)[number] = [];
    for (const shape of xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? []) {
      const at = shape.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
      const text = [...shape.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((one) => one[1]).join("");
      if (!at || !text) continue;
      const [x, y, w, h] = at.slice(1).map((one) => Number(one) / 914400) as [
        number,
        number,
        number,
        number,
      ];
      found.push({ x, y, w, h, text });
    }
    slides.push(found);
  }
  return slides;
}

describe("a deck's texts", () => {
  const zh = "这是一段比较长的中文说明文字，用来检验换行之后的行高和下一块内容之间会不会互相压住";
  const en =
    "A fairly long sentence in English that is certain to wrap onto a second and perhaps a third line in a narrow box";
  const decks = (long: string, word: string) => [
    { layout: "cover", title: `${long} ${long}`, subtitle: long },
    {
      title: long,
      subtitle: long,
      stats: [
        { value: "$42.6M", label: "Revenue, consolidated", note: long },
        { value: "61.4%", label: "Margin", note: "Target 60%" },
        { value: "Q3 2026 launch", label: "Next" },
        { value: "112%", label: "Retention", note: "Up from 108%" },
      ],
      takeaway: long,
    },
    {
      title: "Options",
      columns: [
        { heading: long, bullets: [long, "Short", "Short"] },
        { heading: "Two", bullets: ["Short", long] },
        { heading: "Three", text: `${long} ${long}` },
      ],
    },
    {
      title: "Steps",
      steps: Array.from({ length: 6 }, (_, i) => ({
        title: `${word} ${i + 1}`,
        text: i % 2 ? long : "Short",
      })),
      takeaway: "Each ends with a review.",
    },
    { title: "Risks", bullets: [long, { text: long, sub: [long, "Short"] }, long, "Short"] },
    { title: "Said", quote: { text: `${long} ${long} ${long}`, by: long } },
    {
      title: "Numbers, points and a chart",
      stats: [
        { value: "42.6", label: "Revenue", note: "+18%" },
        { value: "61%", label: "Margin" },
      ],
      chart: { type: "bar", categories: ["a", "b"], series: [{ name: "x", values: [1, 2] }] },
      bullets: ["Short", "Short"],
    },
    { layout: "section", title: long, subtitle: long },
    { layout: "closing", title: "Thanks", subtitle: long, bullets: ["a@example.com", long] },
  ];

  it("never stand one on another, and never leave the slide", async () => {
    for (const slides of [decks(en, "Internationalisation"), decks(zh, "国际化推进阶段")]) {
      const bytes = await makeFile("d.pptx", "slides", { slides } as never);
      const pages = boxes(bytes);
      expect(pages.length).toBe(slides.length);
      for (const [index, page] of pages.entries()) {
        for (const box of page) {
          expect(box.x, `slide ${index + 1} "${box.text.slice(0, 20)}"`).toBeGreaterThanOrEqual(0);
          expect(box.y, `slide ${index + 1} "${box.text.slice(0, 20)}"`).toBeGreaterThanOrEqual(0);
          expect(
            box.x + box.w,
            `slide ${index + 1} "${box.text.slice(0, 20)}"`,
          ).toBeLessThanOrEqual(13.34);
          expect(
            box.y + box.h,
            `slide ${index + 1} "${box.text.slice(0, 20)}"`,
          ).toBeLessThanOrEqual(7.5);
        }
        for (const [i, a] of page.entries())
          for (const b of page.slice(i + 1)) {
            const apart =
              a.x + a.w <= b.x + 0.001 ||
              b.x + b.w <= a.x + 0.001 ||
              a.y + a.h <= b.y + 0.001 ||
              b.y + b.h <= a.y + 0.001;
            expect(
              apart,
              `slide ${index + 1}: "${a.text.slice(0, 20)}" over "${b.text.slice(0, 20)}"`,
            ).toBe(true);
          }
      }
    }
  });

  it("takes a line break out of a text, so a point is one paragraph with one bullet", async () => {
    const bytes = await makeFile("n.pptx", "slides", {
      slides: [
        {
          title: "Plan",
          bullets: ["Pricing:\nmove to usage-based by Q2\nkeep seats for legacy", "Second"],
          takeaway: "Decide by March.",
        },
      ],
    } as never);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"] as Uint8Array);
    expect(xml).toContain("Pricing: move to usage-based by Q2 keep seats for legacy");
    expect(xml.match(/<a:buChar/g)?.length).toBe(2);
  });

  it("is refused, with what to do, when a slide holds more than can be set apart", async () => {
    const long = Array.from({ length: 12 }, () => `${en} ${en} ${en}`);
    await expect(
      makeFile("d.pptx", "slides", { slides: [{ title: "Too much", bullets: long }] } as never),
    ).rejects.toThrow(/holds more text than fits/);
    await expect(
      makeFile("d.pptx", "slides", {
        slides: [{ title: "Said", quote: { text: `${en} `.repeat(40) } }],
      } as never),
    ).rejects.toThrow(/holds more text than fits/);
  });

  it("gives a table row the height its longest cell needs, and a slide the rows that fit", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => [
      `Row ${i + 1}`,
      i,
      i % 2 ? `${en} ${en}` : "ok",
    ]);
    const bytes = await makeFile("t.pptx", "slides", {
      slides: [{ title: "Table", table: { headers: ["Name", "Value", "Comment"], rows } }],
    } as never);
    const parts = unzipSync(bytes);
    let seen = 0;
    for (let n = 1; parts[`ppt/slides/slide${n}.xml`]; n++) {
      const xml = strFromU8(parts[`ppt/slides/slide${n}.xml`] as Uint8Array);
      const top = Number(xml.match(/<p:graphicFrame>.*?<a:off x="\d+" y="(\d+)"/s)?.[1]) / 914400;
      const heights = [...xml.matchAll(/<a:tr h="(\d+)"/g)].map((one) => Number(one[1]) / 914400);
      seen += heights.length - 1;
      // The rows of a slide end above where content must end.
      expect(top + heights.reduce((sum, one) => sum + one, 0)).toBeLessThanOrEqual(6.71);
      // A row with a long comment stands taller than one without.
      expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights) * 1.5);
    }
    expect(seen).toBe(12);
  });
});
