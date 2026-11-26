import { deckPages, type SlideRecipe } from "./deck.js";
import type { FileRecipe } from "./make.js";
import { fromHeader } from "./table.js";

/**
 * A file's source, and one change to it (CHA-223).
 *
 * A file an agent makes is kept with the recipe it was made from: its slides, its sheets
 * or its text. That is what lets a long file be built a few slides at a time, and one
 * slide, sheet or section be changed without the model writing the whole file again: the
 * change is made to the recipe here, the file is made again from it by the same code as
 * before, and the result is the file's next version. Nothing here calls a model.
 */

type Row = (string | number | boolean | null)[];

/** One change to a file. Which fields count follows from the file's kind. */
export interface FileChange {
  /** pptx: slides to put in. With `replace` they take that slide's place; with `at` they go before that slide; otherwise at the end. */
  slides?: SlideRecipe[];
  at?: number;
  replace?: number;
  /** pptx: the slide to take out. */
  remove?: number;
  /** xlsx: a sheet to add, to replace (`rows`), to add rows to (`append`) or to take out (`remove`). */
  sheet?: {
    name: string;
    rows?: Row[];
    append?: Row[];
    chart?: NonNullable<FileRecipe["sheets"]>[number]["chart"];
    remove?: boolean;
  };
  /** docx, md, txt, html, csv: the new text of one section (named by its heading), or text to add at the end. */
  section?: string;
  text?: string;
  append?: boolean;
  /** The look and what stands on the first page. */
  cover?: FileRecipe["cover"];
}

export class CannotChange extends Error {}

const ending = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
const SLIDES_A_STEP = 12;
const ROWS_A_STEP = 2000;

/**
 * The recipe as it is kept when a file is first made: a deck's pages numbered as they are
 * in the file, with the cover that is made when the agent gave none. From then on the
 * pages are exactly what is kept: a change adds no cover and moves no number.
 */
export function kept(name: string, recipe: FileRecipe): FileRecipe {
  if (ending(name) !== "pptx" || !Array.isArray(recipe.slides) || recipe.pages) return recipe;
  return { ...recipe, slides: deckPages(recipe.cover, recipe.slides), pages: true };
}
/** A recipe is kept whole with every version. One beyond this is not kept changing in place. */
export const RECIPE_BYTES = 4 * 1024 * 1024;

const heading = (line: string) => /^(#{1,6})\s+(.*)$/.exec(line.trim());
/** The headings of a text with the line each is on. A "# comment" inside a fenced block of code is not one. */
const headings = (lines: string[]) => {
  const found: { at: number; level: number; title: string }[] = [];
  let fenced = false;
  for (const [at, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const is = heading(line);
      if (is) found.push({ at, level: (is[1] ?? "#").length, title: is[2] ?? "" });
    }
  }
  return found;
};
const same = (a: string, b: string) =>
  a
    .replace(/[#*_`\s]+/g, " ")
    .trim()
    .toLowerCase() ===
  b
    .replace(/[#*_`\s]+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Makes one change to a recipe. Answers the new recipe and what changed, in words that go
 * on the version and in front of the person: "Slide 3 replaced".
 */
export function change(
  name: string,
  recipe: FileRecipe,
  wanted: FileChange,
): { recipe: FileRecipe; note: string } {
  const kind = ending(name);
  const notes: string[] = [];
  const next: FileRecipe = { ...recipe };
  if (wanted.cover && typeof wanted.cover === "object") {
    next.cover = { ...recipe.cover, ...wanted.cover };
    notes.push("Cover changed");
  }
  const asked = [
    wanted.remove !== undefined,
    wanted.replace !== undefined,
    wanted.replace === undefined && Array.isArray(wanted.slides) && wanted.slides.length > 0,
  ].filter(Boolean).length;
  if (kind === "pptx" && asked > 1)
    throw new CannotChange(
      "One kind of change per call: remove a slide, replace a slide, or add slides. The numbers move after each, so look at files.outline in between.",
    );

  if (kind === "pptx") {
    const slides = [...(recipe.slides ?? [])];
    const whole = (n: unknown, what: string) => {
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > slides.length)
        throw new CannotChange(
          `There is no slide ${String(n)} to ${what}: the deck has ${slides.length} slides. Look at files.outline first.`,
        );
      return (n as number) - 1;
    };
    const given = Array.isArray(wanted.slides) ? wanted.slides : [];
    if (given.length > SLIDES_A_STEP)
      throw new CannotChange(`Add at most ${SLIDES_A_STEP} slides in one step.`);
    if (wanted.remove !== undefined) {
      const at = whole(wanted.remove, "remove");
      slides.splice(at, 1);
      notes.push(`Slide ${at + 1} removed`);
    }
    if (wanted.replace !== undefined) {
      if (given.length === 0) throw new CannotChange('Give the new slide in "slides".');
      const at = whole(wanted.replace, "replace");
      slides.splice(at, 1, ...given);
      notes.push(
        given.length === 1
          ? `Slide ${at + 1} replaced`
          : `Slide ${at + 1} replaced by ${given.length} slides`,
      );
    } else if (given.length > 0) {
      const at =
        wanted.at === undefined
          ? slides.length
          : Number.isInteger(wanted.at) && wanted.at >= 1 && wanted.at <= slides.length + 1
            ? wanted.at - 1
            : -1;
      if (at < 0)
        throw new CannotChange(
          `"at" is the slide number to put them before, 1 to ${slides.length + 1}.`,
        );
      slides.splice(at, 0, ...given);
      notes.push(
        `${given.length} slide${given.length === 1 ? "" : "s"} added ${at === slides.length - given.length ? "at the end" : `before slide ${at + 1}`}`,
      );
    }
    if (slides.length === 0) throw new CannotChange("A presentation keeps at least one slide.");
    // The cover slide says what the cover says: a new title or subtitle is put on it.
    const front = slides[0];
    if (wanted.cover && front && String(front.layout ?? "").toLowerCase() === "cover")
      slides[0] = {
        ...front,
        ...(typeof wanted.cover.title === "string" ? { title: wanted.cover.title } : {}),
        ...(typeof wanted.cover.subtitle === "string" ? { subtitle: wanted.cover.subtitle } : {}),
      };
    next.slides = slides;
    next.pages = true;
  } else if (kind === "xlsx") {
    const sheets = [...(recipe.sheets ?? [])];
    const sheet = wanted.sheet;
    if (sheet && typeof sheet === "object") {
      const label = String(sheet.name ?? "").trim();
      if (!label) throw new CannotChange("Name the sheet.");
      const at = sheets.findIndex((one) => same(one.name, label));
      const rows = (value: unknown, what: string, most: number) => {
        if (!Array.isArray(value) || value.some((row) => !Array.isArray(row)))
          throw new CannotChange(`"${what}" is a list of rows, each a list of cells.`);
        if (value.length > most) throw new CannotChange(`Give at most ${most} rows in one step.`);
        return value as Row[];
      };
      if (sheet.remove) {
        if (at < 0) throw new CannotChange(`There is no sheet "${label}".`);
        sheets.splice(at, 1);
        notes.push(`Sheet "${label}" removed`);
      } else if (sheet.rows !== undefined) {
        const made = {
          name: at < 0 ? label : (sheets[at]?.name ?? label),
          rows: rows(sheet.rows, "rows", 5000),
          ...(sheet.chart
            ? { chart: sheet.chart }
            : at >= 0 && sheets[at]?.chart
              ? { chart: sheets[at]?.chart }
              : {}),
        };
        if (at < 0) sheets.push(made);
        else sheets[at] = made;
        notes.push(
          `Sheet "${made.name}" ${at < 0 ? "added" : "replaced"} (${made.rows.length} rows)`,
        );
      } else if (sheet.append !== undefined) {
        const now = sheets[at];
        if (!now) throw new CannotChange(`There is no sheet "${label}" to add rows to.`);
        const more = rows(sheet.append, "append", ROWS_A_STEP);
        sheets[at] = {
          ...now,
          rows: [...now.rows, ...more],
          ...(sheet.chart ? { chart: sheet.chart } : {}),
        };
        notes.push(
          `${more.length} row${more.length === 1 ? "" : "s"} added to sheet "${now.name}"`,
        );
      } else if (sheet.chart) {
        const now = sheets[at];
        if (!now) throw new CannotChange(`There is no sheet "${label}".`);
        sheets[at] = { ...now, chart: sheet.chart };
        notes.push(`Chart on sheet "${now.name}" changed`);
      }
    }
    if (sheets.length === 0) throw new CannotChange("A workbook keeps at least one sheet.");
    next.sheets = sheets;
  } else {
    const text = typeof wanted.text === "string" ? wanted.text : "";
    if (text.length > 200_000) throw new CannotChange("That is too much text for one step.");
    const now = typeof recipe.text === "string" ? recipe.text : "";
    if (wanted.section !== undefined) {
      if (!text.trim()) throw new CannotChange('Give the section\'s new text in "text".');
      const lines = now.replace(/\r\n?/g, "\n").split("\n");
      const all = headings(lines);
      const which = all.findIndex((one) => same(one.title, String(wanted.section)));
      const found = all[which];
      if (!found)
        throw new CannotChange(
          `There is no section "${String(wanted.section)}". Look at files.outline for the headings.`,
        );
      const start = found.at;
      // A section runs to the next heading of its own level or above. The document's title
      // is the exception: under it is the whole document, so its section is only what
      // stands between it and the first heading after it.
      const title = which === 0 && all.some((one) => one.level > found.level);
      const stop = all.slice(which + 1).find((one) => title || one.level <= found.level);
      const end = stop ? stop.at : lines.length;
      // The new text brings its own heading when it has one; otherwise the old heading stays.
      const body = heading(text.split("\n")[0] ?? "")
        ? text.trimEnd()
        : `${lines[start]}\n\n${text.trim()}`;
      next.text = [...lines.slice(0, start), body, "", ...lines.slice(end)]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
      notes.push(`Section "${String(wanted.section).trim()}" rewritten`);
    } else if (text.trim()) {
      if (!wanted.append)
        throw new CannotChange(
          'Say which "section" the text replaces, or set "append" to add it at the end.',
        );
      next.text = `${now.trimEnd()}\n\n${text.trim()}\n`;
      notes.push("Text added at the end");
    }
  }
  if (notes.length === 0) throw new CannotChange("Say what to change.");
  return { recipe: next, note: notes.join("; ") };
}

/** A file's parts, numbered and named, so that a change can say which one it means. */
export function outline(name: string, recipe: FileRecipe, version: number): string {
  const kind = ending(name);
  const head = `"${name}", version ${version}.`;
  if (kind === "pptx") {
    const slides = recipe.slides ?? [];
    return `${head} ${slides.length} slides:\n${slides
      .map((slide, index) => {
        const holds = [
          slide.chart && "chart",
          slide.table && "table",
          slide.stats?.length && "stats",
          slide.columns?.length && "columns",
          slide.steps?.length && "steps",
          slide.quote && "quote",
          slide.bullets?.length && `${slide.bullets.length} bullets`,
        ].filter(Boolean);
        return `${index + 1}. [${slide.layout || holds[0] || "text"}] ${String(slide.title ?? "").slice(0, 120)}${holds.length ? ` (${holds.join(", ")})` : ""}`;
      })
      .join("\n")}`;
  }
  if (kind === "xlsx") {
    const sheets = recipe.sheets ?? [];
    return `${head} ${sheets.length} sheets:\n${sheets
      .map(
        (sheet) =>
          `- "${sheet.name}": ${Math.max(0, fromHeader(sheet.rows).length - 1)} rows; columns: ${(fromHeader(sheet.rows)[0] ?? []).map(String).join(", ").slice(0, 300)}${sheet.chart ? "; has a chart" : ""}`,
      )
      .join("\n")}`;
  }
  const text = typeof recipe.text === "string" ? recipe.text : "";
  const sections = headings(text.replace(/\r\n?/g, "\n").split("\n"));
  return `${head} ${text.length} characters${
    sections.length
      ? `; sections:\n${sections.map((one) => `${"  ".repeat(one.level - 1)}- ${one.title}`).join("\n")}`
      : "; no headings."
  }`;
}
