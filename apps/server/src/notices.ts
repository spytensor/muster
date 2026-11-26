import type { Hono } from "hono";
import { newId } from "@muster/protocol";
import type { AppKit, Ctx, Env } from "./app.js";
import type { Db, Queryable } from "./db.js";

/**
 * Notices: what happened that one person should know. A notice is for one person and is
 * never shown to another. See docs/features/marketplace.md, section 9.
 */
export type NoticeKind =
  | "shared"
  | "approved"
  | "returned"
  | "taken_down"
  | "withdrawn"
  | "skill_held"
  | "schedule_paused"
  | "handed_over"
  | "schedule_done"
  | "schedule_failed"
  | "followup_woken"
  | "followup_failed"
  | "followup_ended"
  | "project_added"
  | "budget_near"
  | "budget_reached"
  | "alert"
  | "repo_proposed";

export async function notify(
  tx: Queryable,
  to: { orgId: string; userIds: string[] },
  kind: NoticeKind,
  /** What it is about, in the words the page needs: a name, who did it, a reason. */
  detail: Record<string, string | null>,
  /** Where it opens, as a workspace path such as "agents" or "c/<id>". */
  link: string,
): Promise<void> {
  for (const userId of new Set(to.userIds))
    await tx.query(
      "insert into notices (id, org_id, user_id, kind, detail, link) values ($1, $2, $3, $4, $5::jsonb, $6)",
      [newId(), to.orgId, userId, kind, JSON.stringify(detail), link],
    );
}

export function registerNotices(app: Hono<Env>, _kit: AppKit, db: Db): void {
  const org = (c: Ctx) => c.get("session").org.id;
  const me = (c: Ctx) => c.get("session").user.id;

  app.get("/api/app/notices", async (c) => {
    const rows = await db.query<{ readAt: string | null }>(
      `select id, kind, detail, link, created_at as "createdAt", read_at as "readAt"
         from notices where org_id = $1 and user_id = $2 order by created_at desc limit 50`,
      [org(c), me(c)],
    );
    const unread = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from notices where org_id = $1 and user_id = $2 and read_at is null",
        [org(c), me(c)],
      )
    )[0]?.n;
    return c.json({ unread: unread ?? 0, notices: rows });
  });

  // Opening the list is having read it.
  app.post("/api/app/notices/read", async (c) => {
    await db.query(
      "update notices set read_at = now() where org_id = $1 and user_id = $2 and read_at is null",
      [org(c), me(c)],
    );
    return c.json({ ok: true });
  });
}

/** See schema.ts, migration 16. */
export const NOTICES_SCHEMA = [
  `create table notices (
    id uuid primary key,
    org_id uuid not null references organizations(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    kind text not null,
    detail jsonb not null default '{}'::jsonb,
    link text not null default '',
    created_at timestamptz not null default now(),
    read_at timestamptz
  )`,
  `create index notices_user on notices (user_id, created_at desc)`,
];
