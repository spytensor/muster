import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db.js";

export const APP_LOGIN_COOKIE = "muster_app";
const MINUTES = 10;

/**
 * Where a native app may ask to be sent back to after sign-in: Muster's own URL
 * scheme (mobile and desktop), or a port on this machine's loopback address
 * (desktop). Nothing else, so a sign-in can never be redirected to a website.
 */
export function allowedAppRedirect(value: string): boolean {
  if (value === "muster://auth") return true;
  return /^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/.test(value);
}

const validChallenge = (value: string) => /^[A-Za-z0-9_-]{43,128}$/.test(value);
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Starts a sign-in on behalf of an app. Returns the id to keep in the browser's cookie, or null if the request is not acceptable. */
export async function beginAppLogin(
  db: Queryable,
  challenge: string,
  redirect: string,
): Promise<string | null> {
  if (!validChallenge(challenge) || !allowedAppRedirect(redirect)) return null;
  const id = randomBytes(24).toString("base64url");
  await db.query("delete from app_logins where expires_at < now()");
  await db.query(
    "insert into app_logins (id, challenge, redirect, expires_at) values ($1, $2, $3, now() + ($4 || ' minutes')::interval)",
    [id, challenge, redirect, String(MINUTES)],
  );
  return id;
}

export async function pendingAppLogin(
  db: Queryable,
  id: string | undefined,
): Promise<{ redirect: string } | null> {
  if (!id) return null;
  return (
    (
      await db.query<{ redirect: string }>(
        "select redirect from app_logins where id = $1 and code is null and expires_at > now()",
        [id],
      )
    )[0] ?? null
  );
}

/**
 * The signed-in person agreed to let the app in. Returns the address to send the
 * browser to, carrying a one-time code. The code is useless without the verifier
 * only the app that started the sign-in holds.
 */
export async function approveAppLogin(
  db: Queryable,
  id: string,
  who: { userId: string; orgId: string; provider: string },
): Promise<string | null> {
  const code = randomBytes(32).toString("base64url");
  const row = (
    await db.query<{ redirect: string }>(
      `update app_logins set user_id = $2, org_id = $3, provider = $4, code = $5
        where id = $1 and code is null and expires_at > now() returning redirect`,
      [id, who.userId, who.orgId, who.provider, code],
    )
  )[0];
  if (!row) return null;
  const target = new URL(row.redirect);
  target.searchParams.set("code", code);
  return target.toString();
}

/** Exchanges the one-time code. Works once, and only with the matching verifier. */
export async function redeemAppLogin(
  db: Queryable,
  code: string,
  verifier: string,
): Promise<{ userId: string; orgId: string; provider: string } | null> {
  if (
    typeof code !== "string" ||
    typeof verifier !== "string" ||
    code.length < 20 ||
    verifier.length < 43
  )
    return null;
  const row = (
    await db.query<{ user_id: string; org_id: string; provider: string }>(
      "delete from app_logins where code = $1 and challenge = $2 and expires_at > now() returning user_id, org_id, provider",
      [code, s256(verifier)],
    )
  )[0];
  return row ? { userId: row.user_id, orgId: row.org_id, provider: row.provider } : null;
}
