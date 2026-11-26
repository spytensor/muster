// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { DraftScope, DraftsProvider, MailDraftCard, useDraftCards } from "./drafts";

vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});

/** What the server says of the conversation's drafts; a test changes it and has the page read again. */
const server = {
  sending: { allowed: true, connected: true, mail: true, teams: true, account: "mia@acme.test" },
  drafts: [] as unknown[],
};
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path.endsWith("/drafts")) return structuredClone(server);
    return {};
  }),
}));

const MESSAGE = "11111111-1111-4111-8111-111111111111";
let cards: ReturnType<typeof useDraftCards> = [];
function Listed() {
  cards = useDraftCards();
  return null;
}
const page = () =>
  render(
    <I18nProvider>
      <DraftsProvider conversation="c1" beat={0}>
        <DraftScope.Provider value={{ messageId: MESSAGE, outside: false, superseded: false }}>
          <MailDraftCard
            props={{ to: ["lei@acme.test"], cc: [], subject: "Quote", body: "First words." }}
          />
        </DraftScope.Provider>
        <Listed />
      </DraftsProvider>
    </I18nProvider>,
  );
const again = () =>
  act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });

afterEach(() => {
  cleanup();
  server.drafts = [];
});

describe("a draft whose sending is not known (CHA-269)", () => {
  it("shows what was submitted, not what the agent first wrote, on the card and beside it", async () => {
    page();
    await again();
    // The page as read anew: the agent's words, waiting to be sent.
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("lei@acme.test");
    expect(cards).toMatchObject([{ status: "unsent" }]);
    const key = (cards[0]?.id ?? "").slice(`draft-${MESSAGE}-`.length);

    // The person changed who it goes to and what it says, pressed Send, and Microsoft did
    // not say whether it went. The server holds what was submitted.
    server.drafts = [
      {
        messageId: MESSAGE,
        key,
        kind: "mail",
        status: "unknown",
        at: "2026-11-18T01:00:00Z",
        content: { to: ["nora@acme.test"], cc: [], subject: "Quote v2", body: "Changed words." },
      },
    ];
    await again();
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("nora@acme.test");
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Quote v2");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Changed words.");
    expect(screen.getByText("May have been sent")).toBeTruthy();
    // Beside the conversation it is not "not sent": it is the same thing the card says.
    expect(cards).toMatchObject([{ status: "unknown", title: "Quote v2 · nora@acme.test" }]);

    // It turns out not to have gone: the card goes on from what was submitted.
    server.drafts = [];
    await again();
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("nora@acme.test");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Changed words.");
    expect(cards).toMatchObject([{ status: "unsent" }]);
  });
});
