import type { ISectionOptions } from "docx";

/** How a made file looks and what stands on its first page; shared by documents and presentations. */
export interface Cover {
  /** "ink" (navy and blue), "ember" (graphite and orange), "forest", "plum". */
  theme?: string;
  title?: string;
  subtitle?: string;
  /** Who it is from and when: "Mia Chen · November 2026". */
  byline?: string;
}

export const ACCENTS: Record<string, { dark: string; accent: string; soft: string }> = {
  ink: { dark: "0B1F3A", accent: "2F6BFF", soft: "E8EFFF" },
  ember: { dark: "1F2328", accent: "FF7F41", soft: "FFEDE4" },
  forest: { dark: "0F2A22", accent: "17A673", soft: "E1F5EC" },
  plum: { dark: "241538", accent: "8B5CF6", soft: "EFE8FF" },
};
// A paper, not a page of an app: black type, one family, grey hairlines. No colour is
// used for decoration, so no tinted boxes, no bars down the side, no rule under a title.
const INK = "1A1A1A";
const BLACK = "000000";
const MUTED = "595959";
const RULE = "D9D9D9";
const SURFACE = "F2F2F2";
/** The width of the text on a page, in twentieths of a point: A4 with an inch on each side. */
const PAGE_WIDE = 11906 - 2 * 1440;
const TOTAL_ROW = /^\s*\**(total|grand total|subtotal|sum|合计|总计|小计)(?![a-z])/i;
/** How wide a text is, in characters of ordinary width: a Chinese character counts as two. */
const wide = (text: string) => [...text].reduce((sum, ch) => sum + (CJK.test(ch) ? 2 : 1), 0);
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;

interface Piece {
  text: string;
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}
/** One line of markdown as pieces: **bold**, *italic* and `code` kept, everything else as written. */
export function inline(line: string): Piece[] {
  return line
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : part.startsWith("`") && part.endsWith("`") && part.length > 2
          ? { text: part.slice(1, -1), code: true }
          : part.startsWith("*") && part.endsWith("*") && part.length > 2
            ? { text: part.slice(1, -1), italics: true }
            : { text: part },
    );
}
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const numeric = (value: string) => /^[\s$¥€£+-]*[\d,.]+\s*[%kKmMbB万亿]?\s*$/.test(value);

/**
 * Makes a Word document from markdown, laid out as a finished paper: a title block,
 * styled headings, real lists and tables as wide as what they hold, and page numbers.
 */
export async function makeDocument(text: string, cover: Cover = {}): Promise<Uint8Array> {
  const docx = await import("docx");
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    LevelFormat,
    LineRuleType,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
  } = docx;
  // One family through the whole document. Where there is Chinese, one that has it on every computer.
  const font = CJK.test(text + JSON.stringify(cover))
    ? { ascii: "Arial", hAnsi: "Arial", eastAsia: "Microsoft YaHei", cs: "Arial" }
    : { ascii: "Arial", hAnsi: "Arial", eastAsia: "Arial", cs: "Arial" };
  type RunLook = { size?: number; color?: string; bold?: boolean };
  const run = (piece: Piece, look: RunLook = {}) =>
    new TextRun({
      text: piece.text,
      bold: piece.bold || look.bold,
      italics: piece.italics,
      size: look.size,
      color: look.color,
      font: piece.code
        ? { ascii: "Menlo", hAnsi: "Menlo", eastAsia: font.eastAsia, cs: "Menlo" }
        : font,
      shading: piece.code ? { type: ShadingType.CLEAR, fill: SURFACE, color: "auto" } : undefined,
    });
  const para = (line: string, options: Record<string, unknown> = {}, look: RunLook = {}) =>
    new Paragraph({ ...options, children: inline(line).map((piece) => run(piece, look)) });

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // The first top-level heading is the document's title unless one was given.
  let title = String(cover.title ?? "").trim();
  const firstHeading = lines.findIndex((line) => /^#\s+/.test(line));
  if (!title && firstHeading >= 0 && lines.slice(0, firstHeading).every((line) => !line.trim())) {
    title = (lines[firstHeading] as string).replace(/^#\s+/, "").trim();
    lines.splice(0, firstHeading + 1);
  } else if (
    title &&
    firstHeading >= 0 &&
    lines.slice(0, firstHeading).every((line) => !line.trim())
  ) {
    // The title was given and the text opens with a title of its own, the same or a
    // longer form of it: a document has one, and it is the one on its first page.
    lines.splice(0, firstHeading + 1);
  }

  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const body: Block[] = [];
  if (title) {
    body.push(
      new Paragraph({
        spacing: { before: 0, after: 120, line: 264, lineRule: LineRuleType.AUTO },
        children: [new TextRun({ text: title, bold: true, size: 52, color: BLACK, font })],
      }),
    );
    const subtitle = String(cover.subtitle ?? "").trim();
    if (subtitle)
      body.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: subtitle, size: 28, color: MUTED, font })],
        }),
      );
    const byline = String(cover.byline ?? "").trim();
    if (byline)
      body.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: byline, size: 21, color: MUTED, font })],
        }),
      );
    // Space closes the title block, and nothing drawn.
    body.push(new Paragraph({ spacing: { after: 240 }, children: [] }));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const depth = Math.min(3, heading[1]?.length ?? 1);
      const look = [
        { size: 32, color: BLACK, before: 400, after: 140 },
        { size: 26, color: BLACK, before: 320, after: 100 },
        { size: 22, color: BLACK, before: 240, after: 80 },
      ][depth - 1] as { size: number; color: string; before: number; after: number };
      body.push(
        para(
          heading[2] ?? "",
          {
            heading: [
              docx.HeadingLevel.HEADING_1,
              docx.HeadingLevel.HEADING_2,
              docx.HeadingLevel.HEADING_3,
            ][depth - 1],
            keepNext: true,
            spacing: { before: look.before, after: look.after },
          },
          { size: look.size, color: look.color, bold: true },
        ),
      );
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string)) {
        // The |---|---| line under a header only says it is a header.
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i] as string)) rows.push(cells(lines[i] as string));
        i++;
      }
      i--;
      // A line of dashes alone is no table, and Word refuses one with no rows.
      if (!rows.length) continue;
      const width = Math.max(...rows.map((row) => row.length));
      const right = Array.from(
        { length: width },
        (_, column) =>
          column > 0 &&
          rows.length > 1 &&
          rows.slice(1).every((row) => !row[column] || numeric(row[column] as string)),
      );
      // A column is as wide as what it holds, and the table as wide as its columns: three
      // short columns are not stretched across the page.
      const natural = Array.from(
        { length: width },
        (_, column) =>
          Math.min(40, Math.max(5, ...rows.map((row) => wide(row[column] ?? "")))) * 115 + 300,
      );
      // Too wide for the page: the room is taken from the widest columns, whose text can
      // wrap, and a column of figures keeps the width of its figures. Only when even
      // that is too much are all made narrower together.
      const columnWidths = [...natural];
      const over = () => columnWidths.reduce((all, one) => all + one, 0) - PAGE_WIDE;
      const floor = 14 * 115 + 300;
      for (let turn = 0; turn < 60 && over() > 0; turn++) {
        const widest = Math.max(...columnWidths);
        if (widest <= floor) break;
        const next = Math.max(floor, ...columnWidths.filter((one) => one < widest));
        const at = columnWidths.map((one, column) => (one === widest ? column : -1));
        const those = at.filter((column) => column >= 0);
        const cut = Math.min(widest - next, Math.ceil(over() / those.length));
        for (const column of those) columnWidths[column] = widest - cut;
      }
      if (over() > 0) {
        const scale = PAGE_WIDE / columnWidths.reduce((all, one) => all + one, 0);
        columnWidths.forEach((one, column) => {
          columnWidths[column] = Math.floor(one * scale);
        });
      }
      const line = { style: BorderStyle.SINGLE, size: 4, color: RULE };
      body.push(
        new Table({
          width: { size: columnWidths.reduce((all, one) => all + one, 0), type: WidthType.DXA },
          columnWidths,
          layout: TableLayoutType.FIXED,
          borders: {
            top: line,
            left: line,
            right: line,
            bottom: line,
            insideVertical: line,
            insideHorizontal: line,
          },
          rows: rows.map((row, index) => {
            const total = index > 0 && TOTAL_ROW.test(row[0] ?? "");
            return new TableRow({
              tableHeader: index === 0,
              // A row is kept whole on a page unless its cells are long: a row of a dozen
              // lines kept whole would leave half the page before it empty.
              cantSplit:
                index === 0 ||
                Math.max(
                  ...row.map((cell, column) =>
                    Math.ceil(
                      (wide(cell) * 115) / Math.max(1, (columnWidths[column] ?? 1000) - 240),
                    ),
                  ),
                ) <= 10,
              children: Array.from(
                { length: width },
                (_, column) =>
                  new TableCell({
                    width: { size: columnWidths[column] as number, type: WidthType.DXA },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    shading:
                      index === 0
                        ? { type: ShadingType.CLEAR, color: "auto", fill: SURFACE }
                        : undefined,
                    children: [
                      para(
                        row[column] ?? "",
                        {
                          alignment: right[column] ? AlignmentType.RIGHT : AlignmentType.LEFT,
                          spacing: { after: 0, line: 276, lineRule: LineRuleType.AUTO },
                        },
                        { size: 20, color: INK, bold: index === 0 || total },
                      ),
                    ],
                  }),
              ),
            });
          }),
        }),
        new Paragraph({ spacing: { after: 120 }, children: [] }),
      );
    } else if (/^\s*>\s?/.test(line)) {
      // Lines that start with > are set in from both sides, as a quotation is in a paper.
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      quoted
        .filter((part) => part.trim())
        .forEach((part, index, kept) => {
          body.push(
            para(part, {
              indent: { left: 480, right: 480 },
              spacing: {
                before: index === 0 ? 160 : 0,
                after: index === kept.length - 1 ? 240 : 60,
              },
            }),
          );
        });
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      body.push(
        new Paragraph({
          spacing: { before: 120, after: 240 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
          children: [],
        }),
      );
    } else if (/^\s*[-*+]\s+/.test(line)) {
      const depth = Math.min(2, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2));
      body.push(
        para(line.replace(/^\s*[-*+]\s+/, ""), {
          numbering: { reference: "bullets", level: depth },
          spacing: { after: 80 },
        }),
      );
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      body.push(
        para(line.replace(/^\s*\d+[.)]\s+/, ""), {
          numbering: { reference: "numbers", level: 0 },
          spacing: { after: 80 },
        }),
      );
    } else if (line.trim()) {
      body.push(para(line));
    }
  }

  const page: ISectionOptions["properties"] = {
    page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
  };
  const small = (
    children: InstanceType<typeof TextRun>[],
    alignment: (typeof AlignmentType)[keyof typeof AlignmentType],
  ) => new Paragraph({ alignment, children });
  const document = new Document({
    title: title || undefined,
    styles: {
      default: {
        document: {
          run: { font, size: 22, color: INK },
          // The rule is said: left out, some programs take the figure for an exact height,
          // and a title of two lines is then set one line over the other.
          paragraph: { spacing: { after: 160, line: 300, lineRule: LineRuleType.AUTO } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 500, hanging: 320 } } },
            },
          ],
        },
        {
          reference: "bullets",
          levels: ["•", "–", "·"].map((symbol, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: symbol,
            alignment: AlignmentType.START,
            style: {
              paragraph: { indent: { left: 500 + level * 400, hanging: 280 } },
              run: { color: INK },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: page,
        footers: {
          default: new Footer({
            children: [
              small(
                [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 18,
                    color: MUTED,
                    font,
                  }),
                ],
                AlignmentType.CENTER,
              ),
            ],
          }),
        },
        children: body.length ? body : [new Paragraph("")],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
