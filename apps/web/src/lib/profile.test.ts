import { describe, expect, it } from "vitest";
import { signed, unsigned } from "./profile";

const SIGNATURE = "Mia Chen\nFinance, Acme\n+971 50 000 0000";

describe("a mail's signature", () => {
  it("goes under the body once", () => {
    const body = "Hi Lei,\n\nConfirming Wednesday at two.\n";
    const withIt = signed(body, SIGNATURE);
    expect(withIt).toBe(`Hi Lei,\n\nConfirming Wednesday at two.\n\n${SIGNATURE}`);
    expect(signed(withIt, SIGNATURE)).toBe(withIt);
    expect(signed(body, "")).toBe(body);
  });

  it("is taken off what is handed back to an agent, whatever else the person changed", () => {
    // The person fixed a word in the body; the signature is still under it.
    const edited = `Hi Lei,\n\nConfirming Thursday at two.\n\n${SIGNATURE}\n`;
    const back = unsigned(edited, SIGNATURE);
    expect(back).toBe("Hi Lei,\n\nConfirming Thursday at two.");
    expect(back).not.toContain("+971 50 000 0000");
    // A body the person took the signature off, or that never had one, is left as it is.
    expect(unsigned("Hi Lei.", SIGNATURE)).toBe("Hi Lei.");
    expect(unsigned("Hi Lei.", "")).toBe("Hi Lei.");
  });
});
