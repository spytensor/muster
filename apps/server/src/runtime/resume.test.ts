import type { AgentMessage } from "@openclaw/agent-core";
import { describe, expect, it } from "vitest";
import { type Kept, resumable } from "./runs.js";

const said = (...calls: string[]) =>
  ({
    role: "assistant",
    content: [
      { type: "text", text: "Working." },
      ...calls.map((id) => ({ type: "toolCall", id, name: "docs.write", arguments: {} })),
    ],
  }) as unknown as AgentMessage;
const result = (id: string, text = "ok") =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "docs.write",
    content: [{ type: "text", text }],
    isError: false,
  }) as unknown as AgentMessage;
const kept = (messages: AgentMessage[]) => {
  const json = resumable(messages);
  return json === null ? null : (JSON.parse(json) as Kept).transcript.length;
};

describe("what is kept of a reply that did not finish", () => {
  it("ends on the last result, without what the model was saying when it broke off", () => {
    expect(kept([said("a"), result("a"), said("b"), result("b"), said()])).toBe(4);
    // Nor the agent's own note that the turn was interrupted.
    const note = { role: "custom", content: "<turn_aborted>" } as unknown as AgentMessage;
    expect(kept([said("a"), result("a"), said(), note])).toBe(2);
    // Half a call that was never run is not kept.
    expect(kept([said("a"), result("a"), said("b")])).toBe(2);
  });
  it("keeps what the person added that had not yet been answered", () => {
    const aside = {
      role: "user",
      content: [
        { type: "text", text: "[The person added this while you were working. …]\n\ncc Bob" },
      ],
    } as unknown as AgentMessage;
    // Handed over after the last result, then the model's call failed: it is said again.
    const json = resumable([said("a"), result("a"), aside, said()]) as string;
    const transcript = (JSON.parse(json) as Kept).transcript;
    expect(transcript).toHaveLength(3);
    expect(JSON.stringify(transcript.at(-1))).toContain("cc Bob");
    // Any other words after the last result are still where it broke off.
    const nudge = { role: "user", content: [{ type: "text", text: "[From Muster] go on" }] };
    expect(kept([said("a"), result("a"), nudge as unknown as AgentMessage])).toBe(2);
  });

  it("drops a turn cut off between its calls, with its half of the results", () => {
    expect(kept([said("a"), result("a"), said("b", "c"), result("b")])).toBe(2);
    expect(kept([said("b", "c"), result("b")])).toBeNull();
  });
  it("keeps nothing when nothing was done, or when it is too much to keep", () => {
    expect(kept([])).toBeNull();
    expect(kept([said()])).toBeNull();
    expect(kept([said("a"), result("a", "x".repeat(1_600_000))])).toBeNull();
  });
  it("is text the database can hold: no null character, no half of a pair", () => {
    const json = resumable([said("a"), result("a", `cut \0 here \ud83d`)]) ?? "";
    expect(json).not.toContain("\\u0000");
    expect(json).not.toMatch(/\\ud83d/i);
    expect(json).toContain("cut  here \ufffd");
  });
  it("says a step that changes something and was cut off by a stop has no known outcome", () => {
    const failed = (id: string, toolName: string) =>
      ({ ...result(id, "Operation aborted"), toolName, isError: true }) as unknown as AgentMessage;
    const acts = (tool: string) => tool === "web.send";
    const texts = (messages: AgentMessage[]) =>
      (
        JSON.parse(resumable(messages, { interrupted: acts, skills: ["s1"] }) ?? "{}") as Kept
      ).transcript.map((message) => JSON.stringify(message));
    const after = texts([
      said("a"),
      failed("a", "web.send"),
      said("b", "c"),
      failed("b", "files.read"),
      failed("c", "web.send"),
    ]);
    // An earlier failure is what it was; a read that was cut off can simply be read again.
    expect(after[1]).toContain("Operation aborted");
    expect(after[3]).toContain("Operation aborted");
    expect(after[4]).toContain("Whether it took effect is not known");
    // The skills picked for the message are kept with the work.
    expect(resumable([said("a"), result("a")], { skills: ["s1"] })).toContain('"skills":["s1"]');
  });
});
