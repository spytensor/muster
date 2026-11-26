import { useColorScheme } from "react-native";

/**
 * The app's colours, to the app's design standard (CHA-260): a pure white
 * or pure black page, flat opaque surfaces with hairline borders, black-and-white primary
 * actions, and one accent used only as a small mark (a link, a selection, a dot). Colour
 * says what something is (waiting, wrong, done); nothing is coloured for decoration.
 */
export interface Colors {
  dark: boolean;
  /** The page itself. */
  page: string;
  /** Cards and grouped lists. */
  card: string;
  /** A step above a card: a pressed row, a callout, a chip. */
  soft: string;
  text: string;
  /** Secondary text. */
  muted: string;
  /** Placeholders and the smallest notes. */
  faint: string;
  /** The hairline round a card. */
  border: string;
  /** The hairline between rows. */
  separator: string;
  /** The outline of glass and of an outlined button. */
  outline: string;
  /** The person's own message. */
  bubble: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  primary: string;
  onPrimary: string;
  warn: string;
  warnSoft: string;
  warnBorder: string;
  bad: string;
  badSoft: string;
  ok: string;
  okSoft: string;
}

const light: Colors = {
  dark: false,
  page: "#ffffff",
  card: "#f7f7f8",
  soft: "#f1f1f3",
  text: "#0d0d0d",
  muted: "#666970",
  faint: "#6b6f78",
  border: "rgba(0,0,0,0.08)",
  separator: "rgba(0,0,0,0.12)",
  outline: "rgba(0,0,0,0.12)",
  bubble: "#f1f1f3",
  accent: "#5b7cfa",
  accentText: "#2f4fd0",
  accentSoft: "#eef1ff",
  primary: "#000000",
  onPrimary: "#ffffff",
  warn: "#8a6100",
  warnSoft: "#fdf6e9",
  warnBorder: "#efd9ae",
  bad: "#c52b24",
  badSoft: "#fdefed",
  ok: "#167960",
  okSoft: "#eaf6ef",
};

const dark: Colors = {
  dark: true,
  page: "#000000",
  card: "#1a1d22",
  soft: "#22262c",
  text: "#ffffff",
  muted: "#9aa0a8",
  faint: "#8a9099",
  border: "rgba(255,255,255,0.06)",
  separator: "rgba(255,255,255,0.12)",
  outline: "rgba(255,255,255,0.18)",
  bubble: "#2a2a2c",
  accent: "#9db0ff",
  accentText: "#9db0ff",
  accentSoft: "#1c2340",
  primary: "#ffffff",
  onPrimary: "#000000",
  warn: "#f5c451",
  warnSoft: "#2a2112",
  warnBorder: "#5b4520",
  bad: "#ff5a4e",
  badSoft: "#321715",
  ok: "#5ad1b0",
  okSoft: "#12281c",
};

/** The colours for the appearance in effect (the person's choice, or the system's). */
export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

export const mono = "Menlo";

/**
 * The type scale: the system font, few sizes. `body` is what an agent writes; `secondary`
 * is everything said under or beside something else.
 */
export const type = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  cardTitle: { fontSize: 17, lineHeight: 25, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 25 },
  row: { fontSize: 15, fontWeight: "500" },
  button: { fontSize: 15, fontWeight: "600" },
  secondary: { fontSize: 13, lineHeight: 20 },
  section: { fontSize: 13, fontWeight: "600" },
  meta: { fontSize: 11, lineHeight: 17 },
} as const;

/** Corner radii. Every rounded shape uses the continuous curve. */
export const radius = {
  card: 20,
  input: 18,
  control: 14,
  chip: 12,
  bubble: 22,
  pill: 999,
} as const;
/** Spread into a style with a radius: the system's continuous corner. */
export const curve = { borderCurve: "continuous" } as const;
/** How far a pressed thing fades. Pressing never scales. */
export const PRESSED = 0.7;
