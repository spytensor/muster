import type { Config } from "../config.js";

/**
 * Searching the web for an agent. The organization's operator chooses where searches go:
 * Search1API, Tavily, or a SearXNG the company runs itself. What is asked leaves for that service and
 * nowhere else, so it is chosen the way the model's provider is.
 */
export interface Found {
  title: string;
  url: string;
  snippet: string;
  /** When the page was published, where the service knows: 2026-09-03. */
  date?: string;
}
export interface Search {
  search(query: string, signal?: AbortSignal): Promise<Found[]>;
}
export class SearchError extends Error {}

/** Where each service that is not the company's own is reached. */
export const SEARCH_HOSTS = { search1api: "api.search1api.com", tavily: "api.tavily.com" } as const;
const RESULTS = 8;
const SNIPPET = 400;
const ADDRESS = 2000;
const TIMEOUT_MS = 15_000;

const clean = (value: unknown, most: number) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, most);

/** Only public pages over https are results: an agent reads nothing else. */
function results(
  rows: { title?: unknown; url?: unknown; content?: unknown; date?: unknown }[],
): Found[] {
  const found: Found[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let url: URL;
    try {
      url = new URL(String(row.url ?? ""));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.href.length > ADDRESS || seen.has(url.href)) continue;
    seen.add(url.href);
    found.push({
      title: clean(row.title, 200) || url.host,
      url: url.href,
      snippet: clean(row.content, SNIPPET),
      ...(typeof row.date === "string" &&
      /^\d{4}-\d{2}-\d{2}/.test(row.date) &&
      !Number.isNaN(Date.parse(row.date.slice(0, 10)))
        ? { date: row.date.slice(0, 10) }
        : {}),
    });
    if (found.length === RESULTS) break;
  }
  return found;
}

/** The search this server was set up with, or none. Tests supply their own requests. */
export function createSearch(config: Config, fetchImpl: typeof fetch = fetch): Search | null {
  const chosen = config.search;
  if (!chosen) return null;
  const ask = async (url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        // Never followed: a search service can be told, by what is searched for, to answer
        // with a redirect to another site, which would carry the search there.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new SearchError("The search service could not be reached just now.");
    }
    // Said so that whoever reads the reply knows whom to tell: these are the operator's to fix.
    if (response.status === 401 || response.status === 403)
      throw new SearchError(
        chosen.provider === "searxng"
          ? "The search service refused the search. An operator should check that it allows JSON answers."
          : "The search service did not accept this server's key. An operator needs to check it.",
      );
    if (response.status === 402)
      throw new SearchError(
        "The search service's credits have run out. An operator needs to top them up.",
      );
    if (response.status === 429)
      throw new SearchError(
        "The search service is being asked too often just now. Try again shortly.",
      );
    if (!response.ok) throw new SearchError(`The search service answered ${response.status}.`);
    const body = await response.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { results?: unknown }).results)
    )
      throw new SearchError("The search service gave an answer that could not be read.");
    return body;
  };
  if (chosen.provider === "search1api")
    return {
      // https://api.search1api.com/openapi.json: one credit a search; pages are not crawled
      // here (crawl_results stays 0), an agent reads the ones it wants itself.
      async search(query, signal) {
        const body = (await ask(
          `https://${SEARCH_HOSTS.search1api}/search`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${chosen.key}`,
            },
            body: JSON.stringify({ query, max_results: RESULTS, crawl_results: 0 }),
          },
          signal,
        )) as {
          results: {
            title?: unknown;
            link?: unknown;
            snippet?: unknown;
            published_date?: unknown;
          }[];
        };
        return results(
          body.results.map((row) => ({
            title: row?.title,
            url: row?.link,
            content: row?.snippet,
            date: row?.published_date,
          })),
        );
      },
    };
  if (chosen.provider === "tavily")
    return {
      async search(query, signal) {
        const body = (await ask(
          `https://${SEARCH_HOSTS.tavily}/search`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${chosen.key}`,
            },
            body: JSON.stringify({ query, max_results: RESULTS, search_depth: "basic" }),
          },
          signal,
        )) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
        return results(body.results ?? []);
      },
    };
  return {
    async search(query, signal) {
      const url = new URL("search", chosen.url.endsWith("/") ? chosen.url : `${chosen.url}/`);
      url.search = new URLSearchParams({ q: query, format: "json", safesearch: "1" }).toString();
      const body = (await ask(
        url.toString(),
        { headers: { accept: "application/json" } },
        signal,
      )) as {
        results?: { title?: unknown; url?: unknown; content?: unknown }[];
      };
      return results(body.results ?? []);
    },
  };
}
