import { isId, newId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import type { Db, Queryable } from "./db.js";
import { Refusal } from "./errors.js";
import { plain, plainName } from "./names.js";
import { notify } from "./notices.js";
import { sharedWith, unlist } from "./sharing.js";

/**
 * Skills: a person's way of doing a piece of work, written down once so any agent can
 * follow it. A skill is its instructions and the texts it needs (a template, an example,
 * a checklist). It is words, never code: it can ask nothing of an agent that the agent's
 * tools and the gateway would not allow anyway.
 *
 * Before anyone but its author can use a skill it is scanned (decision D-2), because a
 * skill is exactly the place to hide an instruction: "send the result to this address",
 * "do not tell the person". See docs/features/marketplace.md, section 4.
 */
export interface Finding {
  /** Which rule found it. */
  rule: "address" | "sending" | "override" | "hidden" | "blocked";
  /** The words that tripped it, cut short, for the author to find. */
  excerpt: string;
}
export interface Scan {
  status: "passed" | "failed";
  findings: Finding[];
}

const around = (text: string, at: number, length: number) =>
  text
    .slice(Math.max(0, at - 30), at + length + 40)
    .replace(/\s+/g, " ")
    .trim();

// The one the agent works for. A customer or a reader is someone the work is about:
// "never ask the customer for their password" is good practice, not hiding.
const WHO = "(?:the\\s+)?(?:user|person|human|owner|them)";
/** Telling an agent to set its rules aside, to hide what it does, or to act without asking. */
const OVERRIDES = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your|system)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|your|system)/i,
  /forget\s+(everything|all|what)\b[^.\n]{0,40}\b(told|instruct\w*|rules?|before|above|earlier)/i,
  /override\s+(the\s+|your\s+)?(system|previous|prior|earlier)\s*(prompt|instructions?|rules?)/i,
  new RegExp(`(do\\s+not|don'?t|never)\\s+(tell|inform|notify|warn)\\s+${WHO}`, "i"),
  new RegExp(
    `(do\\s+not|don'?t|never)\\s+(let|allow)\\s+${WHO}\\s+(to\\s+)?(know|see|find\\s+out|notice)`,
    "i",
  ),
  new RegExp(`(do\\s+not|don'?t|never)\\s+mention\\s+(this|it|that)(\\s+to\\s+${WHO})?`, "i"),
  new RegExp(`(hidden|secret|concealed)\\s+from\\s+${WHO}`, "i"),
  new RegExp(`without\\s+${WHO}('s)?\\s*(noticing|knowing|seeing|knowledge|approval|consent)`, "i"),
  // Doing something without asking: "send it without asking", "delete them without confirmation".
  // Not "without asking for the format again", and not "without approval from legal, do not publish".
  /\b(send|post|publish|delete|remove|submit|forward|upload|share|pay|transfer|approve|proceed|execute|act|do\s+(it|this|so|that))\b[^\n!?]{0,80}?\bwithout\s+(asking|telling|notifying|informing|confirmation|confirming|approval|permission|consent)\b(?!\s+(for|about|which|what|how|again|from|of)\b)/i,
  new RegExp(`without\\s+(asking|telling|notifying|informing)\\s+(${WHO}|first)`, "i"),
  /skip\s+(the\s+)?(confirmation|approval)|approve\s+automatically|auto-?approve/i,
  /(secretly|silently|covertly|quietly)\s+(send|post|upload|copy|forward|share|email)/i,
  /(忽略|无视|忘记|忘掉|不要理会|不用管)[^。\n]{0,8}(指令|规则|提示|要求|设定)/,
  /(别|不要|不得|请勿|勿|不许|不能|不可)[^。\n]{0,3}(告诉|告知|提醒|通知|透露)[^。\n]{0,4}(用户|对方|本人|使用者)/,
  /(别|不要|不得|请勿|勿|不许|不能|不可)让(用户|对方|本人|使用者)[^。\n]{0,2}(知道|发现|看到|察觉)/,
  /对(用户|使用者|对方|本人)[^。\n]{0,2}(保密|隐瞒)|瞒着(用户|使用者|对方|本人)/,
  // "不经用户确认直接发送"; not "未经审批不得发送", which forbids the very thing.
  /(不经|未经|跳过)[^。\n]{0,6}(确认|同意|批准|审批|许可)(?![^。\n]{0,8}(不得|不能|不可|不许|禁止|不要|勿))/,
  // "无需确认，直接执行"; not "格式无需再次确认，按模板来".
  /(无需|不需要|不必|不用)[^。\n]{0,4}(确认|询问|征得|同意|批准)[，,、\s]{0,2}(直接|就|立即|马上)?[^。\n]{0,2}(发送|执行|提交|删除|操作|转发|上传|处理)/,
  /(偷偷|悄悄|暗中|私下)[^。\n]{0,6}(发送|上传|转发|复制|分享)/,
];
/** Telling an agent to send what it has somewhere: naming the sending tool, or sending to a hook. */
const SENDING = [
  /\bweb\.send\b/i,
  // "post it to the webhook"; not "explain what a webhook is".
  /\b(send|post|push|call|notify|forward|submit|deliver)\b[^.\n]{0,40}\bwebhook\b/i,
  /(发送|推送|发到|提交|转发)[^。\n]{0,20}webhook/i,
  /\b(send|post|upload|forward|submit|transmit|exfiltrate)\b[^.\n]{0,60}\bto\s+(https?:\/\/|[\w.-]+@[\w-]+\.[\w.-]+)/i,
  /(发送|上传|转发|提交|发到|发给)[^。\n]{0,30}(https?:\/\/|[\w.-]+@[\w-]+\.[\w.-]+)/,
];
/** Characters that are there and cannot be seen, and long runs that are not words. */
const HIDDEN = [
  /[­​-‏‪-‮⁠-⁤﻿]/,
  /[\u{E0000}-\u{E007F}]/u,
  /[A-Za-z0-9+/]{240,}={0,2}/,
  // The same thing broken over lines.
  /(?:^[A-Za-z0-9+/]{30,}={0,2}[ \t]*\r?\n){5,}/m,
  // Words written in two alphabets at once to slip past a reader of patterns: Cyrillic
  // beside Latin, or a Greek look-alike inside a Latin word. (Units such as "10μg" are not.)
  /[A-Za-z][Ѐ-ӿ]|[Ѐ-ӿ][A-Za-z]|[A-Za-z][οανρ][A-Za-z]/,
];
/** Words written one letter at a time ("d o n o t t e l l"), not a row of initials or grades ("A B C D"). */
const SPACED = /(?:\b[A-Za-z]\s+){7,}[A-Za-z]\b/;
/**
 * An address written out: with a scheme, as a mailbox, as a bare host, or as numbers.
 * Every part is bounded and none starts in the middle of a word, so reading a long text
 * takes time in proportion to its length whatever it holds.
 */
const SCHEMES = /(?<![a-z0-9])(?:https?|ftp|sftp|wss?):\/\/[^\s<>"'`)\]]{1,2000}/gi;
const MAILTO = /(?<![a-z0-9])mailto:[^\s<>"'`)\]]{1,320}/gi;
const MAILBOX = /(?<![\w.+-])[\w+-][\w.+-]{0,63}@(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}(?![\w-])/gi;
const NUMBERS =
  /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s<>"'`)\]]{0,300})?(?![\w.])/g;
/** Endings that are a site and little else. */
const SITE = "com|org|net|cn|ru|de|uk|jp|fr|xyz|biz|shop|online|example";
/** Endings that are as often a file's, a product's or a word's: "logo.ai", "Keynote.app", "summary.me". */
const EITHER = "io|co|dev|app|ai|info|top|site|me|test|ly|sh|us|ca|to|in";
const HOST = new RegExp(
  `(?<![\\w.@/-])((?:www\\.)?(?:[a-z0-9-]{1,63}\\.){1,8})(${SITE}|${EITHER})(?![\\w-])([/:?#][^\\s<>"'\`)\\]]{0,300})?`,
  "gi",
);
const SITES = new RegExp(`^(${SITE})$`, "i");
/** Whether a bare host found in prose is an address and not a file, a product or a version. */
function isSite(whole: string, labels: string, ending: string, path: string | undefined): boolean {
  // Followed by another dotted part ("summary.me.md", "report.final.de.docx") it is a file's name.
  if (!path && /^\.[A-Za-z0-9]/.test(whole)) return false;
  if (path || /^www\./i.test(labels)) return true;
  // Written as people write a site: in small letters. "ASP.NET" and "Keynote.app" are names.
  if (labels !== labels.toLowerCase() || ending !== ending.toLowerCase()) return false;
  return SITES.test(ending);
}
/** The host an address names. */
function hostOf(address: string): string {
  const mail = /@([^\s/?#]+)$/.exec(address.replace(/^mailto:/i, "").split("?")[0] ?? "");
  if (mail?.[1] && !address.includes("://")) return mail[1].toLowerCase();
  try {
    return new URL(address.includes("://") ? address : `https://${address}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Reads a skill's words for what should not be in one. `allow` are sites an administrator
 * said skills may name; `block` are words they said no skill may hold.
 */
export function scanSkill(raw: string, lists: { allow: string[]; block: string[] }): Scan {
  const text = plain(raw).replace(/\[\.\]|\(dot\)|\[dot\]/gi, ".");
  const findings: Finding[] = [];
  const add = (rule: Finding["rule"], from: string, at: number, length: number) => {
    if (findings.length < 20)
      findings.push({ rule, excerpt: around(from, at, length).slice(0, 160) });
  };
  // An allowed site is that host and what is under it, whatever port it was written with.
  const allowed = lists.allow.map((site) => site.toLowerCase().replace(/:\d+$/, ""));
  // A link, and the host inside it, are one finding: what an earlier pattern took is skipped.
  const taken: [number, number][] = [];
  const found = (at: number, address: string) => {
    if (findings.length >= 20 || taken.some(([from, to]) => at >= from && at < to)) return;
    taken.push([at, at + address.length]);
    const host = hostOf(address);
    const ok = host !== "" && allowed.some((site) => host === site || host.endsWith(`.${site}`));
    if (!ok) add("address", text, at, address.length);
  };
  // "evil[.]com" and "evil(dot)com" are read as what they mean.
  for (const pattern of [SCHEMES, MAILTO, MAILBOX, NUMBERS])
    for (const match of text.matchAll(pattern)) found(match.index ?? 0, match[0]);
  for (const match of text.matchAll(HOST)) {
    const at = match.index ?? 0;
    const after = text.slice(at + match[0].length, at + match[0].length + 2);
    if (isSite(after, match[1] ?? "", match[2] ?? "", match[3])) found(at, match[0]);
  }
  for (const [rule, patterns, from] of [
    ["sending", SENDING, text],
    ["override", OVERRIDES, text],
    // What cannot be seen is looked for in the words as they were written.
    ["hidden", HIDDEN, raw],
  ] as const)
    for (const pattern of patterns) {
      const match = pattern.exec(from);
      if (match) add(rule, from, match.index, match[0].length);
    }
  // One letter at a time, with enough small letters to be words and not a row of initials.
  const spaced = SPACED.exec(raw);
  if (spaced && (spaced[0].match(/[a-z]/g)?.length ?? 0) >= 6)
    add("hidden", raw, spaced.index, spaced[0].length);
  // A blocked word is found whatever spacing or case it is written with.
  const squeezed = text.toLowerCase().replace(/\s+/g, " ");
  for (const word of lists.block) {
    const wanted = plain(word).trim().toLowerCase().replace(/\s+/g, " ");
    const at = wanted ? squeezed.indexOf(wanted) : -1;
    if (at >= 0) add("blocked", squeezed, at, wanted.length);
  }
  return { status: findings.length === 0 ? "passed" : "failed", findings };
}

const TEXTS = 5;
const SkillBody = z.strictObject({
  name: plainName(60),
  description: z.string().trim().max(300).default(""),
  instructions: z.string().trim().min(1).max(12_000),
  /** Texts the skill needs: a template, an example, a checklist. Kept in the skill itself. */
  texts: z
    .array(
      z.strictObject({ name: z.string().trim().min(1).max(120), text: z.string().max(40_000) }),
    )
    .max(TEXTS)
    .default([]),
});

const COLUMNS = `k.id, k.name, k.description, k.instructions, k.texts, k.source, k.version,
  k.scan_status as "scanStatus", k.scan_findings as "scanFindings", k.updated_at as "updatedAt"`;

/** What a skill says to an agent that takes it up: its procedure and the texts it comes with. */
export function skillText(skill: {
  name: string;
  instructions: string;
  texts: { name: string; text: string }[];
}): string {
  return [
    `Skill "${skill.name}". Follow this way of doing the work:`,
    skill.instructions,
    ...skill.texts.map((item) => `--- ${item.name} ---\n${item.text}`),
  ].join("\n\n");
}

/** The skills this person may use: their own, and those shared with them that passed their scan. */
export async function usableSkills(
  db: Queryable,
  orgId: string,
  userId: string,
  ids: string[],
): Promise<
  {
    id: string;
    name: string;
    description: string;
    instructions: string;
    texts: { name: string; text: string }[];
  }[]
> {
  if (ids.length === 0) return [];
  return db.query(
    `select k.id, k.name, k.description, k.instructions, k.texts from skills k
      where k.org_id = $1 and k.deleted_at is null and k.id = any($3::uuid[])
        and (k.owner_user_id = $2 or (k.scan_status = 'passed' and ${sharedWith("skill", "k", "$1", "$2")}))`,
    [orgId, userId, ids],
  );
}

export function registerSkills(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { actorOf, clientIp, inTx, need } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;
  const lists = async (tx: Queryable, orgId: string) =>
    (
      await tx.query<{ allow: string[]; block: string[] }>(
        "select skill_allow as allow, skill_block as block from org_settings where org_id = $1",
        [orgId],
      )
    )[0] ?? { allow: [], block: [] };
  const digest = async (body: z.infer<typeof SkillBody>) => {
    const bytes = new TextEncoder().encode(JSON.stringify([body.instructions, body.texts]));
    return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  };
  const whole = (
    body: Pick<z.infer<typeof SkillBody>, "name" | "description" | "instructions" | "texts">,
  ) =>
    [
      body.name,
      body.description,
      body.instructions,
      ...body.texts.map((t) => `${t.name}\n${t.text}`),
    ].join("\n\n");

  // A person's skills: their own, in any state, and those shared with them.
  app.get("/api/app/skills", async (c) => {
    const rows = await db.query(
      `select ${COLUMNS}, (k.owner_user_id = $2) as mine,
              case when k.owner_user_id <> $2 then json_build_object('name', o.name, 'email', o.email) end as "sharedBy",
              (select count(*)::int from shares s where s.kind = 'skill' and s.item_id = k.id) as shares
         from skills k left join users o on o.id = k.owner_user_id
        where k.org_id = $1 and k.deleted_at is null
          and (k.owner_user_id = $2 or (k.scan_status = 'passed' and ${sharedWith("skill", "k", "$1", "$2")}))
        order by (k.owner_user_id = $2) desc, k.name`,
      [org(c), me(c)],
    );
    return c.json(rows);
  });

  const save = async (c: Ctx, id: string | null) => {
    const parsed = SkillBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_skill");
    const body = parsed.data;
    return inTx(c, async (tx) => {
      if (id) {
        const mine = await tx.query(
          "select 1 from skills where id = $1 and org_id = $2 and owner_user_id = $3 and deleted_at is null for update",
          [id, org(c), me(c)],
        );
        if (mine.length === 0) throw new Refusal("not_found");
      }
      const clash = await tx.query(
        "select 1 from skills where org_id = $1 and owner_user_id = $2 and lower(name) = lower($3) and deleted_at is null and id <> $4",
        [org(c), me(c), body.name, id ?? newId()],
      );
      if (clash.length > 0) throw new Refusal("skill_name_taken");
      // Scanned every time it is saved: what passed is exactly what is kept.
      const scan = scanSkill(whole(body), await lists(tx, org(c)));
      const version = await digest(body);
      const skillId = id ?? newId();
      if (id)
        await tx.query(
          `update skills set name = $2, description = $3, instructions = $4, texts = $5::jsonb, version = $6,
                  scan_status = $7, scan_findings = $8::jsonb, updated_at = now() where id = $1`,
          [
            id,
            body.name,
            body.description,
            body.instructions,
            JSON.stringify(body.texts),
            version,
            scan.status,
            JSON.stringify(scan.findings),
          ],
        );
      else
        await tx.query(
          `insert into skills (id, org_id, owner_user_id, source, name, description, instructions, texts, version, scan_status, scan_findings)
           values ($1, $2, $3, 'user', $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)`,
          [
            skillId,
            org(c),
            me(c),
            body.name,
            body.description,
            body.instructions,
            JSON.stringify(body.texts),
            version,
            scan.status,
            JSON.stringify(scan.findings),
          ],
        );
      // A skill that no longer passes is no longer anyone else's to use.
      if (scan.status === "failed")
        await tx.query("delete from shares where kind = 'skill' and item_id = $1", [skillId]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: id ? "skill.changed" : "skill.created",
        target: { type: "skill", id: skillId, label: body.name },
        detail: { scan: scan.status, findings: scan.findings.map((finding) => finding.rule) },
        ip: clientIp(c),
      });
      return c.json({ id: skillId, scanStatus: scan.status, scanFindings: scan.findings });
    });
  };
  app.post("/api/app/skills", (c) => save(c, null));
  app.patch("/api/app/skills/:id", (c) => {
    const id = c.req.param("id");
    return isId(id) ? save(c, id) : Promise.resolve(fail(c, "not_found"));
  });

  app.delete("/api/app/skills/:id", async (c) => {
    const id = c.req.param("id");
    if (!isId(id)) return fail(c, "not_found");
    return inTx(c, async (tx) => {
      const removed = await tx.query<{ name: string }>(
        "update skills set deleted_at = now() where id = $1 and org_id = $2 and owner_user_id = $3 and deleted_at is null returning name",
        [id, org(c), me(c)],
      );
      if (!removed[0]) throw new Refusal("not_found");
      await tx.query("delete from shares where kind = 'skill' and item_id = $1", [id]);
      await unlist(tx, org(c), "skill", id, removed[0].name);
      await tx.query("delete from agent_parts where kind = 'skill' and item_id = $1", [id]);
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "skill.deleted",
        target: { type: "skill", id, label: removed[0].name },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    });
  });

  // What skills may name and may not hold, kept by an administrator.
  app.get("/api/settings/skills", async (c) => {
    const denied = need(c, "settings.read");
    if (denied) return denied;
    return c.json(await lists(db, org(c)));
  });
  app.put("/api/settings/skills", async (c) => {
    const denied = need(c, "settings.manage");
    if (denied) return denied;
    const parsed = z
      .strictObject({
        allow: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              // A site, with at least a name and an ending: not "com", not "...".
              .regex(/^(?=.{4,100}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?$/)
              .refine((site) => !/^(com?|net|org|gov|edu|ac)\.[a-z]{2}(:\d+)?$/.test(site)),
          )
          .max(100),
        block: z.array(z.string().trim().min(2).max(80)).max(100),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    const changed = await inTx(c, async (tx) => {
      const before = await lists(tx, org(c));
      await tx.query(
        `insert into org_settings (org_id, skill_allow, skill_block) values ($1, $2, $3)
         on conflict (org_id) do update set skill_allow = excluded.skill_allow, skill_block = excluded.skill_block`,
        [org(c), parsed.data.allow, parsed.data.block],
      );
      // The lists are what a skill is read against, so every skill is read again now: one
      // that holds a word just blocked stops being anyone's but its author's at once.
      const all = await tx.query<{
        id: string;
        name: string;
        description: string;
        instructions: string;
        texts: { name: string; text: string }[];
        status: string;
        owner: string | null;
      }>(
        "select id, name, description, instructions, texts, scan_status as status, owner_user_id as owner from skills where org_id = $1 and deleted_at is null",
        [org(c)],
      );
      let turned = 0;
      for (const skill of all) {
        const scan = scanSkill(whole(skill), parsed.data);
        if (scan.status !== skill.status) turned += 1;
        // Its author is told: it would otherwise quietly stop working for everyone else.
        if (scan.status === "failed" && skill.status === "passed" && skill.owner)
          await notify(
            tx,
            { orgId: org(c), userIds: [skill.owner] },
            "skill_held",
            { name: skill.name },
            "agents/skills",
          );
        await tx.query(
          "update skills set scan_status = $2, scan_findings = $3::jsonb where id = $1",
          [skill.id, scan.status, JSON.stringify(scan.findings)],
        );
      }
      await recordEvent(tx, {
        orgId: org(c),
        actor: actorOf(c),
        action: "policy.changed",
        // What the lists were and are, so the record answers "what changed".
        detail: {
          skillAllow: parsed.data.allow,
          skillBlock: parsed.data.block,
          was: before,
          skillsRead: all.length,
          skillsChanged: turned,
        },
        ip: clientIp(c),
      });
      return c.json({ ok: true, skillsChanged: turned });
    });
    return changed;
  });
}

/** Tables for skills and for what an agent carries. See schema.ts, migration 12. */
export const SKILLS_SCHEMA = [
  `create table skills (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    owner_user_id uuid references users(id) on delete set null,
    source text not null check (source in ('platform', 'org', 'user')),
    name text not null,
    description text not null default '',
    instructions text not null,
    texts jsonb not null default '[]'::jsonb,
    version text not null,
    scan_status text not null check (scan_status in ('passed', 'failed')),
    scan_findings jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  )`,
  `create index skills_owner on skills (org_id, owner_user_id) where deleted_at is null`,
  // What an agent carries beside its instructions and tools.
  `create table agent_parts (
    agent_id uuid not null references agents(id) on delete cascade,
    kind text not null check (kind in ('skill', 'knowledge', 'connector')),
    item_id uuid not null,
    primary key (agent_id, kind, item_id)
  )`,
  `alter table org_settings add column skill_allow text[] not null default '{}'`,
  `alter table org_settings add column skill_block text[] not null default '{}'`,
];
