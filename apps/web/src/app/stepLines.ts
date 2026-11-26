/** A line of a project's notes that is a step to take: "- [ ] …" or "- [x] …". */
const STEP_LINE = /^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/;

/**
 * How many steps a project's notes still hold as lines of text. The server makes them
 * steps of their own and takes them out of the notes (`stepsInNotes`,
 * apps/server/src/projects.ts); the page only needs to know there are some.
 */
export const stepLinesIn = (notes: string): number =>
  notes.split(/\r?\n/).filter((line) => (line.match(STEP_LINE)?.[2] ?? "").trim()).length;
