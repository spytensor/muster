import { describe, expect, it } from "vitest";
import { agentWords, generalOf, shownAgent } from "./agentName";
import { eventTarget } from "./events";

describe("the name an agent is shown by", () => {
  it("shows the general agent as Muster, by what its row says it is", () => {
    expect(shownAgent({ name: "Assistant", source: "platform" })).toBe("Muster");
    expect(shownAgent({ name: "Anything", general: true })).toBe("Muster");
    expect(shownAgent({ name: "Researcher", source: "platform" })).toBe("Researcher");
    // A person's own agent of that name, from before the name was kept, is theirs.
    expect(shownAgent({ name: "Assistant", source: "user" })).toBe("Assistant");
    expect(shownAgent({ name: "Assistant", source: "org" })).toBe("Assistant");
    expect(shownAgent({ name: "Assistant" })).toBe("Assistant");
    expect(shownAgent(null)).toBe("");
    expect(shownAgent(undefined)).toBe("");
  });

  it("is found by the name it is shown by and the one it is kept under", () => {
    const general = { name: "Assistant", source: "platform" };
    expect(agentWords(general).toLowerCase()).toContain("muster");
    expect(agentWords(general).toLowerCase()).toContain("assistant");
    expect(agentWords({ name: "Researcher", source: "platform" })).toBe("Researcher Researcher");
  });

  it("still finds it among the others, and before a person's own of the same name", () => {
    const mine = { name: "Assistant", source: "user" };
    const general = { name: "Assistant", source: "platform" };
    expect(generalOf([{ name: "Researcher", source: "platform" }, mine, general])).toBe(general);
    expect(generalOf([{ name: "Muster", source: "user" }])).toBeUndefined();
  });

  it("names it so in the activity log, for an agent and for an approval of its", () => {
    expect(eventTarget({ targetType: "agent", targetLabel: "Assistant" })).toBe("Muster");
    expect(eventTarget({ targetType: "approval", targetLabel: "Assistant · mail.send" })).toBe(
      "Muster · mail.send",
    );
    expect(eventTarget({ targetType: "approval", targetLabel: "Researcher · web.fetch" })).toBe(
      "Researcher · web.fetch",
    );
    // A person or a file that happens to be called so is not an agent.
    expect(eventTarget({ targetType: "member", targetLabel: "Assistant" })).toBe("Assistant");
    expect(eventTarget({ targetType: null, targetLabel: null })).toBe("");
  });
});
