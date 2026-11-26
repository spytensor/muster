import { newId } from "@muster/protocol";
import { recordEvent } from "../audit.js";
import type { Config } from "../config.js";
import type { Queryable } from "../db.js";
import type { Role } from "../roles.js";

/** What the identity provider asserted about the person signing in. */
export interface Identity {
  provider: string;
  subject: string;
  email: string;
  /** The provider vouches that this address reaches this person. */
  emailVerified: boolean;
  /**
   * The provider vouches that the address's domain owner manages this account today
   * (a Google Workspace or a verified Entra domain), not merely that the address was
   * verified once. Needed wherever the address alone grants access.
   */
  domainProven: boolean;
  /**
   * The account is one the company itself gave out: it comes from the directory this
   * server was set up to sign people in with (the company's Microsoft directory, or its
   * own provider the operator vouched for), and is not a guest there. Such a person is a
   * member by signing in: the company decides who is in it by who is in its directory.
   */
  fromDirectory?: boolean;
  name: string;
  avatarUrl: string | null;
}

export type DenyReason =
  | "email_unverified"
  | "not_member"
  | "removed"
  | "suspended"
  | "identity_conflict";

/** Thrown to undo a half-made admission; the caller's transaction rolls back and the sign-in is refused. */
export class AdmissionConflict extends Error {}

export type Admission =
  | { ok: true; userId: string; orgId: string; role: Role }
  | { ok: false; reason: DenyReason };

/**
 * Decides whether a person who proved their identity may enter, and on first entry
 * creates their account and membership. Run inside a transaction.
 *
 * A returning person is recognised by the provider's account ID, not by email. An
 * account the server has not seen before is matched to an existing person by email
 * only when that person has no account at this provider yet and the provider proves
 * the domain; otherwise a recycled or look-alike address could inherit someone
 * else's access.
 *
 * Entry is granted by, in order: an active membership; an open invitation for this
 * address; an account from the company's own directory; a domain the organization lets
 * in automatically (domain proven); or, on a deployment with no organization yet, being
 * the configured bootstrap owner. Anyone else is refused and no account is created for
 * them. Someone an administrator removed stays out until an administrator lets them back.
 */
export async function admit(
  db: Queryable,
  config: Config,
  identity: Identity,
  ip: string | null,
): Promise<Admission> {
  const raw = identity.email.trim();
  // Printable ASCII only, checked before lower-casing: folding other scripts can turn
  // one address into another (U+212A becomes "k").
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(raw) || !identity.emailVerified) {
    return { ok: false, reason: "email_unverified" };
  }
  const email = raw.toLowerCase();

  let userId = (
    await db.query<{ user_id: string }>(
      "select user_id from identities where provider = $1 and subject = $2",
      [identity.provider, identity.subject],
    )
  )[0]?.user_id;

  if (!userId) {
    const existing = (
      await db.query<{ id: string }>("select id from users where email = $1", [email])
    )[0]?.id;
    if (existing) {
      const sameProvider = await db.query(
        "select 1 from identities where user_id = $1 and provider = $2",
        [existing, identity.provider],
      );
      // Same provider, different account ID: the address now belongs to another
      // account. A different provider: only a proven domain may link.
      if (sameProvider.length > 0 || !identity.domainProven) {
        const membership = (
          await db.query<{ org_id: string }>("select org_id from memberships where user_id = $1", [
            existing,
          ])
        )[0];
        if (membership) {
          await recordEvent(db, {
            orgId: membership.org_id,
            actor: { userId: null, email },
            action: "auth.login_denied",
            detail: { reason: "identity_conflict", provider: identity.provider },
            ip,
          });
        }
        return { ok: false, reason: "identity_conflict" };
      }
      userId = existing;
    }
  }

  const membership = userId
    ? (
        await db.query<{ org_id: string; role: Role; status: "active" | "suspended" | "removed" }>(
          "select org_id, role, status from memberships where user_id = $1",
          [userId],
        )
      )[0]
    : undefined;

  if (userId && membership?.status === "active") {
    await touchUser(db, userId, identity);
    return { ok: true, userId, orgId: membership.org_id, role: membership.role };
  }
  if (userId && membership?.status === "suspended") {
    await recordEvent(db, {
      orgId: membership.org_id,
      actor: { userId, email },
      action: "auth.login_denied",
      detail: { reason: "suspended", provider: identity.provider },
      ip,
    });
    return { ok: false, reason: "suspended" };
  }

  // Someone removed from the organization is not let back in by the directory or a domain
  // rule: an administrator restores them (or, where invitations are used, invites them).
  const grant = await findGrant(
    db,
    config,
    email,
    identity.domainProven,
    membership?.status === "removed",
    identity.fromDirectory === true,
  );
  if (!grant) {
    // Someone who was removed and tries again is on record, like someone suspended.
    if (userId && membership?.status === "removed")
      await recordEvent(db, {
        orgId: membership.org_id,
        actor: { userId, email },
        action: "auth.login_denied",
        detail: { reason: "removed", provider: identity.provider },
        ip,
      });
    return { ok: false, reason: membership?.status === "removed" ? "removed" : "not_member" };
  }

  if (!userId) {
    // Two first sign-ins of the same person can race; the second finds the first's row.
    await db.query(
      "insert into users (id, email, name, avatar_url) values ($1, $2, $3, $4) on conflict (email) do nothing",
      [newId(), email, identity.name, identity.avatarUrl],
    );
    userId = (await db.query<{ id: string }>("select id from users where email = $1", [email]))[0]
      ?.id as string;
  }
  await touchUser(db, userId, identity);

  let orgId = grant.orgId;
  if (grant.via === "bootstrap") {
    orgId = newId();
    await db.query("insert into organizations (id, name) values ($1, $2)", [orgId, config.orgName]);
    await recordEvent(db, {
      orgId,
      actor: { userId, email },
      action: "org.created",
      target: { type: "organization", id: orgId, label: config.orgName },
      ip,
    });
  }
  const joined = await db.query(
    `insert into memberships (org_id, user_id, role, department_id, joined_via)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set role = excluded.role, department_id = excluded.department_id, joined_via = excluded.joined_via,
           status = 'active', joined_at = now()
       where memberships.status = 'removed' and memberships.org_id = excluded.org_id
     returning user_id`,
    [orgId, userId, grant.role, grant.departmentId, grant.via],
  );
  // Nothing written: the person already holds a membership the grant cannot replace
  // (one in another organization). Refuse rather than report a join that did not happen.
  if (joined.length === 0) throw new AdmissionConflict();
  if (grant.invitationId) {
    await db.query("update invitations set accepted_at = now() where id = $1", [
      grant.invitationId,
    ]);
  }
  await recordEvent(db, {
    orgId,
    actor: { userId, email },
    action: "member.joined",
    target: { type: "member", id: userId, label: email },
    detail: { via: grant.via, role: grant.role },
    ip,
  });
  return { ok: true, userId, orgId, role: grant.role };
}

interface Grant {
  orgId: string;
  role: Role;
  departmentId: string | null;
  via: "invitation" | "domain" | "bootstrap" | "directory";
  invitationId?: string;
}

async function findGrant(
  db: Queryable,
  config: Config,
  email: string,
  domainProven: boolean,
  invitationOnly: boolean,
  fromDirectory: boolean,
): Promise<Grant | null> {
  // Locked so two sign-ins cannot both use the same invitation.
  const invitation = (
    await db.query<{ id: string; org_id: string; role: Role; department_id: string | null }>(
      `select id, org_id, role, department_id from invitations
        where email = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        for update`,
      [email],
    )
  )[0];
  if (invitation) {
    return {
      orgId: invitation.org_id,
      role: invitation.role,
      departmentId: invitation.department_id,
      via: "invitation",
      invitationId: invitation.id,
    };
  }
  if (invitationOnly) return null;

  // The company's own directory: whoever it holds is a member of the one organization
  // this deployment serves. There must be one already: the first owner makes it.
  if (fromDirectory) {
    const org = (await db.query<{ id: string }>("select id from organizations limit 2")) ?? [];
    if (org.length === 1)
      return {
        orgId: (org[0] as { id: string }).id,
        role: "member",
        departmentId: null,
        via: "directory",
      };
  }

  if (domainProven) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const rule = (
      await db.query<{ org_id: string }>(
        "select org_id from org_domains where domain = $1 and auto_join = true",
        [domain],
      )
    )[0];
    if (rule) return { orgId: rule.org_id, role: "member", departmentId: null, via: "domain" };
  }

  // Creating the organization rests on the address alone, so the domain must be proven.
  if (domainProven && email === config.bootstrapOwnerEmail) {
    const any = await db.query("select 1 from organizations limit 1");
    if (any.length === 0) return { orgId: "", role: "owner", departmentId: null, via: "bootstrap" };
  }
  return null;
}

async function touchUser(db: Queryable, userId: string, identity: Identity): Promise<void> {
  await db.query(
    `insert into identities (provider, subject, user_id) values ($1, $2, $3)
     on conflict (provider, subject) do nothing`,
    [identity.provider, identity.subject, userId],
  );
  await db.query(
    `update users set last_login_at = now(),
            name = case when $2 <> '' then $2 else name end,
            avatar_url = coalesce($3, avatar_url)
      where id = $1`,
    [userId, identity.name, identity.avatarUrl],
  );
}
