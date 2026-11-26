/**
 * How a document, a presentation and a workbook are written here: what an agent reads
 * before it writes one (`files.guide`), and what is looked for in what it wrote
 * (`review`). The look of a file is decided by the code that makes it; whether it reads
 * well is decided by what the agent hands over, and that is what these are for.
 *
 * Added 2026-11-22, after the owner showed a nine-page profile Muster had made: walls of
 * text, every paragraph led by a bold phrase, tables of five columns with a sentence in
 * each cell, and the agent's own working labels (N23, E34) in the text.
 */
import type { SlideRecipe } from "./deck.js";

export type GuideKind = "document" | "presentation" | "workbook";

const WORDS = `The words, in any of them:
- Write for the person who will read it, who was not in this conversation. Nothing about how you worked: no "this version adds", "based on the material provided", "as requested", no list of what you searched, unless they asked for a method section, and then it comes last.
- No labels of your own working (N23, E34, "finding 7", "grade A2"). Name the thing. If the reader must be able to cite items, number them plainly and define the numbering once.
- Say it once, plainly, with the figure, its unit and its date. No slogans, no sets of three for rhythm, no chains of dashes; a sentence that needs two dashes is two sentences.
- Write in the language the person writes in.`;

const GUIDES: Record<GuideKind, string> = {
  document: `How a document is written here (.docx).

Before you write, decide who reads it, what they must come away with, and what kind of paper it is (a memo, a report, a brief, a profile, a proposal, minutes). Then its sections, in the order the reader needs them.

Order
- The first paragraph under the title holds what the reader most needs: the conclusion, the answer, the recommendation. Grounds come after, detail last.
- What changed since an earlier version, and how the work was done, are short sections at the end, or left out.

Headings
- A heading says what its section says ("Europe missed plan by $0.7M") or names its subject plainly. Read the headings alone: they should tell the paper's story. Two levels are usually enough.

Paragraphs
- One point to a paragraph, two to five sentences. None over about 120 words, or 200 Chinese characters: a longer one is two points, or a list.
- Bold is for the few words a reader skimming the page must not miss: once or twice a page. Do not begin paragraph after paragraph with a bold phrase. Paragraphs that each open with a bold label are a set of sections or a list: write them as one.

Lists
- For things of the same kind: steps, options, risks. Each item a line or two. If every item is a paragraph, it is not a list: give each a heading.

Tables
- Only for figures, and for comparing a few things on the same few attributes. A cell holds a number or a few words (about 12 words, or 20 Chinese characters, at most).
- Sentences do not go in cells. Material that needs a sentence per cell is prose: write a short section for each row, or a list whose items begin with the row's name in bold.
- Five columns at most on a page. The first column names the row; a unit goes in the header, not in every cell; figures in one column have the same decimals.

Other
- A ">" line is for words someone said or wrote, quoted. It is not a box for a key point: a key point is the first sentence of its section.
- Sources go in brackets after the claim as (who, date), or in a Sources section at the end, not in a column of a table.
- As long as its content and no longer. Cut what is said twice.

${WORDS}

When the file is made you are told what a reader would stumble on. Put right what is a fault with files.change before you answer; what is as this document needs it (a contract's long clauses) stands.`,

  presentation: `How a presentation is written here (.pptx).

Before you write, decide who is in the room and what they should decide or remember. Write the titles of all the slides first, in order: read alone they must tell the whole story. Then fill each slide.

Slides
- One message to a slide, said in its title as a short sentence ("Enterprise drove two thirds of new revenue"), at most about 12 words or 24 Chinese characters. A slide that sets something up (an agenda, a process) may have a plain name as its title.
- Choose the form by what the content is: a few headline numbers are "stats"; numbers by segment or over time are a "chart"; a few things compared are "columns" or a small "table"; a sequence is "steps"; a statement with its reasons is bullets.
- Bullets: four to a slide is right and five the most, each one line (about 15 words or 25 Chinese characters). Never two slides of bullets in a row where one could be a chart, columns or steps. Detail goes in "notes", for the presenter.
- A table on a slide: at most six columns and eight rows, a number or a few words to a cell.
- A chart shows one kind of number. Say what it shows in the slide's title, not in a caption.
- "takeaway" only where the slide has a conclusion that its title does not already say.
- Cut words before anything is made smaller: what does not fit on a slide belongs on two, or in the notes.

The deck
- Cover: the title, a subtitle that says what the deck is for, who and when. Nothing else.
- Section slides only in a deck of more than about eight slides.
- The last slide with content says what happens next or what is asked of the audience. A "closing" slide after it holds a line and up to three contact lines, nothing more: next steps written there are set as contact lines.
- Vary the slides: a deck is not one layout repeated.

${WORDS}

When the file is made you are told what an audience would stumble on. Put right what is a fault with files.change before you answer.`,

  workbook: `How a workbook is written here (.xlsx).

Before you write, decide what the person will do with it: read a result, keep a record, or change inputs and watch results follow. That decides its sheets.

Sheets
- The sheet the person needs first comes first: the summary or result, then the detail behind it, then inputs. One or two sheets for a simple question.
- One table to a sheet, its header in the first row. No title row above it, no blank rows or columns inside it, no notes beside it.
- Short sheet names that say what the sheet holds ("Summary", "By region", "Assumptions").

Columns
- Names first, then figures, then any note, which is the last column and short.
- One fact to a cell. A unit goes in the header ("Revenue ($M)"), never in the cell. A date is a date (2026-11-22), not "end of November".
- Numbers are numbers, never text; a rate or a share is a fraction (0.203) under a header that says so. Figures in one column have the same precision.

Figures
- Every total, difference, share and ratio is a formula, so it follows when the person changes a number. A figure the others depend on (a rate, a price, a growth assumption) stands in a cell of its own, on an "Assumptions" sheet when there are several, and the formulas refer to it.
- A row of totals is named "Total".
- A chart where the person asked for one, or where the point of the sheet is a trend or a comparison: shape that sheet for the chart.

${WORDS}`,
};

/** What an agent reads before it writes a file of this kind. */
export function guideFor(kind: string): string {
  const named = kind.trim().toLowerCase();
  const which: GuideKind | null = /^(document|doc|docx|word|report|memo)$/.test(named)
    ? "document"
    : /^(presentation|deck|slides|pptx|powerpoint)$/.test(named)
      ? "presentation"
      : /^(workbook|spreadsheet|sheet|xlsx|excel)$/.test(named)
        ? "workbook"
        : null;
  if (!which) throw new Error('The kind is "document", "presentation" or "workbook".');
  return GUIDES[which];
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;
/** How long a text is, in characters of ordinary width: a Chinese character counts as two. */
const wide = (text: string) => [...text].reduce((sum, ch) => sum + (CJK.test(ch) ? 2 : 1), 0);
/**
 * How long a text is in words, as the guides count: a word of letters or digits is one,
 * and a Chinese character is three fifths of one (200 characters to 120 words). A link
 * counts as the words it shows, not its address.
 */
function words(text: string): number {
  const shown = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "link");
  const latin = shown.match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g)?.length ?? 0;
  const cjk = [...shown].filter((ch) => CJK.test(ch)).length;
  return latin + cjk * 0.6;
}
const short = (text: string, most = 40) => {
  const flat = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most)}…` : flat;
};

/** What a reader would stumble on in a document's markdown. */
function reviewDocument(text: string): string[] {
  const found: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  // Tables whose cells hold sentences.
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i] as string)) continue;
    const rows: string[][] = [];
    while (i < lines.length && isRow(lines[i] as string)) {
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i] as string))
        rows.push(
          (lines[i] as string)
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
      i++;
    }
    const body = rows.slice(1).flat().filter(Boolean);
    const columns = Math.max(0, ...rows.map((row) => row.length));
    // The guide allows a cell about twelve words; a little more is let pass.
    const long = body.filter((cell) => words(cell) > 15).length;
    const name = short((rows[0] ?? []).join(" / "), 50);
    if (body.length >= 4 && long / body.length > 0.3)
      found.push(
        `The table headed "${name}" holds sentences in its cells (${long} of ${body.length} are long), so each column is a few words wide and each row many lines tall. Write it as a short section for each row, or a list whose items begin with the row's name in bold; keep a table for figures and for cells of a few words.`,
      );
    else if (columns > 6)
      found.push(
        `The table headed "${name}" has ${columns} columns, more than a page holds without breaking words: keep the five that matter, or make two tables.`,
      );
  }
  // A paragraph is a line of running text: not a heading, a list item, a quotation, a rule,
  // nor a numbered clause of a contract ("1.1 …", "(a) …"), which is as long as it must be.
  const paragraphs = lines.filter(
    (line) =>
      line.trim() &&
      !isRow(line) &&
      !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|-{3,}|\*{3,}|\d+(\.\d+)+\.?\s|\(?[a-z0-9]{1,3}\)\s)/i.test(
        line,
      ),
  );
  // The guide says about 120 words; only what is well past that is said.
  const tooLong = paragraphs.filter((line) => words(line) > 140);
  if (tooLong.length)
    found.push(
      `${tooLong.length === 1 ? "A paragraph runs" : `${tooLong.length} paragraphs run`} well over 120 words or 200 Chinese characters (the first begins "${short(tooLong[0] as string)}"). Break each at its second point, or make its parts a list.`,
    );
  const led = paragraphs.filter((line) => /^\s*\*\*[^*]+\*\*/.test(line));
  if (paragraphs.length >= 6 && led.length / paragraphs.length > 0.4)
    found.push(
      `${led.length} of ${paragraphs.length} paragraphs begin with a bold phrase, so nothing on the page stands out. Where the bold phrases are labels, make them headings or the names of list items; keep bold for the few words a skimming reader must not miss.`,
    );
  // Labels of the agent's own working: one letter with numbers that follow one another
  // (N23, N24, N25). A model of aeroplane, a product code or a road is not that: A320 and
  // A350 do not follow each other, and naming them is what the text is for.
  const byLetter = new Map<string, Set<number>>();
  for (const label of text.match(/(?<![A-Za-z0-9])[A-Z]\d{2,3}(?![A-Za-z0-9.-])/g) ?? []) {
    const letter = label[0] as string;
    byLetter.set(letter, (byLetter.get(letter) ?? new Set()).add(Number(label.slice(1))));
  }
  const runs = [...byLetter].flatMap(([letter, numbers]) => {
    const start = [...numbers].find((n) => numbers.has(n + 1) && numbers.has(n + 2));
    return start === undefined
      ? []
      : [`${letter}${start}`, `${letter}${start + 1}`, `${letter}${start + 2}`];
  });
  if (runs.length)
    found.push(
      `The text uses what look like labels of your own working (${runs.slice(0, 4).join(", ")}…). If the reader was never given them, name each thing instead, or number the items plainly and say once what the numbers are.`,
    );
  return found;
}

/** What an audience would stumble on in a deck. */
function reviewDeck(slides: SlideRecipe[]): string[] {
  const found: string[] = [];
  const crowded: number[] = [];
  const wordy: number[] = [];
  let plain = 0;
  let content = 0;
  slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") return;
    const points = Array.isArray(slide.bullets) ? slide.bullets : [];
    const other =
      slide.chart ||
      slide.table ||
      slide.stats?.length ||
      slide.columns?.length ||
      slide.steps?.length ||
      slide.quote;
    const kind = String(slide.layout ?? "").toLowerCase();
    if (kind === "cover" || kind === "closing" || kind === "section") return;
    if (!points.length && !other) return;
    content += 1;
    if (points.length && !other) plain += 1;
    if (points.length > 5) crowded.push(index + 1);
    if (
      points.some(
        (point) => wide(typeof point === "string" ? point : String(point?.text ?? "")) > 110,
      )
    )
      wordy.push(index + 1);
  });
  const said = (numbers: number[]) => numbers.slice(0, 8).join(", ");
  if (crowded.length)
    found.push(
      `Slide${crowded.length > 1 ? "s" : ""} ${said(crowded)} ${crowded.length > 1 ? "have" : "has"} more than five bullets: keep the four that carry the message and move the rest to the notes or to a slide of their own.`,
    );
  if (wordy.length)
    found.push(
      `Slide${wordy.length > 1 ? "s" : ""} ${said(wordy)} ${wordy.length > 1 ? "have" : "has"} a bullet of several lines: a bullet is one line, and what explains it belongs in the notes.`,
    );
  if (content >= 5 && plain / content > 0.6)
    found.push(
      `${plain} of ${content} slides are bullets alone. Where a slide's content is numbers make it stats or a chart, where it compares things make it columns or a table, where it is a sequence make it steps.`,
    );
  return found;
}

/**
 * What a reader would stumble on in a file as the agent wrote it, for the agent to put
 * right. Nothing here refuses a file: it is made, and these are said with it.
 */
export function review(name: string, given: { text?: unknown; slides?: unknown }): string[] {
  const ending = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ending === "docx" && typeof given.text === "string") return reviewDocument(given.text);
  if (ending === "pptx" && Array.isArray(given.slides))
    return reviewDeck(given.slides as SlideRecipe[]);
  return [];
}
