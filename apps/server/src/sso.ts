/**
 * The organization's own way in, set up in the console: sign-in through the company's
 * identity provider with SAML 2.0, and the tokens its directory provisions people with
 * (the SCIM server itself is scim.ts). docs/features/platform.md, "Single sign-on".
 *
 * A person comes back from the provider in two steps. The provider's page posts its
 * answer here from its own site, and a browser sends no cookie of ours along with such a
 * form. So the answer is checked and kept under a code that is used once, and the
 * browser is sent on to an address of ours: there it does show the cookie that ties the
 * attempt to it, and only there is the person let in.
 */
import { createHash, randomBytes } from "node:crypto";
import { isId, newId } from "@muster/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { AdmissionConflict, admit, type DenyReason, type Identity } from "./auth/admission.js";
import { APP_LOGIN_COOKIE, pendingAppLogin } from "./auth/app-login.js";
import {
  authnRequest,
  certificateFacts,
  type IdentityProvider,
  parseMetadata,
  readResponse,
  SAML_MAX_BYTES,
  SamlProblem,
  serviceMetadata,
} from "./auth/saml.js";
import {
  createSession,
  resolveSession,
  revokeSessionByToken,
  SESSION_COOKIE,
} from "./auth/session.js";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { checkUrl, type Net } from "./runtime/net.js";

export const SSO_SCHEMA = [
  // The identity provider an organization signs in through. `verified_at`: when someone
  // last got in through it as it is set now; it cannot be switched on before that, so a
  // mistyped setting locks nobody out.
  `create table saml_settings (
    org_id uuid primary key references organizations(id) on delete cascade,
    entity_id text not null,
    sso_url text not null,
    certificates jsonb not null,
    metadata_url text,
    enabled boolean not null default false,
    verified_at timestamptz,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now()
  )`,
  // A sign-in on its way: asked, then answered, then used once. `binding` is the hash of
  // what only the browser that began holds; `code` the hash of what it is sent back with.
  `create table saml_requests (
    id text primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    binding text not null,
    answer jsonb,
    code text,
    created_at timestamptz not null default now()
  )`,
  // Assertions already presented: each is taken once.
  `create table saml_assertions (
    org_id uuid not null references organizations(id) on delete cascade,
    id text not null,
    expires_at timestamptz not null,
    primary key (org_id, id)
  )`,
  // What the company's directory provisions people with. Only the hash of a token is kept.
  `create table scim_tokens (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    token_hash text not null unique,
    tail text not null,
    created_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  )`,
  // The directory's own name for a person or a department it provisioned.
  `create table scim_ids (
    org_id uuid not null references organizations(id) on delete cascade,
    kind text not null check (kind in ('user', 'group')),
    id uuid not null,
    external_id text not null,
    primary key (org_id, kind, id)
  )`,
];

/** What review asked for (MUS-30): who switched it on, and a sign-in begun by someone signed in. */
export const SSO_FIXES_SCHEMA = [
  "alter table saml_settings add column enabled_by uuid references users(id) on delete set null",
  // Set when the sign-in was begun in the console by this person, to make the provider's
  // account theirs: it lets in nobody else and makes nobody a member.
  "alter table saml_requests add column connect_user uuid references users(id) on delete cascade",
  "create index saml_requests_created on saml_requests (created_at)",
];

const SAML_COOKIE = "muster_saml";
/** How long a person has at the provider's page. */
const ASKING_MINUTES = 10;
/** How long the browser has to come back for an answer that was checked. */
const ANSWER_SECONDS = 120;
export const SCIM_TOKENS = 5;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/**
 * What an organization's provider is to this server's record of who signed in with what.
 * One name per organization, whatever provider it names: changing the provider does not
 * make everyone a stranger whose address may be claimed again.
 */
const providerOf = (orgId: string) => `saml:${orgId}`;
/** How many sign-ins one address may begin in a minute, and how many may be on their way at once. */
export const SSO_LIMITS = { beginPerMinute: 20, waiting: 5000 };

/**
 * Whether the provider's word is enough to let this person in. A person it has named
 * before is known by its account id and comes in as before. For anyone else it has only
 * given an address, and an address is not proof of being someone who is already here:
 *
 * - someone already in this organization as a plain member becomes that member (the
 *   company's directory is how its members sign in);
 * - an owner, an administrator, or anyone with another role is never matched by address:
 *   they connect their own account from the console, signed in;
 * - someone who is not here yet is let in only at an address in a domain the organization
 *   has named as its own.
 *
 * Returns why not, or null.
 */
async function mayEnter(
  tx: Queryable,
  orgId: string,
  identity: Identity,
): Promise<DenyReason | null> {
  const known = await tx.query("select 1 from identities where provider = $1 and subject = $2", [
    identity.provider,
    identity.subject,
  ]);
  if (known.length > 0) return null;
  const raw = identity.email.trim();
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(raw)) return "email_unverified";
  const email = raw.toLowerCase();
  const here = (
    await tx.query<{ orgId: string | null; role: string | null }>(
      `select m.org_id as "orgId", m.role from users u left join memberships m on m.user_id = u.id
        where u.email = $1`,
      [email],
    )
  )[0];
  if (here) return here.orgId === orgId && here.role === "member" ? null : "identity_conflict";
  const domain = await tx.query("select 1 from org_domains where org_id = $1 and domain = $2", [
    orgId,
    email.slice(email.lastIndexOf("@") + 1),
  ]);
  return domain.length > 0 ? null : "not_member";
}

type Settings = {
  orgId: string;
  entityId: string;
  ssoUrl: string;
  certificates: string[];
  metadataUrl: string | null;
  enabled: boolean;
  verifiedAt: Date | null;
  updatedAt: Date;
};

const COLUMNS = `org_id as "orgId", entity_id as "entityId", sso_url as "ssoUrl", certificates,
  metadata_url as "metadataUrl", enabled, verified_at as "verifiedAt", updated_at as "updatedAt"`;

export function registerSso(app: Hono<Env>, kit: AppKit, db: Db, config: Config, net: Net): void {
  const { need, actorOf, clientIp, inTx } = kit;
  const secure = config.publicUrl.startsWith("https://");
  const service = {
    entityId: `${config.publicUrl}/auth/saml/metadata`,
    acsUrl: `${config.publicUrl}/auth/saml/acs`,
  };
  const org = (c: Ctx) => c.get("session").org.id;
  const cookie = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/auth" };
  const denied = (c: Context, reason: DenyReason | "failed") =>
    c.redirect(`${config.publicUrl}/?error=${reason}`);

  /** The one organization that has set this up, or the one asked for by its id. */
  const settingsFor = async (orgId?: string): Promise<Settings | null> => {
    const rows = orgId
      ? await db.query<Settings>(`select ${COLUMNS} from saml_settings where org_id = $1`, [orgId])
      : await db.query<Settings>(`select ${COLUMNS} from saml_settings limit 2`);
    return rows.length === 1 ? (rows[0] as Settings) : null;
  };

  // ---- signing in ----

  /** How many times one address may begin a sign-in in a minute, and how many may be on their way at once. */
  const begun = new Map<string, { since: number; n: number }>();
  const tooOften = (ip: string | null) => {
    const key = ip ?? "";
    const now = Date.now();
    if (begun.size > 10_000) begun.clear();
    const hit = begun.get(key);
    if (!hit || now - hit.since >= 60_000) {
      begun.set(key, { since: now, n: 1 });
      return false;
    }
    return ++hit.n > SSO_LIMITS.beginPerMinute;
  };
  /** Stores a sign-in on its way and says where to send the person. */
  const ask = async (c: Context, settings: Settings, connect: string | null) => {
    await db.query(
      `delete from saml_requests where created_at < now() - interval '${ASKING_MINUTES} minutes'`,
    );
    const waiting = (
      await db.query<{ n: number }>("select count(*)::int as n from saml_requests")
    )[0]?.n;
    if ((waiting ?? 0) >= SSO_LIMITS.waiting) return null;
    const { id, url } = authnRequest(settings, service, new Date());
    const binding = randomBytes(32).toString("base64url");
    await db.query(
      "insert into saml_requests (id, org_id, binding, connect_user) values ($1, $2, $3, $4)",
      [id, settings.orgId, hash(binding), connect],
    );
    // Ties the attempt to this browser: an answer handed to someone else is useless.
    setCookie(c, SAML_COOKIE, binding, { ...cookie, maxAge: ASKING_MINUTES * 60 });
    return url;
  };

  kit.signInWith({
    id: "saml",
    offered: async () => {
      // It stands in for the server's own ways in only where the server has one
      // organization: another organization's people still need theirs.
      const orgs = await db.query("select 1 from organizations limit 2");
      if (orgs.length !== 1) return null;
      const on = await db.query("select 1 from saml_settings where enabled limit 1");
      return on.length === 1 ? { id: "saml", label: "Single sign-on" } : null;
    },
    begin: async (c) => {
      if (tooOften(clientIp(c)))
        return c.text("Too many sign-ins begun. Try again in a minute.", 429);
      const asked = c.req.query("org");
      const settings = await settingsFor(asked && isId(asked) ? asked : undefined);
      // Not switched on is not there: nobody gets in through it (an owner trying it out
      // begins in the console, signed in).
      if (!settings?.enabled) return c.notFound();
      const url = await ask(c, settings, null);
      return url ? c.redirect(url) : denied(c, "failed");
    },
  });

  app.get("/auth/saml/metadata", (c) =>
    c.body(serviceMetadata(service.entityId, service.acsUrl), 200, {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
    }),
  );

  // The provider's answer, posted from its own page.
  app.use(
    "/auth/saml/acs",
    bodyLimit({ maxSize: SAML_MAX_BYTES * 2, onError: (c) => denied(c, "failed") }),
  );
  app.post("/auth/saml/acs", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const answer = (form as Record<string, unknown>).SAMLResponse;
    if (typeof answer !== "string" || !answer) return denied(c, "failed");
    const now = new Date();
    const everyone = await db.query<Settings>(`select ${COLUMNS} from saml_settings`);
    let read: { settings: Settings; said: ReturnType<typeof readResponse> } | null = null;
    let problem = "no_provider";
    for (const settings of everyone) {
      try {
        const said = readResponse(answer, {
          provider: settings,
          entityId: service.entityId,
          acsUrl: service.acsUrl,
          now,
        });
        read = { settings, said };
        break;
      } catch (error) {
        if (!(error instanceof SamlProblem)) throw error;
        problem = error.reason;
      }
    }
    const refused = async (orgId: string | undefined, why: string) => {
      // On record where there is an organization to put it under: why, never what was sent.
      if (orgId)
        await recordEvent(db, {
          orgId,
          actor: { userId: null, email: "" },
          action: "auth.login_denied",
          detail: { reason: "saml", problem: why, provider: "saml" },
          ip: clientIp(c),
        });
      return denied(c, "failed");
    };
    if (!read)
      return refused(everyone.length === 1 ? (everyone[0] as Settings).orgId : undefined, problem);
    const { settings, said } = read;
    const code = randomBytes(32).toString("base64url");
    const kept = await db
      .tx(async (tx) => {
        // The one request the signed answer names, and only that one: it must be this
        // organization's, still waiting, and not yet answered.
        const taken = await tx.query(
          `update saml_requests set answer = $3::jsonb, code = $4, created_at = now()
            where id = $1 and org_id = $2 and answer is null
              and created_at > now() - interval '${ASKING_MINUTES} minutes'
            returning id`,
          [
            said.inResponseTo,
            settings.orgId,
            JSON.stringify({ subject: said.subject, email: said.email, name: said.name }),
            hash(code),
          ],
        );
        if (taken.length === 0) return "unasked";
        await tx.query("delete from saml_assertions where expires_at < now() - interval '1 hour'");
        // Taken once: the same assertion presented again finds its id here.
        const fresh = await tx.query(
          `insert into saml_assertions (org_id, id, expires_at) values ($1, $2, $3)
           on conflict do nothing returning id`,
          [settings.orgId, said.assertionId, said.notOnOrAfter],
        );
        if (fresh.length === 0) throw new SamlProblem("replayed");
        return null;
      })
      .catch((error: unknown) => {
        if (error instanceof SamlProblem) return error.reason;
        throw error;
      });
    if (kept) return refused(settings.orgId, kept);
    // 303: the browser comes back with a plain GET, and with its cookies.
    return c.redirect(`${config.publicUrl}/auth/saml/done?code=${code}`, 303);
  });

  // The same browser that began, back on this site: now the person is let in.
  app.get("/auth/saml/done", async (c) => {
    const binding = getCookie(c, SAML_COOKIE);
    deleteCookie(c, SAML_COOKIE, cookie);
    const code = c.req.query("code") ?? "";
    if (!binding || !code) return denied(c, "failed");
    const row = (
      await db.query<{
        orgId: string;
        connect: string | null;
        answer: { subject: string; email: string; name: string };
      }>(
        `delete from saml_requests
          where code = $1 and binding = $2 and answer is not null
            and created_at > now() - interval '${ANSWER_SECONDS} seconds'
          returning org_id as "orgId", connect_user as connect, answer`,
        [hash(code), hash(binding)],
      )
    )[0];
    if (!row) return denied(c, "failed");
    const settings = await settingsFor(row.orgId);
    if (!settings) return denied(c, "failed");
    const provider = providerOf(settings.orgId);
    const ip = clientIp(c);
    const previous = getCookie(c, SESSION_COOKIE);

    // Begun in the console by someone signed in: the account at the provider becomes
    // theirs. Who they are is their session, never the address the provider gave; nobody
    // is made a member this way, and no new session begins.
    if (row.connect) {
      const session = previous ? await resolveSession(db, previous) : null;
      if (!session || session.user.id !== row.connect || session.org.id !== settings.orgId)
        return denied(c, "failed");
      const linked = await db.tx(async (tx) => {
        const holder = (
          await tx.query<{ user_id: string }>(
            "select user_id from identities where provider = $1 and subject = $2",
            [provider, row.answer.subject],
          )
        )[0]?.user_id;
        // The provider's account is somebody else's here already.
        if (holder && holder !== session.user.id) return false;
        await tx.query("delete from identities where provider = $1 and user_id = $2", [
          provider,
          session.user.id,
        ]);
        await tx.query("insert into identities (provider, subject, user_id) values ($1, $2, $3)", [
          provider,
          row.answer.subject,
          session.user.id,
        ]);
        await tx.query(
          // To the millisecond: the database keeps a finer time than the one read back from it,
          // and the two were never equal on PostgreSQL (found running the suite there).
          "update saml_settings set verified_at = now() where org_id = $1 and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz)",
          [settings.orgId, settings.updatedAt],
        );
        await recordEvent(tx, {
          orgId: settings.orgId,
          actor: { userId: session.user.id, email: session.user.email },
          action: "sso.saml_connected",
          target: { type: "sso", id: settings.orgId, label: settings.entityId },
          ip,
        });
        return true;
      });
      return linked
        ? c.redirect(`${config.publicUrl}/#/admin/security`)
        : denied(c, "identity_conflict");
    }

    // Anyone else comes in only while it is switched on.
    if (!settings.enabled) return denied(c, "failed");
    // The provider is the company's own directory, switched on by an owner: being in it
    // is being a member. What it may not do is hand someone an account that is already
    // here, by naming their address: see `mayEnter`.
    const identity: Identity = {
      provider,
      subject: row.answer.subject,
      email: row.answer.email,
      emailVerified: true,
      domainProven: true,
      fromDirectory: true,
      name: row.answer.name,
      avatarUrl: null,
    };
    const result = await db
      .tx(async (tx) => {
        const barred = await mayEnter(tx, settings.orgId, identity);
        if (barred) {
          await recordEvent(tx, {
            orgId: settings.orgId,
            actor: { userId: null, email: identity.email.trim().toLowerCase().slice(0, 320) },
            action: "auth.login_denied",
            detail: { reason: barred, provider: "saml" },
            ip,
          });
          return { ok: false as const, reason: barred };
        }
        const admission = await admit(tx, config, identity, ip);
        if (!admission.ok) return admission;
        // One organization's provider lets nobody into another: whatever was written
        // for this sign-in is undone.
        if (admission.orgId !== settings.orgId) throw new AdmissionConflict();
        if (previous) await revokeSessionByToken(tx, previous);
        const session = await createSession(tx, {
          userId: admission.userId,
          orgId: admission.orgId,
          provider: "saml",
          days: config.sessionDays,
          ip,
          userAgent: c.req.header("user-agent") ?? null,
        });
        await recordEvent(tx, {
          orgId: admission.orgId,
          actor: { userId: admission.userId, email: identity.email.trim().toLowerCase() },
          action: "auth.login",
          detail: { provider: "saml" },
          ip,
        });
        return { ok: true as const, session };
      })
      .catch((error: unknown) => {
        if (error instanceof AdmissionConflict)
          return { ok: false as const, reason: "not_member" as const };
        throw error;
      });
    if (!result.ok) return denied(c, result.reason);
    setCookie(c, SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      expires: result.session.expiresAt,
    });
    if (await pendingAppLogin(db, getCookie(c, APP_LOGIN_COOKIE)))
      return c.redirect(`${config.publicUrl}/auth/app/confirm`);
    return c.redirect(`${config.publicUrl}/`);
  });

  // ---- the console ----

  /**
   * Which provider the organization signs in through, whether it is on, and what its
   * directory provisions with, decide who can get into every account in it: an owner's to
   * say, not an administrator's.
   */
  const ownerOnly = (c: Ctx) =>
    need(c, "settings.manage") ??
    (c.get("session").role === "owner" ? null : fail(c, "owner_only"));

  const shown = (settings: Settings | null) =>
    settings && {
      entityId: settings.entityId,
      ssoUrl: settings.ssoUrl,
      certificates: settings.certificates.map(certificateFacts),
      metadataUrl: settings.metadataUrl,
      enabled: settings.enabled,
      // Whether someone has got in through it as it is set now.
      verified: Boolean(settings.verifiedAt && settings.verifiedAt >= settings.updatedAt),
      updatedAt: settings.updatedAt,
    };

  app.get("/api/settings/sso", async (c) => {
    const refused = need(c, "settings.read");
    if (refused) return refused;
    const tokens = await db.query(
      `select t.id, t.tail, t.created_at as "createdAt", t.last_used_at as "lastUsedAt",
              (select u.email from users u where u.id = t.created_by) as "createdBy"
         from scim_tokens t where t.org_id = $1 and t.revoked_at is null order by t.created_at`,
      [org(c)],
    );
    return c.json({
      saml: shown(await settingsFor(org(c))),
      service,
      // Whether this person may set it up and switch it: an owner.
      owner: c.get("session").role === "owner",
      scim: { baseUrl: `${config.publicUrl}/scim/v2`, tokens, most: SCIM_TOKENS },
    });
  });

  const SamlBody = z.union([
    z.strictObject({ metadataUrl: z.string().min(1).max(2000) }),
    z.strictObject({ metadataXml: z.string().min(1).max(SAML_MAX_BYTES) }),
  ]);

  // The provider as its metadata describes it. Setting it, or setting it again, switches
  // it off until someone has got in through it: see `verified_at`.
  app.put("/api/settings/sso/saml", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const parsed = SamlBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_saml");
    let xml: string;
    let metadataUrl: string | null = null;
    if ("metadataUrl" in parsed.data) {
      try {
        const url = checkUrl(parsed.data.metadataUrl);
        if (url.protocol !== "https:") return fail(c, "invalid_saml");
        metadataUrl = url.toString();
        const got = await net.request(metadataUrl, { sameSite: true, timeoutMs: 15_000 });
        if (got.status !== 200 || got.truncated) return fail(c, "saml_unreachable");
        xml = got.text;
      } catch {
        return fail(c, "saml_unreachable");
      }
    } else xml = parsed.data.metadataXml;
    let provider: IdentityProvider;
    try {
      provider = parseMetadata(xml, config.dev);
    } catch (error) {
      if (error instanceof SamlProblem) return fail(c, "invalid_saml");
      throw error;
    }
    return inTx(c, async (tx) => {
      // One organization per provider: the same one answering for two would let either in.
      const other = await tx.query(
        "select 1 from saml_settings where entity_id = $1 and org_id <> $2",
        [provider.entityId, org(c)],
      );
      if (other.length > 0) throw new Refusal("invalid_saml");
      await tx.query(
        `insert into saml_settings (org_id, entity_id, sso_url, certificates, metadata_url, updated_by)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         on conflict (org_id) do update set entity_id = excluded.entity_id, sso_url = excluded.sso_url,
           certificates = excluded.certificates, metadata_url = excluded.metadata_url,
           updated_by = excluded.updated_by, updated_at = now(), enabled = false, verified_at = null`,
        [
          org(c),
          provider.entityId,
          provider.ssoUrl,
          JSON.stringify(provider.certificates),
          metadataUrl,
          actorOf(c).userId,
        ],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sso.saml_set",
        target: { type: "sso", id: org(c), label: provider.entityId },
        detail: {
          ssoHost: new URL(provider.ssoUrl).host,
          certificates: provider.certificates.map((one) => certificateFacts(one).fingerprint),
        },
        ip: clientIp(c),
      });
      const settings = (
        await tx.query<Settings>(`select ${COLUMNS} from saml_settings where org_id = $1`, [org(c)])
      )[0] as Settings;
      return c.json(shown(settings));
    });
  });

  app.put("/api/settings/sso/saml/enabled", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const parsed = z
      .strictObject({ on: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    const { on } = parsed.data;
    return inTx(c, async (tx) => {
      const settings = (
        await tx.query<Settings>(
          `select ${COLUMNS} from saml_settings where org_id = $1 for update`,
          [org(c)],
        )
      )[0];
      if (!settings) throw new Refusal("not_found");
      if (on && !(settings.verifiedAt && settings.verifiedAt >= settings.updatedAt))
        throw new Refusal("saml_untried");
      if (settings.enabled !== on) {
        await tx.query("update saml_settings set enabled = $2, enabled_by = $3 where org_id = $1", [
          org(c),
          on,
          on ? actorOf(c).userId : null,
        ]);
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: on ? "sso.saml_on" : "sso.saml_off",
          target: { type: "sso", id: org(c), label: settings.entityId },
          ip: clientIp(c),
        });
      }
      return c.json({ ok: true });
    });
  });

  // Trying it out, and making the account at the provider one's own: begun here, signed
  // in, and ended in the same browser (`connect_user`). An owner may do it before it is
  // switched on, which is how it comes to be known to work; once it is on, so may anyone
  // who administers, whose account is never matched by its address.
  app.post("/api/settings/sso/saml/try", async (c) => {
    const refused = need(c, "settings.manage");
    if (refused) return refused;
    const settings = await settingsFor(org(c));
    if (!settings) return fail(c, "not_found");
    if (!settings.enabled && c.get("session").role !== "owner") return fail(c, "owner_only");
    const url = await ask(c, settings, actorOf(c).userId);
    if (!url) return fail(c, "saml_unreachable");
    return c.json({ url });
  });

  app.delete("/api/settings/sso/saml", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    return inTx(c, async (tx) => {
      const gone = await tx.query<{ entity_id: string }>(
        "delete from saml_settings where org_id = $1 returning entity_id",
        [org(c)],
      );
      if (!gone[0]) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "sso.saml_removed",
        target: { type: "sso", id: org(c), label: gone[0].entity_id },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- provisioning tokens ----

  // The token is said once, here. What is kept cannot be turned back into it.
  app.post("/api/settings/sso/scim/tokens", async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    return inTx(c, async (tx) => {
      await tx.query("select 1 from organizations where id = $1 for update", [org(c)]);
      const live = await tx.query(
        "select 1 from scim_tokens where org_id = $1 and revoked_at is null",
        [org(c)],
      );
      if (live.length >= SCIM_TOKENS) throw new Refusal("scim_too_many");
      const id = newId();
      const token = `scim_${randomBytes(32).toString("base64url")}`;
      await tx.query(
        "insert into scim_tokens (id, org_id, token_hash, tail, created_by) values ($1, $2, $3, $4, $5)",
        [id, org(c), hash(token), token.slice(-4), actorOf(c).userId],
      );
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "scim.token_created",
        target: { type: "scim_token", id, label: `…${token.slice(-4)}` },
        ip: clientIp(c),
      });
      return c.json({ id, token, tail: token.slice(-4) });
    });
  });

  app.delete("/api/settings/sso/scim/tokens/:id", async (c) => {
    const refused = need(c, "settings.manage");
    if (refused) return refused;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const gone = await tx.query<{ tail: string }>(
        `update scim_tokens set revoked_at = now()
          where id = $1 and org_id = $2 and revoked_at is null returning tail`,
        [id, org(c)],
      );
      if (!gone[0]) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "scim.token_revoked",
        target: { type: "scim_token", id, label: `…${gone[0].tail}` },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });
}
