// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";
import type { TaskNote } from "@/lib/desktop";
import { TaskLines } from "./code";

vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});

const task = (over: Partial<TaskNote> = {}): TaskNote => ({
  name: "web",
  branch: "muster/fix-the-cart-total-5d51e0",
  base: "main",
  copy: false,
  ahead: 0,
  remote: true,
  pr: null,
  ...over,
});
const pr = (over: Partial<NonNullable<TaskNote["pr"]>> = {}): TaskNote["pr"] => ({
  url: "https://github.com/acme/web/pull/12",
  number: 12,
  state: "OPEN",
  checks: "passing",
  failing: [],
  comments: 0,
  ...over,
});
const show = (note: TaskNote, ask?: (text: string) => void) =>
  render(
    <I18nProvider>
      <TaskLines task={note} ask={ask} />
    </I18nProvider>,
  );
afterEach(cleanup);

describe("undoing a reply's changes", () => {
  it("says before anything changes how many files will, and names the first of them", () => {
    expect(en.app.code.undoFiles(["web/cart.js"])).toBe(
      "Puts back 1 file: web/cart.js. A file changed again since is left as it is.",
    );
    expect(en.app.code.undoFiles(["a", "b", "c", "d", "e", "f"])).toBe(
      "Puts back 6 files: a, b, c, d and 2 more. A file changed again since is left as it is.",
    );
    expect(zh.app.code.undoFiles(["a", "b", "c", "d", "e"])).toContain(
      "将恢复 5 个文件：a、b、c、d",
    );
  });
});

describe("a conversation's work in a repository, in the pane", () => {
  it("names the branch and where it came from, and offers a pull request only once there is something to open one from", () => {
    const ask = vi.fn();
    show(task(), ask);
    expect(screen.getByText("muster/fix-the-cart-total-5d51e0")).toBeTruthy();
    expect(screen.getByText(/from main/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    // Nothing to push to: nothing to press.
    show(task({ ahead: 2, remote: false }), ask);
    expect(screen.getByText("2 commits")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    show(task({ ahead: 2, copy: true }), ask);
    expect(screen.getByText(/in a copy/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open pull request" }));
    // Said to the agent as the person's own message: what leaves the computer is asked about there.
    expect(ask).toHaveBeenCalledWith("Open a pull request for this work.");
  });

  it("shows how the pull request stands, and one button when it needs something", () => {
    const ask = vi.fn();
    show(task({ ahead: 2, pr: pr() }), ask);
    const link = screen.getByRole("link", { name: "Pull request #12" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/pull/12");
    expect(screen.getByText("open · checks passed")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    show(task({ ahead: 2, pr: pr({ checks: "failing", failing: ["test"], comments: 2 }) }), ask);
    expect(screen.getByText("open · checks failed · 2 review comments")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Have it fixed" }));
    expect(ask).toHaveBeenCalledWith(
      "The pull request's checks failed and the pull request has review comments. Look at them, fix what they ask for, commit, and push the fix to the pull request.",
    );
    cleanup();
    // While a reply is being written there is nothing to press; a merged one asks nothing.
    show(task({ ahead: 2, pr: pr({ checks: "failing" }) }));
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    show(task({ pr: pr({ state: "MERGED", checks: "failing", comments: 3 }) }), ask);
    expect(screen.getByText("merged")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
