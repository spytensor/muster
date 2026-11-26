import { newId } from "@muster/protocol";
import type { Queryable } from "./db.js";

export interface AdminEvent {
  orgId: string;
  actor: { userId: string | null; email: string };
  action: string;
  target?: { type: string; id: string; label: string };
  detail?: Record<string, unknown>;
  ip?: string | null;
  /** When it happened, if not now. For sample data only: a row's time cannot be changed afterwards. */
  time?: Date;
}

/** Appends one record of an administrative or sign-in action. Call it in the same transaction as the change. */
export async function recordEvent(db: Queryable, event: AdminEvent): Promise<void> {
  await db.query(
    `insert into admin_events
       (id, org_id, actor_user_id, actor_email, action, target_type, target_id, target_label, detail, ip, time)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, coalesce($11::timestamptz, now()))`,
    [
      newId(),
      event.orgId,
      event.actor.userId,
      event.actor.email,
      event.action,
      event.target?.type ?? null,
      event.target?.id ?? null,
      event.target?.label ?? null,
      JSON.stringify(event.detail ?? {}),
      event.ip ?? null,
      event.time ?? null,
    ],
  );
}
