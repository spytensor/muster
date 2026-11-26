/**
 * What a "run code" step asked for, laid out for a person: the code as code, not as one
 * long line inside quotes. What is kept of a step is cut at a length, so the request may
 * stop mid-way; the code is then shown as far as it was kept.
 */
export interface RanCode {
  language: "python" | "shell";
  code: string;
  files: string[];
  keep: string[];
  /** The code was longer than what is kept of a step. */
  cut: boolean;
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];

export function ranCode(asked: string): RanCode | null {
  try {
    const value = JSON.parse(asked) as Record<string, unknown>;
    if (!value || typeof value.code !== "string") return null;
    return {
      language: value.language === "shell" ? "shell" : "python",
      code: value.code,
      files: names(value.files),
      keep: names(value.keep),
      cut: false,
    };
  } catch {
    // Cut short: take the code from where it begins to where what was kept ends.
    const at = asked.indexOf('"code":"');
    if (at === -1) return null;
    let raw = asked.slice(at + 8);
    const end = raw.search(/(?<!\\)(?:\\\\)*"/);
    const whole = end !== -1;
    if (whole) raw = raw.slice(0, raw.indexOf('"', end));
    // An escape cut in half is not one: a "\u" short of its four digits, or a lone
    // backslash at the end (an odd number of them; an even number is whole pairs).
    raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, (cut, at: number) =>
      (raw.slice(0, at).match(/\\*$/)?.[0].length ?? 0) % 2 === 0 ? "" : cut,
    );
    if ((raw.match(/\\*$/)?.[0].length ?? 0) % 2 === 1) raw = raw.slice(0, -1);
    let code: string;
    try {
      code = JSON.parse(`"${raw}"`) as string;
    } catch {
      return null;
    }
    return {
      language: /"language":"shell"/.test(asked) ? "shell" : "python",
      code,
      files: [],
      keep: [],
      cut: !whole,
    };
  }
}

/** The last few lines of what a running step printed: what fits under its row. */
export const lastLines = (said: string, most = 6) =>
  said.trimEnd().split("\n").slice(-most).join("\n");
