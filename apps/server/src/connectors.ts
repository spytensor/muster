import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { servicesOff, servicesSending } from "./company.js";
import type { Config } from "./config.js";
import {
  type Connections,
  ConnectorError,
  MICROSOFT_SCOPES,
  MICROSOFT_SEND_SCOPES,
  WrongPerson,
} from "./connections.js";
import type { Db } from "./db.js";

const safe = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/**
 * Wraps what the server writes into a page of its own that names a person's address. A
 * proxy in front (Cloudflare) rewrites addresses it finds in HTML into a placeholder that
 * a script of its own restores; these pages run no script, so the person would read
 * "[email protected]". The comments tell it to leave what is between them alone.
 */
export const keepAddresses = (html: string) => `<!--email_off-->${html}<!--/email_off-->`;

/** The words of the page a person lands on, in the two languages the product speaks. */
const WORDS = {
  en: {
    connected: "Microsoft 365 is connected",
    as: "Connected as",
    can: "Agents working for you can now",
    list: [
      "Search and read your Outlook mail",
      "Read your calendar",
      "Find and read files in OneDrive and SharePoint",
      "Read your Teams chats",
    ],
    only: "Agents only read. They can draft a mail or a Teams message for you, and it is sent only when you press Send on it. They cannot change your calendar or files. You can disconnect at any time in Settings, under Connections.",
    back: "Back to Muster",
    close: "You can close this tab.",
    failed: "Microsoft 365 was not connected",
    declined: "You did not give consent, so nothing was connected.",
    incomplete: "The answer from Microsoft was not complete. Try connecting again from Muster.",
    stale: "This link is no longer good",
    staleLead: "It was already used or is more than ten minutes old. Start again from Muster.",
    refused:
      "Microsoft did not accept the request. An operator may need to check how Muster is registered there.",
    wrong: (account: string) =>
      `${account} gave consent, but that is not the account Muster knows you by, so nothing was connected. Open the link in the browser where you are signed in to Muster, or choose your own work account at Microsoft.`,
  },
  zh: {
    connected: "Microsoft 365 已连接",
    as: "已连接账号",
    can: "为你工作的 Agent 现在可以",
    list: [
      "搜索和阅读你的 Outlook 邮件",
      "查看你的日历",
      "查找和阅读 OneDrive、SharePoint 里的文件",
      "阅读你的 Teams 聊天",
    ],
    only: "Agent 只能读取。它可以为你起草邮件或 Teams 消息，只有你点了“发送”才会发出。它不能改你的日历和文件。你可以随时在“设置 → 连接”里断开。",
    back: "回到 Muster",
    close: "可以关闭这个标签页了。",
    failed: "Microsoft 365 没有连接成功",
    declined: "你没有同意授权，所以没有连接任何内容。",
    incomplete: "微软返回的信息不完整。请回到 Muster 重新连接。",
    stale: "这个链接已失效",
    staleLead: "它已经被用过，或者超过了十分钟。请回到 Muster 重新开始。",
    refused: "微软没有接受这次请求。可能需要运维检查 Muster 在微软那边的注册信息。",
    wrong: (account: string) =>
      `授权的是 ${account}，但它不是你在 Muster 里的账号，所以没有连接任何内容。请在已登录 Muster 的浏览器里打开链接，或在微软那边选择你自己的工作账号。`,
  },
};
type Words = (typeof WORDS)["en"];

const MUSTER_MARK = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><circle cx="9" cy="11" r="2.6"/><rect x="14" y="8.6" width="11" height="4.8" rx="2.4"/><circle cx="9" cy="21" r="2.6"/><rect x="14" y="18.6" width="11" height="4.8" rx="2.4" opacity=".55"/></svg>`;
const MICROSOFT_MARK = `<svg viewBox="0 0 21 21" width="24" height="24" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/**
 * The page a person lands on after the service's consent page. It shows the two sides
 * joined (or not), who was connected and what that allows. It runs nothing and loads
 * nothing: everything it needs is in it, and it follows the system's light or dark look.
 */
function page(
  words: Words,
  lang: string,
  home: string,
  result: { ok: true; account: string } | { ok: false; title: string; lead: string },
): string {
  const body = result.ok
    ? `<h1>${safe(words.connected)}</h1>
<p class="account">${safe(words.as)} <b class="who">${safe(result.account)}</b></p>
<section><h2>${safe(words.can)}</h2><ul>${words.list.map((line) => `<li>${CHECK}<span>${safe(line)}</span></li>`).join("")}</ul></section>
<p class="note">${safe(words.only)}</p>`
    : `<h1>${safe(result.title)}</h1><p class="lead">${safe(result.lead)}</p>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(result.ok ? words.connected : result.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--ink:#0d0d0d;--muted:#666970;--line:#0000001a;--ok:#17a673;--bad:#d14343;--btn:#0d0d0d;--btn-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1a1d22;--card:#1a1d22;--ink:#fff;--muted:#9aa0a8;--line:#ffffff1a;--btn:#fff;--btn-ink:#0d0d0d}}
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;width:min(100%,384px)}
.join{display:flex;align-items:center;justify-content:center;margin-bottom:20px}
.tile{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;border:1px solid var(--line)}
.tile svg{width:22px;height:22px}
.tile.muster{background:var(--ink);color:var(--card);border-color:transparent}.tile.muster svg{fill:currentColor}
.link{width:48px;height:1px;background:var(--line);position:relative}
.link b{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--${result.ok ? "ok" : "bad"});box-shadow:0 0 0 4px var(--card)}
.link b svg{width:11px;height:11px}
h1{font-size:20px;font-weight:600;line-height:1.3;margin:0 0 4px;text-align:center;letter-spacing:-.015em}
.account,.lead{color:var(--muted);margin:0 0 20px;text-align:center;overflow-wrap:anywhere}
/* Whatever is put in place of the address stays plain text in the line. */
.account *{all:unset}.account .who{color:var(--ink);font-weight:500}
section{border-top:1px solid var(--line);padding:16px 0 4px}
h2{font-size:13px;font-weight:500;color:var(--muted);margin:0 0 8px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
li{display:flex;gap:8px;align-items:flex-start}li svg{flex:none;margin-top:4px;color:var(--ok)}
.note{font-size:12px;color:var(--muted);margin:12px 0 20px}
.actions{display:grid;gap:10px;justify-items:center}
.actions a{display:block;width:100%;text-align:center;background:var(--btn);color:var(--btn-ink);text-decoration:none;border-radius:8px;padding:11px 16px;font-size:15px;font-weight:500}
.close{font-size:12px;color:var(--muted)}
</style></head>
<body><main>
<div class="join"><span class="tile muster">${MUSTER_MARK}</span><span class="link"><b>${result.ok ? CHECK : CROSS}</b></span><span class="tile">${MICROSOFT_MARK}</span></div>
${keepAddresses(body)}
<div class="actions"><a href="${safe(home)}">${safe(words.back)}</a><span class="close">${safe(words.close)}</span></div>
</main></body></html>`;
}

/** People's connections to other services: see them, make one, take one back. */
export function registerConnectors(
  app: Hono<Env>,
  kit: AppKit,
  db: Db,
  config: Config,
  connections: Connections,
): void {
  const owner = (c: Ctx) => {
    const s = c.get("session");
    return { orgId: s.org.id, userId: s.user.id };
  };

  // A service an administrator switched off for the company is not offered to anyone.
  const isOff = async (c: Ctx) => (await servicesOff(db, owner(c).orgId)).includes("microsoft");
  app.get("/api/app/connectors", async (c) => {
    const off = await isOff(c);
    return c.json(
      (await connections.list(owner(c))).map((service) =>
        off ? { ...service, available: false, off: true } : service,
      ),
    );
  });

  // A person who is suspended or removed no longer has agents working for them, so what
  // they let those agents read is given up too.
  kit.onMemberBlocked(async (userId) => {
    for (const ended of await connections.removeAll(userId))
      await recordEvent(db, {
        orgId: ended.orgId,
        actor: { userId: null, email: "muster (member suspended or removed)" },
        action: "connector.disconnected",
        target: { type: "connector", id: "microsoft", label: ended.account },
        detail: { by: "suspension", userId, email: ended.email },
      });
  });

  // For administrators: which services this server is registered with and who has connected.
  app.get("/api/connections", async (c) => {
    const denied = kit.need(c, "members.read");
    if (denied) return denied;
    const [microsoft] = await connections.list(owner(c));
    const off = await isOff(c);
    return c.json({
      services: [
        {
          id: "microsoft",
          // Registered on this server, and not switched off for the company.
          available: Boolean(microsoft?.available) && !off,
          off,
          // The two that send are asked for only once sending is switched on.
          scopes: [
            ...MICROSOFT_SCOPES,
            ...((await servicesSending(db, owner(c).orgId)).includes("microsoft")
              ? MICROSOFT_SEND_SCOPES
              : []),
          ],
        },
      ],
      people: await connections.all(owner(c).orgId),
    });
  });

  // An administrator ends a person's connection. The person can connect again; this is
  // for when they should not be connected now.
  app.delete("/api/connections/:user/microsoft", async (c) => {
    const denied = kit.need(c, "members.manage");
    if (denied) return denied;
    const userId = c.req.param("user");
    const person = isId(userId)
      ? (
          await db.query<{ email: string }>(
            "select u.email from users u join memberships m on m.user_id = u.id where u.id = $1 and m.org_id = $2",
            [userId, owner(c).orgId],
          )
        )[0]
      : undefined;
    const account = person && (await connections.remove({ orgId: owner(c).orgId, userId }));
    if (!person || !account) return fail(c, "not_found");
    await recordEvent(db, {
      orgId: owner(c).orgId,
      actor: kit.actorOf(c),
      action: "connector.disconnected",
      target: { type: "connector", id: "microsoft", label: account },
      detail: { by: "administrator", userId, email: person.email },
      ip: kit.clientIp(c),
    });
    return c.json({ ok: true });
  });

  // Begins a connection: answers with the address of the service's consent page, which
  // the person's browser then opens. A POST, so no other site can start one for them.
  app.post("/api/app/connectors/microsoft/start", async (c) => {
    // Switched off by an administrator is said as that, not as a server that is not set up.
    if (await isOff(c)) return fail(c, "connector_off");
    const url = await connections.start(
      owner(c),
      (await servicesSending(db, owner(c).orgId)).includes("microsoft"),
    );
    return url ? c.json({ url }) : fail(c, "connector_unavailable");
  });

  // The service sends the person back here with its answer. Reached without a session.
  app.get("/api/app/connectors/microsoft/callback", async (c) => {
    // The person's own language, as their browser states it.
    const zh = /^\s*zh\b/i.test(c.req.header("accept-language") ?? "");
    const words = zh ? WORDS.zh : WORDS.en;
    const show = (
      result: { ok: true; account: string } | { ok: false; title: string; lead: string },
    ) =>
      c.html(page(words, zh ? "zh" : "en", config.publicUrl, result), result.ok ? 200 : 400, {
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        // no-transform: a proxy in front must hand the page on as it is written.
        "cache-control": "no-store, no-transform",
      });
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (c.req.query("error") || !state || !code)
      return show({
        ok: false,
        title: words.failed,
        lead: c.req.query("error") === "access_denied" ? words.declined : words.incomplete,
      });
    try {
      // Whoever is signed in to Muster in this browser, if anyone: see Connections.finish.
      const done = await connections.finish(state, code, c.get("session")?.user.id);
      if (!done) return show({ ok: false, title: words.stale, lead: words.staleLead });
      await recordEvent(db, {
        orgId: done.orgId,
        actor: { userId: done.userId, email: done.email },
        action: "connector.connected",
        target: { type: "connector", id: "microsoft", label: done.account },
        ip: kit.clientIp(c),
      });
      return show({ ok: true, account: done.account });
    } catch (error) {
      if (error instanceof WrongPerson)
        return show({ ok: false, title: words.failed, lead: words.wrong(error.account) });
      console.error(
        "connecting Microsoft 365 failed:",
        error instanceof ConnectorError ? error.message : error,
      );
      return show({ ok: false, title: words.failed, lead: words.refused });
    }
  });

  app.delete("/api/app/connectors/microsoft", async (c) => {
    const account = await connections.remove(owner(c));
    if (!account) return fail(c, "not_found");
    await recordEvent(db, {
      orgId: owner(c).orgId,
      actor: kit.actorOf(c),
      action: "connector.disconnected",
      target: { type: "connector", id: "microsoft", label: account },
      ip: kit.clientIp(c),
    });
    return c.json({ ok: true });
  });
}
