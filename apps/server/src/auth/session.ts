import { createHash, randomBytes } from "node:crypto";
import { newId } from "@muster/protocol";
import type { Queryable } from "../db.js";
import type { Role } from "../roles.js";

export const SESSION_COOKIE = "muster_session";

export interface SessionContext {
  sessionId: string;
  user: { id: string; email: string; name: string; avatarUrl: string | null };
  org: { id: string; name: string };
  role: Role;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a session and returns the token for the cookie. Only its hash is stored. */
export async function createSession(
  db: Queryable,
  input: {
    userId: string;
    orgId: string;
    provider: string;
    days: number;
    /** A browser holds the token in a cookie; a native app holds it itself. */
    kind?: "browser" | "app";
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.days * 86_400_000);
  await db.query(
    `insert into sessions (id, public_id, user_id, org_id, provider, expires_at, ip, user_agent, kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      hashToken(token),
      newId(),
      input.userId,
      input.orgId,
      input.provider,
      expiresAt,
      input.ip,
      input.userAgent?.slice(0, 300) ?? null,
      input.kind ?? "browser",
    ],
  );
  return { token, expiresAt };
}

/**
 * Resolves a cookie token to the signed-in person. Returns null when the session is
 * unknown, expired or revoked, or when the person is no longer an active member.
 */
export async function resolveSession(db: Queryable, token: string): Promise<SessionContext | null> {
  const rows = await db.query<{
    public_id: string;
    last_seen_at: Date;
    user_id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    org_id: string;
    org_name: string;
    role: Role;
  }>(
    `select s.public_id, s.last_seen_at, u.id as user_id, u.email, u.name, u.avatar_url,
            o.id as org_id, o.name as org_name, m.role
       from sessions s
       join users u on u.id = s.user_id
       join memberships m on m.user_id = s.user_id and m.org_id = s.org_id
       join organizations o on o.id = s.org_id
      where s.id = $1 and s.revoked_at is null and s.expires_at > now() and m.status = 'active'`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // Touch at most once a minute so reads do not become writes on every request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await db.query("update sessions set last_seen_at = now() where id = $1", [hashToken(token)]);
  }
  return {
    sessionId: row.public_id,
    user: { id: row.user_id, email: row.email, name: row.name, avatarUrl: row.avatar_url },
    org: { id: row.org_id, name: row.org_name },
    role: row.role,
  };
}

export async function revokeSessionByToken(db: Queryable, token: string): Promise<void> {
  await db.query("update sessions set revoked_at = now() where id = $1 and revoked_at is null", [
    hashToken(token),
  ]);
}

/** Ends every live session of a person. Used when they are suspended or removed. */
export async function revokeSessionsOfUser(db: Queryable, userId: string): Promise<number> {
  const rows = await db.query(
    "update sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id",
    [userId],
  );
  return rows.length;
}
