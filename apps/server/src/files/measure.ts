/**
 * How wide a text is and how many lines it takes, worked out from the widths of its
 * letters, so that what is drawn under a text begins under it and never on it.
 *
 * A slide is laid out here, not by PowerPoint: every box is given its place before the
 * program that opens the file has measured a word. Until 2026-11-22 a text's height was
 * guessed from how many characters it had; a guess that fell short put one text over the
 * next. The owner, on seeing it: "不能出现文字重叠，这是最基本的".
 *
 * The widths are those of Helvetica, which Arial and Liberation Sans are drawn to match,
 * in thousandths of the type's size, for the characters from the space to the tilde.
 * Everything here errs on the side of taking more room: a text measured too wide leaves
 * a little space, one measured too narrow overlaps.
 */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters set a full square wide: Chinese, Japanese and Korean, and their punctuation. */
const SQUARE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/;
/** Whether a text holds Chinese, Japanese or Korean, and is set in a font that has them. */
export const hasSquare = (text: string) => SQUARE.test(text);

/**
 * How wide one character is, in parts of the type's size. `square` says the text is set
 * in a Chinese font, whose Latin letters are wider than Arial's and in which every other
 * character (a dash, an arrow, a circled number, a star) is a full square.
 *
 * What is not known for certain is taken at its widest: a text measured too wide leaves
 * a little room, one measured too narrow stands on the next.
 */
function charWide(ch: string, bold: boolean, square: boolean): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) {
    const wide = ((bold ? BOLD : REGULAR)[code - 32] as number) / 1000;
    // The Latin of a Chinese font (YaHei, PingFang) runs about a tenth wider than Arial.
    return square ? wide * 1.12 : wide;
  }
  if (square || SQUARE.test(ch) || code > 0xffff) return 1;
  // Accented Latin: no wider than the widest letters it is built on.
  if (code >= 0xa0 && code <= 0x24f) return bold ? 0.78 : 0.74;
  // Greek and Cyrillic: their capitals (Ж, Ш, Щ, Ю) run to 0.94.
  if (code >= 0x370 && code <= 0x52f) return 0.95;
  // Typographic quotation marks and the hyphen; the en dash and daggers; the rest
  // (em dash, bar, ellipsis) a full square.
  if (code >= 0x2010 && code <= 0x2027) {
    if (code === 0x2010 || code === 0x2011 || (code >= 0x2018 && code <= 0x201f)) return 0.45;
    if (code === 0x2012 || code === 0x2013 || code === 0x2020 || code === 0x2021) return 0.6;
    return 1;
  }
  // Arrows, stars, circled numbers, other scripts: a full square.
  return 1;
}

/** Marks that never begin a line: the character before them comes down with them. */
const CLOSES = /[，。、；：！？）》」』】〉”’,.;:!?)\]}%…]/;
/** Marks that never end a line: they go down with what follows. */
const OPENS = /[（《「『【〈“‘([{]/;

/** How wide a text is on one line, in inches. */
export function textWide(text: string, size: number, bold = false, square = false): number {
  let parts = 0;
  for (const ch of text) parts += charWide(ch, bold, square);
  return (parts * size) / 72;
}

/**
 * How many lines a text takes in a box so many inches wide, wrapped as a program that
 * opens the file wraps it. Words are kept whole where they fit; a long address or a
 * hyphenated word breaks after "/", "-", "?", "&" or "=", and anywhere only when a piece
 * is longer than a line; Chinese breaks between any two characters, but a closing mark
 * never begins a line and an opening one never ends it. A line given in the text ends
 * there.
 */
export function linesOf(
  text: string,
  size: number,
  wide: number,
  bold = false,
  square = false,
): number {
  // A little is held back: a program that measures a hair wider wraps a word sooner.
  const room = Math.max(0.2, wide * 0.97) * (72 / size);
  const measure = (piece: string) => {
    let need = 0;
    for (const ch of piece) need += charWide(ch, bold, square);
    return need;
  };
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines += 1;
    let used = 0;
    // What was last put on the line, and how wide: it may have to come down.
    let last = "";
    let lastWide = 0;
    // Spaces, square characters each on their own, and runs of the rest cut after the
    // marks a long word may break at.
    const tokens =
      paragraph.match(
        /\s+|[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[^\s\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF/\-?&=]*[/\-?&=]+|[^\s\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF/\-?&=]+/gu,
      ) ?? [];
    for (const token of tokens) {
      const need = measure(token);
      if (/^\s+$/.test(token)) {
        // A space at the end of a line takes no room on the next.
        if (used > 0 && used + need <= room) used += need;
        last = "";
        continue;
      }
      if (used + need <= room) {
        used += need;
        last = token;
        lastWide = need;
        continue;
      }
      if (need <= room) {
        lines += 1;
        // A closing mark takes the character before it down with it; so does what
        // follows an opening mark.
        const carried =
          last && (CLOSES.test(token[0] as string) || OPENS.test(last[last.length - 1] as string))
            ? lastWide
            : 0;
        used = Math.min(room, carried + need);
        last = token;
        lastWide = need;
        continue;
      }
      // A piece longer than a line: broken wherever the line ends.
      for (const ch of token) {
        const one = charWide(ch, bold, square);
        if (used + one > room && used > 0) {
          lines += 1;
          used = 0;
        }
        used += one;
      }
      last = "";
    }
  }
  return Math.max(1, lines);
}
