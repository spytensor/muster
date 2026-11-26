import { AtomIcon, FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A file named in running text, as an editor shows it: the language's small mark in its
 * colour, then the file's name. The whole path is in the title. Drawn here from letters
 * and one icon; no project's artwork is used.
 */
type Mark = { label?: string; atom?: boolean; color: string };

const BY_ENDING: Record<string, Mark> = {
  ts: { label: "TS", color: "#3178c6" },
  mts: { label: "TS", color: "#3178c6" },
  cts: { label: "TS", color: "#3178c6" },
  tsx: { atom: true, color: "#3b82f6" },
  jsx: { atom: true, color: "#3b82f6" },
  js: { label: "JS", color: "#d4a017" },
  mjs: { label: "JS", color: "#d4a017" },
  cjs: { label: "JS", color: "#d4a017" },
  json: { label: "{}", color: "#c08a1e" },
  md: { label: "M↓", color: "#5b7bd5" },
  mdx: { label: "M↓", color: "#5b7bd5" },
  css: { label: "#", color: "#2965f1" },
  scss: { label: "#", color: "#c6538c" },
  html: { label: "<>", color: "#e34c26" },
  py: { label: "PY", color: "#3572a5" },
  go: { label: "GO", color: "#00add8" },
  rs: { label: "RS", color: "#ce7e4a" },
  swift: { label: "SW", color: "#f05138" },
  kt: { label: "KT", color: "#a97bff" },
  java: { label: "J", color: "#b07219" },
  rb: { label: "RB", color: "#cc342d" },
  php: { label: "PHP", color: "#777bb4" },
  c: { label: "C", color: "#555fb5" },
  h: { label: "H", color: "#555fb5" },
  cpp: { label: "C++", color: "#f34b7d" },
  cs: { label: "C#", color: "#178600" },
  sh: { label: "$", color: "#4b8b3b" },
  zsh: { label: "$", color: "#4b8b3b" },
  yml: { label: "YML", color: "#cb4b4b" },
  yaml: { label: "YML", color: "#cb4b4b" },
  toml: { label: "TML", color: "#9c4221" },
  sql: { label: "SQL", color: "#e38c00" },
  vue: { label: "V", color: "#41b883" },
  svelte: { label: "S", color: "#ff3e00" },
};
/** Endings that are files but have no language: a plain page mark. */
const OTHER =
  /^(txt|lock|env|gitignore|svg|png|jpe?g|gif|webp|pdf|csv|xml|ini|conf|log|mp4|docx|xlsx|pptx)$/;

const ending = (name: string) => name.toLowerCase().match(/\.([a-z0-9+]+)$/)?.[1] ?? "";

/**
 * Whether words in backticks name a file: a path or a name with an ending a file has. A
 * version ("1.2.3"), a call (`total()`), a domain or a sentence is not one.
 */
export function namesFile(given: string): boolean {
  // `src/orders.ts:16` is the file at a line.
  const text = given.replace(/:\d+(:\d+)?$/, "");
  if (!/^[\w@.\-/[\]]+$/.test(text) || text.length > 200) return false;
  const end = ending(text);
  if (!end || /^\d+$/.test(end)) return false;
  return Object.hasOwn(BY_ENDING, end) || OTHER.test(end);
}

export function LangMark({ name, className }: { name: string; className?: string }) {
  const mark = BY_ENDING[ending(name)];
  if (!mark)
    return (
      <FileIcon aria-hidden className={cn("size-[0.95em] text-muted-foreground", className)} />
    );
  if (mark.atom)
    return (
      <AtomIcon
        aria-hidden
        className={cn("size-[0.95em]", className)}
        style={{ color: mark.color }}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block min-w-[1.1em] text-center font-sans text-[0.68em] font-bold tracking-tight",
        className,
      )}
      style={{ color: mark.color }}
    >
      {mark.label}
    </span>
  );
}

/** A file named in text: its language's mark and its name, the whole path on hover. */
export function FileMention({ path, folder }: { path: string; folder?: boolean }) {
  const [, file = path, at = ""] = /^(.*?)(:\d+(?::\d+)?)?$/.exec(path) ?? [];
  const parts = file.split("/").filter(Boolean);
  const name = (parts.at(-1) ?? file) + at;
  // Where it is, dimmed after the name, when two files of one name could be told apart only so.
  const where = folder && parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return (
    <span
      title={path}
      className="inline-flex items-baseline gap-[0.3em] font-medium whitespace-nowrap"
    >
      <LangMark name={file} className="self-center" />
      {name}
      {where && <span className="font-normal text-muted-foreground">{where}</span>}
    </span>
  );
}

/** The language endings, for finding file names in running text. */
export const LANG_ENDINGS = Object.keys(BY_ENDING).filter((end) => end.length > 1);
