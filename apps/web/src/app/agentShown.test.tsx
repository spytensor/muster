// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { api } from "@/lib/api";
import type { AppAgent, Step } from "./api";
import { Composer, StepRow } from "./Chat";

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

/**
 * The general agent is kept as "Assistant" and shown as Muster (lib/agentName.ts). These
 * hold the two places a person calls it and reads of it in a conversation: the "@" list
 * with its chip, and the row of a step another agent passed to it.
 */
const agent = (over: Partial<AppAgent>): AppAgent =>
  ({
    id: "a",
    name: "Assistant",
    description: "",
    source: "platform",
    risk: "R1",
    state: "published",
    instructions: "",
    tools: [],
    mine: null,
    ...over,
  }) as AppAgent;

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

describe("the general agent, where a person calls it and reads of it", () => {
  it("is found by @ under the name it is shown by, and its chip says Muster; a person's own Assistant keeps its name", async () => {
    vi.mocked(api).mockImplementation(async (path: string) =>
      path === "/api/app/agents"
        ? {
            agents: [
              agent({ id: "general" }),
              agent({ id: "mine", source: "user", description: "My own." }),
              agent({ id: "r", name: "Researcher" }),
            ],
          }
        : [],
    );
    render(
      <I18nProvider>
        <Composer
          placeholder="Message"
          disabled={false}
          running={false}
          onSend={async () => true}
        />
      </I18nProvider>,
    );
    const box = screen.getByPlaceholderText("Message");
    await act(async () => {
      fireEvent.change(box, { target: { value: "@mus" } });
    });
    // Only the general agent answers to "@mus", and it is listed as Muster.
    const offered = await screen.findAllByText("Muster");
    expect(offered.length).toBeGreaterThan(0);
    expect(screen.queryByText("Researcher")).toBeNull();
    await act(async () => {
      fireEvent.click(offered[0] as HTMLElement);
    });
    // Called: the chip beside the message says who, by the same name.
    expect(screen.getByText("Muster")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();

    // The name it is kept under finds it too, beside the person's own agent of that name,
    // which is listed as what it is called.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message"), { target: { value: "@assi" } });
    });
    expect((await screen.findAllByText("Assistant")).length).toBe(1);
    expect(screen.getAllByText("Muster").length).toBeGreaterThan(1);
  });

  it("reads who a passed step was done by as the server names it", () => {
    const step: Step = {
      id: "s1",
      tool: "web.fetch",
      status: "ok",
      detail: "example.com/page",
      ms: 12,
      by: "Muster",
    };
    render(
      <I18nProvider>
        <ul>
          <StepRow step={step} />
        </ul>
      </I18nProvider>,
    );
    expect(screen.getByText("Muster")).toBeTruthy();
    expect(screen.getByText("example.com/page")).toBeTruthy();
  });
});
