import type { FileKind } from "./api";

/**
 * The mark of a file's type, as people know it from their own computer: a sheet of
 * paper in the type's colour with its letter. Blue W for Word, green X for Excel,
 * orange P for PowerPoint, red PDF. Drawn here; no vendor's artwork is used.
 */
type Mark = { color: string; label: string; picture?: boolean };

const BY_ENDING: Record<string, Mark> = {
  docx: { color: "#2b7cd3", label: "W" },
  doc: { color: "#2b7cd3", label: "W" },
  xlsx: { color: "#188a4d", label: "X" },
  xlsm: { color: "#188a4d", label: "X" },
  xls: { color: "#188a4d", label: "X" },
  csv: { color: "#188a4d", label: "CSV" },
  tsv: { color: "#188a4d", label: "TSV" },
  pptx: { color: "#e2572b", label: "P" },
  ppt: { color: "#e2572b", label: "P" },
  pdf: { color: "#e5352b", label: "PDF" },
  md: { color: "#6b7280", label: "MD" },
  txt: { color: "#6b7280", label: "TXT" },
  json: { color: "#a16207", label: "{ }" },
  html: { color: "#7c5cd6", label: "</>" },
  htm: { color: "#7c5cd6", label: "</>" },
};
const BY_KIND: Record<FileKind, Mark> = {
  document: { color: "#2b7cd3", label: "W" },
  spreadsheet: { color: "#188a4d", label: "X" },
  slides: { color: "#e2572b", label: "P" },
  pdf: { color: "#e5352b", label: "PDF" },
  image: { color: "#0e9aa7", label: "", picture: true },
  page: { color: "#7c5cd6", label: "</>" },
  text: { color: "#6b7280", label: "TXT" },
  data: { color: "#188a4d", label: "CSV" },
};
/** A note kept in Muster itself, which is no file type of anyone's. */
const NOTE: Mark = { color: "#b7791f", label: "N" };
/** A file of a type that has no mark of its own. */
const PLAIN: Mark = { color: "#6b7280", label: "" };
const PICTURE = /^(png|jpe?g|gif|webp|svg|bmp|heic)$/;

const ending = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

export function FileTypeIcon({
  name = "",
  kind,
  note,
  small,
  className,
}: {
  /** The file's name: its ending decides first. */
  name?: string;
  /** The file's kind, for a name without a known ending. */
  kind?: FileKind;
  /** A note kept in Muster, not a file. */
  note?: boolean;
  /** Drawn at the size of a line of text: words of several letters would not be legible, so they are lines. */
  small?: boolean;
  className?: string;
}) {
  const end = ending(name);
  const mark = note
    ? NOTE
    : kind === "image" || PICTURE.test(end)
      ? BY_KIND.image
      : (BY_ENDING[end] ?? (kind ? BY_KIND[kind] : PLAIN));
  const long = mark.label.length !== 1;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M5.5 1.5h9L20 7v14a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 21V3a1.5 1.5 0 0 1 1.5-1.5Z"
        fill={mark.color}
      />
      <path d="M14.5 1.5 20 7h-4a1.5 1.5 0 0 1-1.5-1.5Z" fill="#fff" fillOpacity=".45" />
      {mark.picture ? (
        <>
          <circle cx="9" cy="11.5" r="1.6" fill="#fff" />
          <path d="m6.5 19 3.6-4.2 2.3 2.4 2.2-2.9 2.9 4.7Z" fill="#fff" />
        </>
      ) : long && (small || !mark.label) ? (
        <path
          d="M7.5 11h9M7.5 14.5h9M7.5 18h5.5"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ) : (
        <text
          x="12"
          y={long ? 17.3 : 18.6}
          textAnchor="middle"
          fontSize={long ? 7.2 : 12.5}
          fontWeight="700"
          fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
          fill="#fff"
          letterSpacing={long ? "-0.2" : "0"}
        >
          {mark.label}
        </text>
      )}
    </svg>
  );
}
