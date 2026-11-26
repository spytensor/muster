import { z } from "zod";

/**
 * Characters that make a name read as something it is not: line breaks and other control
 * characters, characters that cannot be seen, and those that turn the direction of the
 * text around so that "txt.exe" reads "exe.txt".
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is looked for
export const MISLEADING = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/;

/** Full-width letters and digits, as people type them by accident with a Chinese keyboard. */
const WIDE = /[０-９Ａ-Ｚａ-ｚ]/g;
const narrow = (text: string) =>
  text.replace(WIDE, (letter) => String.fromCharCode(letter.charCodeAt(0) - 0xfee0));

/**
 * A name a person gives something: one line of ordinary characters. Full-width letters
 * and digits are kept as the ordinary ones, so "Ａssistant" and "Assistant" are one name;
 * full-width punctuation, which Chinese names use on purpose, is left as written.
 */
export const plainName = (max: number) =>
  z
    .string()
    .transform((name) => narrow(name).trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((name) => !MISLEADING.test(name)),
    );

/** Letters of other alphabets that look like Latin ones, as the Latin ones. */
const LOOKALIKE: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  ο: "o",
  α: "a",
  ν: "v",
  ρ: "p",
};
/** The text as a pattern should read it: full-width forms folded, look-alike letters made plain. */
export const plain = (text: string) =>
  text.normalize("NFKC").replace(/[Ѐ-ӿͰ-Ͽ]/g, (letter) => LOOKALIKE[letter] ?? letter);

/** A name as it is compared with another: look-alike letters made plain, case and spacing set aside. */
export const sameAs = (name: string) => plain(name).toLowerCase().replace(/\s+/g, " ").trim();
