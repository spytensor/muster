/**
 * Puts right what models most often get wrong in Mermaid source, so that a diagram with
 * one slip is drawn and not shown as its source (the owner, 2026-11-22, of a reply whose
 * flowchart came out as eight lines of code). Tried only after the source as written has
 * failed to parse; what it cannot put right is still not drawn.
 *
 * It must never draw something other than what was meant: a diagram that looks right and
 * is wrong is worse than one not drawn. So an arrow is folded into a node's label only
 * when what follows it cannot be a node.
 */
const BREAK = String.raw`(?:\\n|<br\s*\/?>)`;
const AFTER_NODE = new RegExp(String.raw`([\])}])\s*${BREAK}\s*(-{2,}>?)\s*([^\n]*)$`);
/** What may follow an arrow as the node it goes to: a name, perhaps with a shape, or more arrows. */
const TARGET = /^[A-Za-z_][\w-]*\s*(?:[[({>]|$)|-->|---|==>|-\.->|\|/;
/** The parts of a line that are labels: in brackets, in quotes, or on an arrow between bars. */
const LABELS = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|"[^"]*"|\|[^|]*\|/g;

export function repairDiagram(code: string): string {
  return (
    code
      // Fences, which the schema says to leave out and models add anyway.
      .replace(/^\s*```(?:mermaid)?\s*\n?/i, "")
      .replace(/\n?\s*```\s*$/, "")
      .split("\n")
      .map((line) => {
        // A subgraph's own line is not a node with an arrow after it.
        const fixed = /^\s*subgraph\b/.test(line)
          ? line
          : line.replace(AFTER_NODE, (_all, close: string, arrow: string, rest: string) => {
              const words = rest.trim();
              // A line break written before a real arrow ("A[x]\n--> B[y]"): the break
              // goes, the arrow and where it leads stay.
              if (!words || TARGET.test(words)) return `${close} ${arrow} ${words}`.trimEnd();
              // An arrow to nowhere, written after a node as if it were the rest of its
              // label ("A[Cut X]\n--> how much is left?"): the words become a second
              // line of the label, the arrow is dropped.
              return `<br/>${words.replace(/["[\](){}|]/g, "")}${close}`;
            });
        // A line break written as the two characters \n: in a label it is <br/>.
        return fixed.replace(LABELS, (label) => label.replace(/\\n/g, "<br/>"));
      })
      .join("\n")
  );
}
