import { strFromU8, Unzip, UnzipInflate, unzipSync } from "fflate";
import { htmlToText } from "../runtime/net.js";
import type { FileKind } from "./kind.js";
import { readCharts, type SheetChartShown } from "./sheetchart.js";
import { csvRows, TABLE_CELLS, TABLE_ROWS, type Table, tableOf, tooLarge } from "./table.js";

/** The most text handed to an agent from one file. The agent is told when there was more. */
export const TEXT_LIMIT = 60_000;
const ZIP_ENTRIES = 2000;
const ZIP_BYTES = 100 * 1024 * 1024;
/** A workbook's parser needs many times the size of what it reads, so workbooks get a smaller allowance. */
const WORKBOOK_BYTES = 40 * 1024 * 1024;
const PDF_PAGES = 300;
const SHEETS = 20;
const ROWS = 500;
const COLUMNS = 60;

export class Unreadable extends Error {}

/**
 * Word, Excel and PowerPoint files are zip archives. Before any parser sees one, it is
 * unpacked here and the bytes that really come out are counted: what an archive says
 * about its own size is not believed. One that has too many entries or unpacks to more
 * than a document should is refused. That is what a zip bomb looks like.
 */
export function checkArchive(bytes: Uint8Array, limit = ZIP_BYTES): void {
  let entries = 0;
  let total = 0;
  const tooBig = () => new Unreadable("This file unpacks to far more than a document should.");
  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > ZIP_ENTRIES) throw tooBig();
    file.ondata = (error, chunk) => {
      if (error) throw error;
      total += chunk.length;
      // More than the allowance, or hundreds of times what the file weighs.
      if (total > limit || total > bytes.byteLength * 200 + 1_000_000) throw tooBig();
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    throw new Unreadable("This file is damaged and cannot be opened.");
  }
  if (entries === 0) throw new Unreadable("This file is damaged and cannot be opened.");
}

/** Text as its bytes say: UTF-8, UTF-16 when it is marked so, otherwise the encoding Chinese Windows saves in. */
export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}
const xmlText = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The text on each slide, in order. Read straight from the slides' own markup; nothing in it is interpreted. */
function slidesText(bytes: Uint8Array): string {
  const wanted = /^ppt\/(slides\/slide|notesSlides\/notesSlide)(\d+)\.xml$/;
  const files = unzipSync(bytes, { filter: (entry) => wanted.test(entry.name) });
  const numbered = (prefix: string) =>
    Object.keys(files)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]));
  const paragraphs = (xml: string) =>
    [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((p) =>
        [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1] ?? "")).join(""),
      )
      .filter((line) => line.trim())
      .join("\n");
  const notes = new Map(
    numbered("ppt/notesSlides/").map((name) => [
      name.match(/(\d+)\.xml$/)?.[1],
      // A notes page also carries the slide's number as a line of its own; that is not a note.
      paragraphs(strFromU8(files[name] as Uint8Array))
        .split("\n")
        .filter((line) => !/^\d+$/.test(line.trim()))
        .join("\n"),
    ]),
  );
  return numbered("ppt/slides/")
    .map((name, index) => {
      const number = name.match(/(\d+)\.xml$/)?.[1];
      const said = notes.get(number);
      return `--- Slide ${index + 1} ---\n${paragraphs(strFromU8(files[name] as Uint8Array))}${said ? `\n[Notes] ${said}` : ""}`;
    })
    .join("\n\n");
}

/**
 * The elements of one name in a piece of XML, found by walking it once: each with its
 * attributes and what is inside it. Never a pattern that looks ahead for a closing tag,
 * which on a crafted file of unclosed tags takes time by the square of its size. A tag
 * that never closes, or opens again before it closes, means the XML is not what it
 * should be, and the file is said to be unreadable.
 */
function* elements(xml: string, name: string): Generator<{ attrs: string; inner: string }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const after = xml[start + open.length];
    // "<c" is also how "<col" and "<cols" begin: only the tag itself.
    if (
      after !== ">" &&
      after !== "/" &&
      after !== " " &&
      after !== "\n" &&
      after !== "\t" &&
      after !== "\r"
    ) {
      at = start + open.length;
      continue;
    }
    const end = xml.indexOf(">", start);
    if (end < 0) throw new Error("unclosed tag");
    const attrs = xml.slice(start + open.length, end);
    if (attrs.endsWith("/")) {
      yield { attrs: attrs.slice(0, -1), inner: "" };
      at = end + 1;
      continue;
    }
    const stop = xml.indexOf(close, end + 1);
    if (stop < 0) throw new Error("unclosed element");
    yield { attrs, inner: xml.slice(end + 1, stop) };
    at = stop + close.length;
  }
}
const attr = (attrs: string, name: string) => {
  const at = attrs.indexOf(` ${name}="`);
  if (at < 0) return "";
  const from = at + name.length + 3;
  const to = attrs.indexOf('"', from);
  return to < 0 ? "" : attrs.slice(from, to);
};
/** Text as XML writes it, with its character references too. */
const xmlChars = (value: string) =>
  xmlText(
    value.replace(/&#(x[0-9a-fA-F]{1,6}|\d{1,7});/g, (whole, code: string) => {
      const point = code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }),
  );

/**
 * A workbook's cells read straight from its parts, for a workbook the library cannot load.
 * Files written by other programs than Excel are often like that: one with cell comments
 * kept where openpyxl keeps them stops the library before it has read a single cell. What
 * is lost is how a value is shown, and the agent is told so in the first line: a date
 * comes as its number, a percentage as a fraction. A workbook whose sheets cannot be
 * found, or whose XML breaks off, is not read in part: it is unreadable.
 */
function plainRows(
  bytes: Uint8Array,
  most: number,
): {
  sheets: { name: string; rows: { number: number; cells: string[] }[]; filled: number }[];
  more: number;
} {
  const files = unzipSync(bytes, {
    filter: (entry) =>
      /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|[^/]+\.xml|worksheets\/[^/]+\.xml)$/i.test(
        entry.name,
      ),
  });
  const part = (name: string) => (files[name] ? strFromU8(files[name] as Uint8Array) : "");
  /** The words of a string: its runs of text, without the reading aids some languages add. */
  const words = (xml: string) => {
    let out = "";
    let plain = "";
    let at = 0;
    for (;;) {
      // Phonetic text ("how this is read aloud") is not what the cell says.
      const skip = xml.indexOf("<rPh", at);
      if (skip < 0) {
        plain += xml.slice(at);
        break;
      }
      plain += xml.slice(at, skip);
      const end = xml.indexOf("</rPh>", skip);
      if (end < 0) break;
      at = end + 6;
    }
    for (const run of elements(plain, "t")) out += xmlChars(run.inner);
    return out;
  };
  const rels = [...elements(part("xl/_rels/workbook.xml.rels"), "Relationship")].map((rel) => ({
    id: attr(rel.attrs, "Id"),
    type: attr(rel.attrs, "Type"),
    target: attr(rel.attrs, "Target").replace(/^\/?(xl\/)?/, "xl/"),
  }));
  const stringsAt =
    rels.find((rel) => rel.type.endsWith("/sharedStrings"))?.target ?? "xl/sharedStrings.xml";
  const shared = [...elements(part(stringsAt), "si")].map((item) => words(item.inner));
  const sheets = [...elements(part("xl/workbook.xml"), "sheet")].map((sheet) => ({
    name: xmlChars(attr(sheet.attrs, "name")),
    path:
      rels.find((rel) => rel.id === (attr(sheet.attrs, "r:id") || attr(sheet.attrs, "id")))
        ?.target ?? "",
  }));
  if (sheets.length === 0) throw new Error("no sheets");
  const column = (ref: string) => {
    let n = 0;
    for (const letter of ref.toUpperCase()) {
      if (letter < "A" || letter > "Z") break;
      n = n * 26 + letter.charCodeAt(0) - 64;
      if (n > 20_000) break;
    }
    return n;
  };
  const read: { name: string; rows: { number: number; cells: string[] }[]; filled: number }[] = [];
  for (const sheet of sheets.slice(0, SHEETS)) {
    // A worksheet that is named and not there is a broken workbook, not an empty sheet.
    if (!files[sheet.path]) throw new Error("a sheet is missing");
    const rows: { number: number; cells: string[] }[] = [];
    let filled = 0;
    let number = 0;
    for (const row of elements(part(sheet.path), "row")) {
      number = Number(attr(row.attrs, "r")) || number + 1;
      const cells: string[] = [];
      let next = 1;
      for (const cell of elements(row.inner, "c")) {
        const index = column(attr(cell.attrs, "r")) || next;
        next = index + 1;
        // Beyond what is shown, or written out of order: left out, never put in another column.
        if (index > COLUMNS || index <= cells.length) continue;
        const type = attr(cell.attrs, "t");
        const [value] = [...elements(cell.inner, "v")].map((v) => xmlChars(v.inner));
        const text =
          type === "s"
            ? value === undefined || value === ""
              ? ""
              : (shared[Number(value)] ?? "")
            : type === "inlineStr"
              ? words(cell.inner)
              : type === "b"
                ? value === "1"
                  ? "TRUE"
                  : "FALSE"
                : (value ?? "");
        while (cells.length < index - 1) cells.push("");
        cells.push(text);
      }
      if (!cells.some(Boolean)) continue;
      filled += 1;
      if (rows.length < most) rows.push({ number, cells });
    }
    read.push({ name: sheet.name, rows, filled });
  }
  return { sheets: read, more: Math.max(0, sheets.length - SHEETS) };
}

function plainSheets(bytes: Uint8Array): string {
  const { sheets, more } = plainRows(bytes, ROWS);
  const out = sheets.map((sheet) => {
    const lines = sheet.rows.map(
      (row) =>
        `${row.number}: ${row.cells.map((text) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)).join(",")}`,
    );
    const rest =
      sheet.filled > lines.length ? `\n[${sheet.filled - lines.length} more rows not shown]` : "";
    return `--- Sheet "${sheet.name}" (${sheet.filled} rows) ---\n${lines.join("\n")}${rest}`;
  });
  if (more > 0) out.push(`[${more} more sheets not shown]`);
  return `[This workbook was read without its formatting: a date is shown as its serial number, a percentage as a fraction, and a formula as its last saved result.]\n\n${out.join("\n\n")}`;
}

/**
 * Every table of a workbook or a CSV file, for working things out over all its rows
 * (table.ts). The first row of each sheet is its header.
 */
export async function tables(file: { name: string }, bytes: Uint8Array): Promise<Table[]> {
  const ending = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ending === "csv" || ending === "tsv") {
    const text = decode(bytes);
    return [
      tableOf(
        file.name,
        ending === "tsv" ? text.split(/\r?\n/).map((line) => line.split("\t")) : csvRows(text),
      ),
    ];
  }
  if (ending !== "xlsx" && ending !== "xlsm")
    throw new Unreadable("Only a spreadsheet (.xlsx) or a .csv file holds a table to work on.");
  checkArchive(bytes, WORKBOOK_BYTES);
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  } catch {
    try {
      return plainRows(bytes, TABLE_ROWS + 1).sheets.map((sheet) =>
        tableOf(
          sheet.name,
          sheet.rows.map((row) => row.cells),
        ),
      );
    } catch {
      throw new Unreadable(
        "This file could not be read. It may be damaged or protected by a password.",
      );
    }
  }
  return book.worksheets.slice(0, SHEETS).map((sheet) => {
    // Refused whole, before its cells are gone through: a total over part of a table is wrong.
    const wide = Math.min(sheet.actualColumnCount, 200);
    if (sheet.actualRowCount > TABLE_ROWS + 60 || sheet.actualRowCount * wide > TABLE_CELLS)
      throw new Unreadable(tooLarge(sheet.actualRowCount, wide));
    const rows: unknown[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: unknown[] = [];
      for (let column = 1; column <= Math.min(row.cellCount, 200); column++) {
        const cell = row.getCell(column);
        const value = cell.value;
        // A formula is its result; rich text and links are their words; a date stays a date.
        cells.push(
          value instanceof Date || typeof value === "number" || typeof value === "boolean"
            ? value
            : value && typeof value === "object" && "result" in value
              ? ((value as { result?: unknown }).result ?? null)
              : (cell.text ?? ""),
        );
      }
      rows.push(cells);
    });
    return tableOf(sheet.name, rows);
  });
}

async function sheetsText(bytes: Uint8Array): Promise<string> {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  } catch {
    // The library gave up on the workbook as a whole. Its cells can still be read.
    return plainSheets(bytes);
  }
  const out: string[] = [];
  for (const sheet of book.worksheets.slice(0, SHEETS)) {
    const lines: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (lines.length >= ROWS) return;
      const cells: string[] = [];
      for (let column = 1; column <= Math.min(row.cellCount, COLUMNS); column++) {
        // What a person sees in the cell: a formula's result, a date as a date.
        const text = row.getCell(column).text ?? "";
        cells.push(/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      }
      lines.push(`${number}: ${cells.join(",")}`);
    });
    const more =
      sheet.actualRowCount > lines.length
        ? `\n[${sheet.actualRowCount - lines.length} more rows not shown]`
        : "";
    out.push(
      `--- Sheet "${sheet.name}" (${sheet.actualRowCount} rows) ---\n${lines.join("\n")}${more}`,
    );
  }
  if (book.worksheets.length > SHEETS)
    out.push(`[${book.worksheets.length - SHEETS} more sheets not shown]`);
  return out.join("\n\n");
}

/** The text of a file, for an agent to read. */
export async function extractText(
  file: { name: string; kind: FileKind; mime: string },
  bytes: Uint8Array,
  /** The most text to give back. An agent reading a file gets the default; a knowledge base asks for more. */
  limit = TEXT_LIMIT,
): Promise<{ text: string; truncated: boolean }> {
  const ending = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  let text: string;
  try {
    if (file.kind === "image") {
      throw new Unreadable("An image has no text to read.");
    } else if (file.mime === "application/pdf") {
      text = await pdfText(bytes, limit);
    } else if (ending === "docx") {
      checkArchive(bytes);
      const { default: mammoth } = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } else if (ending === "xlsx" || ending === "xlsm") {
      checkArchive(bytes, WORKBOOK_BYTES);
      text = await sheetsText(bytes);
    } else if (ending === "pptx") {
      checkArchive(bytes);
      text = slidesText(bytes);
    } else if (ending === "doc" || ending === "xls" || ending === "ppt") {
      throw new Unreadable(
        `This older Office format cannot be read here. Save it as .${ending}x and upload it again.`,
      );
    } else if (file.kind === "page") {
      text = htmlToText(decode(bytes));
    } else {
      text = decode(bytes);
    }
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    throw new Unreadable(
      "This file could not be read. It may be damaged or protected by a password.",
    );
  }
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

async function pdfText(bytes: Uint8Array, limit: number): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  let length = 0;
  // Page by page, stopping once there is more than will be used: a PDF can hold far more than it weighs.
  for (let number = 1; number <= Math.min(pdf.numPages, PDF_PAGES) && length <= limit; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
      .join("");
    pages.push(`--- Page ${number} ---\n${text}`);
    length += text.length;
    page.cleanup();
  }
  if (pdf.numPages > pages.length)
    pages.push(`[${pdf.numPages - pages.length} more pages not read]`);
  return pages.join("\n\n");
}

/**
 * What a cell shows in a spreadsheet: a number with the separators, decimals or percent
 * sign its format asks for, a date as a date, anything else as its text.
 */
function shown(cell: { value: unknown; text?: string; numFmt?: string }): string {
  const value =
    cell.value && typeof cell.value === "object" && "result" in cell.value
      ? (cell.value as { result: unknown }).result
      : cell.value;
  if (value instanceof Date) {
    const timed = value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0;
    return value
      .toISOString()
      .slice(0, timed ? 16 : 10)
      .replace("T", " ");
  }
  if (typeof value !== "number") return cell.text ?? "";
  const format = cell.numFmt ?? "";
  const decimals = format.match(/\.(0+)/)?.[1]?.length ?? 0;
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format.includes("%")) return `${(value * 100).toLocaleString("en-US", digits)}%`;
  if (format.includes(",") || decimals > 0)
    return value.toLocaleString("en-US", { useGrouping: format.includes(","), ...digits });
  return String(value);
}

export interface SheetGrid {
  name: string;
  /** What each cell shows, row by row. */
  rows: string[][];
  /** Rows and columns in the sheet, which may be more than are sent. */
  totalRows: number;
  totalColumns: number;
  /** Merged areas as [top, left, bottom, right], counted from 0. */
  merges: [number, number, number, number][];
  /** How cells are dressed where the workbook says so, by "row:column" counted from 0. */
  looks: Record<string, { fill?: string; color?: string; bold?: true }>;
  /** Each column's width in characters; 0 where the workbook sets none. */
  widths: number[];
  /** How many rows at the top and columns at the left stay in place when scrolling. */
  frozenRows: number;
  frozenColumns: number;
  /** The charts on the sheet, as what they showed when the workbook was saved. */
  charts?: SheetChartShown[];
}
const GRID_ROWS = 2000;
const GRID_COLUMNS = 100;

/** A workbook as grids of what its cells show: formulas as their results, dates and numbers as formatted. */
export async function sheetGrids(bytes: Uint8Array): Promise<SheetGrid[]> {
  try {
    checkArchive(bytes, WORKBOOK_BYTES);
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    // A chart that cannot be read does not take the table with it.
    let charts = new Map<number, SheetChartShown[]>();
    try {
      charts = readCharts(
        unzipSync(bytes, {
          filter: (entry) =>
            /^xl\/.*\.(xml|rels)$/.test(entry.name) && !/sharedStrings|styles/.test(entry.name),
        }),
      );
    } catch {}
    return book.worksheets.slice(0, SHEETS).map((sheet, place) => {
      const totalRows = sheet.rowCount;
      const totalColumns = sheet.columnCount;
      const rows: string[][] = [];
      // How cells are dressed, where the workbook says: "row:column" to fill, text colour and weight.
      const looks: Record<string, { fill?: string; color?: string; bold?: true }> = {};
      const hex = (color: unknown) => {
        const argb = (color as { argb?: unknown } | undefined)?.argb;
        return typeof argb === "string" && /^[0-9a-fA-F]{8}$/.test(argb)
          ? argb.slice(2)
          : undefined;
      };
      for (let r = 1; r <= Math.min(totalRows, GRID_ROWS); r++) {
        const row = sheet.getRow(r);
        const line: string[] = [];
        for (let c = 1; c <= Math.min(totalColumns, GRID_COLUMNS); c++) {
          const cell = row.getCell(c);
          line.push(shown(cell));
          const fill =
            cell.fill?.type === "pattern" && cell.fill.pattern === "solid"
              ? hex(cell.fill.fgColor)
              : undefined;
          const color = hex(cell.font?.color);
          if (fill || color || cell.font?.bold)
            looks[`${r - 1}:${c - 1}`] = {
              ...(fill ? { fill } : {}),
              ...(color ? { color } : {}),
              ...(cell.font?.bold ? { bold: true as const } : {}),
            };
        }
        rows.push(line);
      }
      const widths = Array.from({ length: Math.min(totalColumns, GRID_COLUMNS) }, (_, c) => {
        const set = sheet.getColumn(c + 1).width;
        return typeof set === "number" && set > 0 ? Math.min(80, Math.round(set)) : 0;
      });
      const merges = ((sheet.model as { merges?: string[] }).merges ?? []).flatMap((range) => {
        const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (!match) return [];
        const column = (letters: string) =>
          [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        return [
          [
            Number(match[2]) - 1,
            column(match[1] ?? "A"),
            Number(match[4]) - 1,
            column(match[3] ?? "A"),
          ] as [number, number, number, number],
        ];
      });
      const view = sheet.views?.[0] as
        | { state?: string; xSplit?: number; ySplit?: number }
        | undefined;
      const frozen = view?.state === "frozen";
      return {
        name: sheet.name,
        rows,
        totalRows,
        totalColumns,
        merges,
        looks,
        widths,
        frozenRows: frozen ? (view?.ySplit ?? 0) : 0,
        frozenColumns: frozen ? (view?.xSplit ?? 0) : 0,
        ...(charts.has(place) ? { charts: charts.get(place) as SheetChartShown[] } : {}),
      };
    });
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    throw new Unreadable(
      "This workbook could not be read. It may be damaged or protected by a password.",
    );
  }
}
