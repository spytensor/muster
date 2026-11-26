import { describe, expect, it } from "vitest";
import { tableSample } from "../runtime/tools.js";
import { makeFile } from "./make.js";
import { CannotChange, change, kept, outline } from "./revise.js";
import { BadQuery, csvRows, fromHeader, profile, query, tableOf } from "./table.js";

const slide = (title: string) => ({ title, bullets: ["a point", "another"] });

describe("changing a file's recipe (CHA-223)", () => {
  it("numbers a deck's pages once, when it is made, and never moves them after", () => {
    // Two slides and no title: no cover is made. Adding a third does not bring one in.
    const two = kept("d.pptx", { slides: [slide("One"), slide("Two")] });
    expect(two.slides).toHaveLength(2);
    const three = change("d.pptx", two, { slides: [slide("Three")] }).recipe;
    expect(kept("d.pptx", three).slides?.map((one) => one.title)).toEqual(["One", "Two", "Three"]);
    // With a cover: taking it out takes it out.
    const covered = kept("d.pptx", {
      cover: { title: "Deck" },
      slides: [slide("One"), slide("Two"), slide("Three")],
    });
    expect(covered.slides?.[0]).toMatchObject({ layout: "cover", title: "Deck" });
    const without = change("d.pptx", covered, { remove: 1 }).recipe;
    expect(kept("d.pptx", without).slides?.map((one) => one.title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("puts a new cover title on the cover slide, and takes one kind of change per call", () => {
    const deck = kept("d.pptx", {
      cover: { title: "Old" },
      slides: [slide("One"), slide("Two"), slide("Three")],
    });
    const next = change("d.pptx", deck, { cover: { title: "New", subtitle: "For the board" } });
    expect(next.recipe.slides?.[0]).toMatchObject({ title: "New", subtitle: "For the board" });
    expect(() => change("d.pptx", deck, { remove: 2, replace: 3, slides: [slide("x")] })).toThrow(
      /One kind of change per call/,
    );
  });

  it("makes a deck of sixty slides that was given no cover, as before", async () => {
    const sixty = Array.from({ length: 60 }, (_, n) => slide(`Slide ${n + 1}`));
    const recipe = kept("d.pptx", { cover: { title: "Long" }, slides: sixty });
    expect(recipe.slides).toHaveLength(61);
    expect((await makeFile("d.pptx", "slides", recipe)).byteLength).toBeGreaterThan(1000);
  });

  it("rewrites one section and leaves code, the title and the others alone", () => {
    const text = [
      "# Runbook",
      "",
      "Intro line.",
      "",
      "## Start",
      "",
      "```sh",
      "# not a heading",
      "run --now",
      "```",
      "",
      "## Stop",
      "",
      "Press the button.",
    ].join("\r\n");
    const started =
      change("r.md", { text }, { section: "start", text: "Run it by hand." }).recipe.text ?? "";
    expect(started).toContain("## Start\n\nRun it by hand.");
    expect(started).not.toContain("```");
    expect(started).toContain("## Stop\n\nPress the button.");
    // The title's own section is what stands under it, not the whole document.
    const titled =
      change("r.md", { text }, { section: "Runbook", text: "A new intro." }).recipe.text ?? "";
    expect(titled).toContain("# Runbook\n\nA new intro.");
    expect(titled).toContain("# not a heading");
    expect(titled).toContain("Press the button.");
    expect(outline("r.md", { text }, 1)).not.toContain("not a heading");
    expect(() => change("r.md", { text }, { section: "Nowhere", text: "x" })).toThrow(CannotChange);
  });
});

describe("a table worked out (CHA-223)", () => {
  it("finds the header under a title line, in what it reads and in what it outlines", () => {
    const rows = [["Q3 report"], [], ["Name", "Amount"], ["a", 3], ["b", "1,200"]];
    const table = tableOf("S", rows);
    expect(table.columns).toEqual(["Name", "Amount"]);
    expect(query([table], { measures: [{ column: "Amount", op: "sum" }] })).toContain("\n1203");
    expect(outline("b.xlsx", { sheets: [{ name: "S", rows: rows as never }] }, 1)).toContain(
      "2 rows; columns: Name, Amount",
    );
  });

  it("finds the header of a system's export: under a merged title and a line of notes", () => {
    const title = "Q3 orders (exported from CRM)";
    const rows = [
      // A merged title is read once for every cell it covers.
      [title, title, title, title],
      ["Exported: 2026-10-08", null, "By: Sales operations", null],
      [],
      ["Order", "Day", "Region", "Amount"],
      ["A1", "2026/7/3", "East", "¥8,800"],
      ["A2", "2026.08.15", "East", "1,200.50"],
      ["A3", "9月2日", "West", "-$300"],
      ["A4", new Date(Date.UTC(2026, 8, 30)), "West", 100],
    ];
    const table = tableOf("S", rows);
    expect(table.columns).toEqual(["Order", "Day", "Region", "Amount"]);
    expect(table.rows).toHaveLength(4);
    // Days written four ways are one kind of day; the one without a year is of the others' year.
    expect(table.rows.map((row) => row[1])).toEqual([
      "2026-07-03",
      "2026-08-15",
      "2026-09-02",
      "2026-09-30",
    ]);
    expect(profile([table])).toContain("- Day: date; from 2026-07-03 to 2026-09-30");
    expect(profile([table])).toContain("- Amount: number; sum 9800.5");
    const byMonth = query([table], {
      groupBy: ["month(Day)"],
      measures: [{ column: "Amount", op: "sum" }],
    });
    expect(byMonth).toContain("2026-07,8800");
    expect(byMonth).toContain("2026-09,-200");
    expect(byMonth).not.toContain("not a date");
  });

  it("tells a line of notes from a header by how it reads, not by how wide it is", () => {
    const title = "Customers";
    const columns = (rows: unknown[][]) => tableOf("S", rows).columns;
    // Three notes over four columns: as wide as a header, and still notes.
    expect(
      columns([
        [title, title, title, title],
        ["Exported: 2026-10-08", "By: Ops", "Unit: CNY"],
        ["Order", "Day", "Region", "Amount"],
        ["A1", "2026-07-03", "East", 5],
      ]),
    ).toEqual(["Order", "Day", "Region", "Amount"]);
    // A header whose names are days or years is a header: the notes above it are not.
    expect(
      columns([
        ["单位：千元", "来源：ERP"],
        ["Region", 2024, 2025, 2026],
        ["East", 1, 2, 3],
      ]),
    ).toEqual(["Region", "2024", "2025", "2026"]);
    expect(
      columns([
        [title, title, title, title],
        ["Exported: 2026-10-08", null, "By: Ops", null],
        ["Product", new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 7, 1)), "Total"],
        ["A", 1, 2, 3],
      ])[0],
    ).toBe("Product");
    // A header that names fewer columns than the rows hold, under a title, is still the header.
    const sparse = tableOf("S", [
      ["Customer list"],
      ["Name", null, null, "Notes"],
      ["Ann", "Beijing", "VIP", "call back"],
      ["Bob", "Shanghai", "New", "none"],
    ]);
    expect(sparse.columns).toEqual(["Name", "Column 2", "Column 3", "Notes"]);
    expect(sparse.rows).toHaveLength(2);
    const csv = tableOf("S", csvRows("Q3\nName,Total\na,1,2,3,4\nb,5,6,7,8\n"));
    expect(csv.columns.slice(0, 2)).toEqual(["Name", "Total"]);
    expect(csv.rows).toHaveLength(2);
  });

  it("leaves what an agent wrote above its own table where it is", () => {
    // A rate the formulas below point at is two cells: it is not a title, and it stays.
    const written = [
      ["Q3 plan"],
      ["FX rate", 7.1],
      [],
      ["Item", "USD", "CNY"],
      ["A", 100, "=B5*B2"],
    ];
    expect(fromHeader(written)[0]).toEqual(["FX rate", 7.1]);
    expect(fromHeader(written)).toHaveLength(4);
    // A title and a blank line alone are left out, as before.
    expect(fromHeader([["Q3 plan"], [], ["Item", "USD"], ["A", 100]])).toEqual([
      ["Item", "USD"],
      ["A", 100],
    ]);
  });

  it("reads amounts, shares and days as written, and leaves what it cannot be sure of", () => {
    const value = (cell: unknown) =>
      tableOf("S", [
        ["What", "Value"],
        ["it", cell],
      ]).rows[0]?.[1];
    expect(value("￥1,234.5")).toBe(1234.5);
    expect(value("¥-20")).toBe(-20);
    expect(value("-$300")).toBe(-300);
    expect(value("10%")).toBe(0.1);
    expect(value("12.5％")).toBe(0.125);
    expect(value("33.333333333333%")).toBe(0.33333333333333);
    expect(value("2026年7月3日")).toBe("2026-07-03");
    expect(value("2026/7/3")).toBe("2026-07-03");
    // Left as written: a code, a doubled sign, an amount whose point may mark thousands,
    // a day that does not exist, a day with the month or the day first, a version.
    for (const same of ["007", "$007", "-¥-20", "€1.234", "2026-02-30", "7/3/2026", "1.2.3"])
      expect(value(same)).toBe(same);
    // A day with dots, or without its year, alone in a column that is not of days.
    expect(value("2024.10.1")).toBe("2024.10.1");
    expect(value("8月3日")).toBe("8月3日");
  });

  it("settles a day written with dots or without its year by the column it is in", () => {
    const days = (cells: unknown[]) =>
      tableOf("S", [["Day"], ...cells.map((cell) => [cell])]).rows.map((row) => row[0]);
    // A column of days: dots are days, and a day without its year is of the year they share.
    expect(days(["2026-07-01", "2026.08.15", "9月2日", "2026/9/30"])).toEqual([
      "2026-07-01",
      "2026-08-15",
      "2026-09-02",
      "2026-09-30",
    ]);
    // Past the end of the year the others are in, the year is not known: left as written.
    expect(days(["2025-12-28", "2025-12-30", "1月2日"])).toEqual([
      "2025-12-28",
      "2025-12-30",
      "1月2日",
    ]);
    // Where the days that say their year disagree, a day without one is left as written.
    expect(days(["2025-12-30", "2026-01-02", "1月5日"])).toEqual([
      "2025-12-30",
      "2026-01-02",
      "1月5日",
    ]);
    // A column of versions is not a column of days because one of them could be a date.
    expect(days(["2024.10.1", "v2", "3.1.4", "release"])).toEqual([
      "2024.10.1",
      "v2",
      "3.1.4",
      "release",
    ]);
  });

  it("refuses a table too large to read whole, and says a total over nothing is nothing", () => {
    const many = [["n"], ...Array.from({ length: 300_001 }, (_, n) => [n])];
    expect(() => tableOf("S", many)).toThrow(BadQuery);
    expect(() => tableOf("S", many)).toThrow(/Nothing was read in part/);
    const table = tableOf("S", csvRows("Region,Amount\nUAE,5\nKSA,x\n"));
    const none = query([table], {
      where: [{ column: "Region", is: "=", value: "Oman" }],
      measures: [{ op: "count" }, { column: "Amount", op: "sum" }],
    });
    expect(none).toContain("0 of 2 rows");
    expect(none).toContain("\n0,");
    // More and less are not asked of a number against text.
    expect(query([table], { where: [{ column: "Amount", is: ">", value: 3 }] })).toContain(
      "1 of 2 rows",
    );
    expect(profile([{ ...table, dropped: 12 }])).toContain("12 more columns to the right");
  });

  it("shows an agent a sample of a large sheet and tells it where figures come from", () => {
    const sheet = `--- Sheet "Sales" (5000 rows) ---\n${Array.from({ length: 500 }, (_, n) => `${n + 1}: 2025-01-01,UAE,Online,${n}`).join("\n")}\n[4500 more rows not shown]`;
    const sample = tableSample(sheet);
    expect(sample.length).toBeLessThan(2500);
    expect(sample).toContain("25: 2025-01-01,UAE,Online,24");
    expect(sample).not.toContain("26: 2025");
    expect(sample).toContain("[475 more rows here: not shown]");
    expect(sample).toContain("data.query");
    // A small sheet is given whole.
    expect(tableSample('--- Sheet "S" (2 rows) ---\n1: a,b\n2: 1,2')).not.toContain("sample");
  });
});
