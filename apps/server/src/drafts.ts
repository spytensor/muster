import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { servicesOff, servicesSending } from "./company.js";
import { type Connections, ConnectorError, NotConnected } from "./connections.js";
import type { Db } from "./db.js";
import { MISLEADING } from "./names.js";

/** A chat's id as Microsoft writes it: "19:…@thread.v2", "19:…@unq.gbl.spaces". Never a path. */
const CHAT_ID = /^19:[A-Za-z0-9_.@-]{1,190}$/;
/** Every character of the misleading kind, to take out of a name Microsoft gives. */
const MISLEADING_ALL = new RegExp(MISLEADING.source, "g");

/**
 * What an agent drafted and a person sent (CHA-220).
 *
 * An agent has no tool that sends mail or a Teams message. It can write a draft into its
 * reply (`MailDraft`, `TeamsDraft` in packages/ui-schema), which is words on a page and
 * nothing more. The person reads it on a card, changes what they like and presses Send.
 * That press is their own request, made in their own session, and it is the only thing
 * that reaches this file: what is sent is what they submitted, through their own
 * connection, once.
 *
 * A row here is the record of what became of a draft, so the card says so after a reload
 * and a second press sends nothing. It guards against a slip of the hand, not against the
 * person: whoever holds their session can send as them, as they could from their mailbox.
 * What the server does hold to, whatever the page sent: sending is switched on, the
 * connection may send, a Teams chat is one of the person's own and is named as Microsoft
 * names it, anyone outside the organization was confirmed, and no more than a few an hour.
 */
export const DRAFTS_SCHEMA = [
  `create table sent_drafts (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    message_id uuid not null references messages(id) on delete cascade,
    key text not null,
    kind text not null check (kind in ('mail', 'teams')),
    status text not null check (status in ('sending', 'sent', 'discarded')),
    content jsonb not null default '{}',
    at timestamptz not null default now(),
    unique (message_id, key)
  )`,
  // The services people here may send through. Empty until an administrator says so.
  `alter table org_settings add column sending text[] not null default '{}'`,
];
/** Migration 20: a send whose outcome is not known is its own state. */
export const DRAFTS_UNKNOWN_SCHEMA = [
  `alter table sent_drafts drop constraint sent_drafts_status_check`,
  `alter table sent_drafts add constraint sent_drafts_status_check
     check (status in ('sending', 'sent', 'discarded', 'unknown'))`,
];

/** How many drafts a person may send in an hour. A person sends a few; a stolen session would send many. */
const SENDS_AN_HOUR = 30;
/** A send still "sending" after this long did not end where the server could see. */
const STUCK = "2 minutes";

/**
 * An address in plain letters. One with letters of another alphabet, or characters that
 * cannot be seen, can read as a colleague's and be a stranger's, so it is not taken.
 */
const Address = z
  .string()
  .trim()
  .max(254)
  .regex(
    /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/,
  );
const Common = { messageId: z.string().refine(isId), key: z.string().regex(/^[a-z0-9]{1,40}$/) };
const Body = z.discriminatedUnion("kind", [
  z.strictObject({
    ...Common,
    kind: z.literal("mail"),
    to: z.array(Address).min(1).max(20),
    cc: z.array(Address).max(20).default([]),
    // One line: a line break in a subject is how a header is forged.
    subject: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((subject) => !MISLEADING.test(subject)),
    body: z.string().min(1).max(100_000),
    /** The person was shown who is outside their organization and said yes. */
    outside: z.boolean().default(false),
  }),
  z.strictObject({
    ...Common,
    kind: z.literal("teams"),
    chatId: z.string().regex(CHAT_ID),
    body: z.string().min(1).max(20_000),
    outside: z.boolean().default(false),
  }),
]);
/** The component a draft of each kind is written with. */
const COMPONENT = { mail: "MailDraft(", teams: "TeamsDraft(" } as const;
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** A Teams chat as Microsoft describes it: never as the draft named it. */
export interface Chat {
  name: string;
  members: string[];
  /** Someone in it is not of the person's organization. */
  outside: boolean;
}

export function registerDrafts(app: Hono<Env>, kit: AppKit, db: Db, connections: Connections) {
  const { actorOf, clientIp } = kit;
  const owner = (c: Ctx) => {
    const s = c.get("session");
    return { orgId: s.org.id, userId: s.user.id };
  };
  /** A finished reply in one of the person's own conversations that holds a draft of this kind. */
  const reply = async (c: Ctx, messageId: string, kind?: "mail" | "teams") =>
    (
      await db.query<{ content: string }>(
        `select m.content from messages m join conversations v on v.id = m.conversation_id
          where m.id = $1 and v.org_id = $2 and v.user_id = $3 and m.role = 'assistant' and m.status = 'complete'`,
        [messageId, owner(c).orgId, owner(c).userId],
      )
    ).find((message) => !kind || message.content.includes(COMPONENT[kind]));
  const failed = (c: Ctx, code: string, message: string, status: 409 | 429 | 502) =>
    c.json({ error: { code, message } }, status);

  /**
   * The chat a draft would be posted in, asked of Microsoft as the person. The name on the
   * card and in the log is this one. A chat the person is not in is not found.
   */
  const chatOf = async (c: Ctx, chatId: string): Promise<Chat> => {
    const chat = (await connections.graph(
      owner(c),
      `/chats/${encodeURIComponent(chatId)}?$expand=members`,
    )) as {
      topic?: string | null;
      chatType?: string;
      members?: { displayName?: string | null; email?: string | null; tenantId?: string }[];
    };
    const members = chat.members ?? [];
    const names = members
      .map((member) => (member.displayName || member.email || "").replace(MISLEADING_ALL, ""))
      .filter(Boolean);
    const tenants = new Set(members.map((member) => member.tenantId).filter(Boolean));
    return {
      name: (
        chat.topic?.replace(MISLEADING_ALL, "").trim() ||
        names.slice(0, 4).join(", ") ||
        (chat.chatType === "oneOnOne" ? "One-to-one chat" : "Group chat")
      ).slice(0, 200),
      members: names.slice(0, 50),
      // By the directory each member belongs to, which Microsoft states. Someone it states
      // none for (a personal account, a guest without one) is taken to be from outside.
      // The address is not gone by: one company often has several domains.
      outside: tenants.size > 1 || members.some((member) => !member.tenantId),
    };
  };

  // What the cards of one conversation need: whether sending is possible, and what was
  // already sent or put aside.
  app.get("/api/app/conversations/:id/drafts", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    const { orgId, userId } = owner(c);
    const mine = await db.query(
      "select 1 from conversations where id = $1 and org_id = $2 and user_id = $3",
      [id, orgId, userId],
    );
    if (mine.length === 0) return fail(c, "not_found");
    const [microsoft] = await connections.list(owner(c));
    const off = (await servicesOff(db, orgId)).includes("microsoft");
    return c.json({
      // Why a card can or cannot send, each said on the card in its own words.
      sending: {
        allowed: !off && (await servicesSending(db, orgId)).includes("microsoft"),
        connected: Boolean(microsoft?.connected) && !off,
        mail: microsoft?.connected?.sends.mail ?? false,
        teams: microsoft?.connected?.sends.teams ?? false,
        account: microsoft?.connected?.account ?? null,
      },
      // One still "sending" after a while ended where nobody saw: said as not known.
      drafts: await db.query(
        `select d.message_id as "messageId", d.key, d.kind, d.at, d.content,
                case when d.status = 'sending' and d.at < now() - interval '${STUCK}' then 'unknown' else d.status end as status
           from sent_drafts d join messages m on m.id = d.message_id
          where m.conversation_id = $1 and d.user_id = $2 order by d.at`,
        [id, userId],
      ),
    });
  });

  // The chat a Teams draft names, as Microsoft names it, for the card to show before Send.
  app.get("/api/app/drafts/chat/:id", async (c) => {
    const chatId = c.req.param("id");
    if (!CHAT_ID.test(chatId)) return fail(c, "not_found");
    if ((await servicesOff(db, owner(c).orgId)).includes("microsoft"))
      return fail(c, "sending_off");
    const [microsoft] = await connections.list(owner(c));
    if (!microsoft?.connected) return fail(c, "sending_not_connected");
    try {
      return c.json(await chatOf(c, chatId));
    } catch (error) {
      if (error instanceof NotConnected) return fail(c, "sending_not_connected");
      return fail(c, "chat_unknown");
    }
  });

  app.post("/api/app/drafts/send", async (c) => {
    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_draft");
    const draft = parsed.data;
    const { orgId, userId } = owner(c);
    if (!(await reply(c, draft.messageId, draft.kind))) return fail(c, "not_found");
    if (
      (await servicesOff(db, orgId)).includes("microsoft") ||
      !(await servicesSending(db, orgId)).includes("microsoft")
    )
      return fail(c, "sending_off");
    const [microsoft] = await connections.list(owner(c));
    if (!microsoft?.connected?.sends[draft.kind]) return fail(c, "sending_not_connected");
    const home = domainOf(microsoft.connected.account);
    const recently = await db.query<{ n: number }>(
      "select count(*)::int as n from sent_drafts where user_id = $1 and status in ('sent', 'unknown', 'sending') and at > now() - interval '1 hour'",
      [userId],
    );
    if ((recently[0]?.n ?? 0) >= SENDS_AN_HOUR) return fail(c, "send_limit");

    // Where it goes, as the server knows it, and whether that is outside the organization.
    let chat: Chat | null = null;
    if (draft.kind === "teams") {
      try {
        chat = await chatOf(c, draft.chatId);
      } catch (error) {
        if (error instanceof NotConnected) return fail(c, "sending_not_connected");
        return fail(c, "chat_unknown");
      }
    }
    const outside =
      draft.kind === "mail"
        ? [...draft.to, ...draft.cc].some((address) => domainOf(address) !== home)
        : (chat?.outside ?? false);
    // Whatever page sent this, leaving the organization is something the person said yes to.
    if (outside && !draft.outside) return fail(c, "confirm_outside");

    const content =
      draft.kind === "mail"
        ? { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body }
        : { chatId: draft.chatId, chat: chat?.name ?? "", body: draft.body };
    // Taken before it is sent: of two presses, one sends. A draft put aside can still be sent.
    const before = (
      await db.query<{ status: string }>(
        "select status from sent_drafts where message_id = $1 and key = $2",
        [draft.messageId, draft.key],
      )
    )[0]?.status;
    const taken = await db.query<{ id: string }>(
      `insert into sent_drafts (id, org_id, user_id, message_id, key, kind, status, content)
       values ($1, $2, $3, $4, $5, $6, 'sending', $7::jsonb)
       on conflict (message_id, key) do update set status = 'sending', kind = excluded.kind, content = excluded.content, at = now()
         where sent_drafts.status = 'discarded'
       returning id`,
      [newId(), orgId, userId, draft.messageId, draft.key, draft.kind, JSON.stringify(content)],
    );
    if (!taken[0]) {
      // In flight, sent, or ended unseen: none of them is sent a second time by a press.
      // Read now, not before: another press may have taken it in between.
      const now = (
        await db.query<{ status: string; stuck: boolean }>(
          `select status, at < now() - interval '${STUCK}' as stuck from sent_drafts where message_id = $1 and key = $2`,
          [draft.messageId, draft.key],
        )
      )[0];
      return fail(
        c,
        now?.status === "sent"
          ? "draft_sent"
          : now?.status === "sending" && !now.stuck
            ? "draft_busy"
            : "draft_unknown",
      );
    }
    const record = (detail: Record<string, unknown>) =>
      recordEvent(db, {
        orgId,
        actor: actorOf(c),
        action: "draft.sent",
        target: {
          type: "message",
          id: draft.messageId,
          label: (draft.kind === "mail" ? draft.to.join(", ") : (chat?.name ?? "")).slice(0, 200),
        },
        // Who it went to and how much, never what it said.
        detail: {
          ...(draft.kind === "mail"
            ? { kind: "mail", to: draft.to, cc: draft.cc }
            : { kind: "teams", chat: chat?.name ?? "", chatId: draft.chatId }),
          bytes: Buffer.byteLength(draft.body),
          outside,
          ...detail,
        },
        ip: clientIp(c),
      });
    try {
      if (draft.kind === "mail")
        await connections.post(owner(c), "/me/sendMail", {
          message: {
            subject: draft.subject,
            body: { contentType: "Text", content: draft.body },
            toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: draft.cc.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        });
      else
        await connections.post(owner(c), `/chats/${encodeURIComponent(draft.chatId)}/messages`, {
          body: { contentType: "text", content: draft.body },
        });
    } catch (error) {
      const refused =
        error instanceof NotConnected ||
        (error instanceof ConnectorError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429);
      if (refused) {
        // Microsoft said no: nothing went. The draft is as it was and can be sent again.
        await db.query(
          before === "discarded"
            ? "update sent_drafts set status = 'discarded' where id = $1"
            : "delete from sent_drafts where id = $1",
          [taken[0].id],
        );
        if (error instanceof NotConnected) return fail(c, "sending_not_connected");
        return failed(c, "send_failed", `${(error as Error).message} Nothing was sent.`, 502);
      }
      // No answer, or a failure on Microsoft's side after it took the request: it may have
      // gone. Saying "nothing was sent" would have the person send it twice.
      if (!(error instanceof ConnectorError))
        console.error("a draft's sending ended unseen:", error);
      await db.query("update sent_drafts set status = 'unknown', at = now() where id = $1", [
        taken[0].id,
      ]);
      await record({ outcome: "unknown" });
      return fail(c, "draft_unknown");
    }
    const [sent] = await db.query<{ at: Date }>(
      "update sent_drafts set status = 'sent', at = now() where id = $1 returning at",
      [taken[0].id],
    );
    await record({});
    return c.json({ status: "sent", at: sent?.at });
  });

  // Put aside: the card closes and says so. It can still be sent later.
  //
  // With `release`, the person says of a draft whose sending ended unseen: "I looked, it
  // did not go." Only the button under that warning sends it, so a card open elsewhere
  // that has not heard cannot free such a draft, and then send it a second time, by "Put aside".
  app.post("/api/app/drafts/discard", async (c) => {
    const parsed = z
      .strictObject({
        ...Common,
        kind: z.enum(["mail", "teams"]),
        release: z.boolean().default(false),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_draft");
    const { orgId, userId } = owner(c);
    const { messageId, key, kind, release } = parsed.data;
    if (!(await reply(c, messageId, kind))) return fail(c, "not_found");
    const put = await db.query(
      `insert into sent_drafts (id, org_id, user_id, message_id, key, kind, status)
       values ($1, $2, $3, $4, $5, $6, 'discarded')
       on conflict (message_id, key) do update set status = 'discarded', at = now()
         where $7 and (sent_drafts.status = 'unknown'
            or (sent_drafts.status = 'sending' and sent_drafts.at < now() - interval '${STUCK}'))
       returning id`,
      [newId(), orgId, userId, messageId, key, kind, release],
    );
    if (put[0]) return c.json({ status: "discarded" });
    const now = (
      await db.query<{ status: string; stuck: boolean }>(
        `select status, at < now() - interval '${STUCK}' as stuck from sent_drafts where message_id = $1 and key = $2`,
        [messageId, key],
      )
    )[0];
    // Already put aside is put aside. What was sent, is being sent, or may have gone is said as that.
    if (now?.status === "discarded") return c.json({ status: "discarded" });
    return fail(
      c,
      now?.status === "sent"
        ? "draft_sent"
        : now?.status === "sending" && !now.stuck
          ? "draft_busy"
          : "draft_unknown",
    );
  });
}
