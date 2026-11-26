import { z } from "zod";

/** A SHA-256 digest as 64 lowercase hex characters. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest");
export type Sha256 = z.infer<typeof Sha256>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Serializes a value so that equal values always produce the same text: object keys
 * are sorted and there is no whitespace. Values JSON cannot represent exactly
 * (undefined, array holes, NaN, Infinity, functions, bigint) are rejected instead of
 * dropped, because a digest over silently altered input would be meaningless.
 *
 * Keys sort by UTF-16 code unit and numbers print in JavaScript's shortest
 * round-trip form, which is what RFC 8785 (JCS) specifies. A verifier written in
 * another language must follow RFC 8785 to reproduce these digests.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

function normalize(value: unknown, path: string): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    // An index loop, not map(): map() skips holes and JSON would print them as null.
    const out: Json[] = [];
    for (let i = 0; i < value.length; i++) out.push(normalize(value[i], `${path}[${i}]`));
    return out;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`not a plain object at ${path}`);
    }
    // No prototype: assigning the key "__proto__" to a normal object would set its
    // prototype and the key would vanish from the output.
    const out: { [key: string]: Json } = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`cannot canonicalize ${typeof value} at ${path}`);
}

export async function sha256Hex(text: string): Promise<Sha256> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest of a value's canonical form. Use it to record arguments without storing them. */
export function digestOf(value: unknown): Promise<Sha256> {
  return sha256Hex(canonicalJson(value));
}
