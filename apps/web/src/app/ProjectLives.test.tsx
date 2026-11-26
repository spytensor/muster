// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { api } from "@/lib/api";
import type { Project, ProjectItem, RepoFacts } from "./api";
import { hostOf, ProjectLives, standingOf } from "./ProjectLives";
import { ProjectPage } from "./ProjectPage";

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
 * What lives in a project, on its page (MUS-59): a kind is there only when the project
 * has some of it, each thing is changed in its place, and the top of the page counts
 * what the repositories say.
 */
const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Payments platform",
  instructions: "Move card settlement to the new ledger by March.\nWrite plainly.",
  updatedAt: "2026-11-24T08:00:00.000Z",
  conversations: 0,
  notes: "",
  notesAt: null,
  notesRev: 0,
  notesBy: null,
  notesEarlier: false,
  steps: 12,
  stepsDone: 5,
  health: null,
  role: "owner",
  owner: null,
  people: 0,
  items: 3,
  repos: 2,
  updateAt: "2026-11-24T06:00:00.000Z",
  ...over,
});
const item = (over: Partial<ProjectItem>): ProjectItem => ({
  id: "i1",
  n: 1,
  kind: "link",
  title: "Board",
  detail: "",
  url: null,
  ref: null,
  file: null,
  state: {},
  position: 1,
  by: "Olivia",
  byAgent: false,
  updatedAt: "2026-11-24T08:00:00.000Z",
  ...over,
});
const ITEMS = [
  item({ id: "r1", n: 1, kind: "repo", title: "acme/ledger-core", ref: "acme/ledger-core" }),
  item({
    id: "r2",
    n: 2,
    kind: "repo",
    title: "acme/settlement-jobs",
    ref: "acme/settlement-jobs",
  }),
  item({
    id: "e1",
    n: 3,
    kind: "environment",
    title: "Production",
    url: "https://pay.acme.test/",
    detail: "Blue-green.",
    state: { version: "v2.14" },
    by: "Muster",
    byAgent: true,
  }),
];
const FACTS: Record<string, RepoFacts> = {
  "acme/ledger-core": { branch: "main", pulls: 2, checks: "passing" },
  "acme/settlement-jobs": { branch: "main", pulls: 1, checks: "failing" },
};

/** The server, as far as this page asks it. What was sent is kept. */
function server(items: ProjectItem[] = ITEMS) {
  const sent: { path: string; method: string; body?: unknown }[] = [];
  vi.mocked(api).mockImplementation(async (path: string, init = {}) => {
    const method = init.method ?? "GET";
    if (method !== "GET") sent.push({ path, method, body: init.body });
    if (path.endsWith("/items") && method === "GET") return { items };
    if (path.endsWith("/repos")) return { facts: FACTS };
    if (path.includes("/library")) return { rows: [] };
    return [];
  });
  return sent;
}
const lives = (over: Partial<Parameters<typeof ProjectLives>[0]> = {}) =>
  render(
    <I18nProvider>
      <ProjectLives
        project={project()}
        conversations={[]}
        adding={null}
        onAdding={() => undefined}
        onPeople={() => undefined}
        onStanding={() => undefined}
        onChange={() => undefined}
        pinned={0}
        {...over}
      />
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

describe("what lives in a project, on its page", () => {
  it("shows the kinds the project has and no other, each thing with what is known of it", async () => {
    server();
    const standing = vi.fn();
    await act(async () => {
      lives({ onStanding: standing });
    });
    expect(screen.getByText("Repositories")).toBeTruthy();
    // The four blocks are always there, whatever the project holds.
    for (const block of ["Repositories", "Guides", "Environments and links", "People"])
      expect(screen.getByText(block)).toBeTruthy();
    // What Muster should know is the first of the guides, so that group is there too.
    expect(screen.getByText("Guides")).toBeTruthy();
    for (const absent of ["Links", "Contacts", "Facts", "Environments"])
      expect(screen.queryByText(absent)).toBeNull();
    expect(screen.getByText("acme/ledger-core")).toBeTruthy();
    expect(screen.getByText("2 PRs")).toBeTruthy();
    expect(screen.getByLabelText("Checks failing")).toBeTruthy();
    expect(screen.getByText("v2.14")).toBeTruthy();
    expect(screen.getByText("Move card settlement to the new ledger by March.")).toBeTruthy();
    // The top of the page is told what the repositories say.
    expect(standing).toHaveBeenLastCalledWith({ repos: 2, failing: 1, pulls: 3 });
  });

  it("changes a thing in its place, moves it among its kind, and removes it", async () => {
    const sent = server();
    await act(async () => {
      lives();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit: Production" }));
    });
    // Who last changed it is said where it is changed, not on its row.
    expect(screen.getByText(/by Muster/)).toBeTruthy();
    const version = screen.getByLabelText("Version now") as HTMLInputElement;
    expect(version.value).toBe("v2.14");
    fireEvent.change(version, { target: { value: "v2.15" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(sent).toEqual([
      {
        path: "/api/app/projects/p1/items/e1",
        method: "PATCH",
        body: {
          title: "Production",
          detail: "Blue-green.",
          url: "https://pay.acme.test/",
          version: "v2.15",
        },
      },
    ]);
    // The second repository goes up; the first cannot go further up.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit: acme/settlement-jobs" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    });
    expect(sent.at(-1)).toEqual({
      path: "/api/app/projects/p1/items/r2",
      method: "PATCH",
      body: { to: 0 },
    });
    expect((screen.getByRole("button", { name: "Move down" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(sent.at(-1)).toEqual({
      path: "/api/app/projects/p1/items/r2",
      method: "DELETE",
      body: undefined,
    });
  });

  it("writes a new thing where its kind is, and a repository by its name on the code host", async () => {
    const sent = server([]);
    const adding = vi.fn();
    await act(async () => {
      lives({ adding: "repo", onAdding: adding });
    });
    expect(screen.getByText("Repositories")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: " acme/web " } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(sent).toEqual([
      {
        path: "/api/app/projects/p1/items",
        method: "POST",
        body: { kind: "repo", title: "", detail: "", url: undefined, ref: "acme/web" },
      },
    ]);
    expect(adding).toHaveBeenLastCalledWith(null);
  });

  it("offers nothing to change to someone who only sees the project, and says so when it is empty", async () => {
    server();
    await act(async () => {
      lives({ project: project({ role: "view", owner: { id: "o", name: "Olivia" } }) });
    });
    expect(screen.queryByRole("button", { name: /^Edit:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add:/ })).toBeNull();
    cleanup();
    server([]);
    await act(async () => {
      lives({
        project: project({ role: "view", instructions: "", owner: { id: "o", name: "Olivia" } }),
      });
    });
    // Each empty block says so in a line, and offers nothing to press.
    expect(screen.getAllByText("Nothing has been put here yet.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Add repository")).toBeNull();
  });

  it("counts what the repositories say, and names an address by where it leads", () => {
    expect(standingOf(ITEMS, FACTS, 1)).toEqual({ repos: 3, failing: 1, pulls: 3 });
    expect(standingOf(ITEMS, {}, 0)).toEqual({ repos: 2, failing: 0, pulls: 0 });
    expect(hostOf("https://www.grafana.acme.test/d/1")).toBe("grafana.acme.test");
    expect(hostOf("not an address")).toBe("");
    expect(hostOf(null)).toBe("");
  });
});

describe("a project's page", () => {
  it("says how it stands at its top, and puts what is happening before what lives in it", async () => {
    server();
    await act(async () => {
      render(
        <I18nProvider>
          <ProjectPage
            project={project()}
            conversations={[]}
            waiting={[]}
            bar={{} as Parameters<typeof ProjectPage>[0]["bar"]}
            onChange={() => undefined}
            onSettings={() => undefined}
          />
        </I18nProvider>,
      );
    });
    const chips = within(screen.getByRole("list", { name: "Where it stands" }));
    expect(chips.getByText("Steps 5 / 12")).toBeTruthy();
    expect(chips.getByText("2 repositories")).toBeTruthy();
    expect(chips.getByText("1 check failing")).toBeTruthy();
    expect(chips.getByText("3 pull requests open")).toBeTruthy();
    // Its goal is the first line of what Muster should know.
    expect(
      screen.getAllByText("Move card settlement to the new ledger by March.").length,
    ).toBeGreaterThan(0);
    // One column on a narrow page, with what the project is made of before how it goes.
    // On a narrow page what is happening comes first: what waits for the person is never
    // pushed down by what the project is made of.
    const steps = screen.getByText("Steps");
    const repos = screen.getByText("Repositories");
    expect(steps.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The menu of what can be added names every kind.
    expect(screen.getAllByRole("button", { name: "Add" }).length).toBeGreaterThan(0);
  });
});
