import type { AgentMessage } from "@openclaw/agent-core";
import { describe, expect, it } from "vitest";
import { measureContext, partOf } from "./context.js";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;
const said = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const result = (text: string) =>
  ({ role: "toolResult", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;

/** What an asking of the model is made of, by part (docs/design/context-panel.md). */
describe("measureContext", () => {
  it("sorts the instructions' pieces by what they are", () => {
    expect(partOf("These skills apply to this work.")).toBe("skills");
    expect(partOf("What the person has asked to be remembered, …")).toBe("memory");
    expect(partOf("The project's notes, kept from …")).toBe("project");
    expect(partOf('The repository "web" names the commands …')).toBe("project");
    expect(partOf("You are an assistant.")).toBe("instructions");
  });

  it("counts the earlier messages and the person's words as the conversation, the rest as this reply's work", () => {
    const earlier = user("An earlier question that is long enough to count.");
    const parts = measureContext({
      promptParts: ["You are an assistant.", "These skills apply: write well."],
      tools: [{ name: "local.read", description: "Read a file.", parameters: { type: "object" } }],
      skillCount: 1,
      memoryCount: 0,
      shown: [
        earlier,
        user("Fix the total."),
        said("Reading it."),
        result("x".repeat(3000)),
        user("[From Muster, not from the person] The checks failed."),
      ],
      history: new Set([earlier]),
    });
    expect(parts.instructions).toBeGreaterThan(0);
    expect(parts.skills).toBeGreaterThan(0);
    expect(parts.tools).toBeGreaterThan(0);
    expect(parts.toolCount).toBe(1);
    expect(parts.work).toBeGreaterThan(parts.conversation);
    expect(parts.conversation).toBeGreaterThan(0);
  });
});
