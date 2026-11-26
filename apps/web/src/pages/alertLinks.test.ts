import { describe, expect, it } from "vitest";
import { evidenceOf } from "./alertLinks";

describe("where an alert's evidence is", () => {
  it("is the page that already shows it, filtered to what the rule counted", () => {
    expect(evidenceOf({ rule: "run_failures", subject: "", detail: { window: 60 } })).toBe(
      "traces?status=error&range=1h",
    );
    expect(
      evidenceOf({ rule: "model_failing", subject: "test-model", detail: { window: 15 } }),
    ).toBe("traces?status=error&range=15m");
    expect(
      evidenceOf({
        rule: "blocked_actions",
        subject: "user:1",
        detail: { window: 720, email: "may+x@acme.test" },
      }),
    ).toBe("traces?status=blocked&range=12h&user=may%2Bx%40acme.test");
    expect(
      evidenceOf({ rule: "blocked_actions", subject: "agent:abc", detail: { window: 1440 } }),
    ).toBe("traces?status=blocked&range=24h&agent=abc");
    expect(evidenceOf({ rule: "spend_spike", subject: "", detail: {} })).toBe("usage");
    expect(evidenceOf({ rule: "approval_waiting", subject: "agent:abc", detail: {} })).toBe(
      "market",
    );
    expect(evidenceOf({ rule: "sandbox_down", subject: "", detail: {} })).toBe("sandbox");
    expect(evidenceOf({ rule: "audit_chain_broken", subject: "", detail: {} })).toBe("audit");
  });
});
