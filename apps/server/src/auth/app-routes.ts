import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../app.js";
import { recordEvent } from "../audit.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  APP_LOGIN_COOKIE,
  approveAppLogin,
  beginAppLogin,
  pendingAppLogin,
  redeemAppLogin,
} from "./app-login.js";
import { createSession, resolveSession, SESSION_COOKIE } from "./session.js";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Sign-in for native apps (desktop, mobile).
 *
 * Identity providers refuse to sign people in inside an app's embedded web view, so
 * the app opens the system browser here. The person signs in as usual, confirms on a
 * page we serve, and the browser is sent back to the app with a one-time code. The app
 * exchanges the code, plus a secret only it holds (PKCE), for a session token.
 */
export function registerAppLogin(
  app: Hono<Env>,
  config: Config,
  db: Db,
  clientIp: (c: Context) => string | null,
): void {
  const secure = config.publicUrl.startsWith("https://");
  const cookie = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/auth" };
  const home = `${config.publicUrl}/`;
  const signedIn = async (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    return token ? resolveSession(db, token) : null;
  };

  app.get("/auth/app/start", async (c) => {
    const id = await beginAppLogin(
      db,
      c.req.query("challenge") ?? "",
      c.req.query("redirect") ?? "",
    );
    if (!id) return c.text("This sign-in link is not valid.", 400);
    setCookie(c, APP_LOGIN_COOKIE, id, { ...cookie, maxAge: 600 });
    if (await signedIn(c)) return c.redirect(`${config.publicUrl}/auth/app/confirm`);
    // Not signed in yet. The app said which provider the person pressed, or there is only
    // one: go straight to it. Otherwise the person chooses on the sign-in page.
    const asked = c.req.query("provider");
    // The organization's own way in, set up in the console (sso.ts): the app names it as
    // the sign-in page offered it.
    if (asked === "saml") return c.redirect(`${config.publicUrl}/auth/login/saml`);
    const [only, ...others] = config.providers;
    const chosen =
      config.providers.find((provider) => provider.id === asked) ??
      (others.length === 0 ? only : undefined);
    return c.redirect(chosen ? `${config.publicUrl}/auth/login/${chosen.id}` : home);
  });

  app.get("/auth/app/confirm", async (c) => {
    const pending = await pendingAppLogin(db, getCookie(c, APP_LOGIN_COOKIE));
    const session = await signedIn(c);
    if (!pending || !session) return c.redirect(home);
    // The page is the server's own, so it reads the browser's language itself.
    const zh = /^\s*zh\b/i.test(c.req.header("accept-language") ?? "");
    const phone = pending.redirect.startsWith("muster://");
    // Kept from a proxy that would replace it with "[email protected]" (see keepAddresses
    // in connectors.ts): this page runs no script that could put it back.
    const email = `<!--email_off--><b>${escapeHtml(session.user.email)}</b><!--/email_off-->`;
    const words = zh
      ? {
          lang: "zh-CN",
          title: "登录 Muster 应用",
          heading: "要登录 Muster 应用吗？",
          body: `这会让 ${email} 登录到${phone ? "这台设备上的 Muster 应用" : "这台电脑上的 Muster 桌面应用"}。只有在你刚刚从应用里发起登录时才继续。`,
          go: "继续",
          no: "取消",
        }
      : {
          lang: "en",
          title: "Sign in to the Muster app",
          heading: "Sign in to the Muster app?",
          body: `This will sign ${email} in to ${phone ? "the Muster app on this device" : "the Muster desktop app on this computer"}. Continue only if you just started this from the app.`,
          go: "Continue",
          no: "Cancel",
        };
    // No script, and the only form posts back to us; the Origin check covers that POST.
    // Browsers apply form-action to the redirect that follows too, so the app's own
    // address is named: the one place this sign-in may hand its code to.
    const back = pending.redirect.startsWith("muster://")
      ? "muster:"
      : new URL(pending.redirect).origin;
    // Not kept by anything in between, and handed on as it is written.
    c.header("cache-control", "no-store, no-transform");
    c.header(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' ${back}`,
    );
    return c.html(`<!doctype html><html lang="${words.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${words.title}</title>
<style>body{font:15px -apple-system,"Segoe UI",sans-serif;background:#f7f7f8;margin:0;display:grid;place-items:center;min-height:100dvh;color:#0d0d0d}
main{background:#fff;border:1px solid #0000001a;border-radius:16px;padding:28px;width:min(92vw,380px);text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#666970;margin:0 0 20px;font-size:14px}b{color:#0d0d0d}
button{font:inherit;font-weight:500;border:0;border-radius:999px;padding:10px 20px;width:100%;cursor:pointer}
.go{background:#000;color:#fff}.no{background:none;color:#666970;margin-top:8px}
@media (prefers-color-scheme:dark){body{background:#000;color:#fff}main{background:#1a1d22;border-color:#ffffff1a}b{color:#fff}.go{background:#fff;color:#000}}</style></head><body><main>
<h1>${words.heading}</h1>
<p>${words.body}</p>
<form method="post" action="/auth/app/approve"><button class="go" name="decision" value="allow">${words.go}</button><button class="no" name="decision" value="deny">${words.no}</button></form>
</main></body></html>`);
  });

  app.post("/auth/app/approve", async (c) => {
    const id = getCookie(c, APP_LOGIN_COOKIE);
    deleteCookie(c, APP_LOGIN_COOKIE, cookie);
    const session = await signedIn(c);
    // A body that is not a form is the same as no answer.
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    if (!id || !session || form.decision !== "allow") {
      if (id) await db.query("delete from app_logins where id = $1", [id]);
      return c.redirect(home);
    }
    const provider =
      (
        await db.query<{ provider: string }>("select provider from sessions where public_id = $1", [
          session.sessionId,
        ])
      )[0]?.provider ?? "";
    const target = await approveAppLogin(db, id, {
      userId: session.user.id,
      orgId: session.org.id,
      provider,
    });
    return c.redirect(target ?? home);
  });

  app.post("/auth/app/token", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      code?: unknown;
      verifier?: unknown;
    } | null;
    const ip = clientIp(c);
    const session = await db.tx(async (tx) => {
      const who = await redeemAppLogin(tx, String(body?.code ?? ""), String(body?.verifier ?? ""));
      if (!who) return null;
      // The person may have been suspended or removed between approving and exchanging.
      const member = (
        await tx.query<{ email: string }>(
          "select u.email from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.org_id = $2 and m.status = 'active'",
          [who.userId, who.orgId],
        )
      )[0];
      if (!member) return null;
      const created = await createSession(tx, {
        userId: who.userId,
        orgId: who.orgId,
        provider: who.provider,
        days: config.sessionDays,
        kind: "app",
        ip,
        userAgent: c.req.header("user-agent") ?? null,
      });
      await recordEvent(tx, {
        orgId: who.orgId,
        actor: { userId: who.userId, email: member.email },
        action: "auth.login",
        detail: { provider: who.provider, app: true },
        ip,
      });
      return created;
    });
    if (!session)
      return c.json(
        { error: { code: "unauthenticated", message: "This sign-in code is not valid." } },
        401,
      );
    return c.json({ token: session.token, expiresAt: session.expiresAt });
  });
}
