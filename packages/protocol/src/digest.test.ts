import { describe, expect, it } from "vitest";
import { agentFingerprint } from "./agent.js";
import { canonicalJson, digestOf, sha256Hex } from "./digest.js";

describe("canonicalJson", () => {
  it("is independent of key order, at every depth", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } };
    const b = { a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it("keeps array order, because order there is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("rejects values it cannot represent exactly instead of dropping them", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/\$\.a/);
    expect(() => canonicalJson({ a: [Number.NaN] })).toThrow(/\$\.a\[0\]/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/plain object/);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  it("rejects an array hole instead of printing it as null", () => {
    const holed = new Array(2);
    holed[1] = 1;
    expect(() => canonicalJson(holed)).toThrow(/\$\[0\]/);
    expect(canonicalJson([null, 1])).toBe("[null,1]");
  });

  it("keeps a __proto__ key as data", () => {
    const withProto = JSON.parse('{"x":1,"__proto__":{"evil":true}}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"evil":true},"x":1}');
    expect(canonicalJson(withProto)).not.toBe(canonicalJson({ x: 1 }));
    expect(canonicalJson(JSON.parse('{"__proto__":5}'))).toBe('{"__proto__":5}');
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 test vectors", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes text as UTF-8", async () => {
    // printf '点兵' | shasum -a 256
    expect(await sha256Hex("点兵")).toBe(
      "eb94593d8ba06a043d41c6dd26e67abb48f4cef7007ae7a697101b0b7594c961",
    );
  });
});

describe("agentFingerprint", () => {
  const base = {
    model: "model-a",
    instructions: "Be brief.",
    skills: { search: "a".repeat(64) },
    tools: ["read", "write"],
  };

  it("is stable when nothing that affects behavior changes", async () => {
    const reordered = {
      tools: ["write", "read", "read"],
      skills: { search: "a".repeat(64) },
      instructions: "Be brief.",
      model: "model-a",
    };
    expect(await agentFingerprint(reordered)).toBe(await agentFingerprint(base));
    expect(await agentFingerprint(base)).toBe(
      await digestOf({ ...base, tools: ["read", "write"] }),
    );
  });

  it("changes when the model, instructions, a skill or the tools change", async () => {
    const original = await agentFingerprint(base);
    const variants = [
      { ...base, model: "model-b" },
      { ...base, instructions: "Be brief!" },
      { ...base, skills: { search: "b".repeat(64) } },
      { ...base, skills: { ...base.skills, mail: "c".repeat(64) } },
      { ...base, tools: ["read"] },
      { ...base, tools: ["read", "write", "bash"] },
    ];
    const prints = await Promise.all(variants.map(agentFingerprint));
    expect(new Set([original, ...prints]).size).toBe(variants.length + 1);
  });

  it("rejects a skill named __proto__ instead of dropping it", async () => {
    const skills = JSON.parse(`{"__proto__":"${"d".repeat(64)}"}`);
    await expect(agentFingerprint({ ...base, skills })).rejects.toThrow(/__proto__/);
    await expect(
      agentFingerprint({ ...base, skills: { search: "not-a-digest" } }),
    ).rejects.toThrow();
  });

  it("rejects a definition with unknown fields rather than ignoring them", async () => {
    await expect(agentFingerprint({ ...base, temperature: 1 } as never)).rejects.toThrow();
  });
});
