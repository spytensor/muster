import { describe, expect, it } from "vitest";
import { effectShown, hostsOf, limited } from "./toolRules";

describe("the tool policy page", () => {
  it("shows a tool as allowed where there is no rule, and a department as following everyone", () => {
    const rules = [
      { tool: "web.send", departmentId: null, effect: "off" as const },
      { tool: "web.send", departmentId: "sales", effect: "ask" as const },
    ];
    expect(effectShown(rules, "web.send", null)).toBe("off");
    expect(effectShown(rules, "docs.write", null)).toBe("allow");
    expect(effectShown(rules, "web.send", "sales")).toBe("ask");
    expect(effectShown(rules, "web.send", "legal")).toBe("inherit");
  });

  it("reads sites as host names, however they were pasted", () => {
    expect(
      hostsOf("Example.com\nhttps://docs.example.com/a?b, example.com  intra.test:8443"),
    ).toEqual(["example.com", "docs.example.com", "intra.test"]);
    expect(hostsOf("  ")).toEqual([]);
  });

  it("names the ways a scope is less than everything", () => {
    expect(
      limited({ files: true, mail: true, web: "all", knowledge: "all", connectors: "all" }),
    ).toEqual([]);
    expect(
      limited({ files: false, mail: true, web: ["a.com"], knowledge: "all", connectors: [] }),
    ).toEqual(["files", "web", "connectors"]);
  });
});
