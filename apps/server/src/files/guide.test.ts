import { describe, expect, it } from "vitest";
import { guideFor, review } from "./guide.js";

describe("how a file is written here", () => {
  it("has a guide for each kind, by any of its names, and none for another", () => {
    expect(guideFor("document")).toContain("Sentences do not go in cells");
    expect(guideFor("docx")).toBe(guideFor("document"));
    expect(guideFor("presentation")).toContain("One message to a slide");
    expect(guideFor("Deck")).toBe(guideFor("presentation"));
    expect(guideFor("workbook")).toContain("One table to a sheet");
    expect(() => guideFor("poster")).toThrow();
    // Every guide carries what is said of the words of any file.
    for (const kind of ["document", "presentation", "workbook"])
      expect(guideFor(kind)).toContain("No labels of your own working");
  });

  it("finds nothing in a document written as the guide says", () => {
    const text = [
      "# Q3 review",
      "",
      "Revenue reached $42.6M, 18% above last year. **Europe missed plan by $0.7M.**",
      "",
      "## Results by region",
      "",
      "| Region | Revenue ($M) | Plan ($M) |",
      "|---|---|---|",
      "| North America | 21.4 | 20.0 |",
      "| Europe | 11.8 | 12.5 |",
      "| Asia Pacific | 6.9 | 6.0 |",
      "",
      "North America carried the quarter. The Q3 plan and the H1 result are in the appendix.",
      "",
      "- Hire two sellers in Europe.",
      "- Launch the usage tier on 1 November.",
    ].join("\n");
    expect(review("r.docx", { text })).toEqual([]);
    // Only a document and a deck are read; a workbook's faults are said where it is made.
    expect(review("r.xlsx", { text })).toEqual([]);
    expect(review("r.md", { text })).toEqual([]);
  });

  it("says when a table holds sentences, paragraphs run on, bold leads everything, or working labels show", () => {
    const sentence =
      "This is a whole sentence about the thing, long enough to wrap in a narrow cell.";
    const table = [
      "| Kind | What it is | What it finds | Limits |",
      "|---|---|---|---|",
      `| One | ${sentence} | ${sentence} | ${sentence} |`,
      `| Two | ${sentence} | ${sentence} | ${sentence} |`,
    ].join("\n");
    const found = review("r.docx", { text: `# T\n\n${table}` });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('The table headed "Kind / What it is / What it finds / Limits"');
    expect(found[0]).toContain("holds sentences");

    const chinese = "这是一段很长的话".repeat(40);
    expect(review("r.docx", { text: `# T\n\n${chinese}` })[0]).toContain(
      "A paragraph runs well over",
    );

    const led = Array.from({ length: 6 }, (_, i) => `**Point ${i}.** Something is said here.`);
    expect(review("r.docx", { text: led.join("\n\n") })[0]).toContain(
      "6 of 6 paragraphs begin with a bold phrase",
    );

    const labels = "See N23, N24 and N25, which follow E34, E35 and E36, and Q3 2026.";
    const said = review("r.docx", { text: labels });
    expect(said[0]).toContain("labels of your own working (N23, N24, N25, E34");
    // An aeroplane, a product, a summit or a fuel is named, not labelled.
    expect(
      review("r.docx", {
        text: "We fly the A320, A350, B737 and B787. M365 rollout, G20 summit, Q10 target, E10 fuel.",
      }),
    ).toEqual([]);
    // A paragraph of four sentences and ninety words is as the guide allows; so are a
    // contract's numbered clauses, however long, and a table with a note of nine words.
    const ninety = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    expect(review("r.docx", { text: ninety })).toEqual([]);
    expect(
      review("r.docx", { text: `1.1 ${ninety} ${ninety}\n\n(a) ${ninety} ${ninety}` }),
    ).toEqual([]);
    expect(review("r.docx", { text: "这是一句话。".repeat(33) })).toEqual([]);
    const noted = [
      "| Item | Cost ($) | Notes |",
      "|---|---|---|",
      "| Hosting | 1200 | Billed monthly, includes the staging environment and backups |",
      "| Licences | 300 | [Vendor terms](https://example.com/a/very/long/address/to/the/terms) |",
    ].join("\n");
    expect(review("r.docx", { text: noted })).toEqual([]);
    // A quarter, a paper size or a heading level is not a working label.
    expect(review("r.docx", { text: "Q3, H1, A4 and B2 are fine, and so is ISO 9001." })).toEqual(
      [],
    );

    const wideTable = `| ${Array.from({ length: 8 }, (_, i) => `C${i}`).join(" | ")} |\n|${"---|".repeat(8)}\n| ${Array(8).fill("1").join(" | ")} |`;
    expect(review("r.docx", { text: wideTable })[0]).toContain("has 8 columns");
  });

  it("says when slides are crowded, wordy, or nothing but bullets", () => {
    const bullets = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i}`);
    const good = [
      { layout: "cover", title: "Deck" },
      { title: "Numbers", stats: [{ value: "1", label: "a" }] },
      { title: "Why", bullets: bullets(3) },
      { layout: "closing", title: "Next", bullets: bullets(3) },
    ];
    expect(review("d.pptx", { slides: good })).toEqual([]);
    const crowded = review("d.pptx", { slides: [good[0], { title: "Much", bullets: bullets(7) }] });
    expect(crowded[0]).toContain("Slide 2 has more than five bullets");
    // Five is the most the guide allows, and is let be.
    expect(review("d.pptx", { slides: [good[0], { title: "Five", bullets: bullets(5) }] })).toEqual(
      [],
    );
    const wordy = review("d.pptx", {
      slides: [{ title: "Long", bullets: ["word ".repeat(40)] }],
    });
    expect(wordy[0]).toContain("Slide 1 has a bullet of several lines");
    const plain = review("d.pptx", {
      slides: Array.from({ length: 6 }, (_, i) => ({ title: `S${i}`, bullets: bullets(3) })),
    });
    expect(plain[0]).toContain("6 of 6 slides are bullets alone");
    // Not an array, or not slides: nothing is said and nothing throws.
    expect(review("d.pptx", { slides: "x" })).toEqual([]);
    expect(review("d.pptx", { slides: [null, 3] })).toEqual([]);
  });
});
