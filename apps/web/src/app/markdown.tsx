import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FileMention, LANG_ENDINGS, namesFile } from "./lang";
import { CodeBlock } from "./reply";

/**
 * A document as it is read: the Markdown agents are asked to write (the same kinds the
 * .docx maker takes, and code blocks): headings, paragraphs, lists, tables, quotations,
 * rules, fenced code, **bold**, *italic*, `code` and links. Nothing is taken as HTML: every
 * piece is a React element around the text as written. A document in plain text keeps its
 * lines and indentation, so it reads as it was typed.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-3 text-sm leading-relaxed", className)}>
      {blocksOf(text).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one text never reorder
        <Fragment key={index}>{show(block)}</Fragment>
      ))}
    </div>
  );
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "rule" }
  | { kind: "code"; language?: string; code: string }
  | { kind: "quote"; text: string }
  /** Items in order, each with how far it is set in: 0 for the list's own, 1 under it, … */
  | { kind: "list"; ordered: boolean; items: { text: string; depth: number; mark: string }[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "paragraph"; text: string };

// A fence may say more after its language ("```ts title=a.ts"): only the language is kept.
const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)[^`]*$/;
// Closing #s are taken off in code: a pattern for them backtracked badly on a long line.
const HEADING = /^(#{1,6})\s+(.*)$/;
// A line of only = or - or * or _ (three or more): `---` in Markdown, and the `====` that
// plain-text writing draws under or between parts.
const RULE = /^\s*([=\-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** The text cut into blocks, in order. */
export function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let at = 0;
  const blank = (line: string | undefined) => line === undefined || line.trim() === "";
  // Whether a line begins a block of its own, so a paragraph above it ends there.
  const starts = (index: number) => {
    const line = lines[index] ?? "";
    return (
      FENCE.test(line) ||
      HEADING.test(line) ||
      RULE.test(line) ||
      QUOTE.test(line) ||
      ITEM.test(line) ||
      (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? ""))
    );
  };
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (blank(line)) {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? "```";
      const body: string[] = [];
      at++;
      // An unclosed fence runs to the end: what was meant as code stays code.
      while (at < lines.length && (lines[at] ?? "").trim() !== mark) body.push(lines[at++] ?? "");
      at++;
      blocks.push({ kind: "code", language: fence[2] || undefined, code: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        text: headingText(heading[2] ?? ""),
      });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      at++;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[at + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && TABLE_ROW.test(lines[at] ?? ""))
        rows.push(cells(lines[at++] ?? ""));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? ""))
        body.push(QUOTE.exec(lines[at++] ?? "")?.[1] ?? "");
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2] ?? "");
      const base = (item[1] ?? "").replace(/\t/g, "  ").length;
      const items: { text: string; depth: number; mark: string }[] = [];
      while (at < lines.length) {
        const next = ITEM.exec(lines[at] ?? "");
        const indent = (next?.[1] ?? "").replace(/\t/g, "  ").length;
        if (next && indent > base) {
          // An item set in under another, of either kind: one level per two spaces or so.
          items.push({
            text: next[3] ?? "",
            depth: Math.min(3, Math.max(1, Math.round((indent - base) / 2))),
            mark: next[2] ?? "",
          });
          at++;
        } else if (next && /\d/.test(next[2] ?? "") === ordered) {
          items.push({ text: next[3] ?? "", depth: 0, mark: next[2] ?? "" });
          at++;
        } else if (!next && !blank(lines[at]) && /^\s+/.test(lines[at] ?? "") && items.length > 0) {
          // An indented line under an item goes on with that item.
          const last = items[items.length - 1];
          if (last) last.text += `\n${(lines[at] ?? "").trim()}`;
          at++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (at < lines.length && !blank(lines[at]) && (body.length === 0 || !starts(at)))
      body.push(lines[at++] ?? "");
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

const headingClass = [
  "pt-1 text-[1.25em] leading-snug font-semibold tracking-tight",
  "pt-2 text-[1.12em] leading-snug font-semibold tracking-tight",
  "pt-1.5 text-[1.05em] leading-snug font-semibold",
  "pt-1 font-semibold",
];

function show(block: Block): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
      return <Tag className={headingClass[Math.min(block.level, 4) - 1]}>{inline(block.text)}</Tag>;
    }
    case "rule":
      return <hr className="border-border" />;
    case "code":
      return <CodeBlock code={block.code} language={block.language} />;
    case "quote":
      return (
        <blockquote className="border-l-2 pl-3 whitespace-pre-wrap text-muted-foreground">
          {inline(block.text)}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className="grid gap-1.5">
          {block.items.map((item, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: items of one list never reorder
              key={index}
              className="grid grid-cols-[1.4em_minmax(0,1fr)] whitespace-pre-wrap"
              style={{ marginLeft: `${item.depth * 1.25}em` }}
            >
              <span aria-hidden className="text-muted-foreground select-none">
                {/\d/.test(item.mark) ? item.mark.replace(")", ".") : item.depth === 0 ? "•" : "◦"}
              </span>
              <span className="min-w-0">{inline(item.text)}</span>
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/60">
              <tr>
                {block.head.map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns of one table never reorder
                  <th key={index} className="px-3 py-2 font-medium">
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of one table never reorder
                <tr key={at} className="border-t">
                  {block.head.map((_, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                    <td key={index} className="px-3 py-2 align-top">
                      {inline(row[index] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "paragraph":
      return <p className="whitespace-pre-wrap">{inline(block.text)}</p>;
  }
}

// `code`, **bold**, *italic*, and [words](address) for web and mail addresses only. An
// underscore is left alone: in names_like_this it is not emphasis.
const RUN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*[^*\s][^*\n]*\*)/;

/** Code named in running text: the brand's colour on a faint wash, a little smaller. */
export const CODE =
  "rounded-[5px] bg-code-wash px-[0.35em] py-[0.08em] font-mono text-[0.86em] text-brand-text [overflow-wrap:anywhere]";

export function inline(text: string): ReactNode {
  return text.split(RUN).map((run, at) => {
    // What the pattern took out is at the odd places; the words between are at the even.
    if (at % 2 === 0)
      // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
      return <Fragment key={at}>{named(run)}</Fragment>;
    if (run.length > 2 && run.startsWith("`") && run.endsWith("`")) {
      const code = run.slice(1, -1);
      // A file named in the text reads as the file: its language's mark and its name.
      if (namesFile(code))
        // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
        return <FileMention key={at} path={code} />;
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
        <code key={at} className={CODE}>
          {code}
        </code>
      );
    }
    if (run.length > 4 && run.startsWith("**") && run.endsWith("**"))
      // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
      return <strong key={at}>{run.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)$/.exec(run);
    if (link)
      return (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
          key={at}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {link[1]}
        </a>
      );
    if (run.length > 2 && run.startsWith("*") && run.endsWith("*"))
      // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
      return <em key={at}>{run.slice(1, -1)}</em>;
    // biome-ignore lint/suspicious/noArrayIndexKey: runs of one text never reorder
    return <Fragment key={at}>{named(run)}</Fragment>;
  });
}

// A file named in plain words (`cart.js`, `src/App.tsx`, `README.md`) and a commit
// (`1514d5d`): an editor's reader knows them on sight, so they are shown as such even
// without backticks. Only language endings count, so "example.com" or "e.g." are words.
const FILE_OR_COMMIT = new RegExp(
  `((?<![\\w./@-])(?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${LANG_ENDINGS.join("|")})(?::\\d+(?::\\d+)?)?(?![\\w/])|(?<![\\w-])[0-9a-f]{7,40}(?![\\w-]))`,
  "i",
);

function named(text: string): ReactNode {
  const parts = text.split(FILE_OR_COMMIT);
  if (parts.length === 1) return text;
  return parts.map((part, at) => {
    if (at % 2 === 0) return part;
    if (/^[0-9a-f]+$/i.test(part)) {
      // A commit has both digits and letters: "decade" and "2026" are words and a year.
      if (!/\d/.test(part) || !/[a-f]/i.test(part) || /^\d+e\d+$/i.test(part)) return part;
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one run never reorder
        <code key={at} className={CODE}>
          {part}
        </code>
      );
    }
    // "Node.js", "Next.js", "Vue.js": a framework's name, not a file.
    if (/^[A-Z][\w]*\.js$/.test(part)) return part;
    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one run never reorder
    return <FileMention key={at} path={part} />;
  });
}

/** A heading's words without the closing #s Markdown allows ("## Title ##"), in one pass. */
function headingText(text: string): string {
  const words = text.trimEnd();
  let end = words.length;
  while (end > 0 && words[end - 1] === "#") end--;
  // Closing #s stand apart from the words; "C#" keeps its #.
  return end < words.length && (end === 0 || /\s/.test(words[end - 1] ?? ""))
    ? words.slice(0, end).trim()
    : words.trim();
}
