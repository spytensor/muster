import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { checkArchive, extractText, sheetGrids, Unreadable } from "./extract.js";
import { identify } from "./kind.js";
import { CannotMake, makeFile } from "./make.js";

const read = async (name: string, bytes: Uint8Array) => {
  const what = identify(name, bytes);
  if (!what) throw new Error(`${name} was not recognised as what its name says`);
  return (await extractText({ name, ...what }, bytes)).text;
};

describe("making a file and reading it back", () => {
  it("writes a Word document with headings, lists and a table", async () => {
    const bytes = await makeFile("plan.docx", "document", {
      text: "# 季度计划\n\nShip **on Friday**.\n\n- Item one\n- Item two\n\n| Risk | Owner |\n|---|---|\n| Delay | Mia |",
    });
    const text = await read("plan.docx", bytes);
    for (const part of [
      "季度计划",
      "Ship on Friday.",
      "Item one",
      "Item two",
      "Risk",
      "Owner",
      "Delay",
      "Mia",
    ])
      expect(text).toContain(part);
    expect(text).not.toContain("**");
    expect(text).not.toContain("|");
  });

  it("writes a workbook with several sheets, numbers as numbers, and formulas kept as text", async () => {
    const bytes = await makeFile("budget.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "Costs",
          rows: [
            ["Item", "Cost"],
            ["Hosting", 1200.5],
            ['=HYPERLINK("http://x")', 3],
          ],
        },
        { name: "Costs", rows: [["Note"], ["second sheet"]] },
        { name: "A/B: [test]?", rows: [["x"]] },
      ],
    });
    const text = await read("budget.xlsx", bytes);
    expect(text).toContain('--- Sheet "Costs" (3 rows) ---');
    // An agent reads numbers as numbers; text that looks like a formula stays text.
    expect(text).toContain("2: Hosting,1200.5");
    expect(text).toContain('3: "=HYPERLINK(""http://x"")",3');
    expect(text).toContain("second sheet");
    // Three sheets, three different names Excel accepts.
    expect([...text.matchAll(/--- Sheet "([^"]+)"/g)].map((m) => m[1])).toHaveLength(3);
    expect(text).not.toMatch(/--- Sheet "[^"]*[[\]:*?/\\]/);
  });

  it("puts a real chart beside a sheet's table, which a spreadsheet program opens and the preview shows", async () => {
    const bytes = await makeFile("spend.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "'Trend & Bob's more'",
          chart: { type: "line", title: "Monthly spend <2026>" },
          rows: [
            ["Month", "Engineering", "Marketing", "Note"],
            ["Jan", "420000", 260000, "start"],
            ["Feb", 455000, 301000, ""],
            ["Mar", 449000, 322000, ""],
            ["Total", 1324000, 883000, ""],
          ],
        },
        {
          name: "Share",
          chart: { type: "pie" },
          rows: [
            ["Team", "Spend"],
            ["A", 3],
            ["B", 1],
          ],
        },
        {
          name: "Plain",
          rows: [
            ["Year", "Code"],
            [2026, "007"],
          ],
        },
      ],
    });
    const parts = unzipSync(bytes);
    const chart = strFromU8(parts["xl/charts/chart1.xml"] as Uint8Array);
    // A line chart of the two number columns, month by month, without the total or the notes.
    expect(chart).toContain("<c:lineChart>");
    expect(chart.match(/<c:ser>/g)).toHaveLength(2);
    expect(chart).toContain("'Trend &#38; Bob''s more'!$B$2:$B$4");
    expect(chart).not.toContain("1324000");
    // A number given as text was stored as the number it is; a code with leading zeros was not.
    expect(chart).toContain("<c:v>420000</c:v>");
    expect(strFromU8(parts["xl/worksheets/sheet1.xml"] as Uint8Array)).toMatch(
      /<drawing r:id="rIdChart1"\/>\s*<\/worksheet>/,
    );
    expect(strFromU8(parts["[Content_Types].xml"] as Uint8Array)).toContain(
      "/xl/charts/chart2.xml",
    );
    // The workbook still opens, and its text is what it was.
    const text = await read("spend.xlsx", bytes);
    expect(text).toContain("2: Jan,420000,260000,start");
    expect(text).toContain("2: 2026,007");
    // The preview gets the charts with the sheets they are on.
    const grids = await sheetGrids(bytes);
    expect(grids[0]?.charts).toMatchObject([
      {
        kind: "line",
        title: "Monthly spend <2026>",
        categories: ["Jan", "Feb", "Mar"],
        series: [
          { name: "Engineering", values: [420000, 455000, 449000] },
          { name: "Marketing", values: [260000, 301000, 322000] },
        ],
      },
    ]);
    expect(grids[1]?.charts?.[0]).toMatchObject({ kind: "pie", categories: ["A", "B"] });
    expect(grids[2]?.charts).toBeUndefined();
    // A year keeps its plain form; a large amount gets separators.
    expect(grids[2]?.rows[1]?.[0]).toBe("2026");
    expect(grids[0]?.rows[1]?.[1]).toBe("420,000");

    // A chart that cannot be drawn is left out and said; the workbook is still made.
    const left: string[] = [];
    const without = await makeFile(
      "t.xlsx",
      "spreadsheet",
      {
        sheets: [
          {
            name: "Words",
            chart: { type: "bar" },
            rows: [
              ["A", "B"],
              ["x", "y"],
              ["Revenue", "27,192,048"],
            ],
          },
        ],
      },
      left,
    );
    expect(left).toEqual([expect.stringContaining('The chart on sheet "Words" was left out')]);
    expect(Object.keys(unzipSync(without)).some((name) => name.startsWith("xl/charts/"))).toBe(
      false,
    );
    // A figure written with separators is kept as the number it is.
    expect(await read("t.xlsx", without)).toContain("Revenue,27192048");
  });

  it("takes a sheet that begins with a title line and a blank one, and still charts its table", async () => {
    // As a model wrote it on 2026-11-15; the whole workbook was refused for it.
    const bytes = await makeFile("Variance.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "Summary",
          rows: [
            ["Q3 2026 Budget vs Actual", "", ""],
            ["", "", ""],
            ["KPI", "Budget", "Actual"],
            ["Operating income", 2115, 2184],
            ["Net profit", 990, 1021],
          ],
          chart: { type: "bar", title: "Budget vs actual" },
        },
      ],
    });
    const text = await read("Variance.xlsx", bytes);
    expect(text).toContain("1: KPI,Budget,Actual");
    expect(text).toContain("2: Operating income,2115,2184");
    expect(Object.keys(unzipSync(bytes)).some((name) => name.startsWith("xl/charts/chart"))).toBe(
      true,
    );
  });

  it("draws amounts and leaves a rate out of the chart, shown as a percentage in its column", async () => {
    const rows = [
      ["Dept", "Budget", "Actual", "Overspend rate"],
      ["A", 100, 120, 0.2],
      ["B", 200, 190, -0.05],
    ];
    const bytes = await makeFile("rates.xlsx", "spreadsheet", {
      sheets: [
        { name: "All", chart: { type: "bar" }, rows },
        { name: "One", chart: { type: "bar", columns: ["actual"] }, rows },
      ],
    });
    const grids = await sheetGrids(bytes);
    expect(grids[0]?.charts?.[0]?.series.map((one) => one.name)).toEqual(["Budget", "Actual"]);
    expect(grids[1]?.charts?.[0]?.series.map((one) => one.name)).toEqual(["Actual"]);
    expect(grids[0]?.rows[1]?.[3]).toBe("20.0%");
    expect(grids[0]?.rows[2]?.[3]).toBe("-5.0%");
  });

  it("leaves text that only looks like a number alone, and keeps a column to one form", async () => {
    const bytes = await makeFile("people.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "People",
          rows: [
            ["Name", "Phone", "Version", "Rate (%)", "Revenue", "Year"],
            ["Ada", "13812345678", "1.10", 3.5, 1950, 2025],
            ["Bo", "13900001111", "2.0", 4.25, 2500, 2026],
          ],
        },
      ],
    });
    const grid = (await sheetGrids(bytes))[0];
    // A phone number and a version stay as written; a percentage already given as one is
    // not multiplied, and shows two decimals as the 4.25 under it does.
    expect(grid?.rows[1]?.slice(1, 4)).toEqual(["13812345678", "1.10", "3.50"]);
    // As many decimals as the most exact figure of the column: nothing is rounded away.
    const exact = (
      await sheetGrids(
        await makeFile("r.xlsx", "spreadsheet", {
          sheets: [
            {
              name: "Rates",
              rows: [
                ["Item", "Exchange rate", "Headcount", "Unit price"],
                ["A", 1.0834, 12, 0.0125],
                ["B", 7.2311, 15, 0.0042],
                ["Average", "", "=ROUND(AVERAGE(C2:C3),1)", ""],
              ],
            },
          ],
        }),
      )
    )[0];
    expect(exact?.rows[1]).toEqual(["A", "1.0834", "12", "0.0125"]);
    expect(exact?.rows[2]).toEqual(["B", "7.2311", "15", "0.0042"]);
    // An average under whole numbers is shown as it comes out, and they stay whole.
    expect(exact?.rows[3]?.[2]).toBe("13.5");
    // A column of formulas takes its decimals from what they come to; a figure smaller
    // than the column's decimals is shown in full.
    const made = await sheetGrids(
      await makeFile("p.xlsx", "spreadsheet", {
        sheets: [
          {
            name: "Per unit",
            rows: [
              ["Item", "Cost", "Units", "Per unit", "Tiny"],
              ["A", 42, 10000, "=B2/C2", 0.00004],
              ["B", 21, 2, "=B3/C3", 0.5],
            ],
          },
        ],
      }),
    );
    expect(made[0]?.rows[1]?.slice(3)).toEqual(["0.0042", "0.00004"]);
    expect(made[0]?.rows[2]?.slice(3)).toEqual(["10.5000", "0.5000"]);
    // One column, one form: amounts with separators, years without.
    expect([grid?.rows[1]?.[4], grid?.rows[2]?.[4]]).toEqual(["1,950", "2,500"]);
    expect([grid?.rows[1]?.[5], grid?.rows[2]?.[5]]).toEqual(["2025", "2026"]);
  });

  it("reads a workbook whose chart is broken or built to stall, and still shows the table", async () => {
    const good = await makeFile("ok.xlsx", "spreadsheet", {
      sheets: [
        {
          name: "S",
          chart: { type: "bar" },
          rows: [
            ["A", "B"],
            ["x", 1],
            ["y", 2],
          ],
        },
      ],
    });
    const parts = unzipSync(good);
    // Thousands of series that open and never close, in a part of several megabytes.
    const stall = zipSync({
      ...parts,
      "xl/charts/chart1.xml": strToU8(
        `<c:barChart>${"<c:ser>".repeat(20_000)}${"x".repeat(3_000_000)}`,
      ),
    });
    const began = Date.now();
    const stalled = await sheetGrids(stall);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(stalled[0]?.rows[1]).toEqual(["x", "1"]);
    expect(stalled[0]?.charts).toBeUndefined();
    // A character reference no text has, and a part named like something every object has.
    const odd = zipSync({
      ...parts,
      "xl/charts/chart1.xml": strToU8(
        strFromU8(parts["xl/charts/chart1.xml"] as Uint8Array).replace(
          "<c:v>x</c:v>",
          "<c:v>&#99999999;</c:v>",
        ),
      ),
      "xl/drawings/_rels/drawing1.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="/constructor"/></Relationships>',
      ),
    });
    expect((await sheetGrids(odd))[0]?.rows[2]).toEqual(["y", "2"]);
  });

  it("writes a designed presentation: a cover, numbers, a real chart, a table and notes", async () => {
    const bytes = await makeFile("deck.pptx", "slides", {
      cover: { title: "Launch plan", byline: "Mia · May", theme: "ember" },
      slides: [
        {
          title: "Launch",
          bullets: ["Pilot in **May**", { text: "Company-wide in July", sub: ["Sales first"] }],
          takeaway: "On track.",
          notes: "Mention the budget.",
        },
        {
          title: "Adoption grew",
          stats: [{ value: "42%", label: "Weekly active" }],
          chart: {
            type: "line",
            categories: ["Jan", "Feb"],
            series: [{ name: "People", values: [10, 20] }],
          },
        },
        {
          title: "Risks & <answers>",
          table: { headers: ["Risk", "Owner"], rows: [["Delay", "Mia"]] },
        },
      ],
    });
    const text = await read("deck.pptx", bytes);
    // A cover is put in front when the agent gave none, from the deck's own title.
    expect(text).toMatch(/--- Slide 1 ---\nLaunch plan\nMia · May/);
    for (const part of [
      "Pilot in May",
      "Company-wide in July",
      "Sales first",
      "On track.",
      "[Notes] Mention the budget.",
      "42%",
      "Weekly active",
      "Risks & <answers>",
      "Delay",
      "--- Slide 4 ---",
    ])
      expect(text).toContain(part);
    // The chart is a real one that PowerPoint can edit, with its numbers inside the file.
    const parts = unzipSync(bytes);
    const chart = Object.keys(parts).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    expect(chart && strFromU8(parts[chart] as Uint8Array)).toContain("<c:lineChart>");
    // The theme's colour is the one used.
    expect(strFromU8(parts["ppt/slides/slide1.xml"] as Uint8Array)).toContain("1F2328");
  });

  it("turns a slide with only a title into a section break, and a long table into several slides", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`Row ${i + 1}`, i]);
    const bytes = await makeFile("t.pptx", "slides", {
      slides: [
        { title: "The deck", subtitle: "For the board" },
        { title: "Part one" },
        { title: "Numbers", table: { headers: ["Name", "Value"], rows } },
      ],
    });
    const text = await read("t.pptx", bytes);
    // A cell's margins are a fraction of an inch. Until 2026-11-22 each was ten inches
    // (points given where the library read inches) and a table's text stood one letter
    // to a line in PowerPoint.
    const slide = strFromU8(unzipSync(bytes)["ppt/slides/slide3.xml"] as Uint8Array);
    const margins = [...slide.matchAll(/mar[LR]="(\d+)"/g)].map((found) => Number(found[1]));
    expect(margins.length).toBeGreaterThan(0);
    expect(Math.max(...margins)).toBeLessThan(914400 / 2);
    // A first slide that is only a title is the cover itself; no second cover is put before it.
    expect(text).toMatch(/--- Slide 1 ---\nThe deck\nFor the board/);
    expect(text).toContain("--- Slide 2 ---\nPart one");
    expect(text).not.toContain("--- Slide 6 ---");
    expect(text).toContain("Numbers (1/3)");
    expect(text).toContain("Numbers (3/3)");
    expect(text).toContain("Row 25");
  });

  it("writes plain formats as they are, and reads a page without its scripts", async () => {
    const page = await makeFile("p.html", "page", {
      text: "<h1>Hi</h1><script>steal()</script><p>there</p>",
    });
    expect(await read("p.html", page)).toBe("Hi\nthere");
    expect(await read("n.md", await makeFile("n.md", "text", { text: "# Notes" }))).toBe("# Notes");
  });

  it("marks formula-like cells in a CSV as text, and leaves plain numbers alone", async () => {
    const csv = new TextDecoder().decode(
      await makeFile("x.csv", "data", {
        text: 'Name,Value\n=HYPERLINK("http://x"),-5\n+SUM(A1),@cmd',
      }),
    );
    expect(csv).toBe("Name,Value\n'=HYPERLINK(\"http://x\"),-5\n'+SUM(A1),'@cmd");
  });

  it("says what is missing instead of making an empty file", async () => {
    await expect(makeFile("a.xlsx", "spreadsheet", { text: "x" })).rejects.toThrow(CannotMake);
    await expect(makeFile("a.pptx", "slides", { slides: [] })).rejects.toThrow(CannotMake);
    await expect(makeFile("a.docx", "document", { text: "  " })).rejects.toThrow(CannotMake);
    await expect(makeFile("a.pdf", "pdf", { text: "x" })).rejects.toThrow(/cannot be made/);
    await expect(makeFile("a.png", "image", { text: "x" })).rejects.toThrow(CannotMake);
  });
});

describe("files that should not be opened", () => {
  it("refuses an archive that unpacks to far more than it weighs", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(40 * 1024 * 1024) }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(() => checkArchive(bomb)).toThrow(Unreadable);
  });

  it("counts what really comes out, whatever the archive says about its own size", () => {
    const bomb = zipSync(
      { "xl/worksheets/sheet1.xml": new Uint8Array(40 * 1024 * 1024) },
      { level: 9 },
    );
    // Rewrite the sizes the archive declares, in its entry and in its table of contents, to 1000 bytes.
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    for (let at = 0; at + 4 <= bomb.byteLength; at++) {
      const mark = view.getUint32(at, true);
      if (mark === 0x04034b50) view.setUint32(at + 22, 1000, true);
      if (mark === 0x02014b50) view.setUint32(at + 24, 1000, true);
    }
    expect(() => checkArchive(bomb)).toThrow(Unreadable);
  });

  it("refuses an archive with too many entries, and one that is not an archive", () => {
    const many = zipSync(
      Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`f${i}`, strToU8("x")])),
    );
    expect(() => checkArchive(many)).toThrow(Unreadable);
    expect(() => checkArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(
      /damaged/,
    );
  });

  it("reports a damaged document as unreadable, not as a crash", async () => {
    const broken = zipSync({ "hello.txt": strToU8("not a document") });
    await expect(
      extractText({ name: "x.docx", kind: "document", mime: "" }, broken),
    ).rejects.toThrow(Unreadable);
    await expect(
      extractText({ name: "p.png", kind: "image", mime: "image/png" }, new Uint8Array(4)),
    ).rejects.toThrow(/no text/);
  });
});
