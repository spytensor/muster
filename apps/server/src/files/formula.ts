/**
 * The formulas a workbook an agent makes may hold: sums, averages, differences and
 * ratios over cells of the same workbook. A total written this way recalculates when
 * the person changes a figure, which a typed number does not.
 *
 * Only this is a formula: numbers, cells and ranges (of this sheet or another sheet of
 * this workbook, by name), + - * / and brackets, and SUM, AVERAGE, MIN, MAX, COUNT,
 * ROUND and ABS. Anything else that begins with "=" (text, a link, a call to another
 * program or workbook) stays text, as before: opening the file cannot run it.
 *
 * What goes into the file is written again from what was understood, never the text as
 * given: nothing the reader passed over can reach Excel.
 */
type Ref = { sheet: string | null; column: number; row: number };
type Node =
  | { kind: "number"; value: number }
  | { kind: "cell"; at: Ref }
  | { kind: "range"; from: Ref; to: Ref }
  | { kind: "negate"; of: Node }
  | { kind: "op"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

/** How many arguments each takes: the least and the most. */
const FUNCTIONS: Record<string, [number, number]> = {
  SUM: [1, 30],
  AVERAGE: [1, 30],
  MIN: [1, 30],
  MAX: [1, 30],
  COUNT: [1, 30],
  ROUND: [2, 2],
  ABS: [1, 1],
};
/** The most cells one range may span, how deep a formula may nest, and Excel's own sheet. */
const RANGE_CELLS = 20_000;
const DEPTH = 40;
const LAST_COLUMN = 16_383;
const LAST_ROW = 1_048_575;
/** The most cells a workbook's formulas may read between them, and how long a chain of formulas may be. */
const WORK = 40_000_000;
const CHAIN = 2000;

const column = (letters: string) =>
  [...letters.toUpperCase()].reduce((sum, letter) => sum * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
const letters = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : letters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));

// A sheet's name in quotes holds none of the characters that would make it a path, a
// workbook, a span of sheets or a call to another program: [ ] : * ? / \ | !
const TOKEN =
  /[ \t]*(?:(\d+(?:\.\d+)?)|(?:(?:'((?:[^'[\]:*?/\\|!]|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![\p{L}\p{N}_(])|([A-Za-z]+)(?=[ \t]*\()|([-+*/(),:]))/uy;

type Token =
  | { type: "number"; value: number }
  | { type: "cell"; at: Ref }
  | { type: "name"; value: string }
  | { type: "sign"; value: string };

function tokens(text: string): Token[] | null {
  const out: Token[] = [];
  let at = 0;
  while (at < text.length) {
    if (/^[ \t]*$/.test(text.slice(at))) break;
    TOKEN.lastIndex = at;
    const found = TOKEN.exec(text);
    if (!found) return null;
    at = TOKEN.lastIndex;
    const [, number, quoted, bare, cellLetters, digits, name, sign] = found;
    if (number !== undefined) {
      // A figure Excel can hold as written: at most fifteen digits before the point.
      if (number.replace(/\..*$/, "").length > 15) return null;
      out.push({ type: "number", value: Number(number) });
    } else if (cellLetters !== undefined && digits !== undefined) {
      const ref = {
        sheet: quoted !== undefined ? quoted.replaceAll("''", "'") : (bare ?? null),
        column: column(cellLetters),
        row: Number(digits) - 1,
      };
      if (ref.row < 0 || ref.row > LAST_ROW || ref.column > LAST_COLUMN) return null;
      out.push({ type: "cell", at: ref });
    } else if (name !== undefined) out.push({ type: "name", value: name.toUpperCase() });
    else if (sign !== undefined) out.push({ type: "sign", value: sign });
    if (out.length > 400) return null;
  }
  return out;
}

/** The formula a cell's text is, or null when it is not one of the kind allowed. */
export function parseFormula(text: string): Node | null {
  if (!text.startsWith("=") || text.length > 600) return null;
  const list = tokens(text.slice(1));
  if (!list || list.length === 0) return null;
  let at = 0;
  const peek = () => list[at];
  const sign = (value: string) => {
    const next = peek();
    if (next?.type === "sign" && next.value === value) {
      at++;
      return true;
    }
    return false;
  };
  /** A range, where one may stand: only as a whole argument of a function. */
  const range = (): Node | null => {
    const [first, colon, second] = [list[at], list[at + 1], list[at + 2]];
    if (
      first?.type !== "cell" ||
      colon?.type !== "sign" ||
      colon.value !== ":" ||
      second?.type !== "cell"
    )
      return null;
    // A range is within one sheet: its second corner is not named again.
    if (second.at.sheet !== null && second.at.sheet !== first.at.sheet) return null;
    at += 3;
    return { kind: "range", from: first.at, to: { ...second.at, sheet: first.at.sheet } };
  };
  const primary = (depth: number): Node | null => {
    if (depth > DEPTH) return null;
    const next = peek();
    if (!next) return null;
    if (next.type === "number") {
      at++;
      return { kind: "number", value: next.value };
    }
    if (next.type === "cell") {
      at++;
      return { kind: "cell", at: next.at };
    }
    if (next.type === "name") {
      const takes = FUNCTIONS[next.value];
      if (!takes) return null;
      at++;
      if (!sign("(")) return null;
      const args: Node[] = [];
      for (;;) {
        const arg = range() ?? sum(depth + 1);
        if (!arg) return null;
        args.push(arg);
        if (sign(")")) break;
        if (!sign(",")) return null;
      }
      if (args.length < takes[0] || args.length > takes[1]) return null;
      // Rounding and the size of a number are of one number, not of a range.
      if ((next.value === "ROUND" || next.value === "ABS") && args.some((a) => a.kind === "range"))
        return null;
      return { kind: "call", name: next.value, args };
    }
    if (sign("(")) {
      const inner = sum(depth + 1);
      return inner && sign(")") ? inner : null;
    }
    if (sign("-")) {
      const of = primary(depth + 1);
      return of ? { kind: "negate", of } : null;
    }
    return null;
  };
  const product = (depth: number): Node | null => {
    let left = primary(depth);
    while (left) {
      const op = sign("*") ? "*" : sign("/") ? "/" : null;
      if (!op) break;
      const right = primary(depth);
      left = right ? { kind: "op", op, left, right } : null;
    }
    return left;
  };
  function sum(depth: number): Node | null {
    let left = product(depth);
    while (left) {
      const op = sign("+") ? "+" : sign("-") ? "-" : null;
      if (!op) break;
      const right = product(depth);
      left = right ? { kind: "op", op, left, right } : null;
    }
    return left;
  }
  const whole = sum(0);
  return whole && at === list.length ? whole : null;
}

/** What Excel shows when a formula cannot be worked out. */
export class FormulaError extends Error {
  constructor(readonly shown: "#DIV/0!" | "#VALUE!" | "#REF!") {
    super(shown);
  }
}
/** Said when a workbook's formulas would take too long to work out here. */
export class TooMuchToWorkOut extends Error {}

/** Rounds as Excel does: halves away from nothing, and 1.005 to two places is 1.01. */
const round = (value: number, places: number) => {
  const by = 10 ** Math.max(-10, Math.min(10, places));
  const rounded =
    (Math.sign(value) * Math.round(Number((Math.abs(value) * by).toPrecision(15)))) / by;
  return rounded === 0 ? 0 : rounded;
};
/** A figure without the trace of how a computer counts: 2183.8 - 2115 is 68.8. Large figures keep every digit. */
const clean = (value: number) => {
  const short = Number(value.toPrecision(12));
  return Math.abs(short - value) <= Math.abs(value) * 1e-13 ? short : Number(value.toPrecision(15));
};

/**
 * Works a formula out. `cell` gives what a cell shows: a number, text, nothing, or (for a
 * cell that is itself a formula) its own result, worked out by the caller.
 */
export function evaluate(node: Node, cell: (at: Ref) => number | string | null): number {
  const spread = (arg: Node): number[] => {
    // A cell given to SUM and its like is read as a range of one: text and nothing are passed over.
    const span =
      arg.kind === "range" ? arg : arg.kind === "cell" ? { from: arg.at, to: arg.at } : null;
    if (!span) return [evaluate(arg, cell)];
    const top = Math.min(span.from.row, span.to.row);
    const bottom = Math.max(span.from.row, span.to.row);
    const left = Math.min(span.from.column, span.to.column);
    const right = Math.max(span.from.column, span.to.column);
    if ((bottom - top + 1) * (right - left + 1) > RANGE_CELLS) throw new FormulaError("#REF!");
    const out: number[] = [];
    for (let row = top; row <= bottom; row++)
      for (let at = left; at <= right; at++) {
        const value = cell({ sheet: span.from.sheet, column: at, row });
        if (typeof value === "number") out.push(value);
      }
    return out;
  };
  switch (node.kind) {
    case "number":
      return node.value;
    case "cell": {
      const value = cell(node.at);
      if (value === null || value === "") return 0;
      if (typeof value === "number") return value;
      throw new FormulaError("#VALUE!");
    }
    case "range":
      throw new FormulaError("#VALUE!");
    case "negate":
      return -evaluate(node.of, cell);
    case "op": {
      const left = evaluate(node.left, cell);
      const right = evaluate(node.right, cell);
      if (node.op === "+") return left + right;
      if (node.op === "-") return left - right;
      if (node.op === "*") return left * right;
      if (right === 0) throw new FormulaError("#DIV/0!");
      return left / right;
    }
    case "call": {
      if (node.name === "ROUND")
        return round(
          evaluate(node.args[0] as Node, cell),
          Math.trunc(evaluate(node.args[1] as Node, cell)),
        );
      if (node.name === "ABS") return Math.abs(evaluate(node.args[0] as Node, cell));
      const values = node.args.flatMap(spread);
      if (node.name === "COUNT") return values.length;
      if (node.name === "SUM") return values.reduce((sum, value) => sum + value, 0);
      if (values.length === 0) {
        if (node.name === "AVERAGE") throw new FormulaError("#DIV/0!");
        return 0;
      }
      if (node.name === "AVERAGE")
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.reduce(
        (best, value) => (node.name === "MIN" ? Math.min(best, value) : Math.max(best, value)),
        values[0] as number,
      );
    }
  }
}

/** A sheet's name as a formula names it: always in quotes, which Excel takes for any name. */
const named = (sheet: string) => `'${sheet.replaceAll("'", "''")}'`;

/** The formula as it goes into the file: written from what was understood. */
function write(node: Node, place: (at: Ref, bare?: boolean) => string): string {
  switch (node.kind) {
    case "number":
      // Never in the form 1e-7, which is not how a figure is written in a cell.
      return /e/i.test(String(node.value))
        ? node.value.toFixed(20).replace(/\.?0+$/, "")
        : String(node.value);
    case "cell":
      return place(node.at);
    case "range":
      // The second corner is on the first one's sheet and is not named again.
      return `${place(node.from)}:${place(node.to, true)}`;
    case "negate":
      return node.of.kind === "op" ? `-(${write(node.of, place)})` : `-${write(node.of, place)}`;
    case "op": {
      const side = (inner: Node, right: boolean) => {
        const text = write(inner, place);
        const loose = inner.kind === "op" && (inner.op === "+" || inner.op === "-");
        const tight = node.op === "*" || node.op === "/";
        // Brackets where leaving them out would change what is worked out.
        return (tight && loose) ||
          (right && inner.kind === "op" && (node.op === "-" || node.op === "/")) ||
          (right && inner.kind === "negate")
          ? `(${text})`
          : text;
      };
      return `${side(node.left, false)}${node.op}${side(node.right, true)}`;
    }
    case "call":
      return `${node.name}(${node.args.map((arg) => write(arg, place)).join(",")})`;
  }
}

export interface FormulaSheet {
  /** The name the agent gave the sheet, which its formulas use. */
  name: string;
  /** The name the sheet has in the file. */
  final: string;
  /** How many rows above the header were left out: the agent counted them. */
  dropped: number;
  rows: unknown[][];
}
export interface WorkedSheet {
  /** The cells as they show: a formula as its result. */
  rows: unknown[][];
  formulas: { row: number; column: number; formula: string; result: number | string }[];
  /** Cells that begin with "=" and are not a formula that can be written: where, and what. */
  refused: { row: number; column: number; text: string }[];
}

/**
 * The formulas among a workbook's cells, worked out, and written for the file as it will
 * be: with each sheet's final name, and rows counted from the header the file begins at.
 */
export function resolveFormulas(sheets: FormulaSheet[]): WorkedSheet[] {
  // A sheet is found by the name the agent gave it or the name it ends up with; of two
  // alike, the first, as Excel would.
  const byName = new Map<string, number>();
  // The names the agent gave come first: a formula means the sheet it was written for.
  for (const pick of [(sheet: FormulaSheet) => sheet.name, (sheet: FormulaSheet) => sheet.final])
    sheets.forEach((sheet, index) => {
      const key = pick(sheet).trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, index);
    });
  const target = (from: number, at: Ref) =>
    at.sheet === null ? from : byName.get(at.sheet.trim().toLowerCase());
  /** Whether every cell a formula names is in a sheet of this workbook and on the sheet. */
  const sound = (node: Node, from: number): boolean => {
    const cellOk = (at: Ref) => {
      const sheet = target(from, at);
      return sheet !== undefined && at.row - (sheets[sheet]?.dropped ?? 0) >= 0;
    };
    switch (node.kind) {
      case "number":
        return true;
      case "cell":
        return cellOk(node.at);
      case "range":
        return cellOk(node.from) && cellOk({ ...node.to, sheet: node.from.sheet });
      case "negate":
        return sound(node.of, from);
      case "op":
        return sound(node.left, from) && sound(node.right, from);
      case "call":
        return node.args.every((arg) => sound(arg, from));
    }
  };
  const refused: WorkedSheet["refused"][] = sheets.map(() => []);
  const parsed = sheets.map((sheet, index) =>
    sheet.rows.map((row, r) =>
      row.map((value, c) => {
        if (typeof value !== "string" || !value.trim().startsWith("=")) return null;
        const node = parseFormula(value.trim());
        if (node && sound(node, index)) return node;
        refused[index]?.push({ row: r, column: c, text: value.trim().slice(0, 80) });
        return null;
      }),
    ),
  );
  const done = new Map<string, number | string>();
  const working = new Set<string>();
  let work = 0;
  const shown = (sheet: number, row: number, at: number): number | string | null => {
    if (++work > WORK) throw new TooMuchToWorkOut();
    const node = parsed[sheet]?.[row]?.[at];
    const raw = sheets[sheet]?.rows[row]?.[at];
    if (!node) return typeof raw === "number" || typeof raw === "string" ? raw : null;
    const key = `${sheet}:${row}:${at}`;
    const known = done.get(key);
    if (known !== undefined) return known;
    // A formula that comes back to itself, or a chain too long to follow, has no value.
    if (working.has(key) || working.size > CHAIN) return "#REF!";
    working.add(key);
    let result: number | string;
    try {
      result = evaluate(node, (ref) => {
        const where = target(sheet, ref) as number;
        const value = shown(where, ref.row - (sheets[where]?.dropped ?? 0), ref.column);
        if (typeof value === "string" && /^#(DIV\/0!|VALUE!|REF!)$/.test(value))
          throw new FormulaError(value as "#REF!");
        return value;
      });
      result = Number.isFinite(result) ? clean(result) : "#VALUE!";
    } catch (error) {
      if (error instanceof RangeError) result = "#REF!";
      else if (error instanceof FormulaError) result = error.shown;
      else throw error;
    }
    working.delete(key);
    done.set(key, result);
    return result;
  };
  return sheets.map((sheet, index) => {
    const formulas: WorkedSheet["formulas"] = [];
    const rows = sheet.rows.map((row, r) =>
      row.map((value, c) => {
        const node = parsed[index]?.[r]?.[c];
        if (!node) return value;
        const result = shown(index, r, c) as number | string;
        formulas.push({
          row: r,
          column: c,
          formula: write(node, (ref, bare) => {
            const where = target(index, ref) as number;
            const cell = `${letters(ref.column)}${ref.row - (sheets[where]?.dropped ?? 0) + 1}`;
            return bare || ref.sheet === null || where === index
              ? cell
              : `${named(sheets[where]?.final ?? "")}!${cell}`;
          }),
          result,
        });
        return result;
      }),
    );
    return { rows, formulas, refused: refused[index] ?? [] };
  });
}
