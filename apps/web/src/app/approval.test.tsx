// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { api } from "@/lib/api";
import type { Approval } from "./api";
import { ApprovalCard } from "./approval";

vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(async () => ({})),
}));

const asking = (tool: string, why?: string): Approval => ({
  id: "a1",
  tool,
  level: "A3",
  status: "pending",
  requestedAt: new Date().toISOString(),
  summary: {
    destination: "notes.md",
    method: "",
    contentType: "text/plain",
    bytes: 4,
    preview: "text",
    ...(why ? { why } : {}),
  },
});
const OFFER = /stop asking for this here/i;
const card = (approval: Approval, onAskLess?: () => Promise<void>) =>
  render(
    <I18nProvider>
      <ApprovalCard approval={approval} agentName="Muster" onAskLess={onAskLess} />
    </I18nProvider>,
  );
const allow = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  });
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("muster.locale", "en");
});
afterEach(cleanup);

describe("the confirmation card teaches modes (Q-3)", () => {
  it("offers to stop asking the third time the same kind is allowed", async () => {
    const askLess = vi.fn(async () => undefined);
    for (const _ of [1, 2]) {
      card(asking("local.write"), askLess);
      expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
      await allow();
      cleanup();
    }
    card(asking("local.write"), askLess);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: OFFER }));
    });
    expect(askLess).toHaveBeenCalledOnce();
    expect(api).toHaveBeenLastCalledWith("/api/app/approvals/a1", {
      method: "POST",
      body: { decision: "approve" },
    });
  });

  it("does not offer it where the mode would change nothing", () => {
    localStorage.setItem("muster.allowed", JSON.stringify({ "local.exec": 5, "web.send": 5 }));
    // Sending asks in every mode.
    card(asking("web.send"), async () => undefined);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
    cleanup();
    // A command that asks whatever the mode says why.
    card(asking("local.exec", "It deletes files."), async () => undefined);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
    cleanup();
    // A conversation that cannot move up is given no way to.
    card(asking("local.exec"));
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });
});
