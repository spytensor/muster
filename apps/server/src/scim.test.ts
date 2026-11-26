import { beforeAll, describe, expect, it } from "vitest";
import { SCIM_PER_MINUTE } from "./scim.js";
import { type Harness, harness, PUBLIC_URL } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
type User = {
  id: string;
  userName: string;
  active: boolean;
  displayName: string;
  externalId?: string;
};
type Group = { id: string; displayName: string; members?: { value: string; display: string }[] };
type List<T> = { totalResults: number; startIndex: number; itemsPerPage: number; Resources: T[] };

describe("the company's directory, provisioning through SCIM", () => {
  let h: Harness;
  let owner: string;
  let token: string;
  let tokenId: string;
  const blocked: string[] = [];
  /** A request as a directory makes it: its token in a header, no cookie, no origin. */
  const scim = (method: string, path: string, body?: unknown, bearer = token) =>
    h.app.request(`/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const events = async () => JSON.stringify(await json(await h.api(owner, "GET", "/api/audit")));
  const statusOf = async (email: string) =>
    (
      await h.db.query<{ status: string }>(
        "select m.status from memberships m join users u on u.id = m.user_id where u.email = $1",
        [email],
      )
    )[0]?.status;

  beforeAll(async () => {
    h = await harness();
    owner = (await h.signIn("owner@acme.test")).cookie as string;
    // The organization's own domain: the directory provisions people at addresses in it.
    await h.api(owner, "PUT", "/api/settings/sign-in/domains/acme.test", { autoJoin: false });
    // What a run engine does: asks to be told when someone's access ends.
    h.runs.stopUser = async (userId: string) => {
      blocked.push(userId);
    };
  });

  it("acts with a token an administrator made, said once and kept only as a hash", async () => {
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    const mo = (await h.signIn("mo@acme.test")).cookie as string;
    expect((await h.api(mo, "POST", "/api/settings/sso/scim/tokens")).status).toBe(403);
    // Nor an administrator's: what the directory may do reaches everyone's access.
    await h.api(owner, "POST", "/api/invitations", { email: "ada@acme.test", role: "admin" });
    const ada = (await h.signIn("ada@acme.test")).cookie as string;
    expect((await h.api(ada, "POST", "/api/settings/sso/scim/tokens")).status).toBe(403);
    const made = await json<{ id: string; token: string; tail: string }>(
      await h.api(owner, "POST", "/api/settings/sso/scim/tokens"),
    );
    token = made.token;
    tokenId = made.id;
    expect(token).toMatch(/^scim_/);
    const page = await json<{ scim: { baseUrl: string; tokens: { id: string; tail: string }[] } }>(
      await h.api(owner, "GET", "/api/settings/sso"),
    );
    expect(page.scim.baseUrl).toBe(`${PUBLIC_URL}/scim/v2`);
    expect(page.scim.tokens).toMatchObject([{ id: tokenId, tail: token.slice(-4) }]);
    expect(JSON.stringify(page)).not.toContain(token);
    const kept = JSON.stringify(await h.db.query("select * from scim_tokens"));
    expect(kept).not.toContain(token);
    expect(await events()).not.toContain(token);

    // Without it, with a wrong one, or with a person's session: nothing.
    expect((await h.app.request("/scim/v2/Users")).status).toBe(401);
    expect((await scim("GET", "/Users", undefined, "scim_wrong")).status).toBe(401);
    expect((await h.api(owner, "GET", "/scim/v2/Users")).status).toBe(401);
    const config = await scim("GET", "/ServiceProviderConfig");
    expect(config.headers.get("content-type")).toContain("application/scim+json");
    expect(await json(config)).toMatchObject({
      patch: { supported: true },
      filter: { supported: true },
    });
    expect(
      (await json<List<{ id: string }>>(await scim("GET", "/ResourceTypes"))).Resources.map(
        (one) => one.id,
      ),
    ).toEqual(["User", "Group"]);
    expect((await json<List<unknown>>(await scim("GET", "/Schemas"))).totalResults).toBe(2);
  });

  it("brings people in, finds them, and changes what the directory says of them", async () => {
    const made = await scim("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "Dana@Acme.test",
      externalId: "ext-dana",
      name: { givenName: "Dana", familyName: "Reyes" },
      active: true,
    });
    expect(made.status).toBe(201);
    const dana = await json<User>(made);
    expect(dana).toMatchObject({
      userName: "dana@acme.test",
      active: true,
      displayName: "Dana Reyes",
      externalId: "ext-dana",
    });
    expect(made.headers.get("location")).toBe(`${PUBLIC_URL}/scim/v2/Users/${dana.id}`);
    // Twice is refused; so is an address that is not one.
    expect((await scim("POST", "/Users", { userName: "dana@acme.test" })).status).toBe(409);
    expect((await scim("POST", "/Users", { userName: "not an address" })).status).toBe(400);
    expect((await scim("POST", "/Users", { userName: "dKna@acme.test" })).status).toBe(400);

    // Found by address, by the directory's own id, or not at all.
    const byName = await json<List<User>>(
      await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "DANA@acme.test"')}`),
    );
    expect(byName).toMatchObject({ totalResults: 1, Resources: [{ id: dana.id }] });
    const byExternal = await json<List<User>>(
      await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "ext-dana"')}`),
    );
    expect(byExternal.Resources.map((one) => one.id)).toEqual([dana.id]);
    expect(
      (
        await json<List<User>>(
          await scim(
            "GET",
            `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.test"')}`,
          ),
        )
      ).totalResults,
    ).toBe(0);
    expect(
      (await scim("GET", `/Users?filter=${encodeURIComponent('userName co "dana"')}`)).status,
    ).toBe(400);
    // In pages.
    const all = await json<List<User>>(await scim("GET", "/Users?startIndex=2&count=1"));
    expect(all).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 1 });
    expect((await scim("GET", `/Users/${dana.id}`)).status).toBe(200);
    expect((await scim("GET", "/Users/not-an-id")).status).toBe(404);

    // The person can sign in with the company's provider and is who was provisioned.
    const cookie = (await h.signIn("dana@acme.test")).cookie;
    expect(cookie).not.toBeNull();

    // Renamed, in the two ways the directories say it.
    const renamed = await json<User>(
      await scim("PATCH", `/Users/${dana.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "displayName", value: "Dana R." }],
      }),
    );
    expect(renamed.displayName).toBe("Dana R.");
    const replaced = await json<User>(
      await scim("PUT", `/Users/${dana.id}`, {
        userName: "dana@acme.test",
        displayName: "Dana Reyes",
        active: true,
      }),
    );
    expect(replaced).toMatchObject({ displayName: "Dana Reyes", active: true });
    expect((await scim("PATCH", `/Users/${dana.id}`, { Operations: [] })).status).toBe(400);
    const log = await events();
    expect(log).toContain('"via":"scim"');
    expect(log).toContain(`…${token.slice(-4)}`);
  });

  it("takes access away as an administrator would: sessions and work end, nothing is deleted", async () => {
    const dana = (
      await json<List<User>>(
        await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "dana@acme.test"')}`),
      )
    ).Resources[0] as User;
    const cookie = (await h.signIn("dana@acme.test")).cookie as string;
    const conversation = await h.db.query<{ n: number }>(
      "select count(*)::int as n from conversations",
    );
    // Entra says "False" as a word; Okta says false in an object.
    const off = await json<User>(
      await scim("PATCH", `/Users/${dana.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      }),
    );
    expect(off.active).toBe(false);
    expect(await statusOf("dana@acme.test")).toBe("suspended");
    expect((await h.api(cookie, "GET", "/api/me")).status).toBe(401);
    expect((await h.signIn("dana@acme.test")).error).toBe("suspended");
    expect(blocked).toContain(dana.id);
    // And back.
    const on = await json<User>(
      await scim("PATCH", `/Users/${dana.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", value: { active: true } }],
      }),
    );
    expect(on.active).toBe(true);
    expect((await h.signIn("dana@acme.test")).cookie).not.toBeNull();

    // Deleted in the directory: removed here, kept on record, gone from what the directory sees.
    blocked.length = 0;
    expect((await scim("DELETE", `/Users/${dana.id}`)).status).toBe(204);
    expect(await statusOf("dana@acme.test")).toBe("removed");
    expect(blocked).toEqual([dana.id]);
    expect((await scim("GET", `/Users/${dana.id}`)).status).toBe(404);
    expect((await scim("DELETE", `/Users/${dana.id}`)).status).toBe(404);
    expect((await h.signIn("dana@acme.test")).error).toBe("removed");
    expect((await h.db.query("select 1 from users where email = 'dana@acme.test'")).length).toBe(1);
    expect(await h.db.query<{ n: number }>("select count(*)::int as n from conversations")).toEqual(
      conversation,
    );
    // Provisioned again, they are back.
    const back = await scim("POST", "/Users", { userName: "dana@acme.test" });
    expect(back.status).toBe(201);
    expect((await json<User>(back)).id).toBe(dana.id);
    expect(await statusOf("dana@acme.test")).toBe("active");

    // An owner or an administrator is not the directory's to change at all.
    const boss = (
      await json<List<User>>(
        await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "owner@acme.test"')}`),
      )
    ).Resources[0] as User;
    const chief = (
      await json<List<User>>(
        await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "ada@acme.test"')}`),
      )
    ).Resources[0] as User;
    for (const reserved of [boss, chief]) {
      expect((await scim("DELETE", `/Users/${reserved.id}`)).status).toBe(403);
      for (const operation of [
        { op: "replace", path: "active", value: false },
        { op: "replace", path: "displayName", value: "Renamed" },
        { op: "replace", path: "userName", value: "taken-over@acme.test" },
      ])
        expect(
          (
            await scim("PATCH", `/Users/${reserved.id}`, {
              schemas: [PATCH],
              Operations: [operation],
            })
          ).status,
        ).toBe(403);
      // Saying again what is already so is let through: a directory's full sync does.
      expect(
        (
          await scim("PUT", `/Users/${reserved.id}`, {
            userName: reserved.userName,
            displayName: reserved.displayName,
            active: true,
            externalId: "ext-kept",
          })
        ).status,
      ).toBe(200);
    }
    expect(await statusOf("owner@acme.test")).toBe("active");
    expect(await statusOf("ada@acme.test")).toBe("active");
    expect(
      (await h.db.query("select 1 from users where email in ('owner@acme.test', 'ada@acme.test')"))
        .length,
    ).toBe(2);
    const log = await events();
    for (const action of ["member.suspended", "member.reactivated", "member.removed"])
      expect(log).toContain(action);
  });

  it("gives back only the access it took away itself, and leaves a signed-in person's address alone", async () => {
    const find = async (email: string) =>
      (
        await json<List<User>>(
          await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`),
        )
      ).Resources[0] as User;
    const active = (id: string, value: boolean) =>
      scim("PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "active", value }],
      });
    const dana = await find("dana@acme.test");
    // An administrator suspends: the directory saying "active" does not undo it.
    expect(
      (await h.api(owner, "PATCH", `/api/members/${dana.id}`, { status: "suspended" })).status,
    ).toBe(200);
    expect((await active(dana.id, true)).status).toBe(403);
    expect(
      (await scim("PUT", `/Users/${dana.id}`, { userName: "dana@acme.test", active: true })).status,
    ).toBe(403);
    expect(await statusOf("dana@acme.test")).toBe("suspended");
    // The administrator lets them back; the directory suspends; then it may give that back.
    expect(
      (await h.api(owner, "PATCH", `/api/members/${dana.id}`, { status: "active" })).status,
    ).toBe(200);
    expect((await active(dana.id, false)).status).toBe(200);
    expect((await active(dana.id, true)).status).toBe(200);
    // An administrator removes: provisioning them again does not bring them back.
    expect((await h.api(owner, "DELETE", `/api/members/${dana.id}`)).status).toBe(200);
    expect((await scim("POST", "/Users", { userName: "dana@acme.test" })).status).toBe(409);
    expect(await statusOf("dana@acme.test")).toBe("removed");
    expect(
      (await h.api(owner, "PATCH", `/api/members/${dana.id}`, { status: "active" })).status,
    ).toBe(200);

    // Dana has signed in: her address is how she is known, and the directory does not move it.
    expect(
      (
        await scim("PATCH", `/Users/${dana.id}`, {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "userName", value: "dana.reyes@acme.test" }],
        })
      ).status,
    ).toBe(403);
    // Someone it provisioned who has never signed in may be moved, within the organization's domains.
    const lee = await json<User>(await scim("POST", "/Users", { userName: "lee@acme.test" }));
    const outside = await scim("PUT", `/Users/${lee.id}`, { userName: "lee@elsewhere.test" });
    expect(outside.status).toBe(400);
    const moved = await scim("PUT", `/Users/${lee.id}`, { userName: "lee.wong@acme.test" });
    expect(moved.status).toBe(200);
    expect((await json<User>(moved)).userName).toBe("lee.wong@acme.test");
    // Once single sign-on is on, the provider says who a person is, whatever their address.
    await h.db.query(
      `insert into saml_settings (org_id, entity_id, sso_url, certificates, enabled)
       select id, 'https://idp.acme.test/saml', 'https://idp.acme.test/sso', '[]'::jsonb, true
         from organizations where name = 'Acme'`,
    );
    expect(
      (
        await scim("PATCH", `/Users/${dana.id}`, {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "userName", value: "dana.reyes@acme.test" }],
        })
      ).status,
    ).toBe(200);
    await scim("PATCH", `/Users/${dana.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "userName", value: "dana@acme.test" }],
    });
    await h.db.query("delete from saml_settings");
    expect(await events()).toContain("member.address_changed");
  });

  it("keeps departments as the directory's groups, with who is in them", async () => {
    const people = (await json<List<User>>(await scim("GET", "/Users"))).Resources;
    const dana = people.find((one) => one.userName === "dana@acme.test") as User;
    const mo = people.find((one) => one.userName === "mo@acme.test") as User;
    const made = await scim("POST", "/Groups", {
      displayName: "Finance",
      externalId: "g-fin",
      members: [{ value: dana.id }],
    });
    expect(made.status).toBe(201);
    const finance = await json<Group>(made);
    expect(finance.members).toMatchObject([{ value: dana.id, display: "dana@acme.test" }]);
    expect((await scim("POST", "/Groups", { displayName: "Finance" })).status).toBe(409);
    expect((await scim("POST", "/Groups", { displayName: "" })).status).toBe(400);
    // The console sees the same department.
    const shown = await json<{ name: string; members: number }[]>(
      await h.api(owner, "GET", "/api/departments"),
    );
    expect(shown).toMatchObject([{ name: "Finance", members: 1 }]);

    // Added and taken out, the ways Entra and Okta say it.
    await scim("PATCH", `/Groups/${finance.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "Add", path: "members", value: [{ value: mo.id }] }],
    });
    await scim("PATCH", `/Groups/${finance.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "Remove", path: `members[value eq "${dana.id}"]` }],
    });
    let now = await json<Group>(await scim("GET", `/Groups/${finance.id}`));
    expect(now.members?.map((one) => one.value)).toEqual([mo.id]);
    await scim("PATCH", `/Groups/${finance.id}`, {
      schemas: [PATCH],
      Operations: [
        { op: "remove", path: "members", value: [{ value: mo.id }] },
        { op: "replace", value: { displayName: "Finance & Legal" } },
      ],
    });
    now = await json<Group>(await scim("GET", `/Groups/${finance.id}`));
    expect(now).toMatchObject({ displayName: "Finance & Legal", members: [] });
    // Replaced whole.
    now = await json<Group>(
      await scim("PUT", `/Groups/${finance.id}`, {
        displayName: "Finance",
        members: [{ value: dana.id }, { value: mo.id }],
      }),
    );
    expect(now.members?.length).toBe(2);
    now = await json<Group>(
      await scim("PUT", `/Groups/${finance.id}`, {
        displayName: "Finance",
        members: [{ value: mo.id }],
      }),
    );
    expect(now.members?.map((one) => one.value)).toEqual([mo.id]);
    // Found by name, without its members when that is asked.
    const found = await json<List<Group>>(
      await scim(
        "GET",
        `/Groups?filter=${encodeURIComponent('displayName eq "Finance"')}&excludedAttributes=members`,
      ),
    );
    expect(found.Resources).toMatchObject([{ id: finance.id, displayName: "Finance" }]);
    expect(found.Resources[0]?.members).toBeUndefined();

    expect((await scim("DELETE", `/Groups/${finance.id}`)).status).toBe(204);
    expect((await scim("GET", `/Groups/${finance.id}`)).status).toBe(404);
    expect(await json(await h.api(owner, "GET", "/api/departments"))).toEqual([]);
    expect(await statusOf("mo@acme.test")).toBe("active");
    const log = await events();
    for (const action of [
      "department.created",
      "department.renamed",
      "member.department_changed",
      "department.deleted",
    ])
      expect(log).toContain(action);
  });

  it("reaches only its own organization, is slowed when it asks too much, and stops when revoked", async () => {
    // Another organization's person is not this token's to see or change.
    const other = "01900000-0000-7000-8000-00000000aaaa";
    await h.db.query("insert into organizations (id, name) values ($1, 'Other')", [other]);
    await h.db.query("insert into users (id, email, name) values ($1, 'eve@other.test', 'Eve')", [
      other,
    ]);
    await h.db.query(
      "insert into memberships (org_id, user_id, role, joined_via) values ($1, $1, 'member', 'test')",
      [other],
    );
    expect((await scim("GET", `/Users/${other}`)).status).toBe(404);
    expect((await scim("DELETE", `/Users/${other}`)).status).toBe(404);
    // An address outside the organization's domains is answered the same whether or not
    // somebody somewhere has it.
    const taken = await scim("POST", "/Users", { userName: "eve@other.test" });
    const free = await scim("POST", "/Users", { userName: "nobody@other.test" });
    expect(taken.status).toBe(400);
    expect(await taken.text()).toBe(await free.text());
    expect((await h.db.query("select 1 from users where email = 'nobody@other.test'")).length).toBe(
      0,
    );
    // Where to begin is a whole number, and no further in than anyone has people.
    expect((await scim("GET", "/Users?startIndex=abc")).status).toBe(400);
    expect((await scim("GET", "/Users?count=1.5")).status).toBe(400);
    expect(await json<List<User>>(await scim("GET", "/Users?startIndex=99999999"))).toMatchObject({
      startIndex: 1_000_000,
      itemsPerPage: 0,
    });
    expect(await json<List<User>>(await scim("GET", "/Users?startIndex=-3&count=1"))).toMatchObject(
      {
        startIndex: 1,
        itemsPerPage: 1,
      },
    );
    expect(
      (
        await json<List<User>>(
          await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "eve@other.test"')}`),
        )
      ).totalResults,
    ).toBe(0);
    expect(await statusOf("eve@other.test")).toBe("active");

    let last = 200;
    for (let n = 0; n < SCIM_PER_MINUTE + 5 && last === 200; n++)
      last = (await scim("GET", "/ServiceProviderConfig")).status;
    expect(last).toBe(429);

    expect((await h.api(owner, "DELETE", `/api/settings/sso/scim/tokens/${tokenId}`)).status).toBe(
      200,
    );
    expect((await scim("GET", "/Users")).status).toBe(401);
    for (let n = 0; n < 5; n++)
      expect((await h.api(owner, "POST", "/api/settings/sso/scim/tokens")).status).toBe(200);
    expect((await h.api(owner, "POST", "/api/settings/sso/scim/tokens")).status).toBe(409);
    const log = await events();
    expect(log).toContain("scim.token_created");
    expect(log).toContain("scim.token_revoked");
  });
});
