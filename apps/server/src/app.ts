import { getConnInfo } from "@hono/node-server/conninfo";
import { isId, newId } from "@muster/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { recordEvent } from "./audit.js";
import { AdmissionConflict, admit, type DenyReason } from "./auth/admission.js";
import { APP_LOGIN_COOKIE, pendingAppLogin } from "./auth/app-login.js";
import { registerAppLogin } from "./auth/app-routes.js";
import { LOGIN_COOKIE, Oidc } from "./auth/oidc.js";
import {
  createSession,
  resolveSession,
  revokeSessionByToken,
  revokeSessionsOfUser,
  SESSION_COOKIE,
  type SessionContext,
} from "./auth/session.js";
import { type Config, DEV_IDP_PATH } from "./config.js";
import type { Db, Queryable } from "./db.js";
import { createDevIdp } from "./dev/idp.js";
import { ERRORS, type ErrorCode, Refusal } from "./errors.js";
import { plainName } from "./names.js";
import {
  can,
  canGrant,
  canManage,
  type Permission,
  permissionsOf,
  ROLES,
  type Role,
} from "./roles.js";

export type Env = { Variables: { session: SessionContext } };
export type Ctx = Context<Env>;

const INVITATION_DAYS = 14;

/** Mailbox providers anyone can register at. Letting one in automatically would admit the public. */
const PUBLIC_EMAIL_DOMAINS = new Set(
  `gmail.com googlemail.com outlook.com hotmail.com hotmail.co.uk live.com msn.com yahoo.com yahoo.co.jp
   yahoo.co.uk ymail.com aol.com icloud.com me.com mac.com proton.me protonmail.com pm.me gmx.com gmx.net
   gmx.de mail.com mail.ru yandex.com yandex.ru zoho.com fastmail.com hey.com tutanota.com naver.com
   daum.net qq.com 163.com 126.com yeah.net foxmail.com sina.com sina.cn sohu.com aliyun.com 139.com`.split(
    /\s+/,
  ),
);

/** A mailbox provider under any country's ending (outlook.de, yahoo.fr), or an ending itself (co.uk). */
const PUBLIC_PROVIDERS =
  /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|aol|icloud|proton|protonmail|gmx|yandex|zoho|mail)\.([a-z]{2,3}|com?\.[a-z]{2})$/;
const PUBLIC_ENDINGS = /^(com?|net|org|gov|edu|ac)\.[a-z]{2}$/;
const isPublicDomain = (domain: string) =>
  PUBLIC_EMAIL_DOMAINS.has(domain) || PUBLIC_PROVIDERS.test(domain) || PUBLIC_ENDINGS.test(domain);

const RoleSchema = z.enum(ROLES);
const IdSchema = z.string().refine(isId, "must be an id");
// ASCII only: case-folding other scripts can turn one address into another.
const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[\x21-\x7e]+$/)
  .pipe(z.email().max(254));
const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "not a domain");

export const fail = (c: Context, code: ErrorCode) =>
  c.json({ error: { code, message: ERRORS[code][1] } }, ERRORS[code][0]);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Text with what no database column holds taken out: null characters, and halves of character pairs. */
export const storable = (text: string) =>
  text.replaceAll("\0", "").replace(new RegExp(LONE_SURROGATE.source, "g"), "\ufffd");
/** Whether any text inside a parsed body holds a null character or an unpaired surrogate. */
function unstorable(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0") || LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.some(unstorable);
  if (value && typeof value === "object")
    return Object.entries(value).some(([key, inner]) => unstorable(key) || unstorable(inner));
  return false;
}

/** The most a JSON request may weigh: the longest message, document or set of skill texts fits several times over. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface AppKit {
  need(c: Ctx, permission: Permission): Response | null;
  actorOf(c: Ctx): { userId: string; email: string };
  clientIp(c: Context): string | null;
  inTx(c: Ctx, fn: (tx: Queryable) => Promise<Response>): Promise<Response>;
  /** Asks to be told when a member is suspended or removed, so whatever they have in progress can end. */
  onMemberBlocked(fn: (userId: string) => Promise<void> | void): void;
  /**
   * Says that a member was suspended or removed by something other than the members page
   * (the company's directory, through SCIM): everyone who asked to be told is.
   */
  memberBlocked(userId: string): Promise<void>;
  /** A way to sign in that is the organization's own, set up in the console (sso.ts). */
  signInWith(way: SignInWay): void;
}

/**
 * A way in that an administrator set up, beside the ones the server was started with.
 * While it is on it is the organization's one way in: the sign-in page offers it alone.
 */
export interface SignInWay {
  id: string;
  /** What the sign-in page offers, or null while it is not switched on. */
  offered(): Promise<{ id: string; label: string } | null>;
  /** Sends the person to it. */
  begin(c: Context): Promise<Response>;
  /** Takes the person back from it at /auth/callback/<id>, for a way that returns there. */
  complete?(c: Context): Promise<Response>;
}

/** Where a connected service sends a person back to. See connectors.ts. */
const CONSENT_ANSWER = /^\/api\/app\/connectors\/[a-z]+\/callback$/;

export async function createApp(
  config: Config,
  db: Db,
  extend?: (app: Hono<Env>, kit: AppKit) => void,
): Promise<Hono<Env>> {
  const app = new Hono<Env>();
  const secure = config.publicUrl.startsWith("https://");
  const whenBlocked: ((userId: string) => Promise<void> | void)[] = [];
  const memberBlocked = async (userId: string) => {
    // Each on its own: one that fails does not keep the others from ending what they hold.
    for (const fn of whenBlocked)
      try {
        await fn(userId);
      } catch (error) {
        console.error("ending what a blocked member had failed:", error);
      }
  };
  const ways: SignInWay[] = [];
  /** After a member change went through: if the person is no longer active, what they had running ends too. */
  const endWorkOf = async (c: Context, response: Response) => {
    const id = c.req.param("id") ?? "";
    if (response.status !== 200 || !isId(id)) return response;
    const active = await db.query(
      "select 1 from memberships where user_id = $1 and status = 'active'",
      [id],
    );
    if (active.length === 0) await memberBlocked(id);
    return response;
  };

  /**
   * For the record only; never used to decide access. The forwarded header is
   * believed only when the operator says a proxy sets it, and then the right-most
   * entry is used: it is the one the proxy itself added.
   */
  const clientIp = (c: Context): string | null => {
    if (config.trustProxy) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      return null; // not running on a socket (tests)
    }
  };

  /** Runs `fn` in a transaction. A Refusal thrown inside rolls everything back, then is sent. */
  const inTx = async (c: Ctx, fn: (tx: Queryable) => Promise<Response>): Promise<Response> => {
    try {
      return await db.tx(fn);
    } catch (error) {
      if (error instanceof Refusal) return fail(c, error.code);
      throw error;
    }
  };

  app.onError((error, c) => {
    // A refusal thrown while validating, before any transaction started.
    if (error instanceof Refusal) return fail(c, error.code);
    // The database refusing a value it was handed (a null character, a half of a character
    // pair, a day that is not a day, a number where a whole one is needed) is the caller's
    // mistake, not the server's. Its codes of class 22 are "data exception".
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^22[0-9A-Z]{3}$/.test(code)) {
      // Written down all the same: the value may have been one the server made itself.
      console.warn(
        `${c.req.method} ${c.req.path} refused by the database (${code}):`,
        error instanceof Error ? error.message : error,
      );
      return fail(c, "invalid_request");
    }
    console.error(`${c.req.method} ${c.req.path} failed:`, error);
    // A sign-in that breaks part-way lands on the sign-in page, not a bare error.
    if (
      c.req.path.startsWith("/auth/login/") ||
      c.req.path.startsWith("/auth/callback/") ||
      c.req.path.startsWith("/auth/saml/")
    ) {
      return c.redirect(`${config.publicUrl}/?error=failed`);
    }
    return c.json(
      { error: { code: "internal", message: "Something went wrong on the server." } },
      500,
    );
  });

  const devProvider = config.providers.find((p) => p.id === "dev");
  // Requests to the development provider are answered in-process, so sign-in works
  // without the server having to reach its own public URL.
  const fetchImpl: typeof fetch | undefined = devProvider
    ? (input, init) => {
        const request = new Request(input as string | URL | Request, init);
        if (!request.url.startsWith(`${devProvider.issuer}/`)) return fetch(request);
        const { pathname, search } = new URL(request.url);
        return Promise.resolve(
          app.fetch(new Request(`http://internal${pathname}${search}`, request)),
        );
      }
    : undefined;
  if (devProvider) {
    app.route(
      DEV_IDP_PATH,
      await createDevIdp(devProvider, `${config.publicUrl}/auth/callback/dev`),
    );
  }
  const oidc = new Oidc(config, fetchImpl);

  // State-changing requests must come from our own pages. Together with the
  // SameSite=Lax cookie this blocks cross-site request forgery.
  app.use("*", async (c, next) => {
    // A request that carries its token itself (a native app) is not exposed to forgery:
    // no other site can make a browser send that header.
    const selfAuthenticated =
      c.req.header("authorization")?.startsWith("Bearer ") || c.req.path === "/auth/app/token";
    // The company's identity provider sends the person back with a form from its own
    // page, so from its origin. What it carries is believed only if the provider signed
    // it, and it lets nobody in by itself (sso.ts).
    if (c.req.method === "POST" && c.req.path === "/auth/saml/acs") return next();
    const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (changes && !selfAuthenticated && !c.req.path.startsWith(`${DEV_IDP_PATH}/`)) {
      if (c.req.header("origin") !== config.publicUrl) return fail(c, "bad_origin");
    }
    // A page somewhere else says where it is from, token or no token: the desktop app shows
    // other pages inside its window (the preview of a dev server), and none of them may
    // change anything here as the person. A native app's own requests name no origin.
    const origin = c.req.header("origin");
    if (changes && selfAuthenticated && origin !== undefined && origin !== config.publicUrl)
      return fail(c, "bad_origin");
    await next();
  });

  // What the API says is for the person who asked and nobody after them, and is what it
  // says it is: never kept by a cache, never guessed to be another kind of content.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    if (/^\/(api|auth)\//.test(c.req.path) && !c.res.headers.has("cache-control"))
      c.header("cache-control", "no-store");
  });

  // A body sent to the API is JSON and of a size a person could have written. Files go
  // through their own route, which has its own limit.
  const jsonBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => fail(c, "too_large"),
  });
  app.use("/api/*", async (c, next) => {
    const upload = c.req.method === "POST" && c.req.path === "/api/app/files";
    if (upload || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const sends =
      Number(c.req.header("content-length") ?? 0) > 0 || c.req.header("transfer-encoding");
    const type = c.req.header("content-type") ?? "";
    if ((sends || type) && !/^application\/json\b/i.test(type)) return fail(c, "not_json");
    return jsonBody(c, async () => {
      // Text no database column holds: a null character, or half of a character pair.
      const text = await c.req.text();
      let value: unknown;
      try {
        value = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON at all: the route says so in its own words.
      }
      // What a person's computer read from a file is cleaned where it is taken in; a stray
      // null character in a log must not cost the agent its answer.
      const device = /^\/api\/app\/conversations\/[^/]+\/device\/[^/]+$/.test(c.req.path);
      if (!device && unstorable(value)) {
        c.res = fail(c, "invalid_request");
        return;
      }
      await next();
    });
  });

  // An address under /api that is nothing answers in the same shape as everything else.
  // A parameter given twice has no one meaning: it is refused, not read as its first value.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET" && c.req.url.includes("&")) {
      const seen = new Set<string>();
      for (const [key] of new URL(c.req.url).searchParams) {
        if (seen.has(key)) return fail(c, "invalid_request");
        seen.add(key);
      }
    }
    await next();
  });

  // One that is something, asked in a way it does not take, says which ways it takes.
  let known: { method: string; shape: RegExp }[] | undefined;
  const methodsAt = (path: string) => {
    known ??= app.routes
      .filter((route) => route.method !== "ALL" && !route.path.includes("*"))
      .map((route) => ({
        method: route.method,
        shape: new RegExp(
          `^${route.path.replace(/[.+?^$()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")}$`,
        ),
      }));
    return [
      ...new Set(known.filter((route) => route.shape.test(path)).map((route) => route.method)),
    ];
  };
  app.notFound((c) => {
    if (!c.req.path.startsWith("/api/")) return c.text("404 Not Found", 404);
    const taken = methodsAt(c.req.path);
    if (taken.length === 0) return fail(c, "not_found");
    // What answers GET answers HEAD as well.
    c.header("allow", [...taken, ...(taken.includes("GET") ? ["HEAD"] : [])].join(", "));
    return fail(c, "wrong_method");
  });

  // ---- sign-in ----

  app.get("/auth/providers", async (c) => {
    // A way in the organization set up for itself is its one way in.
    const own = (await Promise.all(ways.map((way) => way.offered()))).filter((one) => one !== null);
    if (own.length > 0) return c.json(own);
    return c.json(config.providers.map(({ id, label }) => ({ id, label })));
  });

  const loginCookie = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/auth" };

  app.get("/auth/login/:provider", async (c) => {
    const way = ways.find((one) => one.id === c.req.param("provider"));
    if (way) return way.begin(c);
    const provider = oidc.provider(c.req.param("provider"));
    if (!provider) return c.notFound();
    const { url, binding } = await oidc.begin(db, provider);
    // Ties the attempt to this browser: a callback link sent to someone else is useless.
    setCookie(c, LOGIN_COOKIE, binding, { ...loginCookie, maxAge: 600 });
    return c.redirect(url);
  });

  app.get("/auth/callback/:provider", async (c) => {
    const way = ways.find((one) => one.id === c.req.param("provider"));
    if (way?.complete) return way.complete(c);
    const provider = oidc.provider(c.req.param("provider"));
    if (!provider) return c.notFound();
    const denied = (reason: DenyReason | "failed") =>
      c.redirect(`${config.publicUrl}/?error=${reason}`);

    const binding = getCookie(c, LOGIN_COOKIE);
    deleteCookie(c, LOGIN_COOKIE, loginCookie);
    const identity = await oidc.complete(db, provider, new URL(c.req.url), binding);
    if (!identity) return denied("failed");
    const ip = clientIp(c);
    const previous = getCookie(c, SESSION_COOKIE);
    const result = await db
      .tx(async (tx) => {
        const admission = await admit(tx, config, identity, ip);
        if (!admission.ok) return admission;
        // A session this browser already held ends here, whoever it belonged to.
        if (previous) await revokeSessionByToken(tx, previous);
        const session = await createSession(tx, {
          userId: admission.userId,
          orgId: admission.orgId,
          provider: provider.id,
          days: config.sessionDays,
          ip,
          userAgent: c.req.header("user-agent") ?? null,
        });
        await recordEvent(tx, {
          orgId: admission.orgId,
          actor: { userId: admission.userId, email: identity.email.trim().toLowerCase() },
          action: "auth.login",
          detail: { provider: provider.id },
          ip,
        });
        return { ok: true as const, session };
      })
      .catch((error: unknown) => {
        if (error instanceof AdmissionConflict)
          return { ok: false as const, reason: "not_member" as const };
        throw error;
      });
    if (!result.ok) return denied(result.reason);
    setCookie(c, SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      expires: result.session.expiresAt,
    });
    // A native app started this sign-in: ask the person to confirm before letting it in.
    if (await pendingAppLogin(db, getCookie(c, APP_LOGIN_COOKIE)))
      return c.redirect(`${config.publicUrl}/auth/app/confirm`);
    return c.redirect(`${config.publicUrl}/`);
  });

  registerAppLogin(app, config, db, clientIp, async () =>
    (await Promise.all(ways.map((way) => way.offered()))).flatMap((one) => (one ? [one.id] : [])),
  );

  /** The session token: a native app sends it in a header, a browser in its cookie. */
  // A request that carries an Authorization header is judged by that header alone: it skipped
  // the Origin check on that basis, so it must never fall back to the browser's cookie.
  const tokenOf = (c: Context) => {
    const header = c.req.header("authorization");
    return header === undefined ? getCookie(c, SESSION_COOKIE) : header.match(/^Bearer (.+)$/)?.[1];
  };

  app.post("/auth/logout", async (c) => {
    const token = tokenOf(c);
    if (token) {
      await db.tx(async (tx) => {
        const session = await resolveSession(tx, token);
        await revokeSessionByToken(tx, token);
        if (session) {
          await recordEvent(tx, {
            orgId: session.org.id,
            actor: { userId: session.user.id, email: session.user.email },
            action: "auth.logout",
            ip: clientIp(c),
          });
        }
      });
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---- everything under /api needs a session ----

  app.use("/api/*", async (c, next) => {
    // A service sending a person back after they gave consent arrives in whatever browser
    // they used, which may hold no session (the desktop app opens the system's browser).
    // That one address is let through: what it carries is tied to the person who began.
    const token = tokenOf(c);
    const session = token ? await resolveSession(db, token) : null;
    // It still says who is asking when the browser does hold a session: see connectors.ts.
    if (c.req.method === "GET" && CONSENT_ANSWER.test(c.req.path)) {
      if (session) c.set("session", session);
      return next();
    }
    if (!session) return fail(c, "unauthenticated");
    c.set("session", session);
    await next();
  });

  const need = (c: Ctx, permission: Permission) =>
    can(c.get("session").role, permission) ? null : fail(c, "forbidden");
  const actorOf = (c: Ctx) => {
    const s = c.get("session");
    return { userId: s.user.id, email: s.user.email };
  };
  const body = async <T>(c: Ctx, schema: z.ZodType<T>, code: ErrorCode): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new Refusal(code);
    return parsed.data;
  };
  app.get("/api/me", (c) => {
    const s = c.get("session");
    return c.json({
      user: s.user,
      org: s.org,
      role: s.role,
      permissions: permissionsOf(s.role),
      sessionId: s.sessionId,
    });
  });

  // ---- members ----

  app.get("/api/members", async (c) => {
    const denied = need(c, "members.read");
    if (denied) return denied;
    const rows = await db.query(
      `select u.id, u.email, u.name, u.avatar_url as "avatarUrl", u.last_login_at as "lastLoginAt",
              m.role, m.status, m.joined_at as "joinedAt", m.joined_via as "joinedVia",
              m.department_id as "departmentId", d.name as "departmentName"
         from memberships m
         join users u on u.id = m.user_id
         left join departments d on d.id = m.department_id
        where m.org_id = $1
        order by m.joined_at, u.email`,
      [c.get("session").org.id],
    );
    return c.json(rows);
  });

  const MemberPatch = z.strictObject({
    role: RoleSchema.optional(),
    status: z.enum(["active", "suspended"]).optional(),
    departmentId: IdSchema.nullable().optional(),
  });

  /**
   * Starts a change to a member. It locks the organization row, so changes to who
   * holds which role happen one at a time (two owners cannot demote each other at
   * once), and it reads the actor's role again inside that lock rather than
   * trusting what the request started with.
   */
  const beginMemberChange = async (c: Ctx, tx: Queryable, selfOk = false) => {
    const s = c.get("session");
    const id = c.req.param("id") ?? "";
    if (!isId(id)) throw new Refusal("not_found");
    await tx.query("select 1 from organizations where id = $1 for update", [s.org.id]);
    const actor = (
      await tx.query<{ role: Role }>(
        "select role from memberships where org_id = $1 and user_id = $2 and status = 'active'",
        [s.org.id, s.user.id],
      )
    )[0];
    if (!actor || !can(actor.role, "members.manage")) throw new Refusal("forbidden");
    const target = (
      await tx.query<{
        user_id: string;
        email: string;
        role: Role;
        status: string;
        department_id: string | null;
      }>(
        `select m.user_id, u.email, m.role, m.status, m.department_id
           from memberships m join users u on u.id = m.user_id
          where m.org_id = $1 and m.user_id = $2`,
        [s.org.id, id],
      )
    )[0];
    if (!target) throw new Refusal("not_found");
    // Nobody changes their own role or standing. Which department they are in is another
    // matter: a sole owner would otherwise never have one.
    if (target.user_id === s.user.id) {
      if (!selfOk) throw new Refusal("self");
      return { target, actorRole: actor.role };
    }
    if (!canManage(actor.role, target.role)) throw new Refusal("owner_only");
    return { target, actorRole: actor.role };
  };

  /** Refuses when the organization would be left with no active owner if `userId` stopped being one. */
  const keepAnOwner = async (tx: Queryable, orgId: string, userId: string) => {
    const others = await tx.query(
      "select 1 from memberships where org_id = $1 and role = 'owner' and status = 'active' and user_id <> $2 limit 1",
      [orgId, userId],
    );
    if (others.length === 0) throw new Refusal("last_owner");
  };

  app.patch("/api/members/:id", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const patch = await body(c, MemberPatch, "invalid_request");
    const s = c.get("session");
    const response = await inTx(c, async (tx) => {
      const { target, actorRole } = await beginMemberChange(
        c,
        tx,
        Object.keys(patch).every((key) => key === "departmentId"),
      );
      // Someone removed can only be let back in, and whatever else is asked goes with that.
      if (target.status === "removed" && patch.status !== "active") throw new Refusal("not_found");
      const who = { type: "member", id: target.user_id, label: target.email };
      const set = (column: string, value: unknown) =>
        tx.query(`update memberships set ${column} = $3 where org_id = $1 and user_id = $2`, [
          s.org.id,
          target.user_id,
          value,
        ]);

      if (patch.role && patch.role !== target.role) {
        if (!canGrant(actorRole, patch.role)) throw new Refusal("owner_only");
        if (target.role === "owner" && target.status === "active")
          await keepAnOwner(tx, s.org.id, target.user_id);
        await set("role", patch.role);
        await recordEvent(tx, {
          orgId: s.org.id,
          actor: actorOf(c),
          action: "member.role_changed",
          target: who,
          detail: { from: target.role, to: patch.role },
          ip: clientIp(c),
        });
      }

      if (patch.status && patch.status !== target.status) {
        if (patch.status === "suspended" && target.role === "owner")
          await keepAnOwner(tx, s.org.id, target.user_id);
        await set("status", patch.status);
        const ended =
          patch.status === "suspended" ? await revokeSessionsOfUser(tx, target.user_id) : 0;
        await recordEvent(tx, {
          orgId: s.org.id,
          actor: actorOf(c),
          action: patch.status === "suspended" ? "member.suspended" : "member.reactivated",
          target: who,
          // Let back in after being removed, or after being suspended: the record says which.
          detail: patch.status === "suspended" ? { sessionsEnded: ended } : { from: target.status },
          ip: clientIp(c),
        });
      }

      if (patch.departmentId !== undefined && patch.departmentId !== target.department_id) {
        let name: string | null = null;
        if (patch.departmentId) {
          const department = (
            await tx.query<{ name: string }>(
              "select name from departments where id = $1 and org_id = $2",
              [patch.departmentId, s.org.id],
            )
          )[0];
          if (!department) throw new Refusal("department_missing");
          name = department.name;
        }
        await set("department_id", patch.departmentId);
        await recordEvent(tx, {
          orgId: s.org.id,
          actor: actorOf(c),
          action: "member.department_changed",
          target: who,
          detail: {
            from: target.department_id
              ? ((
                  await tx.query<{ name: string }>("select name from departments where id = $1", [
                    target.department_id,
                  ])
                )[0]?.name ?? null)
              : null,
            to: name,
          },
          ip: clientIp(c),
        });
      }
      return c.json({ ok: true });
    });
    return endWorkOf(c, response);
  });

  app.delete("/api/members/:id", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const s = c.get("session");
    const response = await inTx(c, async (tx) => {
      const { target } = await beginMemberChange(c, tx);
      if (target.status === "removed") throw new Refusal("not_found");
      if (target.role === "owner" && target.status === "active")
        await keepAnOwner(tx, s.org.id, target.user_id);
      const ended = await revokeSessionsOfUser(tx, target.user_id);
      // The row stays, marked removed, so a domain rule cannot let the person straight back in.
      await tx.query(
        "update memberships set status = 'removed', role = 'member', department_id = null where org_id = $1 and user_id = $2",
        [s.org.id, target.user_id],
      );
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "member.removed",
        target: { type: "member", id: target.user_id, label: target.email },
        detail: { role: target.role, sessionsEnded: ended },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
    return endWorkOf(c, response);
  });

  // ---- departments ----

  app.get("/api/departments", async (c) => {
    const denied = need(c, "members.read");
    if (denied) return denied;
    const rows = await db.query<{ id: string; name: string; members: string }>(
      `select d.id, d.name, count(m.user_id) as members
         from departments d left join memberships m on m.department_id = d.id and m.status <> 'removed'
        where d.org_id = $1 group by d.id order by d.name`,
      [c.get("session").org.id],
    );
    return c.json(rows.map((r) => ({ ...r, members: Number(r.members) })));
  });

  const DepartmentBody = z.strictObject({ name: plainName(60) });

  app.post("/api/departments", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const { name } = await body(c, DepartmentBody, "invalid_department_name");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      const id = newId();
      const created = await tx.query(
        "insert into departments (id, org_id, name) values ($1, $2, $3) on conflict (org_id, name) do nothing returning id",
        [id, s.org.id, name],
      );
      if (created.length === 0) throw new Refusal("department_exists");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "department.created",
        target: { type: "department", id, label: name },
        ip: clientIp(c),
      });
      return c.json({ id, name, members: 0 });
    });
  });

  app.patch("/api/departments/:id", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const { name } = await body(c, DepartmentBody, "invalid_department_name");
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      // Lock the organization's departments so the name check and the write agree.
      await tx.query("select 1 from organizations where id = $1 for update", [s.org.id]);
      const clash = await tx.query(
        "select 1 from departments where org_id = $1 and name = $2 and id <> $3",
        [s.org.id, name, id],
      );
      if (clash.length > 0) throw new Refusal("department_exists");
      const before = (
        await tx.query<{ name: string }>(
          "select name from departments where id = $1 and org_id = $2",
          [id, s.org.id],
        )
      )[0];
      if (!before) throw new Refusal("not_found");
      // The same name again changes nothing, so nothing is recorded as changed.
      if (before.name === name) return c.json({ ok: true });
      await tx.query("update departments set name = $3 where id = $1 and org_id = $2", [
        id,
        s.org.id,
        name,
      ]);
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "department.renamed",
        target: { type: "department", id, label: name },
        detail: { from: before.name, to: name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.delete("/api/departments/:id", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      // Who was in it: they are in no department afterwards, and the record says who.
      const members = await tx.query<{ email: string }>(
        "select u.email from memberships m join users u on u.id = m.user_id where m.org_id = $2 and m.department_id = $1 order by u.email",
        [id, s.org.id],
      );
      const removed = await tx.query<{ name: string }>(
        "delete from departments where id = $1 and org_id = $2 returning name",
        [id, s.org.id],
      );
      if (!removed[0]) throw new Refusal("not_found");
      // What was shared with the department as such is shared with nobody now.
      await tx.query("delete from shares where to_kind = 'department' and to_id = $1", [id]);
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "department.deleted",
        target: { type: "department", id, label: removed[0].name },
        detail: { count: members.length, members: members.slice(0, 20).map((m) => m.email) },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- invitations ----

  app.get("/api/invitations", async (c) => {
    const denied = need(c, "members.read");
    if (denied) return denied;
    const rows = await db.query(
      `select i.id, i.email, i.role, i.created_at as "createdAt", i.expires_at as "expiresAt",
              d.name as "departmentName", u.email as "invitedBy",
              case when i.accepted_at is not null then 'accepted'
                   when i.revoked_at is not null then 'revoked'
                   when i.expires_at <= now() then 'expired'
                   else 'pending' end as state
         from invitations i
         join users u on u.id = i.invited_by
         left join departments d on d.id = i.department_id
        where i.org_id = $1
        order by i.created_at desc, i.id desc limit 200`,
      [c.get("session").org.id],
    );
    return c.json(rows);
  });

  const InvitationBody = z.strictObject({
    email: EmailSchema,
    role: RoleSchema,
    departmentId: IdSchema.nullable().optional(),
  });

  app.post("/api/invitations", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const {
      email,
      role,
      departmentId = null,
    } = await body(c, InvitationBody, "invalid_invitation");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      await tx.query("select 1 from organizations where id = $1 for update", [s.org.id]);
      const actor = (
        await tx.query<{ role: Role }>(
          "select role from memberships where org_id = $1 and user_id = $2 and status = 'active'",
          [s.org.id, s.user.id],
        )
      )[0];
      if (!actor || !canGrant(actor.role, role)) throw new Refusal("owner_only");
      // A person belongs to one organization, so membership anywhere blocks the invitation.
      // ...and so does having been removed from a different organization.
      const member = await tx.query(
        "select 1 from memberships m join users u on u.id = m.user_id where u.email = $1 and (m.status <> 'removed' or m.org_id <> $2)",
        [email, s.org.id],
      );
      if (member.length > 0) throw new Refusal("already_member");
      if (departmentId) {
        const department = await tx.query(
          "select 1 from departments where id = $1 and org_id = $2",
          [departmentId, s.org.id],
        );
        if (department.length === 0) throw new Refusal("department_missing");
      }
      // Our own expired invitation still occupies the open slot; clear it so a new one can be sent.
      await tx.query(
        `update invitations set revoked_at = now()
          where org_id = $1 and email = $2 and accepted_at is null and revoked_at is null and expires_at <= now()`,
        [s.org.id, email],
      );
      const id = newId();
      const created = await tx.query(
        `insert into invitations (id, org_id, email, role, department_id, invited_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)
         on conflict do nothing returning id`,
        [id, s.org.id, email, role, departmentId, s.user.id, String(INVITATION_DAYS)],
      );
      if (created.length === 0) throw new Refusal("already_invited");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "invitation.created",
        target: { type: "invitation", id, label: email },
        detail: { role },
        ip: clientIp(c),
      });
      return c.json({ id });
    });
  });

  app.delete("/api/invitations/:id", async (c) => {
    const denied = need(c, "members.manage");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      const open = (
        await tx.query<{ role: Role }>(
          "select role from invitations where id = $1 and org_id = $2 and accepted_at is null and revoked_at is null for update",
          [id, s.org.id],
        )
      )[0];
      if (!open) throw new Refusal("not_found");
      // Whoever may not hand out a role may not withdraw an invitation to it either.
      if (!canGrant(s.role, open.role)) throw new Refusal("owner_only");
      const revoked = await tx.query<{ email: string }>(
        "update invitations set revoked_at = now() where id = $1 returning email",
        [id],
      );
      if (!revoked[0]) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "invitation.revoked",
        target: { type: "invitation", id, label: revoked[0].email },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- sign-in settings ----

  app.get("/api/settings/sign-in", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    const domains = await db.query(
      `select domain, auto_join as "autoJoin" from org_domains where org_id = $1 order by domain`,
      [c.get("session").org.id],
    );
    return c.json({
      // Which identity system, and which directory in it: never a secret.
      providers: config.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        // Whether being in this provider is what makes a person a member.
        admits:
          provider.id === "microsoft" || (provider.id === "oidc" && provider.directory === true),
        directory:
          provider.id === "microsoft"
            ? provider.tenant
            : provider.id === "oidc"
              ? new URL(provider.issuer).host
              : null,
      })),
      domains,
      sessionDays: config.sessionDays,
      invitationDays: INVITATION_DAYS,
    });
  });

  app.put("/api/settings/sign-in/domains/:domain", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const domain = DomainSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return fail(c, "invalid_domain");
    const { autoJoin } = await body(
      c,
      z.strictObject({ autoJoin: z.boolean() }),
      "invalid_request",
    );
    if (autoJoin && isPublicDomain(domain.data)) return fail(c, "public_domain");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      const was = (
        await tx.query<{ auto: boolean }>(
          "select auto_join as auto from org_domains where org_id = $1 and domain = $2",
          [s.org.id, domain.data],
        )
      )[0];
      // Set to what it already is: nothing changed, nothing recorded.
      if (was && was.auto === autoJoin) return c.json({ ok: true });
      const saved = await tx.query(
        `insert into org_domains (org_id, domain, auto_join) values ($1, $2, $3)
         on conflict (domain) do update set auto_join = excluded.auto_join where org_domains.org_id = excluded.org_id
         returning domain`,
        [s.org.id, domain.data, autoJoin],
      );
      if (saved.length === 0) throw new Refusal("domain_taken");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "signin.domain_set",
        target: { type: "domain", id: domain.data, label: domain.data },
        detail: { autoJoin },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  app.delete("/api/settings/sign-in/domains/:domain", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const s = c.get("session");
    const domain = c.req.param("domain").toLowerCase();
    return inTx(c, async (tx) => {
      const removed = await tx.query(
        "delete from org_domains where org_id = $1 and domain = $2 returning domain",
        [s.org.id, domain],
      );
      if (removed.length === 0) throw new Refusal("not_found");
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "signin.domain_removed",
        target: { type: "domain", id: domain, label: domain },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- sessions ----

  app.get("/api/sessions", async (c) => {
    const denied = need(c, "sessions.read");
    if (denied) return denied;
    const s = c.get("session");
    const rows = await db.query<{ id: string }>(
      `select s.public_id as id, u.email, u.name, s.provider, s.kind, s.created_at as "createdAt",
              s.last_seen_at as "lastSeenAt", s.expires_at as "expiresAt", s.ip, s.user_agent as "userAgent"
         from sessions s join users u on u.id = s.user_id
        where s.org_id = $1 and s.revoked_at is null and s.expires_at > now()
        order by s.last_seen_at desc limit 500`,
      [s.org.id],
    );
    return c.json(rows.map((r) => ({ ...r, current: r.id === s.sessionId })));
  });

  app.delete("/api/sessions/:id", async (c) => {
    const denied = need(c, "sessions.revoke");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const s = c.get("session");
    return inTx(c, async (tx) => {
      const found = (
        await tx.query<{
          user_id: string;
          email: string;
          role: Role;
          user_agent: string | null;
          ip: string | null;
        }>(
          `select s.user_id, u.email, m.role, s.user_agent, s.ip from sessions s
             join users u on u.id = s.user_id
             join memberships m on m.user_id = s.user_id and m.org_id = s.org_id
            where s.public_id = $1 and s.org_id = $2 and s.revoked_at is null`,
          [id, s.org.id],
        )
      )[0];
      if (!found) throw new Refusal("not_found");
      if (found.user_id !== s.user.id && !canManage(s.role, found.role))
        throw new Refusal("owner_only");
      await tx.query("update sessions set revoked_at = now() where public_id = $1", [id]);
      await recordEvent(tx, {
        orgId: s.org.id,
        actor: actorOf(c),
        action: "session.revoked",
        target: { type: "session", id, label: found.email },
        // Which sign-in it was, and whether the person ended their own or someone ended it for them.
        detail: {
          by: found.user_id === s.user.id ? "self" : "administrator",
          device: (found.user_agent ?? "").slice(0, 200) || null,
          from: found.ip ?? null,
        },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // ---- record of administrative actions ----

  app.get("/api/audit", async (c) => {
    const denied = need(c, "audit.read");
    if (denied) return denied;
    // A whole number written in digits: not empty, not hexadecimal. One outside what is
    // served is refused, as it is for traces.
    const raw = c.req.query("before");
    if (raw !== undefined && !/^\d{1,15}$/.test(raw)) return fail(c, "invalid_request");
    const before = raw === undefined ? null : Number(raw);
    const wanted = c.req.query("limit");
    if (wanted !== undefined && !/^\d{1,4}$/.test(wanted)) return fail(c, "invalid_request");
    const limit = Number(wanted ?? 50);
    if (limit < 1 || limit > 100) return fail(c, "invalid_request");
    const filter = eventFilter(c);
    if (!filter) return fail(c, "invalid_request");
    return c.json(await listEvents(db, c.get("session").org.id, before, limit, filter));
  });

  // The same record as a file, for an auditor to keep. Taking it is itself on the record.
  app.get("/api/audit/export", async (c) => {
    const denied = need(c, "audit.read");
    if (denied) return denied;
    const filter = eventFilter(c);
    if (!filter) return fail(c, "invalid_request");
    // Asking only for the headers takes nothing, so nothing is recorded as taken.
    if (c.req.method === "HEAD") return c.body(null, 200, { "content-type": "text/csv" });
    const s = c.get("session");
    const rows = await listEvents(db, s.org.id, null, EXPORT_ROWS, filter);
    await recordEvent(db, {
      orgId: s.org.id,
      actor: actorOf(c),
      action: "audit.exported",
      detail: { rows: rows.length, ...filter },
      ip: clientIp(c),
    });
    // A cell that starts like a formula is marked as text, so opening the file runs nothing.
    const cell = (value: unknown) => {
      const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const lines = [
      ["time", "actor", "action", "target_type", "target", "detail", "ip"].join(","),
      ...rows.map((row) =>
        [
          (row.time as Date).toISOString(),
          row.actorEmail,
          row.action,
          row.targetType,
          row.targetLabel,
          row.detail,
          row.ip,
        ]
          .map(cell)
          .join(","),
      ),
    ];
    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="muster-activity-log.csv"',
        "cache-control": "no-store",
      },
    });
  });

  extend?.(app, {
    need,
    actorOf,
    clientIp,
    inTx,
    onMemberBlocked: (fn) => {
      whenBlocked.push(fn);
    },
    memberBlocked,
    signInWith: (way) => {
      ways.push(way);
    },
  });
  return app;
}

const EXPORT_ROWS = 10_000;
/** What narrows the record: words, and the days it covers. */
interface EventFilter {
  q: string;
  from: string | null;
  to: string | null;
  actions: string[];
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Reads the filter from the address. Null when a day is not a day. */
function eventFilter(c: Context): EventFilter | null {
  const from = c.req.query("from") || null;
  const to = c.req.query("to") || null;
  // A day has the right shape and is a day of the calendar: 2026-02-30 is neither accepted nor an error later.
  const real = (day: string) =>
    DAY.test(day) &&
    day >= "1900-01-01" &&
    !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if ((from && !real(from)) || (to && !real(to))) return null;
  // The page sends the names of the actions whose label, in the reader's language, holds the words.
  const actions = (c.req.query("actions") ?? "")
    .split(",")
    .filter((name) => /^[a-z_.]{1,60}$/.test(name))
    .slice(0, 60);
  return { q: (c.req.query("q") ?? "").trim().slice(0, 100), from, to, actions };
}

/** Newest first. `before` is the `seq` of the last event of the previous page. */
export async function listEvents(
  db: Queryable,
  orgId: string,
  before: number | null,
  limit: number,
  filter: EventFilter = { q: "", from: null, to: null, actions: [] },
) {
  // The words are looked for in who did it, what was done and what it was done to.
  const like = filter.q ? `%${filter.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db.query<{
    seq: string;
    time: Date;
    actorEmail: string;
    action: string;
    targetType: string | null;
    targetLabel: string | null;
    detail: unknown;
    ip: string | null;
  }>(
    `select id, seq, time, actor_email as "actorEmail", action, target_type as "targetType",
            target_label as "targetLabel", detail, ip
       from admin_events
      where org_id = $1 and ($2::bigint is null or seq < $2::bigint)
        and (($4::text is null and cardinality($7::text[]) = 0)
             or actor_email ilike $4 or action ilike $4 or target_label ilike $4
             or action = any($7::text[]))
        and ($5::date is null or time >= $5::date)
        and ($6::date is null or time < $6::date + 1)
      order by seq desc limit $3`,
    [orgId, before, limit, like, filter.from, filter.to, filter.actions],
  );
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}
