import { describe, expect, it } from "vitest";
import { shortOf } from "./hint";

describe("a line of explanation", () => {
  it("is shown whole when it is short", () => {
    expect(shortOf("Your own systems that agents can reach.")).toEqual({
      line: "Your own systems that agents can reach.",
      more: false,
    });
    expect(shortOf("  Agent 只读。 ")).toEqual({ line: "Agent 只读。", more: false });
  });

  it("shows its first sentence when it is long, and keeps the rest behind the mark", () => {
    const long =
      "What needs attention. The rules below are checked every minute, and an alert closes by itself once what it is about is no longer so.";
    expect(shortOf(long)).toEqual({ line: "What needs attention.", more: true });
    // A Chinese character is as wide as two Latin ones: thirty of them are a line.
    const zh =
      "需要关注的事。每分钟检查一次规则，情况解除后告警会自动关闭，并通知所有者和管理员，也可以同时发到你设置的地址。";
    expect(shortOf(zh)).toEqual({ line: "需要关注的事。", more: true });
  });

  it("is cut by the page, not mid-word here, when even its first sentence is long", () => {
    const one =
      "A public https address that speaks MCP over Streamable HTTP, like https://mcp.example.com/mcp, with nothing secret in it.";
    expect(shortOf(one)).toEqual({ line: one, more: true });
    // A full stop inside an address or a number does not end a sentence.
    expect(shortOf(`See https://mcp.example.com/mcp for how. ${"x".repeat(80)}`).line).toBe(
      "See https://mcp.example.com/mcp for how.",
    );
  });
});
