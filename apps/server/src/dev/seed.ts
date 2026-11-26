import { newId } from "@muster/protocol";
import { recordEvent } from "../audit.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { NO_MODEL } from "../product.js";
import type { Role } from "../roles.js";
import { seedTraces } from "./seed-traces.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fills an empty development database with a believable organization. Never runs outside MUSTER_DEV=1. */
export async function seedDemo(db: Db, config: Config): Promise<void> {
  if (!config.dev) return;
  if ((await db.query("select 1 from organizations limit 1")).length > 0) return;
  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY);

  await db.tx(async (tx) => {
    const orgId = newId(now - 90 * DAY);
    await tx.query("insert into organizations (id, name, created_at) values ($1, $2, $3)", [
      orgId,
      "Northwind Labs",
      at(90),
    ]);
    await tx.query(
      "insert into org_domains (org_id, domain, auto_join) values ($1, 'muster.test', false)",
      [orgId],
    );

    const departments = new Map<string, string>();
    for (const name of ["Product", "Engineering", "Finance", "Legal & Compliance", "Marketing"]) {
      const id = newId(now - 89 * DAY);
      departments.set(name, id);
      await tx.query(
        "insert into departments (id, org_id, name, created_at) values ($1, $2, $3, $4)",
        [id, orgId, name, at(89)],
      );
    }

    const people: [
      string,
      string,
      Role,
      string | null,
      number,
      number | null,
      "active" | "suspended",
      string,
    ][] = [
      ["owner@muster.test", "Olivia Lin", "owner", null, 90, 0, "active", "bootstrap"],
      ["admin@muster.test", "Adam Zhou", "admin", "Engineering", 88, 1, "active", "invitation"],
      [
        "auditor@muster.test",
        "Audrey Shen",
        "auditor",
        "Legal & Compliance",
        80,
        3,
        "active",
        "invitation",
      ],
      ["finance@muster.test", "Frank He", "billing", "Finance", 75, 6, "active", "invitation"],
      ["member@muster.test", "Mia Chen", "member", "Product", 60, 0, "active", "domain"],
      ["wang.lei@muster.test", "Lei Wang", "member", "Engineering", 58, 2, "active", "domain"],
      ["li.na@muster.test", "Na Li", "member", "Marketing", 44, 1, "active", "domain"],
      ["zhao.min@muster.test", "Min Zhao", "admin", "Product", 40, 4, "active", "invitation"],
      ["sun.yu@muster.test", "Yu Sun", "member", "Engineering", 31, 12, "active", "domain"],
      ["qian.fang@muster.test", "Fang Qian", "member", "Finance", 25, null, "active", "invitation"],
      ["zhou.jie@muster.test", "Jie Zhou", "member", "Marketing", 20, 35, "suspended", "domain"],
      ["wu.tong@muster.test", "Tong Wu", "member", null, 9, 0, "active", "domain"],
    ];
    const ids = new Map<string, string>();
    for (const [email, name, role, department, joined, lastLogin, status, via] of people) {
      const id = newId(now - joined * DAY);
      ids.set(email, id);
      await tx.query(
        "insert into users (id, email, name, created_at, last_login_at) values ($1, $2, $3, $4, $5)",
        [id, email, name, at(joined), lastLogin === null ? null : at(lastLogin)],
      );
      await tx.query(
        `insert into memberships (org_id, user_id, role, status, department_id, joined_at, joined_via)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, id, role, status, department ? departments.get(department) : null, at(joined), via],
      );
    }

    const owner = { userId: ids.get("owner@muster.test") ?? null, email: "owner@muster.test" };
    const admin = { userId: ids.get("admin@muster.test") ?? null, email: "admin@muster.test" };
    for (const [email, role, department, daysLeft] of [
      ["liu.yang@muster.test", "member", "Engineering", 12],
      ["compliance.lead@muster.test", "auditor", "Legal & Compliance", 6],
      ["old.invite@muster.test", "member", null, -3],
    ] as const) {
      const id = newId(now - (14 - daysLeft) * DAY);
      await tx.query(
        `insert into invitations (id, org_id, email, role, department_id, invited_by, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          orgId,
          email,
          role,
          department ? departments.get(department) : null,
          admin.userId,
          at(14 - daysLeft),
          at(-daysLeft),
        ],
      );
    }

    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 0) - 3 * HOUR),
      orgId,
      actor: owner,
      action: "org.created",
      target: { type: "organization", id: orgId, label: "Northwind Labs" },
    });
    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 1) - 3 * HOUR),
      orgId,
      actor: owner,
      action: "invitation.created",
      target: { type: "invitation", id: "-", label: "admin@muster.test" },
      detail: { role: "admin" },
    });
    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 2) - 3 * HOUR),
      orgId,
      actor: admin,
      action: "department.created",
      target: { type: "department", id: "-", label: "Engineering" },
    });
    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 3) - 3 * HOUR),
      orgId,
      actor: owner,
      action: "member.role_changed",
      target: { type: "member", id: "-", label: "zhao.min@muster.test" },
      detail: { from: "member", to: "admin" },
    });
    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 4) - 3 * HOUR),
      orgId,
      actor: admin,
      action: "member.suspended",
      target: { type: "member", id: "-", label: "zhou.jie@muster.test" },
      detail: { sessionsEnded: 2 },
    });
    await recordEvent(tx, {
      // Spread over the past weeks, not all stamped "now".
      time: new Date(now - 9 * DAY * (5 - 5) - 3 * HOUR),
      orgId,
      actor: admin,
      action: "invitation.created",
      target: { type: "invitation", id: "-", label: "liu.yang@muster.test" },
      detail: { role: "member" },
    });
    await seedTraces(
      tx,
      orgId,
      [...ids].map(([email, id]) => ({ id, email })),
      now,
      config.model ?? { id: NO_MODEL, inputPrice: 1, outputPrice: 4 },
    );
  });
}
