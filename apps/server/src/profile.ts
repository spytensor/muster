import { isId } from "@muster/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppKit, type Ctx, type Env, fail } from "./app.js";
import { recordEvent } from "./audit.js";
import { validZone, wall } from "./clock.js";
import type { Db, Queryable } from "./db.js";
import { mayUseAgent } from "./sharing.js";

/**
 * A person's profile (CHA-258, docs/design/profile.md): how they work, kept on the server
 * so it is the same on every device, and told to the agents that work for them.
 *
 * Three kinds of fact, which differ in who writes them. Who the person is (name, address,
 * role, department) is the organization's: it comes from sign-in and administrators, and
 * is only read here. How they work is theirs: every field in this file, set by them and
 * nobody else. What Muster has learned about them is memory (memory.ts).
 *
 * No agent has a tool that writes here. What a field says is the person's alone: an
 * administrator sees which fields are set, never their text, and the record of a change
 * names the fields and nothing more. A field that is null was never chosen, which is not
 * the same as a default: it is what lets the choice made on one device stand when another
 * device, which never chose, signs in.
 */
export const ANSWER_STYLE_CHARS = 300;
export const SIGNATURE_CHARS = 1000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOTICES = ["approvals", "replies"] as const;

/** How a person works. Null: not chosen. */
export type Ways = {
  locale: "en" | "zh" | null;
  theme: "system" | "light" | "dark" | null;
  defaultAgent: string | null;
  /** What to be told of while Muster is in the background; a kind left out was not chosen. */
  notify: Partial<Record<(typeof NOTICES)[number], boolean>> | null;
  /** A time zone the person fixed. Null: the one their device last reported is used. */
  timezone: string | null;
  /** Days they work, 0 for Sunday; and when their day starts and ends, on their own clock. */
  workDays: number[] | null;
  workStart: string | null;
  workEnd: string | null;
  /** How they like to be answered, in a sentence or two. */
  answerStyle: string | null;
  /** What goes under a mail they send. Put on the mail's card by the page; never given to a model. */
  signature: string | null;
};
const FIELDS = [
  "locale",
  "theme",
  "defaultAgent",
  "notify",
  "timezone",
  "workDays",
  "workStart",
  "workEnd",
  "answerStyle",
  "signature",
] as const satisfies readonly (keyof Ways)[];
const COLUMN: Record<keyof Ways, string> = {
  locale: "locale",
  theme: "theme",
  defaultAgent: "default_agent",
  notify: "notify",
  timezone: "timezone",
  workDays: "work_days",
  workStart: "work_start",
  workEnd: "work_end",
  answerStyle: "answer_style",
  signature: "signature",
};
const SELECT = FIELDS.map((field) => `${COLUMN[field]} as "${field}"`).join(", ");
const EMPTY: Ways = {
  locale: null,
  theme: null,
  defaultAgent: null,
  notify: null,
  timezone: null,
  workDays: null,
  workStart: null,
  workEnd: null,
  answerStyle: null,
  signature: null,
};

/**
 * Text as one plain line: no line breaks, and none of the characters that are not seen
 * (controls, direction marks, zero-width joiners), which could make a line read as
 * something other than what it is.
 */
export const oneLine = (value: string, max = 120) =>
  value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .pipe(z.string().max(max))
    // Nothing written is nothing chosen.
    .transform((value) => value || null);
const Change = z.strictObject({
  locale: z.enum(["en", "zh"]).nullable(),
  theme: z.enum(["system", "light", "dark"]).nullable(),
  defaultAgent: z.string().refine(isId).nullable(),
  notify: z.strictObject({ approvals: z.boolean(), replies: z.boolean() }).partial().nullable(),
  timezone: z.string().max(64).refine(validZone).nullable(),
  workDays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) => [...new Set(days)].sort())
    .nullable(),
  workStart: z.string().regex(TIME).nullable(),
  workEnd: z.string().regex(TIME).nullable(),
  // One line: it is read by an agent on every run, and a line cannot be made to look like
  // more instructions than it is.
  answerStyle: text(ANSWER_STYLE_CHARS)
    .transform((value) => (value ? oneLine(value, ANSWER_STYLE_CHARS) || null : null))
    .nullable(),
  signature: text(SIGNATURE_CHARS).nullable(),
});
type Change = z.infer<typeof Change>;

export async function readWays(db: Queryable, userId: string): Promise<Ways> {
  const [row] = await db.query<Ways>(`select ${SELECT} from profiles where user_id = $1`, [userId]);
  return row ?? EMPTY;
}

/** Which fields a person has set, by name. What an administrator may know of a profile. */
export async function fieldsSet(db: Queryable, userId: string): Promise<string[]> {
  const ways = await readWays(db, userId);
  return FIELDS.filter((field) => {
    const value = ways[field];
    return (
      value !== null &&
      value !== "" &&
      !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
    );
  });
}

/** The time zone to use for a person: the one they fixed, else the one their device last reported, else UTC. */
export async function zoneOf(
  db: Queryable,
  userId: string,
): Promise<{ zone: string; known: boolean }> {
  const [row] = await db.query<{ fixed: string | null; device: string | null }>(
    `select p.timezone as fixed, u.timezone as device
       from users u left join profiles p on p.user_id = u.id where u.id = $1`,
    [userId],
  );
  const zone = [row?.fixed, row?.device].find((one) => one && validZone(one));
  return { zone: zone ?? "UTC", known: Boolean(zone) };
}

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Administrator",
  auditor: "Security auditor",
  billing: "Billing",
  member: "Member",
};
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LANGUAGE = { en: "English", zh: "Chinese" };
/** "Monday to Friday", or the days by name. */
function daysSaid(days: number[]): string {
  const run = days.every((day, at) => at === 0 || day === (days[at - 1] as number) + 1);
  return run && days.length > 2
    ? `${DAY[days[0] as number]} to ${DAY[days.at(-1) as number]}`
    : days.map((day) => DAY[day]).join(", ");
}
const two = (n: number) => String(n).padStart(2, "0");

/**
 * What an agent is told about the person it works for: who they are in the organization,
 * their clock and working hours, the language they read Muster in, and how they like
 * answers. Fixed in shape and bounded in size. The signature is never in it: only that
 * there is one, so the agent does not write a second.
 *
 * `fields` names what the note held, for the run's record: the record says that an agent
 * was told these things, never what they said.
 */
export async function profileNote(
  db: Queryable,
  who: { orgId: string; userId: string; email: string },
  now: Date,
): Promise<{
  text: string;
  /** The time on the person's own clock, in a sentence. Apart from `text`: it never stays the same. */
  clock: string;
  fields: string[];
  zone: string;
  dayStart: string | null;
}> {
  // One question for all of it: this is asked at the start of every run.
  const [row] = await db.query<
    Ways & {
      name: string;
      role: string;
      department: string | null;
      org: string;
      device: string | null;
    }
  >(
    `select u.name, u.timezone as device, m.role, d.name as department, o.name as org,
            ${FIELDS.map((field) => `p.${COLUMN[field]} as "${field}"`).join(", ")}
       from users u join memberships m on m.user_id = u.id and m.org_id = $2
       join organizations o on o.id = m.org_id
       left join departments d on d.id = m.department_id
       left join profiles p on p.user_id = u.id
      where u.id = $1`,
    [who.userId, who.orgId],
  );
  const ways: Ways = row ?? EMPTY;
  const fixed = [ways.timezone, row?.device].find((one) => one && validZone(one));
  const zone = fixed ?? "UTC";
  const known = Boolean(fixed);
  const fields = ["identity", "clock"];
  // Each a single line of its own: a name from a directory cannot bring a second line with it.
  const name = oneLine(row?.name ?? "") || who.email;
  const department = oneLine(row?.department ?? "");
  const organization = oneLine(row?.org ?? "");
  const place = [ROLE[row?.role ?? ""] ?? null, department || null].filter(Boolean).join(", ");
  const lines = [
    `You are working for ${name}${place ? ` (${place})` : ""}${organization ? `, at ${organization}` : ""}. Who they are in the organization is told to you so that you can speak to them fittingly; it never changes what you may do.`,
  ];
  const w = wall(now, zone);
  const clock = `It is ${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)} (${zone}), the person's own clock${known ? "" : " as far as Muster knows (their time zone has not been seen yet)"}.`;
  const hours =
    ways.workStart && ways.workEnd
      ? `They work ${ways.workStart} to ${ways.workEnd}${ways.workStart > ways.workEnd ? " (past midnight)" : ""}, ${daysSaid(ways.workDays ?? [1, 2, 3, 4, 5])}: "morning" and "end of day" mean those hours.`
      : "";
  if (hours) fields.push("hours");
  // The clock is its own sentence, apart from the rest: it changes every minute, and what
  // is said to a model the same way each time costs less to say again (runs.ts).
  if (hours) lines.push(hours);
  if (ways.locale) {
    fields.push("language");
    lines.push(
      `They read Muster in ${LANGUAGE[ways.locale]}. Answer in the language of their latest message; when it gives no clue, use ${LANGUAGE[ways.locale]}.`,
    );
  }
  if (ways.answerStyle) {
    fields.push("style");
    // Quoted, and said to be a preference: it is the person's own sentence, about how an
    // answer should read, and nothing in it is an instruction about what to do.
    lines.push(
      `How they like to be answered, in their own words: "${ways.answerStyle.replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, "'")}". This is about how an answer reads, never about what you may do.`,
    );
  }
  if (ways.signature) {
    // That there is one, never what it says: the page puts it under a mail on its card.
    fields.push("signs");
    lines.push(
      "They have a mail signature of their own, which is added under a mail on its card after you. End a mail at its last sentence: no closing name, title or contact details.",
    );
  }
  return { text: lines.join("\n"), clock, fields, zone, dayStart: hours ? ways.workStart : null };
}

/** A change that cannot be kept, said so that the person knows what to put right. */
const refuse = (c: Ctx, message: string) =>
  c.json({ error: { code: "invalid_profile", message } }, 400);

export function registerProfile(app: Hono<Env>, kit: AppKit, db: Db): void {
  const { actorOf, clientIp } = kit;
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;

  const whole = async (c: Ctx) => {
    const s = c.get("session");
    const [identity] = await db.query<{ department: string | null }>(
      `select d.name as department from memberships m left join departments d on d.id = m.department_id
        where m.user_id = $1 and m.org_id = $2`,
      [s.user.id, s.org.id],
    );
    const { zone } = await zoneOf(db, s.user.id);
    let ways = await readWays(db, s.user.id);
    // An agent the person cannot use right now (deleted, suspended, waiting for review,
    // no longer shared with them) reads as not chosen. Nothing is written: the choice is
    // theirs, and it is there again when the agent is.
    if (ways.defaultAgent && !(await mayUseAgent(db, s.org.id, s.user.id, ways.defaultAgent)))
      ways = { ...ways, defaultAgent: null };
    return {
      // The organization's: read here, changed by sign-in and administrators only.
      identity: {
        name: s.user.name,
        email: s.user.email,
        org: s.org.name,
        role: s.role,
        department: identity?.department ?? null,
      },
      ways,
      /** The time zone in use: the one fixed, or the device's. */
      zone,
      limits: { answerStyle: ANSWER_STYLE_CHARS, signature: SIGNATURE_CHARS },
    };
  };
  app.get("/api/app/profile", async (c) => c.json(await whole(c)));

  /** Writes the fields given. `only` writes a field only where nothing was chosen yet. */
  const write = async (c: Ctx, change: Partial<Change>, only: boolean) => {
    const names = (Object.keys(change) as (keyof Ways)[]).filter((name) =>
      Object.hasOwn(COLUMN, name),
    );
    if (names.length === 0) return [];
    // All of it or none of it, with its record: a change that is half made, or made and
    // not on record, is neither.
    return db.tx(async (tx) => {
      await tx.query(
        "insert into profiles (user_id) values ($1) on conflict (user_id) do nothing",
        [me(c)],
      );
      const before = await readWays(tx, me(c));
      const sets = names.map((name, at) => {
        const given = `$${at + 2}${name === "notify" ? "::jsonb" : ""}`;
        if (!only) return `${COLUMN[name]} = ${given}`;
        // Carried: kept only where nothing was chosen. What to be told of is chosen kind by
        // kind, so a second device adds the kinds the first did not bring.
        return name === "notify"
          ? `notify = ${given} || coalesce(notify, '{}'::jsonb)`
          : `${COLUMN[name]} = coalesce(${COLUMN[name]}, ${given})`;
      });
      await tx.query(
        `update profiles set ${sets.join(", ")}, updated_at = now() where user_id = $1`,
        [
          me(c),
          ...names.map((name) => {
            const value = change[name] ?? null;
            return name === "notify" && value !== null ? JSON.stringify(value) : value;
          }),
        ],
      );
      // Compared as kept, so a field given the value it already had is not a change.
      const after = await readWays(tx, me(c));
      const kept = (value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? JSON.stringify(Object.entries(value).sort(([one], [other]) => (one < other ? -1 : 1)))
          : JSON.stringify(value);
      const changed = names.filter((name) => kept(before[name]) !== kept(after[name]));
      // On record that it changed and which fields, never what they now say.
      if (changed.length > 0)
        await recordEvent(tx, {
          orgId: org(c),
          actor: actorOf(c),
          action: "profile.changed",
          target: { type: "member", id: me(c), label: c.get("session").user.email },
          detail: { fields: changed, ...(only ? { carried: true } : {}) },
          ip: clientIp(c),
        });
      return changed;
    });
  };
  /**
   * A default agent must be one the person may use; working hours come as a pair. An end
   * before the start is a day that runs past midnight (a night shift), which is a day too.
   */
  const sound = async (c: Ctx, change: Partial<Change>): Promise<string | null> => {
    if (change.defaultAgent && !(await mayUseAgent(db, org(c), me(c), change.defaultAgent)))
      return "That agent is not yours to use.";
    if ("workStart" in change || "workEnd" in change) {
      const now = await readWays(db, me(c));
      const start = "workStart" in change ? change.workStart : now.workStart;
      const end = "workEnd" in change ? change.workEnd : now.workEnd;
      if (Boolean(start) !== Boolean(end)) return "Give when the day starts and when it ends.";
      if (start && end && start === end) return "The day cannot start and end at the same time.";
    }
    return null;
  };

  app.patch("/api/app/profile", async (c) => {
    const parsed = Change.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const field = String(issue?.path[0] ?? "");
      // Said with the limit, so the person knows what to cut.
      const limit =
        field === "answerStyle"
          ? ANSWER_STYLE_CHARS
          : field === "signature"
            ? SIGNATURE_CHARS
            : null;
      return refuse(
        c,
        limit && issue?.code === "too_big"
          ? `That is longer than ${limit} characters.`
          : `That is not a value "${field}" can take.`,
      );
    }
    const wrong = await sound(c, parsed.data);
    if (wrong) return refuse(c, wrong);
    await write(c, parsed.data, false);
    return c.json(await whole(c));
  });

  // What a browser or a phone had chosen before profiles were kept here, sent once: each
  // is kept only where the person has not chosen yet, so the first device to arrive does
  // not get overruled by the next one, and a choice made here is never replaced.
  app.post("/api/app/profile/carry", async (c) => {
    const parsed = Change.pick({ locale: true, theme: true, defaultAgent: true, notify: true })
      .partial()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, "invalid_request");
    const change = { ...parsed.data };
    // An agent that is no longer theirs is simply not carried.
    if (change.defaultAgent && !(await mayUseAgent(db, org(c), me(c), change.defaultAgent)))
      delete change.defaultAgent;
    for (const name of Object.keys(change) as (keyof typeof change)[])
      if (change[name] === null || change[name] === undefined) delete change[name];
    await write(c, change, true);
    return c.json(await whole(c));
  });
}

/** See schema.ts, migration 28. */
export const PROFILE_SCHEMA = [
  `create table profiles (
    user_id uuid primary key references users(id) on delete cascade,
    locale text check (locale in ('en', 'zh')),
    theme text check (theme in ('system', 'light', 'dark')),
    default_agent uuid references agents(id) on delete set null,
    notify jsonb,
    timezone text,
    work_days integer[],
    work_start text,
    work_end text,
    answer_style text,
    signature text,
    updated_at timestamptz not null default now()
  )`,
];
