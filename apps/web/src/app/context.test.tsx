// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import { ContextSection, scaled, tokens } from "./context";

afterEach(cleanup);

const parts = {
  instructions: 6000,
  tools: 4000,
  toolCount: 23,
  skills: 0,
  skillCount: 0,
  project: 1000,
  memory: 500,
  memoryCount: 2,
  conversation: 3000,
  work: 10_500,
};

/** The overview's context section (docs/design/context-panel.md). */
describe("the context section", () => {
  it("scales the run's estimates to the provider's count", () => {
    const measure = scaled(parts, 50_000);
    expect(measure.used).toBe(50_000);
    expect(measure.of("work")).toBe(21_000);
    expect(scaled(parts, 0).estimated).toBe(true);
    expect(tokens(1234)).toBe("1.2K");
    expect(tokens(812)).toBe("812");
  });

  it("shows each part, what is kept for the answer, where the next reply starts and the compact button", () => {
    render(
      <I18nProvider>
        <ContextSection
          context={{
            tokens: 50_000,
            window: 128_000,
            compactAt: 80_000,
            nextConversation: 2500,
            parts,
          }}
          conversationId="c"
          running={false}
          messages={12}
          summarisedAt={null}
          onCompacted={() => undefined}
        />
      </I18nProvider>,
    );
    const section = screen.getByRole("region", { name: "Context" });
    expect(section.textContent).toContain("39% used");
    expect(section.textContent).toContain("50K / 128K");
    expect(section.textContent).toContain("Tools · 23");
    expect(section.textContent).toContain("This reply's work");
    expect(section.textContent).toContain("Kept for the answer");
    expect(section.textContent).toContain("30K until compaction");
    // Instructions 12K + tools 8K + project 2K + memory 1K + the conversation as it will be 2.5K.
    expect(section.textContent).toContain("The next reply starts at about 25.5K");
    expect(screen.getByRole("button", { name: "Compact conversation" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("does not offer to compact while a reply is written or with too few messages", () => {
    render(
      <I18nProvider>
        <ContextSection
          context={{ tokens: 0, window: 128_000, parts: { ...parts } }}
          conversationId="c"
          running
          messages={3}
          summarisedAt={null}
          onCompacted={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Compact conversation" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
