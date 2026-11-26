import { z } from "zod";

/** RFC 9562 UUID version 7: a 48-bit millisecond timestamp followed by random bits. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_TIMESTAMP = 2 ** 48 - 1;

/**
 * Creates a UUIDv7. IDs made later sort after IDs made earlier (to the millisecond),
 * so a list of IDs is already in creation order.
 */
export function newId(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new RangeError(`timestamp out of range for UUIDv7: ${now}`);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Bytes 0-5: big-endian milliseconds since the Unix epoch.
  let rest = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/** Milliseconds since the Unix epoch at which the ID was created. */
export function idTimestamp(id: string): number {
  if (!isId(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

const id = <Brand extends string>(brand: Brand) =>
  z.string().regex(UUID_V7, `${brand} must be a UUIDv7`).brand(brand);

export const TenantId = id("TenantId");
export const UserId = id("UserId");
export const AgentId = id("AgentId");
export const RunId = id("RunId");
export const StepId = id("StepId");
export const ToolCallId = id("ToolCallId");
export const EventId = id("EventId");

export type TenantId = z.infer<typeof TenantId>;
export type UserId = z.infer<typeof UserId>;
export type AgentId = z.infer<typeof AgentId>;
export type RunId = z.infer<typeof RunId>;
export type StepId = z.infer<typeof StepId>;
export type ToolCallId = z.infer<typeof ToolCallId>;
export type EventId = z.infer<typeof EventId>;
