/**
 * What a step's tool is called on a line. Muster's own tools have names in the language
 * files. A tool of one of the company's connectors (`company.<connector>.<tool>`, an MCP
 * server's among them) has none: it is named by the connector and the tool as the company
 * set them up, with the dashes of an identifier read as spaces.
 */
export function toolLabel(
  names: Record<string, string>,
  tool: string,
  connector: (name: string, action: string) => string,
): string {
  const known = names[tool];
  if (known) return known;
  if (tool.startsWith("company.")) {
    const [, name = "", ...rest] = tool.split(".");
    const words = (text: string) => text.replace(/[_-]+/g, " ").trim();
    return connector(words(name), words(rest.join(" ")));
  }
  return tool;
}

/** How much of what went in was read from the model's cache; a dash when nothing went in. */
export const hitRate = (sums: { inputTokens?: number; cachedTokens?: number }): string =>
  sums.inputTokens && sums.inputTokens > 0
    ? `${Math.round(((sums.cachedTokens ?? 0) / sums.inputTokens) * 100)}%`
    : "–";

/** How far a project's steps have got: how many, how many done, and the share as 0..1. */
export function progressOf(steps: readonly { state: string }[]): {
  total: number;
  done: number;
  share: number;
} {
  const done = steps.filter((step) => step.state === "done").length;
  return { total: steps.length, done, share: steps.length ? done / steps.length : 0 };
}
