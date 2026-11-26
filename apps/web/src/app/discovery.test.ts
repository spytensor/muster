import { describe, expect, it } from "vitest";
import { skillFor } from "./discovery";

const skills = [{ name: "Ranking the three changes" }, { name: "周报格式" }, { name: "Triage" }];

describe("skillFor", () => {
  it("offers a skill the text plainly speaks of", () => {
    expect(skillFor("rank the three biggest changes this month", skills)?.name).toBe(
      "Ranking the three changes",
    );
    expect(skillFor("按周报格式整理一下", skills)?.name).toBe("周报格式");
    expect(skillFor("please triage these tickets", skills)?.name).toBe("Triage");
  });

  it("offers nothing on a loose or short match", () => {
    expect(skillFor("what changed?", skills)).toBeNull();
    expect(skillFor("the", skills)).toBeNull();
    expect(skillFor("帮我写周报", skills)).toBeNull();
  });
});
