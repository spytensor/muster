import { describe, expect, it } from "vitest";
import { AgentId, idTimestamp, isId, newId } from "./ids.js";

describe("newId", () => {
  it("produces a version 7, RFC-variant UUID", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isId(id)).toBe(true);
  });

  it("encodes the creation time, which can be read back", () => {
    const at = Date.UTC(2026, 10, 14, 7, 30, 0, 123);
    expect(idTimestamp(newId(at))).toBe(at);
    expect(idTimestamp(newId(0))).toBe(0);
    expect(idTimestamp(newId(2 ** 48 - 1))).toBe(2 ** 48 - 1);
  });

  it("sorts by creation time", () => {
    const ids = [newId(3000), newId(1000), newId(2000)].sort();
    expect(ids.map(idTimestamp)).toEqual([1000, 2000, 3000]);
  });

  it("does not repeat within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId(1_700_000_000_000)));
    expect(ids.size).toBe(5000);
  });

  it("rejects a timestamp that does not fit in 48 bits", () => {
    expect(() => newId(-1)).toThrow(RangeError);
    expect(() => newId(2 ** 48)).toThrow(RangeError);
    expect(() => newId(1.5)).toThrow(RangeError);
  });
});

describe("isId", () => {
  it("accepts only UUIDv7", () => {
    expect(isId("3f2b8c1e-9d4a-4b7c-8e21-5a6f0c9d1e2b")).toBe(false); // version 4
    expect(isId(newId().toUpperCase())).toBe(false);
    expect(isId("")).toBe(false);
    expect(isId(42)).toBe(false);
    expect(() => idTimestamp("not-an-id")).toThrow(TypeError);
  });

  it("is what the branded schemas enforce", () => {
    expect(AgentId.safeParse(newId()).success).toBe(true);
    expect(AgentId.safeParse("3f2b8c1e-9d4a-4b7c-8e21-5a6f0c9d1e2b").success).toBe(false);
  });
});
