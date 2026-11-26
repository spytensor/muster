/** One element of an XML file: its name as written (with its prefix), attributes, children and own text. */
export interface Xml {
  name: string;
  attrs: Record<string, string>;
  children: Xml[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (value: string) =>
  value.includes("&")
    ? value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, code: string) => {
        if (code[0] !== "#") return ENTITIES[code] ?? whole;
        const point = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
    : value;

/**
 * Reads an XML file into a tree. Enough for the files inside an Office document:
 * elements, attributes and text. Declarations, comments and processing instructions are
 * skipped; entities other than the five built in and numeric ones are left as written,
 * so nothing a file declares is ever expanded.
 */
export function parseXml(source: string): Xml {
  const root: Xml = { name: "", attrs: {}, children: [], text: "" };
  const open: Xml[] = [root];
  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    const top = open[open.length - 1] as Xml;
    if (lt < 0) break;
    if (lt > at) top.text += decode(source.slice(at, lt));
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      at = end < 0 ? source.length : end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      top.text += source.slice(lt + 9, end < 0 ? source.length : end);
      at = end < 0 ? source.length : end + 3;
    } else if (source[lt + 1] === "?" || source[lt + 1] === "!") {
      const end = source.indexOf(">", lt);
      at = end < 0 ? source.length : end + 1;
    } else if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt);
      if (open.length > 1) open.pop();
      at = end < 0 ? source.length : end + 1;
    } else {
      // Read a character at a time, once: a tag's length never costs more than its length.
      let i = lt + 1;
      const space = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
      const word = () => {
        const from = i;
        while (i < source.length) {
          const code = source.charCodeAt(i);
          if (space(code) || code === 61 || code === 62 || code === 47) break;
          i++;
        }
        return source.slice(from, i);
      };
      const node: Xml = { name: word(), attrs: {}, children: [], text: "" };
      let closed = false;
      while (i < source.length) {
        const code = source.charCodeAt(i);
        if (code === 62) break;
        if (code === 47) closed = true;
        if (space(code) || code === 47 || code === 61) {
          i++;
          continue;
        }
        closed = false;
        const name = word();
        while (i < source.length && space(source.charCodeAt(i))) i++;
        if (source.charCodeAt(i) !== 61) continue;
        i++;
        while (i < source.length && space(source.charCodeAt(i))) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== "'") continue;
        const end = source.indexOf(quote, i + 1);
        if (end < 0) {
          i = source.length;
          break;
        }
        // A name that an object already has a meaning for is not taken from a file.
        if (name !== "__proto__") node.attrs[name] = decode(source.slice(i + 1, end));
        i = end + 1;
      }
      top.children.push(node);
      if (!closed) open.push(node);
      at = i + 1;
    }
  }
  return root.children[0] ?? root;
}

/** The first child with this name. */
export const child = (node: Xml | undefined, name: string): Xml | undefined =>
  node?.children.find((c) => c.name === name);
/** Follows child names down from a node. */
export const dig = (node: Xml | undefined, ...names: string[]): Xml | undefined =>
  names.reduce<Xml | undefined>((at, name) => child(at, name), node);
export const all = (node: Xml | undefined, name: string): Xml[] =>
  node?.children.filter((c) => c.name === name) ?? [];
