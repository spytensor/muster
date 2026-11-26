import type { I18n } from "@/i18n";
import { logLabel } from "./agentName";
import type { AdminEvent, Role } from "./api";

/**
 * What an event was about, as it is shown. The log keeps the general agent's name as it
 * was stored; here it is the name people know it by (agentName.ts, `logLabel`).
 */
export function eventTarget(event: Pick<AdminEvent, "targetType" | "targetLabel">): string {
  const label = event.targetLabel ?? "";
  return event.targetType === "agent" || event.targetType === "approval" ? logLabel(label) : label;
}

/** A one-line, human description of what an event's detail says. */
export function eventSummary(event: AdminEvent, { t }: I18n): string {
  const d = event.detail;
  const role = (value: unknown) =>
    typeof value === "string" && value in t.roles ? t.roles[value as Role] : null;
  const parts: string[] = [];
  if (role(d.from) && role(d.to)) parts.push(`${role(d.from)} → ${role(d.to)}`);
  else if (role(d.role)) parts.push(role(d.role) as string);
  if (event.action === "member.department_changed")
    parts.push(typeof d.to === "string" ? t.eventDetail.movedTo(d.to) : t.eventDetail.movedOut);
  if (event.action === "department.deleted" && typeof d.count === "number" && d.count > 0)
    parts.push(
      t.eventDetail.leftWithout(
        d.count,
        Array.isArray(d.members) ? d.members.filter((m) => typeof m === "string").join(", ") : "",
      ),
    );
  if (typeof d.via === "string" && d.via in t.joinedVia)
    parts.push(t.eventDetail.via(t.joinedVia[d.via as keyof typeof t.joinedVia]));
  if (typeof d.sessionsEnded === "number" && d.sessionsEnded > 0)
    parts.push(t.eventDetail.sessionsEnded(d.sessionsEnded));
  if (typeof d.autoJoin === "boolean")
    parts.push(d.autoJoin ? t.eventDetail.autoJoinOn : t.eventDetail.autoJoinOff);
  if (d.reason === "suspended") parts.push(t.eventDetail.suspended);
  if (d.reason === "identity_conflict") parts.push(t.eventDetail.identityConflict);
  if (typeof d.provider === "string") parts.push(t.providers[d.provider] ?? d.provider);
  if (typeof d.label === "string") parts.push(d.label);
  if (typeof d.rows === "number") parts.push(t.eventDetail.rows(d.rows));
  return parts.join(" · ");
}

/** "Chrome · macOS" from a user-agent string; best effort. */
export function device(userAgent: string | null, fallback: string, other: string): string {
  if (!userAgent) return fallback;
  // The desktop app names itself when it signs in.
  const browser = /^Muster\//.test(userAgent)
    ? "Muster"
    : /Edg\//.test(userAgent)
      ? "Edge"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : other;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Android/.test(userAgent)
          ? "Android"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}
