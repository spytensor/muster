/**
 * A company's directory at the service its people already work in: Feishu (and Lark, the
 * same service outside China), WeCom and DingTalk. One file per service says how to ask
 * it who is signing in and who is in the company; directory.ts decides what follows.
 */
import type { Net } from "../runtime/net.js";

export const DIRECTORY_KINDS = ["feishu", "lark", "wecom", "dingtalk"] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

/** The application the company registered at the service for this server. */
export interface DirectoryApp {
  kind: DirectoryKind;
  /** Feishu's App ID, WeCom's corporation ID, DingTalk's Client ID. */
  appId: string;
  secret: string;
  /** WeCom alone: which of the corporation's applications this is. */
  agentId: string | null;
}

export interface DirectoryPerson {
  /** The service's own name for the person, the same whenever they come back. */
  subject: string;
  name: string;
  /** An address the company's record holds, or none: many people have no address there. */
  email: string | null;
  avatarUrl: string | null;
  /** In the company and not switched off there. */
  active: boolean;
  /** The departments they are in, as the service names them; the first is their main one. */
  departments: string[];
}

export interface DirectoryDepartment {
  id: string;
  /** Null for one directly under the company. */
  parentId: string | null;
  name: string;
}

export interface DirectoryListing {
  departments: DirectoryDepartment[];
  people: DirectoryPerson[];
}

export type ProblemReason =
  /** The service does not accept the application's ID and secret. */
  | "credentials"
  /** The application is not allowed what was asked; `hint` says what the service named. */
  | "permission"
  /** The service did not answer, or not in a way that can be read. */
  | "unreachable"
  /** The service did not vouch for the person who came back; `hint` is what it said. */
  | "sign_in";

export class DirectoryProblem extends Error {
  constructor(
    readonly reason: ProblemReason,
    /** What the service said is missing: permission names, or its own short message. */
    readonly hint = "",
  ) {
    super(`directory: ${reason}${hint ? ` (${hint})` : ""}`);
  }
}

export interface DirectoryClient {
  /** Whether the sign-in is tied to the browser with a code only it holds (PKCE). */
  pkce: boolean;
  /** Where to send a person to sign in. `inApp`: they are inside the service's own app. */
  authorizeUrl(
    app: DirectoryApp,
    at: { redirectUri: string; state: string; challenge: string; inApp: boolean },
  ): string;
  /**
   * Who came back with this code. Null when they are not one of the company's own people
   * as far as the application may see: someone from outside, or outside what it was given.
   */
  identify(
    app: DirectoryApp,
    at: { code: string; redirectUri: string; verifier: string },
  ): Promise<DirectoryPerson | null>;
  /** Everyone and every department the application may see. */
  list(app: DirectoryApp): Promise<DirectoryListing>;
  /** Passes when the service accepts the application's ID and secret. */
  check(app: DirectoryApp): Promise<void>;
}

/** The most people and departments one company's listing is read to. */
export const LISTING_MOST = { people: 50_000, departments: 5_000 };

/**
 * A listing that stops short is no listing: whoever it left out would read as gone, and
 * lose their access. So reaching a limit is a failure, said as one.
 */
export function tooMany(): never {
  throw new DirectoryProblem("unreachable", "more than this server reads");
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One call to a service: JSON out, JSON back, to that service's hosts and nowhere else. */
export async function callJson(
  net: Net,
  hosts: readonly string[],
  url: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  let answer: Awaited<ReturnType<Net["request"]>>;
  try {
    answer = await net.request(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.headers,
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), contentType: "application/json" }),
      onlyHosts: hosts,
      noRedirect: true,
      timeoutMs: 20_000,
    });
  } catch {
    throw new DirectoryProblem("unreachable");
  }
  if (answer.truncated) throw new DirectoryProblem("unreachable", "answer too long");
  try {
    const value: unknown = JSON.parse(answer.text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return { ...(value as Record<string, unknown>), httpStatus: answer.status };
  } catch {
    // Not JSON: said below.
  }
  throw new DirectoryProblem("unreachable", `status ${answer.status}`);
}

export const field = {
  text,
  object: (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {},
  list: (value: unknown): unknown[] => (Array.isArray(value) ? value : []),
  /** A service's ID, which may arrive as a number. */
  id: (value: unknown): string =>
    typeof value === "number" && Number.isFinite(value) ? String(value) : text(value),
};

/** A short, plain line of what a service said, safe to show an administrator. */
export const said = (value: unknown): string =>
  [...text(value)]
    .filter((ch) => ch >= " " && ch !== "\u007f")
    .join("")
    .slice(0, 300);
