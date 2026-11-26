import { describe, expect, it } from "vitest";
import { chosen, type NamedRepo } from "@/pages/CodeHostCard";
import { edited, httpsOnly, lineKind } from "./CloudWork";

describe("work on a repository in the sandbox", () => {
  it("shows a diff's lines for what they are", () => {
    expect(
      ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " same", "-out", "+in", ""].map(lineKind),
    ).toEqual(["at", "at", "at", "same", "cut", "add", "same"]);
  });

  it("links only to an https address", () => {
    expect(httpsOnly("https://github.com/acme/web/pull/7")).toBe(
      "https://github.com/acme/web/pull/7",
    );
    for (const url of ["javascript:alert(1)", "http://github.com/x", "data:text/html,x", "nope"])
      expect(httpsOnly(url)).toBeNull();
  });

  it("sends the person's own title and words only where they changed them", () => {
    const proposal = { title: "Fix the total", body: "It subtracted." };
    expect(edited(proposal, { title: "Fix the total ", body: "It subtracted.\n" })).toEqual({});
    expect(edited(proposal, { title: "Fix totals", body: "It subtracted." })).toEqual({
      title: "Fix totals",
    });
    expect(edited(proposal, { title: "Fix the total", body: "Fixes #12, cc @dana" })).toEqual({
      body: "Fixes #12, cc @dana",
    });
  });

  it("names repositories one at a time: for whom, from which branches, and whether CI may be changed", () => {
    let named: NamedRepo[] = [];
    named = chosen(named, "acme/web", { on: true });
    named = chosen(named, "acme/api", { on: true });
    // Newly named: for everyone, from the main branch only, CI not to be changed.
    expect(named).toEqual([
      { name: "acme/web", departments: [], branches: [], workflows: false },
      { name: "acme/api", departments: [], branches: [], workflows: false },
    ]);
    named = chosen(named, "acme/web", { department: "d1" });
    named = chosen(named, "acme/web", { branches: "release/1, develop  next" });
    named = chosen(named, "acme/web", { workflows: true });
    expect(named).toEqual([
      { name: "acme/api", departments: [], branches: [], workflows: false },
      {
        name: "acme/web",
        departments: ["d1"],
        branches: ["release/1", "develop", "next"],
        workflows: true,
      },
    ]);
    named = chosen(named, "acme/web", { department: "" });
    expect(named.find((repo) => repo.name === "acme/web")).toMatchObject({
      departments: [],
      workflows: true,
    });
    expect(chosen(named, "acme/api", { on: false }).map((repo) => repo.name)).toEqual(["acme/web"]);
  });
});
