/**
 * What lives in a project, as the phone shows it (the web's ProjectLives, to look at):
 * its repositories, guides, environments, links, people to reach and facts, kind by
 * kind, with what is known of each. Arithmetic only, so it is tested without a screen.
 */

export const ITEM_KINDS = ["repo", "guide", "environment", "link", "contact", "fact"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface ProjectItem {
  id: string;
  n: number;
  kind: ItemKind;
  title: string;
  detail: string;
  url: string | null;
  ref: string | null;
  file: { id: string; name: string; kind: string; size: number } | null;
  state: {
    version?: string;
    versionAt?: string;
    branch?: string;
    doc?: string;
    /** Someone to reach: how. */
    email?: string;
    phone?: string;
    /** A day that matters for it, YYYY-MM-DD. */
    due?: string;
  };
}
export interface RepoFacts {
  branch: string;
  pulls: number | null;
  checks: "passing" | "failing" | "running" | null;
}

/** Only what is a thing of a known kind with a name: a newer server may send kinds this app does not draw. */
export function itemsOf(given: unknown): ProjectItem[] {
  if (!Array.isArray(given)) return [];
  return given.flatMap((one) => {
    const item = one as Partial<ProjectItem> | null;
    if (!item || typeof item.id !== "string" || typeof item.title !== "string") return [];
    if (!ITEM_KINDS.includes(item.kind as ItemKind)) return [];
    const state = (item.state && typeof item.state === "object" ? item.state : {}) as Record<
      string,
      unknown
    >;
    const text = (key: string) =>
      typeof state[key] === "string" ? (state[key] as string) : undefined;
    const file = item.file;
    return [
      {
        id: item.id,
        n: typeof item.n === "number" ? item.n : 0,
        kind: item.kind as ItemKind,
        title: item.title,
        detail: typeof item.detail === "string" ? item.detail : "",
        url: typeof item.url === "string" ? item.url : null,
        ref: typeof item.ref === "string" ? item.ref : null,
        file:
          file && typeof file.id === "string" && typeof file.name === "string"
            ? {
                id: file.id,
                name: file.name,
                kind: typeof file.kind === "string" ? file.kind : "",
                size: typeof file.size === "number" ? file.size : 0,
              }
            : null,
        state: {
          ...(text("version") ? { version: text("version") } : {}),
          ...(text("branch") ? { branch: text("branch") } : {}),
          ...(text("doc") ? { doc: text("doc") } : {}),
          ...(text("email") ? { email: text("email") } : {}),
          ...(text("phone") ? { phone: text("phone") } : {}),
          ...(text("due") ? { due: text("due") } : {}),
        },
      },
    ];
  });
}

/** The kinds a project has something of, in the page's order; a kind with nothing is not there. */
export function groupsOf(
  items: readonly ProjectItem[],
): { kind: ItemKind; items: ProjectItem[] }[] {
  return ITEM_KINDS.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

/** Where an address leads, in a word: its host, without the `www`. */
export function hostOf(address: string | null): string {
  if (!address) return "";
  const found = /^https?:\/\/([^/?#]+)/i.exec(address.trim());
  return found ? (found[1] ?? "").replace(/^[^@]*@/, "").replace(/^www\./i, "") : "";
}

/** An address the phone may open: of the web, and nothing else. */
export const opens = (address: string | null): address is string =>
  typeof address === "string" && /^https?:\/\/[^\s]+$/i.test(address.trim());

/** What the top of the page counts from how the repositories stand. */
export function standingOf(
  items: readonly ProjectItem[],
  facts: Record<string, RepoFacts | undefined>,
): { repos: number; failing: number; pulls: number } {
  const repos = items.filter((item) => item.kind === "repo");
  const known = repos.flatMap((item) => {
    const fact = item.ref ? facts[item.ref] : undefined;
    return fact ? [fact] : [];
  });
  return {
    repos: repos.length,
    failing: known.filter((fact) => fact.checks === "failing").length,
    pulls: known.reduce((sum, fact) => sum + (typeof fact.pulls === "number" ? fact.pulls : 0), 0),
  };
}

/** How a repository's facts are kept by name, from whatever the server sent. */
export function factsOf(given: unknown): Record<string, RepoFacts> {
  const out: Record<string, RepoFacts> = {};
  const facts = (given as { facts?: unknown } | null)?.facts;
  if (!facts || typeof facts !== "object") return out;
  for (const [name, value] of Object.entries(facts as Record<string, unknown>)) {
    const fact = value as Partial<RepoFacts> | null;
    if (!fact || typeof fact.branch !== "string") continue;
    out[name] = {
      branch: fact.branch,
      pulls: typeof fact.pulls === "number" ? fact.pulls : null,
      checks:
        fact.checks === "passing" || fact.checks === "failing" || fact.checks === "running"
          ? fact.checks
          : null,
    };
  }
  return out;
}
