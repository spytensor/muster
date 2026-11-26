import { describe, expect, it } from "vitest";
import { stepLinesIn } from "./stepLines";

describe("steps written in a project's notes", () => {
  it("are counted, ticked or not, whatever ends the lines", () => {
    expect(stepLinesIn("Next\n- [ ] One\n- [x] Two\n* [X] Three\n- not a step")).toBe(3);
    expect(stepLinesIn("- [ ] One\r\n- [ ] Two\r\n")).toBe(2);
    // A box with nothing after it says nothing to do.
    expect(stepLinesIn("- [ ] \n- [ ]")).toBe(0);
    expect(stepLinesIn("")).toBe(0);
  });
});
