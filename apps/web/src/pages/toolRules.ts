export type Effect = "allow" | "ask" | "off";
export interface Rule {
  tool: string;
  departmentId: string | null;
  effect: Effect;
}
export interface Scope {
  files: boolean;
  mail: boolean;
  web: "all" | string[];
  knowledge: "all" | string[];
  connectors: "all" | string[];
}

/** The groups tools are listed under, in the order the page shows them. */
export const GROUPS = [
  "files",
  "web",
  "mail",
  "code",
  "connectors",
  "memory",
  "projects",
  "followups",
  "agents",
] as const;

/**
 * What the control of one tool shows. For everyone: the rule, or "allow" where there is
 * none. For a department: its own rule, or "inherit" where it has none of its own.
 */
export function effectShown(
  rules: readonly Rule[],
  tool: string,
  departmentId: string | null,
): Effect | "inherit" {
  const own = rules.find((rule) => rule.tool === tool && rule.departmentId === departmentId);
  return own?.effect ?? (departmentId ? "inherit" : "allow");
}

/** The host names written in a box, one a line or separated by commas: an address is cut down to its host. */
export function hostsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((word) =>
          word
            .trim()
            .toLowerCase()
            .replace(/^[a-z]+:\/\//, "")
            .replace(/[/?#:].*$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

/** In which ways a scope is less than everything, for the marks on its row. */
export function limited(scope: Scope): ("files" | "mail" | "web" | "knowledge" | "connectors")[] {
  return [
    ...(scope.files ? [] : (["files"] as const)),
    ...(scope.mail ? [] : (["mail"] as const)),
    ...(scope.web === "all" ? [] : (["web"] as const)),
    ...(scope.knowledge === "all" ? [] : (["knowledge"] as const)),
    ...(scope.connectors === "all" ? [] : (["connectors"] as const)),
  ];
}
