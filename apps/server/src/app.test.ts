import { beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness, PUBLIC_URL } from "./test-support.js";

let h: Harness;
let owner: string;

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;

/** Invites an email with a role and signs that person in. */
async function join(email: string, role = "member", as = owner): Promise<string> {
  const invited = await h.api(as, "POST", "/api/invitations", { email, role });
  expect(invited.status).toBe(200);
  const signedIn = await h.signIn(email);
  expect(signedIn.error).toBeNull();
  return signedIn.cookie as string;
}

const idOf = async (email: string) => {
  const members = await json<{ id: string; email: string }[]>(
    await h.api(owner, "GET", "/api/members"),
  );
  return members.find((m) => m.email === email)?.id as string;
};

const actions = async () =>
  (await json<{ action: string }[]>(await h.api(owner, "GET", "/api/audit?limit=100"))).map(
    (e) => e.action,
  );

beforeEach(async () => {
  h = await harness();
  const first = await h.signIn("owner@acme.test");
  expect(first.error).toBeNull();
  owner = first.cookie as string;
});

describe("first sign-in on a fresh deployment", () => {
  it("lets only the configured owner create the organization", async () => {
    const fresh = await harness();
    expect((await fresh.signIn("someone@acme.test")).error).toBe("not_member");
    expect(await fresh.db.query("select 1 from organizations")).toHaveLength(0);
    expect(await fresh.db.query("select 1 from users")).toHaveLength(0);

    const first = await fresh.signIn("owner@acme.test");
    expect(first.error).toBeNull();
    const me = await json(await fresh.api(first.cookie, "GET", "/api/me"));
    expect(me).toMatchObject({
      role: "owner",
      org: { name: "Acme" },
      user: { email: "owner@acme.test" },
    });
  });

  it("does not create a second organization when the owner signs in again", async () => {
    expect((await h.signIn("owner@acme.test")).error).toBeNull();
    expect(await h.db.query("select 1 from organizations")).toHaveLength(1);
    expect(await h.db.query("select 1 from users")).toHaveLength(1);
  });
});

describe("who may sign in", () => {
  it("refuses a stranger and creates no account for them", async () => {
    const result = await h.signIn("stranger@elsewhere.test");
    expect(result).toMatchObject({ error: "not_member", cookie: null });
    expect(
      await h.db.query("select 1 from users where email = 'stranger@elsewhere.test'"),
    ).toHaveLength(0);
  });

  it("refuses an address the provider has not verified, even when invited", async () => {
    await h.api(owner, "POST", "/api/invitations", {
      email: "unverified@acme.test",
      role: "member",
    });
    expect((await h.signIn("unverified@acme.test")).error).toBe("email_unverified");
  });

  it("admits an invited person with the invited role and uses the invitation up", async () => {
    const cookie = await join("ada@acme.test", "admin");
    expect(await json(await h.api(cookie, "GET", "/api/me"))).toMatchObject({ role: "admin" });
    const invitations = await json<{ email: string; state: string }[]>(
      await h.api(owner, "GET", "/api/invitations"),
    );
    expect(invitations).toMatchObject([{ email: "ada@acme.test", state: "accepted" }]);
  });

  it("normalizes the invited address", async () => {
    await h.api(owner, "POST", "/api/invitations", {
      email: "  Mixed.Case@Acme.Test ",
      role: "member",
    });
    expect((await h.signIn("mixed.case@acme.test")).error).toBeNull();
  });

  it("refuses a revoked or expired invitation", async () => {
    const created = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/invitations", { email: "bo@acme.test", role: "member" }),
    );
    expect((await h.api(owner, "DELETE", `/api/invitations/${created.id}`)).status).toBe(200);
    expect((await h.signIn("bo@acme.test")).error).toBe("not_member");

    await h.api(owner, "POST", "/api/invitations", { email: "cy@acme.test", role: "member" });
    await h.db.query(
      "update invitations set expires_at = now() - interval '1 minute' where email = 'cy@acme.test'",
    );
    expect((await h.signIn("cy@acme.test")).error).toBe("not_member");
    // An expired invitation does not block sending a new one.
    expect(
      (await h.api(owner, "POST", "/api/invitations", { email: "cy@acme.test", role: "member" }))
        .status,
    ).toBe(200);
    expect((await h.signIn("cy@acme.test")).error).toBeNull();
  });

  it("will not invite a member or invite the same address twice", async () => {
    await join("ada@acme.test");
    expect(
      (await h.api(owner, "POST", "/api/invitations", { email: "ada@acme.test", role: "member" }))
        .status,
    ).toBe(409);
    await h.api(owner, "POST", "/api/invitations", { email: "new@acme.test", role: "member" });
    expect(
      (await h.api(owner, "POST", "/api/invitations", { email: "new@acme.test", role: "admin" }))
        .status,
    ).toBe(409);
    expect(
      (await h.api(owner, "POST", "/api/invitations", { email: "not-an-email", role: "member" }))
        .status,
    ).toBe(400);
  });

  it("admits a whole domain as members only when the rule says so", async () => {
    await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: false });
    expect((await h.signIn("dee@acme.test")).error).toBe("not_member");
    await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: true });
    const dee = await h.signIn("dee@acme.test");
    expect(dee.error).toBeNull();
    expect(await json(await h.api(dee.cookie, "GET", "/api/me"))).toMatchObject({ role: "member" });
    // A look-alike domain is not the same domain.
    expect((await h.signIn("eve@notacme.test")).error).toBe("not_member");
    expect((await h.signIn("eve@acme.test.evil.test")).error).toBe("not_member");
  });

  it("refuses to open the door to a public mailbox domain", async () => {
    const response = await h.api(owner, "PUT", "/api/settings/sign-in/domains/gmail.com", {
      autoJoin: true,
    });
    expect(response.status).toBe(400);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("public_domain");
    expect(
      (await h.api(owner, "PUT", "/api/settings/sign-in/domains/not a domain", { autoJoin: true }))
        .status,
    ).toBe(400);
  });
});

describe("the sign-in exchange", () => {
  it("sets a cookie scripts cannot read and stores only its hash", async () => {
    const result = await h.signIn("owner@acme.test");
    expect(result.setCookie).toMatch(/HttpOnly/i);
    expect(result.setCookie).toMatch(/SameSite=Lax/i);
    const token = (result.cookie as string).split("=")[1] as string;
    const stored = await h.db.query<{ id: string }>("select id from sessions");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((s) => s.id)).not.toContain(token);
  });

  it("accepts each callback once", async () => {
    const { callback, binding } = await h.start("owner@acme.test");
    const first = await h.app.request(callback, { headers: { cookie: binding } });
    expect(first.headers.get("set-cookie")).toContain("muster_session=");
    const replay = await h.app.request(callback, { headers: { cookie: binding } });
    expect(replay.headers.get("set-cookie") ?? "").not.toContain("muster_session=");
    expect(replay.headers.get("location")).toContain("error=failed");
  });

  it("honours a callback only in the browser that started the sign-in", async () => {
    // Someone who is sent the link, or finds it in a log, has no binding cookie.
    const stolen = await h.start("owner@acme.test");
    const elsewhere = await h.app.request(stolen.callback);
    expect(elsewhere.headers.get("set-cookie") ?? "").not.toContain("muster_session=");
    expect(elsewhere.headers.get("location")).toContain("error=failed");
    // Nor does a browser holding a different attempt's cookie.
    const other = await h.start("owner@acme.test");
    const wrong = await h.app.request(stolen.callback, { headers: { cookie: other.binding } });
    expect(wrong.headers.get("set-cookie") ?? "").not.toContain("muster_session=");
    // Those failures do not use the attempt up.
    const rightful = await h.app.request(stolen.callback, { headers: { cookie: stolen.binding } });
    expect(rightful.headers.get("set-cookie")).toContain("muster_session=");
  });

  it("rejects a callback it did not start", async () => {
    const forged = await h.app.request("/auth/callback/dev?code=abc&state=made-up", {
      headers: { cookie: "muster_login=x" },
    });
    expect(forged.headers.get("set-cookie") ?? "").not.toContain("muster_session=");
    expect(forged.headers.get("location")).toContain("error=failed");
    expect((await h.app.request("/auth/login/nope")).status).toBe(404);
  });

  it("ends a session the browser already held when someone signs in", async () => {
    const again = await h.signIn("owner@acme.test", owner);
    expect(again.error).toBeNull();
    expect((await h.api(owner, "GET", "/api/me")).status).toBe(401);
    expect((await h.api(again.cookie, "GET", "/api/me")).status).toBe(200);
  });

  it("ends the session on sign-out", async () => {
    expect((await h.api(owner, "POST", "/auth/logout")).status).toBe(200);
    expect((await h.api(owner, "GET", "/api/me")).status).toBe(401);
  });

  it("requires a session for the API", async () => {
    expect((await h.api(null, "GET", "/api/me")).status).toBe(401);
    expect((await h.api("muster_session=guess", "GET", "/api/members")).status).toBe(401);
  });
});

describe("requests from other sites", () => {
  it("refuses a state-changing request without our origin", async () => {
    const noOrigin = await h.app.request("/api/departments", {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(noOrigin.status).toBe(403);
    const foreign = await h.api(
      owner,
      "POST",
      "/api/departments",
      { name: "X" },
      { origin: "https://evil.test" },
    );
    expect(foreign.status).toBe(403);
    expect(await json(await h.api(owner, "GET", "/api/departments"))).toEqual([]);
  });
});

describe("what each role may do", () => {
  it("lets an administrator manage ordinary members but not owners or administrators", async () => {
    const admin = await join("ada@acme.test", "admin");
    await join("mo@acme.test", "member");
    await join("al@acme.test", "admin");
    const [ownerId, mo, al] = await Promise.all([
      idOf("owner@acme.test"),
      idOf("mo@acme.test"),
      idOf("al@acme.test"),
    ]);

    expect((await h.api(admin, "PATCH", `/api/members/${mo}`, { role: "auditor" })).status).toBe(
      200,
    );
    expect((await h.api(admin, "PATCH", `/api/members/${mo}`, { role: "admin" })).status).toBe(403);
    expect((await h.api(admin, "PATCH", `/api/members/${mo}`, { role: "owner" })).status).toBe(403);
    expect(
      (await h.api(admin, "PATCH", `/api/members/${ownerId}`, { role: "member" })).status,
    ).toBe(403);
    expect(
      (await h.api(admin, "PATCH", `/api/members/${al}`, { status: "suspended" })).status,
    ).toBe(403);
    expect((await h.api(admin, "DELETE", `/api/members/${ownerId}`)).status).toBe(403);
    expect(
      (await h.api(admin, "POST", "/api/invitations", { email: "x@acme.test", role: "admin" }))
        .status,
    ).toBe(403);
    expect(
      (await h.api(admin, "POST", "/api/invitations", { email: "x@acme.test", role: "member" }))
        .status,
    ).toBe(200);
  });

  it("does not let an administrator withdraw an invitation to a role it could not grant", async () => {
    const admin = await join("ada@acme.test", "admin");
    const forOwner = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/invitations", { email: "o2@acme.test", role: "owner" }),
    );
    const forMember = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/invitations", { email: "m2@acme.test", role: "member" }),
    );
    expect((await h.api(admin, "DELETE", `/api/invitations/${forOwner.id}`)).status).toBe(403);
    expect((await h.api(admin, "DELETE", `/api/invitations/${forMember.id}`)).status).toBe(200);
    expect((await h.signIn("o2@acme.test")).error).toBeNull();
  });

  it("lets the auditor read everything and change nothing", async () => {
    const auditor = await join("au@acme.test", "auditor");
    const mo = await idOf("au@acme.test");
    for (const path of [
      "/api/members",
      "/api/departments",
      "/api/invitations",
      "/api/sessions",
      "/api/audit",
      "/api/settings/sign-in",
      "/api/dashboard",
      "/api/agents",
      "/api/traces",
    ]) {
      expect((await h.api(auditor, "GET", path)).status, path).toBe(200);
    }
    expect((await h.api(auditor, "PATCH", `/api/members/${mo}`, { role: "admin" })).status).toBe(
      403,
    );
    expect((await h.api(auditor, "POST", "/api/departments", { name: "X" })).status).toBe(403);
    expect(
      (await h.api(auditor, "POST", "/api/invitations", { email: "x@acme.test", role: "member" }))
        .status,
    ).toBe(403);
    expect(
      (await h.api(auditor, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: true }))
        .status,
    ).toBe(403);
  });

  it("keeps ordinary members and the billing role out of people data", async () => {
    const member = await join("mo@acme.test", "member");
    const billing = await join("bi@acme.test", "billing");
    expect((await h.api(member, "GET", "/api/me")).status).toBe(200);
    for (const path of [
      "/api/dashboard",
      "/api/members",
      "/api/audit",
      "/api/sessions",
      "/api/traces",
      "/api/agents",
    ]) {
      expect((await h.api(member, "GET", path)).status, path).toBe(403);
    }
    expect((await h.api(billing, "GET", "/api/dashboard")).status).toBe(200);
    expect((await h.api(billing, "GET", "/api/traces")).status).toBe(403);
    expect((await h.api(billing, "GET", "/api/members")).status).toBe(403);
    expect((await h.api(billing, "GET", "/api/audit")).status).toBe(403);
  });

  it("stops anyone changing their own role or status, so an owner cannot orphan the organization", async () => {
    const me = await idOf("owner@acme.test");
    expect((await h.api(owner, "PATCH", `/api/members/${me}`, { role: "member" })).status).toBe(
      400,
    );
    expect(
      (await h.api(owner, "PATCH", `/api/members/${me}`, { status: "suspended" })).status,
    ).toBe(400);
    expect((await h.api(owner, "DELETE", `/api/members/${me}`)).status).toBe(400);
    expect(await json(await h.api(owner, "GET", "/api/me"))).toMatchObject({ role: "owner" });
  });

  it("lets one owner demote another", async () => {
    const second = await join("o2@acme.test", "owner");
    const first = await idOf("owner@acme.test");
    expect((await h.api(second, "PATCH", `/api/members/${first}`, { role: "member" })).status).toBe(
      200,
    );
    expect((await h.api(owner, "GET", "/api/members")).status).toBe(403);
  });

  it("rejects malformed changes", async () => {
    await join("mo@acme.test");
    const mo = await idOf("mo@acme.test");
    expect((await h.api(owner, "PATCH", `/api/members/${mo}`, { role: "god" })).status).toBe(400);
    expect(
      (await h.api(owner, "PATCH", `/api/members/${mo}`, { role: "admin", extra: 1 })).status,
    ).toBe(400);
    expect((await h.api(owner, "PATCH", "/api/members/not-an-id", { role: "admin" })).status).toBe(
      404,
    );
    expect(
      (
        await h.api(owner, "PATCH", `/api/members/${mo}`, {
          departmentId: "0198c3a0-0000-7000-8000-000000000000",
        })
      ).status,
    ).toBe(400);
    // A refused change leaves nothing behind: the role in the same request is not applied either.
    const mixed = await h.api(owner, "PATCH", `/api/members/${mo}`, {
      role: "admin",
      departmentId: "0198c3a0-0000-7000-8000-000000000000",
    });
    expect(mixed.status).toBe(400);
    const members = await json<{ id: string; role: string }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
    expect(members.find((m) => m.id === mo)?.role).toBe("member");
    expect(await actions()).not.toContain("member.role_changed");
  });
});

describe("suspending and removing people", () => {
  it("cuts a suspended person off at once and lets them back when reactivated", async () => {
    const mo = await join("mo@acme.test");
    const id = await idOf("mo@acme.test");
    expect((await h.api(mo, "GET", "/api/me")).status).toBe(200);

    expect(
      (await h.api(owner, "PATCH", `/api/members/${id}`, { status: "suspended" })).status,
    ).toBe(200);
    expect((await h.api(mo, "GET", "/api/me")).status).toBe(401);
    expect((await h.signIn("mo@acme.test")).error).toBe("suspended");

    expect((await h.api(owner, "PATCH", `/api/members/${id}`, { status: "active" })).status).toBe(
      200,
    );
    // The old session stays dead; a new sign-in is needed.
    expect((await h.api(mo, "GET", "/api/me")).status).toBe(401);
    expect((await h.signIn("mo@acme.test")).error).toBeNull();
  });

  it("cuts a removed person off and does not let them back in", async () => {
    const mo = await join("mo@acme.test");
    expect(
      (await h.api(owner, "DELETE", `/api/members/${await idOf("mo@acme.test")}`)).status,
    ).toBe(200);
    expect((await h.api(mo, "GET", "/api/me")).status).toBe(401);
    expect((await h.signIn("mo@acme.test")).error).toBe("removed");
  });

  it("keeps a removed person out even when their domain joins automatically, until invited again", async () => {
    await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: true });
    expect((await h.signIn("dee@acme.test")).error).toBeNull();
    expect(
      (await h.api(owner, "DELETE", `/api/members/${await idOf("dee@acme.test")}`)).status,
    ).toBe(200);
    expect((await h.signIn("dee@acme.test")).error).toBe("removed");
    // Still listed, as removed, so an administrator can let them back in.
    const listed = await json<{ email: string; status: string }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
    expect(listed.find((m) => m.email === "dee@acme.test")?.status).toBe("removed");

    expect(
      (await h.api(owner, "POST", "/api/invitations", { email: "dee@acme.test", role: "auditor" }))
        .status,
    ).toBe(200);
    const back = await h.signIn("dee@acme.test");
    expect(back.error).toBeNull();
    expect(await json(await h.api(back.cookie, "GET", "/api/me"))).toMatchObject({
      role: "auditor",
    });
  });
});

describe("sessions", () => {
  it("lists live sessions and lets an administrator end one", async () => {
    const mo = await join("mo@acme.test");
    const sessions = await json<{ id: string; email: string; current: boolean }[]>(
      await h.api(owner, "GET", "/api/sessions"),
    );
    expect(sessions.filter((s) => s.current).map((s) => s.email)).toEqual(["owner@acme.test"]);
    const target = sessions.find((s) => s.email === "mo@acme.test") as { id: string };
    expect((await h.api(owner, "DELETE", `/api/sessions/${target.id}`)).status).toBe(200);
    expect((await h.api(mo, "GET", "/api/me")).status).toBe(401);
    expect((await h.api(owner, "DELETE", `/api/sessions/${target.id}`)).status).toBe(404);
  });

  it("does not let an administrator end an owner's session", async () => {
    const admin = await join("ada@acme.test", "admin");
    const sessions = await json<{ id: string; email: string }[]>(
      await h.api(admin, "GET", "/api/sessions"),
    );
    const ownersSession = sessions.find((s) => s.email === "owner@acme.test") as { id: string };
    expect((await h.api(admin, "DELETE", `/api/sessions/${ownersSession.id}`)).status).toBe(403);
    expect((await h.api(owner, "GET", "/api/me")).status).toBe(200);
  });
});

describe("departments", () => {
  it("creates, renames, assigns and deletes", async () => {
    const created = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/departments", { name: "工程部" }),
    );
    expect((await h.api(owner, "POST", "/api/departments", { name: "工程部" })).status).toBe(409);
    expect((await h.api(owner, "POST", "/api/departments", { name: "  " })).status).toBe(400);

    await join("mo@acme.test");
    const mo = await idOf("mo@acme.test");
    expect(
      (await h.api(owner, "PATCH", `/api/members/${mo}`, { departmentId: created.id })).status,
    ).toBe(200);
    expect(await json(await h.api(owner, "GET", "/api/departments"))).toEqual([
      { id: created.id, name: "工程部", members: 1 },
    ]);

    expect(
      (await h.api(owner, "PATCH", `/api/departments/${created.id}`, { name: "研发部" })).status,
    ).toBe(200);
    expect((await h.api(owner, "DELETE", `/api/departments/${created.id}`)).status).toBe(200);
    const members = await json<{ email: string; departmentId: string | null }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
    expect(members.find((m) => m.email === "mo@acme.test")?.departmentId).toBeNull();
  });
});

describe("the record of administrative actions", () => {
  it("records every change with who did it", async () => {
    const department = await json<{ id: string }>(
      await h.api(owner, "POST", "/api/departments", { name: "工程部" }),
    );
    await join("mo@acme.test");
    const mo = await idOf("mo@acme.test");
    await h.api(owner, "PATCH", `/api/members/${mo}`, {
      role: "auditor",
      departmentId: department.id,
    });
    await h.api(owner, "PATCH", `/api/members/${mo}`, { status: "suspended" });
    await h.api(owner, "PATCH", `/api/members/${mo}`, { status: "active" });
    await h.api(owner, "DELETE", `/api/members/${mo}`);
    await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: true });
    await h.api(owner, "DELETE", "/api/settings/sign-in/domains/acme.test");
    await h.api(owner, "PATCH", `/api/departments/${department.id}`, { name: "研发部" });
    await h.api(owner, "DELETE", `/api/departments/${department.id}`);

    const seen = await actions();
    for (const action of [
      "org.created",
      "member.joined",
      "auth.login",
      "department.created",
      "invitation.created",
      "member.role_changed",
      "member.department_changed",
      "member.suspended",
      "member.reactivated",
      "member.removed",
      "signin.domain_set",
      "signin.domain_removed",
      "department.renamed",
      "department.deleted",
    ]) {
      expect(seen, action).toContain(action);
    }
    const events = await json<
      { action: string; actorEmail: string; targetLabel: string; detail: unknown }[]
    >(await h.api(owner, "GET", "/api/audit?limit=100"));
    expect(events.find((e) => e.action === "member.role_changed")).toMatchObject({
      actorEmail: "owner@acme.test",
      targetLabel: "mo@acme.test",
      detail: { from: "member", to: "auditor" },
    });
  });

  it("does not record a refused change as if it happened", async () => {
    const admin = await join("ada@acme.test", "admin");
    const before = (await actions()).length;
    await h.api(admin, "PATCH", `/api/members/${await idOf("owner@acme.test")}`, {
      role: "member",
    });
    expect((await actions()).length).toBe(before);
  });

  it("records a suspended person's attempt to sign in", async () => {
    await join("mo@acme.test");
    await h.api(owner, "PATCH", `/api/members/${await idOf("mo@acme.test")}`, {
      status: "suspended",
    });
    await h.signIn("mo@acme.test");
    expect(await actions()).toContain("auth.login_denied");
  });

  it("pages newest first", async () => {
    for (const name of ["a", "b", "c"]) await h.api(owner, "POST", "/api/departments", { name });
    const firstPage = await json<{ seq: number; targetLabel: string }[]>(
      await h.api(owner, "GET", "/api/audit?limit=2"),
    );
    expect(firstPage.map((e) => e.targetLabel)).toEqual(["c", "b"]);
    const next = await json<{ targetLabel: string }[]>(
      await h.api(owner, "GET", `/api/audit?limit=1&before=${firstPage[1]?.seq}`),
    );
    expect(next.map((e) => e.targetLabel)).toEqual(["a"]);
    expect((await h.api(owner, "GET", "/api/audit?before=junk")).status).toBe(400);
  });
});

describe("the dashboard", () => {
  it("counts what is there", async () => {
    await join("mo@acme.test");
    await h.api(owner, "POST", "/api/invitations", { email: "pending@acme.test", role: "member" });
    const dashboard = await json<{
      people: Record<string, unknown>;
      activity: { totals: { runs: number } };
    }>(await h.api(owner, "GET", "/api/dashboard"));
    expect(dashboard.people).toMatchObject({
      members: 2,
      suspended: 0,
      invitations: 1,
      sessions: 2,
    });
    expect(dashboard.people.byRole).toEqual(
      expect.arrayContaining([
        { key: "owner", value: 1 },
        { key: "member", value: 1 },
      ]),
    );
    expect(dashboard.activity.totals.runs).toBe(0);
    expect((await h.api(owner, "GET", "/api/dashboard?range=forever")).status).toBe(400);
  });
});

describe("signing in from a native app", () => {
  const verifier = "v".repeat(50);
  const challenge = async () => {
    const { s256 } = await import("./auth/app-login.js");
    return s256(verifier);
  };
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

  /** Walks the browser side: start, confirm page, approve. Returns where the browser is sent. */
  const browserSide = async (session: string, redirect = "muster://auth") => {
    const start = await h.app.request(
      `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent(redirect)}`,
      { headers: { cookie: session } },
    );
    expect(start.headers.get("location")).toBe("http://muster.test/auth/app/confirm");
    const jar = `${session}; ${cookies(start)}`;
    const page = await h.app.request("/auth/app/confirm", { headers: { cookie: jar } });
    expect(page.headers.get("cache-control")).toContain("no-transform");
    // Between the comments that tell a proxy in front not to hide the address.
    expect(await page.text()).toMatch(/<!--email_off--><b>owner@acme\.test<\/b><!--\/email_off-->/);
    return {
      jar,
      approve: (decision: string, origin = "http://muster.test") =>
        h.app.request("/auth/app/approve", {
          method: "POST",
          headers: { cookie: jar, origin, "content-type": "application/x-www-form-urlencoded" },
          body: `decision=${decision}`,
        }),
    };
  };
  const exchange = (code: string, secret = verifier) =>
    h.app.request("/auth/app/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: secret }),
    });

  it("hands the app a session only after the person confirms, and the token then works as a bearer", async () => {
    const { approve } = await browserSide(owner);
    const back = new URL((await approve("allow")).headers.get("location") as string);
    expect(`${back.protocol}//${back.host}`).toBe("muster://auth");
    const code = back.searchParams.get("code") as string;

    const { token } = (await (await exchange(code)).json()) as { token: string };
    const me = await h.app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ role: "owner", user: { email: "owner@acme.test" } });
    // A bearer request changes things without an Origin header: it carries its own proof.
    const made = await h.app.request("/api/departments", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "From the app" }),
    });
    expect(made.status).toBe(200);
    // But a page somewhere else says where it is from, and is refused, token or no token:
    // the desktop app shows other pages inside its window, and none may act as the person.
    for (const [origin, status] of [
      ["http://localhost:4173", 403],
      ["null", 403],
      [PUBLIC_URL, 200],
    ] as const)
      expect(
        (
          await h.app.request("/api/departments", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              origin,
            },
            body: JSON.stringify({ name: `From ${origin}` }),
          })
        ).status,
        origin,
      ).toBe(status);
    // The code works once.
    expect((await exchange(code)).status).toBe(401);
    const sessions = (await (await h.api(owner, "GET", "/api/sessions")).json()) as {
      kind: string;
    }[];
    expect(sessions.map((s) => s.kind).sort()).toEqual(["app", "browser"]);
  });

  it("gives nothing to someone who has the code but not the app's secret", async () => {
    const { approve } = await browserSide(owner);
    const code = new URL(
      (await approve("allow")).headers.get("location") as string,
    ).searchParams.get("code") as string;
    expect((await exchange(code, "w".repeat(50))).status).toBe(401);
    expect((await exchange("x".repeat(43))).status).toBe(401);
  });

  it("issues no code when the person cancels, or when the approval comes from another site", async () => {
    const cancelled = await browserSide(owner);
    expect((await cancelled.approve("deny")).headers.get("location")).toBe("http://muster.test/");
    const forged = await browserSide(owner);
    expect((await forged.approve("allow", "https://evil.test")).status).toBe(403);
    expect(await h.db.query("select 1 from app_logins where code is not null")).toHaveLength(0);
  });

  it("only sends the browser back to the app or to this computer", async () => {
    for (const redirect of [
      "https://evil.test/callback",
      "muster://auth/extra",
      "musterx://auth",
      "http://127.0.0.1.evil.test:8080/callback",
      "http://localhost:8080/callback",
      "javascript:alert(1)",
    ]) {
      const response = await h.app.request(
        `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent(redirect)}`,
        { headers: { cookie: owner } },
      );
      expect(response.status, redirect).toBe(400);
    }
    const loopback = await browserSide(owner, "http://127.0.0.1:53111/callback");
    expect((await loopback.approve("allow")).headers.get("location")).toMatch(
      /^http:\/\/127\.0\.0\.1:53111\/callback\?code=/,
    );
    expect(
      (await h.app.request("/auth/app/start?challenge=short&redirect=muster%3A%2F%2Fauth")).status,
    ).toBe(400);
  });

  it("sends someone who is not signed in through sign-in first, then to the confirmation", async () => {
    const start = await h.app.request(
      `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent("muster://auth")}`,
    );
    expect(start.headers.get("location")).toBe("http://muster.test/auth/login/dev");
    // The app may say which way of signing in was pressed; one the server does not offer is ignored.
    for (const provider of ["dev", "nobody", "../x"]) {
      const asked = await h.app.request(
        `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent("muster://auth")}&provider=${encodeURIComponent(provider)}`,
      );
      expect(asked.headers.get("location"), provider).toBe("http://muster.test/auth/login/dev");
    }
    // With several ways to sign in, the one named is gone to, and an unknown one leaves the choice to the person.
    const two = await harness({
      MUSTER_GOOGLE_CLIENT_ID: "id",
      MUSTER_GOOGLE_CLIENT_SECRET: "secret",
    });
    const among = async (provider: string) =>
      (
        await two.app.request(
          `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent("muster://auth")}&provider=${provider}`,
        )
      ).headers.get("location");
    expect(await among("google")).toBe("http://muster.test/auth/login/google");
    expect(await among("dev")).toBe("http://muster.test/auth/login/dev");
    expect(await among("nobody")).toBe("http://muster.test/");
    const appCookie = cookies(start);
    const { callback, binding } = await h.start("owner@acme.test");
    const done = await h.app.request(callback, { headers: { cookie: `${binding}; ${appCookie}` } });
    expect(done.headers.get("location")).toBe("http://muster.test/auth/app/confirm");
  });

  it("refuses the exchange for someone suspended in the meantime", async () => {
    const mo = await join("mo@acme.test");
    const start = await h.app.request(
      `/auth/app/start?challenge=${await challenge()}&redirect=${encodeURIComponent("muster://auth")}`,
      { headers: { cookie: mo } },
    );
    const jar = `${mo}; ${cookies(start)}`;
    const approved = await h.app.request("/auth/app/approve", {
      method: "POST",
      headers: {
        cookie: jar,
        origin: "http://muster.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "decision=allow",
    });
    const code = new URL(approved.headers.get("location") as string).searchParams.get(
      "code",
    ) as string;
    await h.api(owner, "PATCH", `/api/members/${await idOf("mo@acme.test")}`, {
      status: "suspended",
    });
    expect((await exchange(code)).status).toBe(401);
  });
});
