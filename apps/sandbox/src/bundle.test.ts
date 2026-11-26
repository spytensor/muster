import { describe, expect, it } from "vitest";
import { BadBundle, frames, pack, safePath, unpack } from "./bundle.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
/** One entry as it stands in a stream, with whatever name and length are wanted. */
const entry = (name: string, content: Uint8Array, claimed = content.length) => {
  const named = bytes(name);
  const head = new Uint8Array(2 + named.length + 4);
  const view = new DataView(head.buffer);
  view.setUint16(0, named.length);
  head.set(named, 2);
  view.setUint32(2 + named.length, claimed);
  return join(head, content);
};
const MAGIC = bytes("MSB1");
const END = new Uint8Array(2);

describe("a working folder's files as one stream", () => {
  it("come out as they went in: long Chinese names, folders, empty files", () => {
    const files = [
      { name: "a.txt", bytes: bytes("hello") },
      // 43 characters, 123 bytes: more than a tar name holds, and an ordinary name here.
      {
        name: "二〇二六年第三季度华东大区销售明细与回款情况汇总表（含退货与折让）最终版.csv",
        bytes: bytes("a,b\n1,2\n"),
      },
      { name: `${"深/".repeat(40)}报告.csv`, bytes: new Uint8Array(1500).fill(7) },
      { name: "empty", bytes: new Uint8Array() },
    ];
    expect(unpack(pack(files))).toEqual(files);
  });

  it("is handed on piece by piece, a file's content as it is", () => {
    const content = new Uint8Array(1000).fill(1);
    const pieces = [...frames([{ name: "big.bin", bytes: content }])];
    expect(pieces.some((piece) => piece === content)).toBe(true);
  });

  it("gives views into the stream, not copies", () => {
    const stream = pack([{ name: "a", bytes: bytes("hello") }]);
    expect(unpack(stream)[0]?.bytes.buffer).toBe(stream.buffer);
  });

  it("refuses the whole stream when one thing in it is not as it should be", () => {
    const good = entry("a.txt", bytes("hello"));
    expect(unpack(join(MAGIC, good, END))).toHaveLength(1);
    const refused = (stream: Uint8Array, why: RegExp) => expect(() => unpack(stream)).toThrow(why);
    refused(join(bytes("XXXX"), good, END), /not a stream/);
    for (const name of ["../../etc/passwd", "/etc/passwd", "a/../b", "a\\b", "a\nb", "x/"])
      refused(join(MAGIC, good, entry(name, bytes("x")), END), /not a name/);
    refused(join(MAGIC, good, good, END), /twice/);
    // A file where another file's folder is: one of them could not be written.
    refused(
      join(MAGIC, entry("a", bytes("x")), entry("a/b", bytes("y")), END),
      /both a file and a folder/,
    );
    refused(
      join(MAGIC, entry("a/b", bytes("y")), entry("a", bytes("x")), END),
      /both a file and a folder/,
    );
    // A length that runs past the end; no end; something after the end.
    refused(join(MAGIC, entry("a", bytes("x"), 5000), END), /short/);
    refused(join(MAGIC, good), /short/);
    refused(join(MAGIC, good, END, bytes("more")), /after the end/);
    refused(join(MAGIC, good, END, new Uint8Array(1)), /after the end/);
    // A name that is not text.
    refused(join(MAGIC, join(Uint8Array.from([0, 2, 0xff, 0xfe, 0, 0, 0, 0])), END), /not text/);
    expect(() => unpack(join(MAGIC, good, entry("b", bytes("x")), END), 1)).toThrow(/too many/);
  });

  it("refuses to write a name no file may have", () => {
    expect(() => pack([{ name: "../x", bytes: bytes("") }])).toThrow(BadBundle);
  });

  it("knows which names a file in a working folder may have", () => {
    for (const ok of [
      "a.txt",
      "out/chart.png",
      "数据/一.csv",
      ".hidden",
      "a b.txt",
      "测".repeat(85),
    ])
      expect(safePath(ok)).toBe(ok);
    for (const bad of [
      "",
      "/a",
      "a/",
      "../a",
      "a/../b",
      "a//b",
      "./a",
      "a\\b",
      "a\nb",
      "a\0b",
      "测".repeat(86), // 258 bytes in one part
      `${"ab/".repeat(134)}c`, // 403 bytes in all
    ])
      expect(safePath(bad)).toBeNull();
  });
});
