/**
 * A whole table, computed (CHA-223).
 *
 * An agent that reads a spreadsheet sees its first rows. To say what ten thousand rows
 * add up to it would have to guess. Here the server does the arithmetic over every row:
 * what a table's columns are and hold (`profile`), and sums, averages and counts by group
 * with filters (`query`). No code from the model runs: a query is a few named columns and
 * operations, and the server works it out.
 */

export type Cell = string | number | null;
export interface Table {
  sheet: string;
  columns: string[];
  rows: Cell[][];
  /** Columns the sheet has beyond the ones kept here. */
  dropped: number;
}

export const TABLE_ROWS = 300_000;
const TABLE_COLUMNS = 200;
/** What fits in the worker that reads files. A table beyond it is refused, never read in part. */
export const TABLE_CELLS = 4_000_000;

/**
 * A sheet's rows from its header on, for a sheet an agent writes. People and models put a
 * title line and a blank line above a table ("Q3 budget vs actual", then nothing, then the
 * columns). The header is the first row with two or more cells; lines above it that hold
 * one cell or none are left out. A line of two or more cells above the table (an
 * assumption, a rate a formula points at) is the agent's own and stays: when there is one,
 * nothing is left out.
 */
export function fromHeader<T extends unknown[]>(rows: T[]): T[] {
  const filled = (row: unknown) =>
    Array.isArray(row)
      ? row.filter((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")
          .length
      : 0;
  const start = rows.slice(0, 50).findIndex((row) => filled(row) >= 2);
  return start > 0 && rows.slice(0, start).every((row) => filled(row) <= 1)
    ? rows.slice(start)
    : rows;
}

/** A cell that is a note, not a column's name: "Exported: 2026-10-08", "单位：元". */
const NOTE_CELL = /^(?=[^:：]*[A-Za-z\u4e00-\u9fff])[^:：]{1,40}[:：]\s*\S/;

/**
 * Where the table begins in a sheet that is being read: a file a person brought, often a
 * system's export. Above the header such a file puts a title (merged across the table, so
 * read as the same words in every cell) and a line of notes ("Exported: …", "By: …",
 * "Unit: …"). The header is the first row with two or more different cells that is not a
 * line of notes; a line of notes is one where at least half the cells read "name: value".
 * Notes written without a colon cannot be told from a header and are taken for one.
 */
function fromTable<T extends unknown[]>(rows: T[]): T[] {
  const start = rows.slice(0, 50).findIndex((row) => {
    if (!Array.isArray(row)) return false;
    const cells = row.filter(
      (cell) => cell !== null && cell !== undefined && String(cell).trim() !== "",
    );
    // A merged cell is read once for each cell it covers: it is one thing said, not many.
    if (new Set(cells.map((cell) => String(cell).trim())).size < 2) return false;
    // Only words can be a note: a day or a figure in a header is a column's name.
    const notes = cells.filter((cell) => typeof cell === "string" && NOTE_CELL.test(cell.trim()));
    return notes.length * 2 < cells.length;
  });
  return start > 0 ? rows.slice(start) : rows;
}
/** Said when a table is larger than can be worked out here: a total over part of it would be wrong. */
export const tooLarge = (rows: number, columns: number) =>
  `This table is too large to work out here (${rows > TABLE_ROWS ? `more than ${TABLE_ROWS.toLocaleString("en-US")} rows` : `${rows.toLocaleString("en-US")} rows of ${columns} columns`}). Nothing was read in part: ask the person for a smaller extract, or for the figures.`;
const GROUPS = 5000;
const SHOWN = 200;

export class BadQuery extends Error {}

const two = (n: number) => String(n).padStart(2, "0");
/** A day that exists, as it is written everywhere else here: 2026-07-03. */
const dayOf = (year: number, month: number, day: number): string | null => {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${year}-${two(month)}-${two(day)}`;
};
/** "7月3日", "7月3号": a day whose year is not said. */
const DAY_WITHOUT_YEAR = /^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]$/;
/** "2026.07.03": a day, or a version ("2024.10.1"). Which, only its column can say. */
const DOTTED = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A number written as text is the number: "1,204.50", "42", an amount with its currency
 * ("¥8,800", "-$1,204.50"), a share ("10%" is 0.1, as a spreadsheet holds it). Not a code
 * with leading zeros ("007", "$007"), and not an amount whose point may be a thousands
 * mark ("€1.234"). A day written with its year first is the day: "2026/7/3", "2026-7-3",
 * "2026年7月3日" are 2026-07-03. A day with the month or the day first ("7/3/2026") is left
 * as written: which is which is not known. A day written with dots, or without its year,
 * is settled by its column (`daysSettled`).
 */
export const cellOf = (value: unknown): Cell => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // A formula that ended in an error: the error as Excel shows it.
  if (typeof value === "object" && !(value instanceof Date))
    return String((value as { error?: unknown }).error ?? "").slice(0, 40) || null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (text === "") return null;
  if (/^-?\d{1,15}(\.\d+)?$/.test(text) && !/^-?0\d/.test(text)) return Number(text);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replaceAll(",", ""));
  const money = /^(-?)\s*[¥￥$€£]\s*(-?)(\d{1,15}|\d{1,3}(?:,\d{3})+)(\.\d+)?$/.exec(text);
  if (
    money &&
    !(money[1] && money[2]) &&
    // A code, not an amount.
    !/^0\d/.test(money[3] ?? "") &&
    // "€1.234" is as likely one thousand two hundred as one and a bit: left as written.
    !(/^\.\d{3}$/.test(money[4] ?? "") && !(money[3] ?? "").includes(","))
  )
    return Number(
      `${money[1] || money[2] ? "-" : ""}${(money[3] ?? "").replaceAll(",", "")}${money[4] ?? ""}`,
    );
  const share = /^(-?\d{1,15}(?:\.\d+)?)\s*[%％]$/.exec(text);
  // Divided as a spreadsheet does it, without the stray digits of the division.
  if (share) return Number((Number(share[1]) / 100).toPrecision(15));
  const day =
    /^(\d{4})\s*([-/])\s*(\d{1,2})\s*\2\s*(\d{1,2})$/.exec(text) ??
    /^(\d{4})\s*(年)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/.exec(text);
  if (day) {
    const written = dayOf(Number(day[1]), Number(day[3]), Number(day[4]));
    if (written) return written;
  }
  return text.slice(0, 500);
};

/**
 * Days that only their column can settle. In a column that is mostly days:
 * - a day written with dots ("2026.07.03") is that day; elsewhere it may be a version;
 * - a day written without its year ("8月3日") takes the year the others share, when they
 *   share one and its month lies within the months they span. Outside them ("1月2日" among
 *   days of December) it may belong to the next year or the last, and is left as written.
 */
function daysSettled(rows: Cell[][], width: number): void {
  for (let index = 0; index < width; index++) {
    let filled = 0;
    const days: string[] = [];
    const dotted: [Cell[], string][] = [];
    const yearless: [Cell[], RegExpExecArray][] = [];
    for (const row of rows) {
      const cell = row[index] ?? null;
      if (cell === null) continue;
      filled += 1;
      if (typeof cell !== "string") continue;
      if (DAY.test(cell)) {
        days.push(cell);
        continue;
      }
      const dots = DOTTED.exec(cell);
      const day = dots ? dayOf(Number(dots[1]), Number(dots[2]), Number(dots[3])) : null;
      if (day) dotted.push([row, day]);
      const part = DAY_WITHOUT_YEAR.exec(cell);
      if (part) yearless.push([row, part]);
    }
    if (dotted.length + yearless.length === 0) continue;
    // Something must say this is a column of days: one written beyond doubt, or three that
    // could be. A single "2024.10.1" is as likely a version.
    if (days.length === 0 && dotted.length + yearless.length < 3) continue;
    // Mostly days: four in five of what the column holds is a day written one way or another.
    if ((days.length + dotted.length + yearless.length) * 5 < filled * 4) continue;
    for (const [row, day] of dotted) {
      row[index] = day;
      days.push(day);
    }
    const years = new Set(days.map((day) => day.slice(0, 4)));
    if (years.size !== 1) continue;
    const year = Number([...years][0]);
    const months = days.map((day) => Number(day.slice(5, 7)));
    const from = Math.min(...months);
    const to = Math.max(...months);
    for (const [row, part] of yearless) {
      const month = Number(part[1]);
      if (month < from || month > to) continue;
      row[index] = dayOf(year, month, Number(part[2])) ?? row[index] ?? null;
    }
  }
}

/** A table from rows whose first is the header. Columns without a name are named by their place. */
export function tableOf(sheet: string, given: unknown[][]): Table {
  const rows = fromTable(given);
  const width = (rows[0] ?? []).length;
  if (
    rows.length - 1 > TABLE_ROWS ||
    (rows.length - 1) * Math.min(width, TABLE_COLUMNS) > TABLE_CELLS
  )
    throw new BadQuery(tooLarge(rows.length - 1, Math.min(width, TABLE_COLUMNS)));
  const header = (rows[0] ?? []).slice(0, TABLE_COLUMNS);
  const used = new Set<string>();
  const columns = header.map((name, index) => {
    let label = String(name ?? "").trim() || `Column ${index + 1}`;
    while (used.has(label.toLowerCase())) label = `${label} (${index + 1})`;
    used.add(label.toLowerCase());
    return label;
  });
  const body: Cell[][] = [];
  for (const row of rows.slice(1)) {
    const cells = columns.map((_, index) => cellOf(row[index]));
    if (cells.some((cell) => cell !== null)) body.push(cells);
  }
  daysSettled(body, columns.length);
  return { sheet, columns, rows: body, dropped: Math.max(0, width - TABLE_COLUMNS) };
}

/** The rows of a CSV file: quoted cells, doubled quotes, line breaks inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (quoted) {
      if (char === '"') {
        if (body[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[at + 1] === "\n") at += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      // A little more than is allowed is enough to know it is too many.
      if (rows.length > TABLE_ROWS + 60) break;
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const find = (tables: Table[], sheet?: string): Table => {
  if (tables.length === 0) throw new BadQuery("This file holds no table.");
  if (!sheet) return tables[0] as Table;
  const wanted = sheet.trim().toLowerCase();
  const found = tables.find((table) => table.sheet.toLowerCase() === wanted);
  if (!found)
    throw new BadQuery(
      `There is no sheet "${sheet}". The sheets are: ${tables.map((table) => `"${table.sheet}"`).join(", ")}.`,
    );
  return found;
};
const shown = (value: Cell | undefined) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 10_000) / 10_000);
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};
const isDate = (value: Cell) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);

/** What a file's tables are: each sheet's size, and for each column what it holds. */
export function profile(tables: Table[], sheet?: string): string {
  const out: string[] = [];
  if (!sheet && tables.length > 1)
    out.push(
      `${tables.length} sheets: ${tables.map((table) => `"${table.sheet}" (${table.rows.length} rows)`).join(", ")}. Shown below: "${tables[0]?.sheet}". Name a sheet to see another.`,
    );
  const table = find(tables, sheet);
  out.push(
    `Sheet "${table.sheet}": ${table.rows.length} rows, ${table.columns.length} columns. Every row was read.${
      table.dropped > 0
        ? ` The sheet has ${table.dropped} more columns to the right that are not read here.`
        : ""
    }`,
  );
  for (const [index, name] of table.columns.entries()) {
    let numbers = 0;
    let dates = 0;
    let filled = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let first = "";
    let last = "";
    const counts = new Map<string, number>();
    for (const row of table.rows) {
      const value = row[index] ?? null;
      if (value === null) continue;
      filled += 1;
      if (typeof value === "number") {
        numbers += 1;
        sum += value;
        if (value < min) min = value;
        if (value > max) max = value;
      } else {
        if (isDate(value)) {
          dates += 1;
          const day = value.slice(0, 10);
          if (!first || day < first) first = day;
          if (!last || day > last) last = day;
        }
        if (counts.size < GROUPS || counts.has(value))
          counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const empty = table.rows.length - filled;
    const tail = empty > 0 ? `; ${empty} empty` : "";
    if (filled === 0) out.push(`- ${name}: empty`);
    else if (numbers === filled)
      out.push(
        `- ${name}: number; sum ${shown(sum)}, average ${shown(sum / numbers)}, least ${shown(min)}, most ${shown(max)}${tail}`,
      );
    else if (dates === filled) out.push(`- ${name}: date; from ${first} to ${last}${tail}`);
    else {
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
      out.push(
        `- ${name}: text; ${counts.size >= GROUPS ? `${GROUPS}+` : counts.size} different values${
          counts.size <= 40 || top.length > 0
            ? `; most common: ${top.map(([value, n]) => `${value.slice(0, 40)} (${n})`).join(", ")}`
            : ""
        }${numbers > 0 ? `; ${numbers} cells are numbers` : ""}${tail}`,
      );
    }
  }
  return out.join("\n");
}

export interface Query {
  sheet?: string;
  where?: { column: string; is: string; value: string | number }[];
  /** Column names, or month(Column), quarter(Column), year(Column) for a date column. */
  groupBy?: string[];
  measures?: { column?: string; op: string }[];
  orderBy?: { by: string; desc?: boolean };
  limit?: number;
}

const OPS = new Set(["sum", "avg", "min", "max", "count", "distinct"]);
const TESTS = new Set(["=", "!=", ">", ">=", "<", "<=", "contains"]);

/** Sums, averages and counts over every row of a table, by group, with filters. */
export function query(tables: Table[], wanted: Query): string {
  const table = find(tables, wanted.sheet);
  const at = (name: string) => {
    const index = table.columns.findIndex(
      (column) => column.toLowerCase() === String(name).trim().toLowerCase(),
    );
    if (index < 0)
      throw new BadQuery(
        `There is no column "${name}" in sheet "${table.sheet}". The columns are: ${table.columns.join(", ")}.`,
      );
    return index;
  };
  const filters = (wanted.where ?? []).slice(0, 12).map((filter) => {
    if (!TESTS.has(filter.is))
      throw new BadQuery('A filter\'s "is" is one of =, !=, >, >=, <, <=, contains.');
    const index = at(filter.column);
    const value = filter.value;
    const text = String(value).toLowerCase();
    return (row: Cell[]) => {
      const cell = row[index] ?? null;
      if (filter.is === "contains")
        return cell !== null && String(cell).toLowerCase().includes(text);
      const asked = cellOf(value);
      const both = typeof cell === "number" && typeof asked === "number";
      const left = both ? (cell as number) : String(cell ?? "").toLowerCase();
      const right = both ? (asked as number) : text;
      if (filter.is === "=") return left === right;
      if (filter.is === "!=") return left !== right;
      // More and less are between two numbers or two texts (a date is text that sorts), never one of each.
      if (cell === null || (typeof cell === "number") !== (typeof asked === "number")) return false;
      if (filter.is === ">") return left > right;
      if (filter.is === ">=") return left >= right;
      if (filter.is === "<") return left < right;
      return left <= right;
    };
  });
  const keys = (wanted.groupBy ?? []).slice(0, 4).map((spec) => {
    const part = /^(month|quarter|year)\((.+)\)$/i.exec(String(spec).trim());
    const index = at(part ? (part[2] ?? "") : spec);
    const grain = part?.[1]?.toLowerCase();
    return {
      label: String(spec).trim(),
      of: (row: Cell[]): string => {
        const cell = row[index] ?? null;
        if (cell === null) return "(empty)";
        if (!grain) return String(cell);
        if (!isDate(cell)) return "(not a date)";
        const day = String(cell);
        if (grain === "year") return day.slice(0, 4);
        if (grain === "month") return day.slice(0, 7);
        return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
      },
    };
  });
  const measures = (wanted.measures ?? []).slice(0, 8).map((measure) => {
    const op = String(measure.op).toLowerCase();
    if (!OPS.has(op))
      throw new BadQuery('A measure\'s "op" is one of sum, avg, min, max, count, distinct.');
    if (op !== "count" && !measure.column) throw new BadQuery(`"${op}" needs a column.`);
    return {
      op,
      index: measure.column ? at(measure.column) : -1,
      label: measure.column ? `${op}(${measure.column})` : "count",
    };
  });
  const matched = filters.length
    ? table.rows.filter((row) => filters.every((test) => test(row)))
    : table.rows;
  const limit = Math.min(
    SHOWN,
    Math.max(1, Number.isInteger(wanted.limit) ? (wanted.limit as number) : 50),
  );
  const lead = `${matched.length} of ${table.rows.length} rows of sheet "${table.sheet}" match.`;

  // With nothing to work out: the rows themselves, so a filter can be looked at.
  if (keys.length === 0 && measures.length === 0)
    return `${lead} The first ${Math.min(limit, matched.length)}:\n${table.columns.join(",")}\n${matched
      .slice(0, limit)
      .map((row) => row.map(shown).join(","))
      .join("\n")}`;

  type Sums = {
    n: number;
    sum: number;
    min: number;
    max: number;
    seen: Set<string> | null;
    filled: number;
  }[];
  const groups = new Map<string, { key: string[]; sums: Sums; rows: number }>();
  for (const row of matched) {
    const key = keys.map((one) => one.of(row));
    const id = key.join("\u0001");
    let group = groups.get(id);
    if (!group) {
      if (groups.size >= GROUPS)
        throw new BadQuery(
          `That makes more than ${GROUPS} groups. Group by fewer or coarser columns.`,
        );
      group = {
        key,
        rows: 0,
        sums: measures.map((measure) => ({
          n: 0,
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
          seen: measure.op === "distinct" ? new Set<string>() : null,
          filled: 0,
        })),
      };
      groups.set(id, group);
    }
    group.rows += 1;
    for (const [index, measure] of measures.entries()) {
      const tally = group.sums[index] as Sums[number];
      const cell = measure.index < 0 ? null : (row[measure.index] ?? null);
      if (cell !== null) tally.filled += 1;
      if (tally.seen && cell !== null && tally.seen.size < 100_000) tally.seen.add(String(cell));
      if (typeof cell === "number") {
        tally.n += 1;
        tally.sum += cell;
        if (cell < tally.min) tally.min = cell;
        if (cell > tally.max) tally.max = cell;
      }
    }
  }
  // A total over nothing is nothing, said as a line of its own and not as an empty answer.
  if (keys.length === 0 && matched.length === 0)
    groups.set("", {
      key: [],
      rows: 0,
      sums: measures.map((measure) => ({
        n: 0,
        sum: 0,
        min: 0,
        max: 0,
        seen: measure.op === "distinct" ? new Set<string>() : null,
        filled: 0,
      })),
    });
  const value = (group: { sums: Sums; rows: number }, index: number): number | null => {
    const measure = measures[index];
    const tally = group.sums[index];
    if (!measure || !tally) return null;
    if (measure.op === "count") return measure.index < 0 ? group.rows : tally.filled;
    if (measure.op === "distinct") return tally.seen?.size ?? 0;
    if (tally.n === 0) return null;
    if (measure.op === "sum") return tally.sum;
    if (measure.op === "avg") return tally.sum / tally.n;
    return measure.op === "min" ? tally.min : tally.max;
  };
  const labels = [...keys.map((key) => key.label), ...measures.map((measure) => measure.label)];
  let lines = [...groups.values()].map((group) => [
    ...group.key,
    ...measures.map((_, index) => value(group, index)),
  ]);
  const by = wanted.orderBy?.by
    ? labels.findIndex((label) => label.toLowerCase() === wanted.orderBy?.by.trim().toLowerCase())
    : -1;
  if (wanted.orderBy?.by && by < 0) throw new BadQuery(`Order by one of: ${labels.join(", ")}.`);
  const column = Math.max(0, by);
  const down = by < 0 ? false : Boolean(wanted.orderBy?.desc);
  lines = lines.sort((a, b) => {
    const left = a[column] ?? null;
    const right = b[column] ?? null;
    const order =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left ?? "").localeCompare(String(right ?? ""));
    return down ? -order : order;
  });
  const more = lines.length > limit ? `\n[${lines.length - limit} more groups not shown]` : "";
  return `${lead}${keys.length ? ` ${lines.length} groups.` : ""}\n${labels.join(",")}\n${lines
    .slice(0, limit)
    .map((line) => line.map((cell) => shown(cell as Cell)).join(","))
    .join("\n")}${more}`;
}
