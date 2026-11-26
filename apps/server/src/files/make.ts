import { BadDeck, makeDeck, type SlideRecipe } from "./deck.js";
import { ACCENTS, type Cover, makeDocument } from "./document.js";
import { resolveFormulas, TooMuchToWorkOut, type WorkedSheet } from "./formula.js";
import type { FileKind } from "./kind.js";
import { addCharts, type SheetChartKind, type SheetChartPlan } from "./sheetchart.js";
import { fromHeader } from "./table.js";

/**
 * What an agent hands over to have a file made. Which part is used follows from the
 * file's name: text for .docx, .md, .txt, .html and .csv; sheets for .xlsx;
 * slides for .pptx.
 */
export interface FileRecipe {
  /** Markdown: # headings, paragraphs, - lists, 1. lists, | tables |, > callouts, **bold**, *italic*. */
  text?: string;
  sheets?: {
    name: string;
    rows: (string | number | boolean | null)[][];
    /** A chart of this sheet's table, placed beside it: the first column names the points, the number columns are drawn. */
    chart?: { type?: string; title?: string; columns?: string[] };
  }[];
  /** For a document or a presentation: its look, and what stands on its first page. */
  cover?: Cover;
  slides?: SlideRecipe[];
  /** The slides are the file's pages exactly, cover included: nothing is added when it is made. Set on a kept recipe. */
  pages?: boolean;
}

export class CannotMake extends Error {}

const SHEET_LIMIT = 20;
const ROW_LIMIT = 5000;
const CHART_POINTS = 60;
const CHART_SERIES = 6;
const SHARE =
  /率|占比|比例|比重|百分比|%|\b(rate|ratio|share|margin|growth|percent|pct|yoy|mom)\b/i;
const TOTAL = /^(total|sum|subtotal|grand total|合计|总计|小计|总和)/i;
/** A number written as text, as models often give them: stored as the number it is. Not a code with leading zeros. */
const asNumber = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  // Only what reads back exactly as it was written ("1.10" is a version, "007" a code),
  // and nothing long enough to be a phone number or an account.
  // A figure written with separators, as people write them: "27,192,048".
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replaceAll(",", ""));
  if (!/^-?\d{1,8}(\.\d+)?$/.test(text) || String(Number(text)) !== text) return value;
  return Number(text);
};

const columnLetters = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : columnLetters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));

/** Whether a cell holds a figure: a number, or text that reads as one ("41%", "¥1,200"). */
const figure = (value: unknown) =>
  typeof value === "number" ||
  (typeof value === "string" && /^[\s$¥€£+-]*\d[\d,.]*\s*[%kKmMbB万亿]?\s*$/.test(value));

async function excel(
  given: NonNullable<FileRecipe["sheets"]>,
  cover: Cover = {},
  left: string[] = [],
): Promise<Uint8Array> {
  if (given.length === 0 || given.length > SHEET_LIMIT)
    throw new CannotMake(`A workbook has 1 to ${SHEET_LIMIT} sheets.`);
  for (const sheet of given)
    if (!Array.isArray(sheet?.rows) || sheet.rows.length > ROW_LIMIT)
      throw new CannotMake(`A sheet has at most ${ROW_LIMIT} rows.`);
  const headed = given.map((sheet) => ({ ...sheet, rows: fromHeader(sheet.rows) }));
  // Excel's own rules for a sheet's name: 31 characters, none of []:*?/\, and no two alike.
  const taken = new Set<string>();
  const names = headed.map((sheet, index) => {
    let name =
      String(sheet.name ?? "")
        .replace(/[[\]:*?/\\]/g, " ")
        // Nor characters that are not text.
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .slice(0, 31)
        // Nor may it begin or end with a quotation mark.
        .replace(/^'+|'+$/g, "")
        .trim() || `Sheet${index + 1}`;
    while (taken.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${taken.size + 1}`;
    taken.add(name.toLowerCase());
    return name;
  });
  // Totals, differences and ratios written as formulas are worked out here, so the file
  // shows their figures at once and the charts and formats below see numbers; the
  // formulas themselves are put in the cells last, and recalculate in Excel.
  let worked: WorkedSheet[];
  try {
    worked = resolveFormulas(
      headed.map((sheet, index) => ({
        name: String(sheet.name ?? ""),
        final: names[index] as string,
        // Rows above the header that were left out: the agent counted them in its cells.
        dropped: (given[index]?.rows.length ?? 0) - sheet.rows.length,
        rows: sheet.rows.map((row) => (Array.isArray(row) ? row.map(asNumber) : [])),
      })),
    );
  } catch (error) {
    if (error instanceof TooMuchToWorkOut)
      throw new CannotMake(
        "This workbook's formulas read too many cells to be worked out here. Write the figures over long ranges with data.query and give them as numbers; keep formulas for totals and ratios.",
      );
    throw error;
  }
  // Cells are named to the agent as it counted them: with the title rows it gave above the header.
  const above = (index: number) =>
    (given[index]?.rows.length ?? 0) - (headed[index]?.rows.length ?? 0);
  // What looked like a formula and is not one that can be written is said, so that the
  // agent can put it right: the person would see the text of it in the cell.
  const refused = worked.flatMap((sheet, index) =>
    sheet.refused.map(
      (cell) =>
        `${names[index]} ${columnLetters(cell.column)}${cell.row + above(index) + 1}: ${cell.text}`,
    ),
  );
  if (refused.length)
    left.push(
      `These cells begin with "=" but are not formulas that can be written here, and were kept as text for the person to see: ${refused.slice(0, 6).join("; ")}${refused.length > 6 ? `; and ${refused.length - 6} more` : ""}. A formula is + - * /, brackets and SUM, AVERAGE, MIN, MAX, COUNT, ROUND(number, places), ABS over cells of this workbook; a sheet is named as you named it. Put a number or a formula of that kind there with files.change.`,
    );
  const broken = worked.flatMap((sheet, index) =>
    sheet.formulas
      .filter((cell) => typeof cell.result === "string")
      .map(
        (cell) =>
          `${names[index]} ${columnLetters(cell.column)}${cell.row + above(index) + 1} ${cell.result}`,
      ),
  );
  if (broken.length)
    left.push(
      `These formulas could not be worked out and show an error in the file: ${broken.slice(0, 6).join("; ")}${broken.length > 6 ? `; and ${broken.length - 6} more` : ""}. A ratio over nothing (#DIV/0!) is better left empty; a cell of text in arithmetic is #VALUE!.`,
    );
  const sheets = headed.map((sheet, index) => ({
    ...sheet,
    rows: worked[index]?.rows ?? sheet.rows,
  }));
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  const look =
    ACCENTS[String(cover.theme ?? "").toLowerCase()] ?? (ACCENTS.ink as (typeof ACCENTS)[string]);
  const face = /[\u2E80-\u9FFF]/.test(JSON.stringify(sheets)) ? "Microsoft YaHei" : "Arial";
  const plans: SheetChartPlan[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const name = names[index] as string;
    const page = book.addWorksheet(name);
    for (const row of sheet.rows) {
      // A cell given as text is stored as text: Excel shows it as written and never runs it as a formula.
      page.addRow(Array.isArray(row) ? row.map(asNumber) : []);
    }
    // A column of shares (a rate, a ratio, a percentage given as 0.203) is shown as percentages.
    const shares = new Set<number>();
    const head = Array.isArray(sheet.rows[0]) ? sheet.rows[0] : [];
    head.forEach((label, column) => {
      const values = sheet.rows
        .slice(1)
        .map((row) => (Array.isArray(row) ? asNumber(row[column]) : null))
        // A formula that shows an error is not a figure of another kind: the column is still what it is.
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            !(typeof value === "string" && /^#(DIV\/0!|VALUE!|REF!)$/.test(value)),
        );
      if (
        column > 0 &&
        values.length > 0 &&
        SHARE.test(String(label ?? "")) &&
        // Fractions only: 3.5 under "Rate (%)" is already a percentage, and 1.08 under
        // "Exchange rate" is not a share at all.
        values.every((value) => typeof value === "number" && Math.abs(value) <= 1)
      )
        shares.add(column);
    });
    if (sheet.chart) {
      const kind = String(sheet.chart.type ?? "bar").toLowerCase();
      if (kind !== "bar" && kind !== "line" && kind !== "pie")
        throw new CannotMake('A sheet\'s chart is "bar", "line" or "pie".');
      // The table from its header down to the last row before a total or a gap.
      const rows = sheet.rows.map((row) => (Array.isArray(row) ? row.map(asNumber) : []));
      let last = 0;
      while (
        last + 1 < rows.length &&
        last < CHART_POINTS &&
        String(rows[last + 1]?.[0] ?? "").trim() !== "" &&
        !TOTAL.test(String(rows[last + 1]?.[0]).trim())
      )
        last += 1;
      const header = rows[0] ?? [];
      // The columns the agent named, or every number column that is not a share: a share
      // beside amounts is another unit and would lie flat along the axis.
      const wanted = new Set(
        (Array.isArray(sheet.chart.columns) ? sheet.chart.columns : []).map((one) =>
          String(one).trim().toLowerCase(),
        ),
      );
      const points = rows.slice(1, last + 1);
      const numeric = header
        .map((_, column) => column)
        .filter(
          (column) =>
            column > 0 &&
            points.some((row) => typeof row[column] === "number") &&
            points.every(
              (row) => typeof row[column] === "number" || row[column] == null || row[column] === "",
            ),
        );
      const named = numeric.filter((column) =>
        wanted.has(
          String(header[column] ?? "")
            .trim()
            .toLowerCase(),
        ),
      );
      const amounts = numeric.filter((column) => !shares.has(column));
      const columns = (named.length ? named : amounts.length ? amounts : numeric).slice(
        0,
        kind === "pie" ? 1 : CHART_SERIES,
      );
      // A chart that cannot be drawn is left out and said: the sheets around it are good
      // work, and a workbook is not thrown away for one picture.
      if (last < 1 || columns.length === 0)
        left.push(
          `The chart on sheet "${name}" was left out: there were no numbers to draw. For a chart, a sheet's first column names the points and at least one other column holds numbers, given as numbers. Put it on a sheet shaped like that with files.change.`,
        );
      else
        plans.push({
          sheet: index,
          sheetName: name,
          kind: kind as SheetChartKind,
          title: String(sheet.chart.title ?? "")
            .trim()
            .slice(0, 120),
          categories: rows.slice(1, last + 1).map((row) => String(row[0] ?? "")),
          series: columns.map((column) => ({
            name: String(header[column] ?? ""),
            column,
            values: rows
              .slice(1, last + 1)
              .map((row) => (typeof row[column] === "number" ? (row[column] as number) : null)),
          })),
          firstRow: 2,
          lastRow: last + 1,
          at: Math.max(1, ...sheet.rows.map((row) => (Array.isArray(row) ? row.length : 0))) + 1,
          // The theme's own two, then others, none said twice.
          colors: [
            ...new Set([
              look.accent,
              look.dark,
              "17A673",
              "FF7F41",
              "8B5CF6",
              "E5484D",
              "0EA5B7",
              "C59A1A",
            ]),
          ],
          percent: columns.every((column) => shares.has(column)),
        });
    }
    const columns = Math.max(1, ...sheet.rows.map((row) => (Array.isArray(row) ? row.length : 0)));
    const thin = { style: "thin" as const, color: { argb: "FFD9D9D9" } };
    // A column of figures is set to the right from its header down, so the header stands
    // over what it names.
    const figures = Array.from({ length: columns }, (_, column) => {
      const below = sheet.rows
        .slice(1)
        .map((row) => (Array.isArray(row) ? row[column] : null))
        .filter((value) => value !== null && value !== undefined && value !== "");
      return below.length > 0 && below.every((value) => figure(asNumber(value)));
    });
    // A table that scrolls keeps its header in view and can be filtered; a short one is
    // left as it is, with no arrows in its header.
    const long = sheet.rows.length > 16;
    page.eachRow((row, number) => {
      const lead = String(row.getCell(1).value ?? "").trim();
      // A row that adds the others up stands out, as it would in a report.
      const total = number > 1 && TOTAL.test(lead);
      row.height = number === 1 ? 22 : 18;
      for (let column = 1; column <= columns; column++) {
        const cell = row.getCell(column);
        cell.font = {
          name: face,
          size: 10,
          bold: number === 1 || total,
          color: { argb: number === 1 ? "FFFFFFFF" : "FF14181F" },
        };
        const toRight =
          number === 1 ? figures[column - 1] === true && column > 1 : figure(cell.value);
        cell.alignment = {
          vertical: "middle",
          horizontal: toRight ? "right" : "left",
          indent: toRight ? 0 : 1,
        };
        cell.border = {
          bottom: thin,
          ...(total ? { top: { style: "thin", color: { argb: `FF${look.dark}` } } } : {}),
        };
        // The header is the one filled row: no stripes, which fight with what a person
        // marks in a sheet themself.
        if (number === 1)
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${look.dark}` } };
      }
    });
    page.views = long
      ? [{ state: "frozen", ySplit: 1, showGridLines: false }]
      : [{ state: "normal", showGridLines: false }];
    if (long) page.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
    page.properties.tabColor = { argb: `FF${look.dark}` };
    page.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    // Large numbers read better with separators, as a person would format them.
    // Decided for a column as a whole, so one column never shows 1950 beside 2,500.
    const years = new Set<number>();
    head.forEach((_, column) => {
      const values = sheet.rows
        .slice(1)
        .map((row) => (Array.isArray(row) ? asNumber(row[column]) : null))
        .filter((value) => typeof value === "number");
      if (
        values.length > 0 &&
        values.every((value) => Number.isInteger(value) && value >= 1900 && value <= 2100)
      )
        years.add(column);
    });
    // One format down a column: as many decimals as its most exact figure has, two at
    // the least (1,200.50, not 1,200.5) and four at the most, so 1.0834 is not shown as 1.08 nor 0.0042 as 0.00. A formula's result does
    // not decide (an average of whole numbers is no reason to write them as 12.00): it
    // shows the column's decimals, or two of its own where the column has none.
    const formulaAt = new Set(
      (worked[index]?.formulas ?? []).map((cell) => `${cell.row}:${cell.column}`),
    );
    const places = (value: number) =>
      Math.min(4, (String(Math.round(value * 1e6) / 1e6).split(".")[1] ?? "").length);
    const decimals = new Map<number, number>();
    const worksOut = new Map<number, number>();
    sheet.rows.slice(1).forEach((row, at) => {
      if (!Array.isArray(row)) return;
      row.forEach((given, column) => {
        const value = asNumber(given);
        if (typeof value !== "number" || formulaAt.has(`${at + 1}:${column}`)) return;
        const own = places(value);
        decimals.set(column, Math.max(decimals.get(column) ?? 0, own && Math.max(2, own)));
      });
    });
    // A column of nothing but formulas (a ratio, a cost per unit) takes its decimals
    // from what they come to: 42/10000 is 0.0042, not 0.00.
    for (const cell of worked[index]?.formulas ?? []) {
      if (typeof cell.result !== "number" || decimals.has(cell.column)) continue;
      const own = places(cell.result);
      worksOut.set(cell.column, Math.max(worksOut.get(cell.column) ?? 0, own && Math.max(2, own)));
    }
    page.eachRow((row) => {
      row.eachCell((cell) => {
        // A column of years is not a column of quantities: 2026 stays 2026.
        const year = years.has(Number(cell.col) - 1);
        if (
          typeof cell.value === "number" &&
          Number(cell.row) > 1 &&
          shares.has(Number(cell.col) - 1)
        )
          cell.numFmt = "0.0%";
        else if (typeof cell.value === "number" && Number(cell.row) > 1 && !year) {
          const column = Number(cell.col) - 1;
          const shown = decimals.get(column) || worksOut.get(column) || 0;
          // A figure too small for the column's decimals is left as it is, in full,
          // not shown as 0.0000.
          const lost = cell.value !== 0 && Math.abs(cell.value) < 0.5 / 10 ** shown;
          if (shown && !lost) cell.numFmt = `#,##0.${"0".repeat(shown)}`;
          else if (Math.abs(cell.value) >= 1000) cell.numFmt = "#,##0";
        }
      });
    });
    page.columns.forEach((column) => {
      let widest = 10;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        // A Chinese character is as wide as two letters.
        const text = String(cell.value ?? "");
        const wide = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
        // The header also holds the filter's arrow.
        widest = Math.max(widest, Math.min(60, wide + (Number(cell.row) === 1 && long ? 7 : 4)));
      });
      column.width = widest;
    });
    // A text longer than its column, which is held to 60, is wrapped and its row made
    // as tall as its lines: left on one line it would run under the cell beside it or
    // be cut off.
    page.eachRow((row) => {
      let lines = 1;
      row.eachCell((cell) => {
        if (typeof cell.value !== "string") return;
        // Letters are counted a little wide (a W is more than an i), and each line the
        // text gives is wrapped by itself.
        const room = Math.max(4, ((page.getColumn(Number(cell.col)).width ?? 10) - 3) * 0.85);
        const needs = cell.value.split("\n").reduce((sum, line) => {
          const wide = [...line].reduce((all, ch) => all + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
          return sum + Math.max(1, Math.ceil(wide / room));
        }, 0);
        if (needs > 1) {
          cell.alignment = { ...cell.alignment, wrapText: true };
          lines = Math.max(lines, needs);
        }
      });
      if (lines > 1) {
        row.height = Math.max(row.height ?? 18, Math.min(400, lines * 15 + 6));
        // The whole row reads from the top, so a short cell stands beside the first
        // line of a long one.
        row.eachCell((cell) => {
          cell.alignment = { ...cell.alignment, vertical: "top" };
        });
      }
    });
    // Last, so that a formula's cell is dressed and sized as the figure it shows.
    for (const cell of worked[index]?.formulas ?? [])
      page.getCell(cell.row + 1, cell.column + 1).value =
        typeof cell.result === "number"
          ? { formula: cell.formula, result: cell.result }
          : { formula: cell.formula, result: { error: cell.result } as never };
  }
  return addCharts(new Uint8Array(await book.xlsx.writeBuffer()), plans);
}

/** Makes the bytes of a file an agent asked for. */
export async function makeFile(
  name: string,
  kind: FileKind,
  recipe: FileRecipe,
  /** What could not be made as asked and was left out, for the agent to be told. */
  left: string[] = [],
): Promise<Uint8Array> {
  const ending = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const needText = () => {
    if (typeof recipe.text !== "string" || !recipe.text.trim())
      throw new CannotMake(`A .${ending} file is made from "text".`);
    return recipe.text;
  };
  if (ending === "xlsx") {
    if (!recipe.sheets) throw new CannotMake('A .xlsx file is made from "sheets".');
    return excel(recipe.sheets, recipe.cover, left);
  }
  if (ending === "pptx") {
    if (!recipe.slides) throw new CannotMake('A .pptx file is made from "slides".');
    try {
      return await makeDeck(recipe.cover, recipe.slides, recipe.pages === true);
    } catch (error) {
      throw error instanceof BadDeck ? new CannotMake(error.message) : error;
    }
  }
  if (ending === "docx") return makeDocument(needText(), recipe.cover);
  if (ending === "csv") {
    // A spreadsheet program runs a cell that starts like a formula. In a file an agent wrote,
    // such a cell is marked as text, so opening the file cannot run anything.
    const safe = needText().replace(/(^|,)(\s*)([=+@-])(?=[^,\n]*[A-Za-z(])/gm, "$1$2'$3");
    return new TextEncoder().encode(safe);
  }
  if (kind === "page" || kind === "text" || kind === "data")
    return new TextEncoder().encode(needText());
  throw new CannotMake(
    `A .${ending} file cannot be made. Use docx, xlsx, pptx, html, md, txt or csv.`,
  );
}
