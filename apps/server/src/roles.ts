export const ROLES = ["owner", "admin", "auditor", "billing", "member"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "console.access"
  | "members.read"
  | "members.manage"
  | "audit.read"
  | "settings.read"
  | "settings.manage"
  | "sessions.read"
  | "sessions.revoke"
  | "agents.read"
  | "traces.read"
  | "traces.annotate"
  | "agents.manage";

const GRANTS: Record<Role, readonly Permission[]> = {
  owner: [
    "console.access",
    "members.read",
    "members.manage",
    "audit.read",
    "settings.read",
    "settings.manage",
    "sessions.read",
    "sessions.revoke",
    "agents.read",
    "traces.read",
    "traces.annotate",
    "agents.manage",
  ],
  admin: [
    "console.access",
    "members.read",
    "members.manage",
    "audit.read",
    "settings.read",
    "settings.manage",
    "sessions.read",
    "sessions.revoke",
    "agents.read",
    "traces.read",
    "traces.annotate",
    "agents.manage",
  ],
  // Reads everything an administrator can see and changes nothing.
  auditor: [
    "console.access",
    "members.read",
    "audit.read",
    "settings.read",
    "sessions.read",
    "agents.read",
    "traces.read",
  ],
  billing: ["console.access"],
  member: [],
};

export function permissionsOf(role: Role): readonly Permission[] {
  return GRANTS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

/** Roles an administrator may hand out or act on. Owner and admin are reserved to owners. */
const ADMIN_MANAGEABLE: readonly Role[] = ["auditor", "billing", "member"];

/** Whether `actor` may manage (re-role, suspend, remove) someone who currently holds `target`. */
export function canManage(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return ADMIN_MANAGEABLE.includes(target);
  return false;
}

/** Whether `actor` may give someone the role `role` (by invitation or by change). */
export function canGrant(actor: Role, role: Role): boolean {
  return canManage(actor, role);
}
