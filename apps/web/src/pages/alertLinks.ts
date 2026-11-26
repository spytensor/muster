/** The Traces page's name for each window a rule can look back over. */
const RANGE: Record<number, string> = { 15: "15m", 60: "1h", 720: "12h", 1440: "24h" };

/** Where what an alert is about can be looked at: the page that already shows it, filtered. */
export function evidenceOf(alert: {
  rule: string;
  subject: string;
  detail: Record<string, string | number | null>;
}): string {
  const range = RANGE[Number(alert.detail.window)] ?? "24h";
  const query = (pairs: Record<string, string>) => new URLSearchParams(pairs).toString();
  switch (alert.rule) {
    case "run_failures":
    case "model_failing":
      return `traces?${query({ status: "error", range })}`;
    case "blocked_actions":
      return alert.subject.startsWith("agent:")
        ? `traces?${query({ status: "blocked", range, agent: alert.subject.slice(6) })}`
        : `traces?${query({ status: "blocked", range, user: String(alert.detail.email ?? "") })}`;
    case "spend_spike":
      return "usage";
    case "approval_waiting":
      return "market";
    case "sandbox_down":
      return "sandbox";
    // What another part of the server raised: the activity log is where its own record is.
    default:
      return "audit";
  }
}
