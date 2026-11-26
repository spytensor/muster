import { describe, expect, it } from "vitest";
import { lockedPage, PAGE_POLICY } from "./page";

describe("a page someone else wrote, as it is shown", () => {
  it("is put under a policy that lets it load nothing and run nothing", () => {
    const shown = lockedPage(
      '<script>fetch("/api/app/me")</script><img src="https://x.test/a.png">',
    );
    // The policy comes before anything of the page's, so nothing of the page's is read first.
    expect(shown.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(PAGE_POLICY).toContain("default-src 'none'");
    // No script source, no connection, no frame, no form target is allowed by it.
    for (const allowed of ["script-src", "connect-src", "frame-src", "form-action", "http"])
      expect(PAGE_POLICY).not.toContain(allowed);
    // Pictures and fonts only as data the page carries.
    expect(PAGE_POLICY).toContain("img-src data:");
  });
});
