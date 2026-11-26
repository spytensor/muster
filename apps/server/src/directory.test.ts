import { beforeAll, describe, expect, it } from "vitest";
import { addressFor, departmentNames, isNoAddress } from "./directory.js";
import type { DirectoryKind } from "./directory/types.js";
import type { Net, NetResponse } from "./runtime/net.js";
import { type Harness, harness, PUBLIC_URL } from "./test-support.js";

const json = async <T = unknown>(response: Response): Promise<T> => (await response.json()) as T;

/** A person as the test's company holds them. */
interface Staff {
  id: string;
  name: string;
  email?: string;
  /** An address the person typed into their own profile there. */
  typed?: string;
  departments: string[];
  /** Left the company, or switched off there. */
  gone?: boolean;
}
interface Company {
  /** What the service accepts as the application's secret. */
  secret: string;
  staff: Staff[];
  /** id, name, parent ("" for one under the company). */
  departments: [string, string, string][];
  /** A code the service gave someone at sign-in, and who they are: staff, or someone from outside. */
  codes: Map<string, string>;
  /** The application was given sight of some people only, not the whole company. */
  part?: boolean;
  /** What the application lacks, when it lacks something. */
  lacks?: string;
  /** Every address asked for, for a test to look at. */
  asked: string[];
}

const answer = (value: unknown, status = 200): NetResponse => ({
  status,
  contentType: "application/json",
  text: JSON.stringify(value),
  truncated: false,
  url: "",
});

/** Stands in for Feishu. People are named by "on_<id>"; someone from outside has no record. */
function feishu(company: Company): Net {
  const user = (one: Staff) => ({
    union_id: `on_${one.id}`,
    open_id: `ou_${one.id}`,
    name: one.name,
    ...(one.email ? { enterprise_email: one.email } : {}),
    ...(one.typed ? { email: one.typed } : {}),
    department_ids: one.departments.length ? one.departments : ["0"],
    status: { is_resigned: Boolean(one.gone), is_frozen: false, is_activated: true },
    avatar: { avatar_240: `https://pictures.test/${one.id}.png` },
  });
  return {
    async request(address, init = {}) {
      company.asked.push(address);
      const url = new URL(address);
      const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
      const path = url.pathname.replace("/open-apis", "");
      if (path === "/auth/v3/tenant_access_token/internal")
        return answer(
          body.app_secret === company.secret
            ? { code: 0, tenant_access_token: "t-app" }
            : { code: 10014, msg: "app secret invalid" },
        );
      if (path === "/authen/v2/oauth/token") {
        const who = company.codes.get(body.code ?? "");
        company.codes.delete(body.code ?? "");
        if (!who || !body.code_verifier || body.client_secret !== company.secret)
          return answer({ code: 20003, error: "invalid_grant" }, 400);
        return answer({ code: 0, access_token: `u-${who}` });
      }
      const bearer = init.headers?.authorization?.replace("Bearer ", "") ?? "";
      if (path === "/authen/v1/user_info") {
        const id = bearer.replace("u-", "");
        return answer({
          code: 0,
          data: { open_id: `ou_${id}`, union_id: `on_${id}`, name: "From the token" },
        });
      }
      if (bearer !== "t-app") return answer({ code: 99991663, msg: "invalid token" }, 400);
      if (company.lacks)
        return answer({ code: 99991672, msg: `Access denied. [${company.lacks}]` }, 400);
      if (path === "/contact/v3/scopes")
        // The whole company is told as its top departments, the people right under it,
        // and its groups of people.
        return answer({
          code: 0,
          data: {
            department_ids: company.departments.filter(([, , parent]) => !parent).map(([id]) => id),
            user_ids: company.staff
              .filter((one) => !one.departments.length)
              .map((one) => `ou_${one.id}`),
            group_ids: ["g1"],
            has_more: false,
          },
        });
      if (path === "/contact/v3/group/g1/member/simplelist")
        return answer({
          code: 0,
          data: {
            has_more: false,
            memberlist: company.staff.slice(0, 2).map((one) => ({ member_id: `ou_${one.id}` })),
          },
        });
      const own = /^\/contact\/v3\/departments\/([^/]+)$/.exec(path);
      if (own) {
        const found = company.departments.find(([id]) => id === own[1]);
        return found
          ? answer({
              code: 0,
              data: {
                department: {
                  open_department_id: found[0],
                  name: found[1],
                  parent_department_id: found[2] || "0",
                },
              },
            })
          : answer({ code: 40004, msg: "no dept authority" }, 400);
      }
      const children = /^\/contact\/v3\/departments\/([^/]+)\/children$/.exec(path);
      if (children)
        return answer({
          code: 0,
          data: {
            has_more: false,
            // Everything under the one asked for, at any depth.
            items: company.departments
              .filter(([, , parent]) => parent === children[1])
              .map(([id, name, parent]) => ({
                open_department_id: id,
                name,
                parent_department_id: parent || "0",
              })),
          },
        });
      if (path === "/contact/v3/users/find_by_department") {
        const department = url.searchParams.get("department_id") ?? "";
        // As the real service does while the application sees only part of the company.
        if (department === "0" && company.part)
          return answer({ code: 40004, msg: "no dept authority error" }, 400);
        return answer({
          code: 0,
          data: {
            has_more: false,
            items: company.staff
              .filter((one) =>
                department === "0"
                  ? one.departments.length === 0
                  : one.departments.includes(department),
              )
              .map(user),
          },
        });
      }
      const single = /^\/contact\/v3\/users\/ou_(.+)$/.exec(path);
      if (single) {
        const one = company.staff.find((each) => each.id === single[1]);
        return one
          ? answer({ code: 0, data: { user: user(one) } })
          : answer({ code: 41050, msg: "no user authority" }, 400);
      }
      return answer({ code: 404, msg: "unknown" }, 404);
    },
  };
}

/** Stands in for WeCom. An outside contact comes back with an `openid` and no `userid`. */
function wecom(company: Company): Net {
  const user = (one: Staff) => ({
    errcode: 0,
    userid: one.id,
    name: one.name,
    department: one.departments.length ? one.departments.map(Number) : [1],
    status: one.gone ? 5 : 1,
    ...(one.email ? { biz_mail: one.email } : {}),
    ...(one.typed ? { email: one.typed } : {}),
  });
  return {
    async request(address) {
      company.asked.push(address);
      const url = new URL(address);
      const path = url.pathname.replace("/cgi-bin", "");
      if (path === "/gettoken")
        return answer(
          url.searchParams.get("corpsecret") === company.secret
            ? { errcode: 0, access_token: "t-app" }
            : { errcode: 40001, errmsg: "invalid credential" },
        );
      if (url.searchParams.get("access_token") !== "t-app")
        return answer({ errcode: 40014, errmsg: "invalid access_token" });
      if (company.lacks) return answer({ errcode: 60020, errmsg: company.lacks });
      if (path === "/auth/getuserinfo") {
        const who = company.codes.get(url.searchParams.get("code") ?? "");
        company.codes.delete(url.searchParams.get("code") ?? "");
        if (!who) return answer({ errcode: 40029, errmsg: "invalid code" });
        return answer(
          company.staff.some((one) => one.id === who)
            ? { errcode: 0, userid: who }
            : { errcode: 0, openid: "outside-contact" },
        );
      }
      if (path === "/user/get") {
        const one = company.staff.find((each) => each.id === url.searchParams.get("userid"));
        return answer(one ? user(one) : { errcode: 60111, errmsg: "userid not found" });
      }
      if (path === "/department/list")
        return answer({
          errcode: 0,
          department: [
            { id: 1, name: "The company", parentid: 0 },
            ...company.departments.map(([id, name, parent]) => ({
              id: Number(id),
              name,
              parentid: Number(parent || 1),
            })),
          ],
        });
      if (path === "/user/list_id")
        return answer({
          errcode: 0,
          dept_user: company.staff.map((one) => ({ userid: one.id, department: 1 })),
        });
      if (path === "/user/list") {
        const department = url.searchParams.get("department_id") ?? "";
        return answer({
          errcode: 0,
          userlist: company.staff
            .filter((one) =>
              department === "1"
                ? one.departments.length === 0
                : one.departments.includes(department),
            )
            .map(user),
        });
      }
      return answer({ errcode: 404, errmsg: "unknown" });
    },
  };
}

/** Stands in for DingTalk. Someone outside the organization has no account in it to be found. */
function dingtalk(company: Company): Net {
  const user = (one: Staff) => ({
    userid: one.id,
    unionid: `union-${one.id}`,
    name: one.name,
    active: !one.gone,
    dept_id_list: one.departments.length ? one.departments.map(Number) : [1],
    ...(one.email ? { org_email: one.email } : {}),
    ...(one.typed ? { email: one.typed } : {}),
  });
  return {
    async request(address, init = {}) {
      company.asked.push(address);
      const url = new URL(address);
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (url.pathname === "/v1.0/oauth2/accessToken")
        return body.appSecret === company.secret
          ? answer({ accessToken: "t-app", expireIn: 7200 })
          : answer({ code: "invalidClientIdOrSecret", message: "wrong secret" }, 400);
      if (url.pathname === "/v1.0/oauth2/userAccessToken") {
        const who = company.codes.get(String(body.code ?? ""));
        company.codes.delete(String(body.code ?? ""));
        return who
          ? answer({ accessToken: `u-${who}` })
          : answer({ code: "invalidCode", message: "bad code" }, 400);
      }
      if (url.pathname === "/v1.0/contact/users/me") {
        const id = (init.headers?.["x-acs-dingtalk-access-token"] ?? "").replace("u-", "");
        return answer({ unionId: `union-${id}`, nick: "From the token" });
      }
      if (url.searchParams.get("access_token") !== "t-app")
        return answer({ errcode: 40014, errmsg: "invalid access_token" });
      if (company.lacks) return answer({ errcode: 60011, errmsg: company.lacks });
      const path = url.pathname.replace("/topapi", "");
      if (path === "/user/getbyunionid") {
        const one = company.staff.find((each) => `union-${each.id}` === body.unionid);
        return answer(
          one
            ? { errcode: 0, result: { userid: one.id } }
            : { errcode: 60121, errmsg: "user not found" },
        );
      }
      if (path === "/v2/user/get") {
        const one = company.staff.find((each) => each.id === body.userid);
        return answer(
          one ? { errcode: 0, result: user(one) } : { errcode: 60121, errmsg: "user not found" },
        );
      }
      if (path === "/v2/department/listsub")
        return answer({
          errcode: 0,
          result: company.departments
            .filter(([, , parent]) => (parent || "1") === String(body.dept_id))
            .map(([id, name, parent]) => ({
              dept_id: Number(id),
              name,
              parent_id: Number(parent || 1),
            })),
        });
      if (path === "/v2/user/list")
        return answer({
          errcode: 0,
          result: {
            has_more: false,
            list: company.staff
              .filter((one) =>
                String(body.dept_id) === "1"
                  ? one.departments.length === 0
                  : one.departments.includes(String(body.dept_id)),
              )
              .map(user),
          },
        });
      return answer({ errcode: 404, errmsg: "unknown" });
    },
  };
}

const SECRET = ["directory", "test", "secret"].join("-");
const company = (): Company => ({
  secret: SECRET,
  codes: new Map(),
  asked: [],
  departments: [
    ["10", "Engineering", ""],
    ["11", "Platform", "10"],
    ["20", "Sales", ""],
  ],
  staff: [
    { id: "boss", name: "The Owner", departments: [] },
    { id: "wei", name: "Wei Zhang", departments: ["11"] },
    { id: "lin", name: "Lin Chen", email: "lin@acme.test", departments: ["20"] },
    { id: "mo", name: "Mo", email: "mo@acme.test", departments: ["10"] },
  ],
});

/** A server with a directory of one kind set up, tried by its owner and switched on. */
async function withDirectory(kind: DirectoryKind, stand: (company: Company) => Net) {
  const firm = company();
  const h = await harness({}, { net: stand(firm) });
  const owner = (await h.signIn("owner@acme.test")).cookie as string;
  // The organization's own mail domain: an address there is believed, no other is.
  await h.db.query(
    "insert into org_domains (org_id, domain) select id, 'acme.test' from organizations",
  );
  const body = {
    kind,
    appId: kind === "wecom" ? "wwcorp1" : "cli_app1",
    secret: SECRET,
    ...(kind === "wecom" ? { agentId: "1000002" } : {}),
  };
  /** Comes back from the service as this person, in the browser that began. */
  const back = async (begun: { location: string; cookie: string }, who: string, more = "") => {
    const state = new URL(begun.location).searchParams.get("state") ?? "";
    const code = `code-${who}-${Math.random().toString(16).slice(2)}`;
    firm.codes.set(code, who);
    const named = kind === "dingtalk" ? "authCode" : "code";
    const done = await h.app.request(`/auth/callback/${kind}?${named}=${code}&state=${state}`, {
      headers: { cookie: [begun.cookie, more].filter(Boolean).join("; ") },
    });
    const to = new URL(done.headers.get("location") ?? PUBLIC_URL);
    const session = done.headers.getSetCookie().find((one) => one.startsWith("muster_session="));
    return {
      cookie: session?.split(";")[0] ?? null,
      error: to.searchParams.get("error"),
      to: to.toString(),
    };
  };
  const signIn = async (who: string) => {
    const begin = await h.app.request(`/auth/login/${kind}`);
    if (begin.status !== 302) return { cookie: null, error: `status ${begin.status}`, to: "" };
    return back(
      {
        location: begin.headers.get("location") ?? "",
        cookie: begin.headers.get("set-cookie")?.split(";")[0] ?? "",
      },
      who,
    );
  };
  /** "Try it" in the console: makes the account at the directory this person's own. */
  const connect = async (session: string, who: string) => {
    const sent = await h.api(session, "POST", "/api/settings/directory/try");
    if (sent.status !== 200) return { cookie: null, error: `status ${sent.status}`, to: "" };
    return back(
      {
        location: (await json<{ url: string }>(sent)).url,
        cookie: sent.headers.get("set-cookie")?.split(";")[0] ?? "",
      },
      who,
      session,
    );
  };
  /** Switching it on reads the directory at once, behind the answer: what that reading did. */
  const firstReading = async () => {
    for (let n = 0; n < 200; n++) {
      const { directory } = await json<{
        directory: { syncedAt: string | null; sync: Record<string, number> };
      }>(await h.api(owner, "GET", "/api/settings/directory"));
      if (directory.syncedAt) return directory.sync;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error("the directory was never read");
  };
  const setUp = async () => {
    expect((await h.api(owner, "PUT", "/api/settings/directory", body)).status).toBe(200);
    expect((await connect(owner, "boss")).to).toContain("#/admin/security");
    expect(
      (await h.api(owner, "PUT", "/api/settings/directory/enabled", { on: true })).status,
    ).toBe(200);
    return firstReading();
  };
  const sync = async (confirm = false) =>
    json<Record<string, number>>(
      await h.api(owner, "POST", "/api/settings/directory/sync", confirm ? { confirm } : {}),
    );
  const members = async () =>
    json<{ id: string; email: string; name: string; status: string; department?: string }[]>(
      await h.api(owner, "GET", "/api/members"),
    );
  const me = async (cookie: string | null) =>
    json<{ user: { email: string; name: string }; role: string }>(
      await h.api(cookie, "GET", "/api/me"),
    );
  return { h, firm, owner, body, signIn, connect, setUp, firstReading, sync, members, me };
}

describe("a person with no address, and a department's place", () => {
  it("gives someone with no address one that can never be written to", () => {
    const ours = new Set(["acme.test"]);
    const feishuOne = addressFor(
      { kind: "feishu", appId: "cli_A1" },
      { subject: "on_9f", email: null },
      ours,
    );
    expect(feishuOne).toBe("on_9f@cli_a1.feishu.invalid");
    expect(isNoAddress(feishuOne)).toBe(true);
    // What cannot stand in an address is made plain, and two that become alike stay two.
    const wecomApp = { kind: "wecom" as const, appId: "ww1" };
    const one = addressFor(wecomApp, { subject: "Zhang San", email: "" }, ours);
    const two = addressFor(wecomApp, { subject: "zhang-san", email: "" }, ours);
    expect(one).toMatch(/^zhang-san-[0-9a-f]{8}@ww1\.wecom\.invalid$/);
    expect(two).toBe("zhang-san@ww1.wecom.invalid");
    // An address in a domain the organization named as its own is used, in lower case.
    const dingtalkApp = { kind: "dingtalk" as const, appId: "x" };
    expect(addressFor(dingtalkApp, { subject: "1", email: " Lin@Acme.test " }, ours)).toBe(
      "lin@acme.test",
    );
    // One anywhere else is not believed, whoever wrote it into the directory.
    expect(addressFor(dingtalkApp, { subject: "1", email: "ceo@other.test" }, ours)).toBe(
      "1@x.dingtalk.invalid",
    );
    expect(addressFor(dingtalkApp, { subject: "1", email: "lin@acme.test" }, new Set())).toBe(
      "1@x.dingtalk.invalid",
    );
  });

  it("names a department by where it sits", () => {
    const names = departmentNames({
      people: [],
      departments: [
        { id: "1", parentId: null, name: "Engineering" },
        { id: "2", parentId: "1", name: "Platform" },
        { id: "3", parentId: null, name: "Sales" },
        { id: "4", parentId: "3", name: "Platform" },
        { id: "5", parentId: "4", name: "A team with a very long name that goes on and on and on" },
        // Its parent is not one the application may see: it stands at the top.
        { id: "6", parentId: "99", name: "Alone" },
      ],
    });
    expect(names.get("2")).toBe("Engineering / Platform");
    expect(names.get("4")).toBe("Sales / Platform");
    expect(names.get("6")).toBe("Alone");
    expect((names.get("5") as string).length).toBeLessThanOrEqual(60);
  });
});

describe("the company's directory at Feishu", () => {
  let t: Awaited<ReturnType<typeof withDirectory>>;
  beforeAll(async () => {
    t = await withDirectory("feishu", feishu);
  });

  it("is an owner's to set up, with a secret the service accepts", async () => {
    const { h, owner, body } = t;
    await h.api(owner, "POST", "/api/invitations", { email: "ada@acme.test", role: "admin" });
    const ada = (await h.signIn("ada@acme.test")).cookie as string;
    expect((await h.api(ada, "PUT", "/api/settings/directory", body)).status).toBe(403);
    expect(
      (await h.api(owner, "PUT", "/api/settings/directory", { ...body, secret: "wrong" })).status,
    ).toBe(400);
    expect((await h.api(owner, "PUT", "/api/settings/directory", { kind: "feishu" })).status).toBe(
      400,
    );
    expect((await h.api(owner, "PUT", "/api/settings/directory", body)).status).toBe(200);
    const shown = await json<{
      directory: Record<string, unknown>;
      redirectUrls: Record<string, string>;
    }>(await h.api(owner, "GET", "/api/settings/directory"));
    expect(shown.directory).toMatchObject({
      kind: "feishu",
      appId: "cli_app1",
      enabled: false,
      verified: false,
      redirectUrl: `${PUBLIC_URL}/auth/callback/feishu`,
    });
    // The secret is never said again, and is not kept as it was given.
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    const kept = await h.db.query<{ secret_sealed: string }>(
      "select secret_sealed from org_directories",
    );
    expect(kept[0]?.secret_sealed).not.toContain(SECRET);
  });

  it("is not a way in, and cannot be switched on, before it has worked once", async () => {
    const { h, owner, signIn, connect } = t;
    expect(await json(await h.app.request("/auth/providers"))).not.toContainEqual(
      expect.objectContaining({ id: "feishu" }),
    );
    expect((await signIn("wei")).error).toBe("status 404");
    expect(
      (await h.api(owner, "PUT", "/api/settings/directory/enabled", { on: true })).status,
    ).toBe(409);
    // Someone from outside the company cannot be the one who tries it.
    await connect(owner, "stranger");
    expect(
      await json<{ directory: unknown }>(await h.api(owner, "GET", "/api/settings/directory")),
    ).toMatchObject({ directory: { verified: false, tried: { reason: "not_in_directory" } } });
    expect((await connect(owner, "boss")).to).toContain("#/admin/security");
    // Mo is a member already, by an invitation, before the directory is switched on.
    await h.api(owner, "POST", "/api/invitations", { email: "mo@acme.test", role: "member" });
    await h.signIn("mo@acme.test");
    expect(
      (await h.api(owner, "PUT", "/api/settings/directory/enabled", { on: true })).status,
    ).toBe(200);
    expect(await json(await h.app.request("/auth/providers"))).toEqual([
      { id: "feishu", label: "Feishu" },
    ]);
  });

  it("brings in the company's people and departments", async () => {
    const { h, owner, sync, members, firstReading } = t;
    // Switching it on read the directory at once.
    const result = await firstReading();
    // Wei and Lin are new; Mo was here and is found by his address; the owner connected
    // their own account and is nobody new.
    expect(result).toMatchObject({ people: 4, departments: 3, added: 2, linked: 1, skipped: 0 });
    const all = await members();
    expect(all.map((one) => one.name).sort()).toEqual(
      expect.arrayContaining(["Lin Chen", "Wei Zhang"]),
    );
    expect(all.find((one) => one.name === "Wei Zhang")?.email).toBe(
      "on_wei@cli_app1.feishu.invalid",
    );
    const departments = await json<{ name: string; members: number }[]>(
      await h.api(owner, "GET", "/api/departments"),
    );
    expect(departments.map((one) => [one.name, one.members])).toEqual([
      ["Engineering", 1],
      ["Engineering / Platform", 1],
      ["Sales", 1],
    ]);
    // Saying it again changes nothing.
    expect(await sync()).toMatchObject({ added: 0, linked: 0, suspended: 0 });
  });

  it("lets its people in by the account they have, with or without an address", async () => {
    const { signIn, me } = t;
    const wei = await signIn("wei");
    expect(wei.error).toBeNull();
    expect(await me(wei.cookie)).toMatchObject({
      user: { email: "on_wei@cli_app1.feishu.invalid", name: "Wei Zhang" },
      role: "member",
    });
    const mo = await signIn("mo");
    expect(await me(mo.cookie)).toMatchObject({ user: { email: "mo@acme.test" } });
  });

  it("lets in nobody from outside the company, and nobody with a spent code", async () => {
    const { h, firm, signIn } = t;
    expect((await signIn("stranger")).error).toBe("failed");
    // A link back that another browser began is of no use.
    const begin = await h.app.request("/auth/login/feishu");
    const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state");
    firm.codes.set("stolen", "wei");
    const other = await h.app.request(`/auth/callback/feishu?code=stolen&state=${state}`);
    expect(other.headers.get("location")).toContain("error=failed");
    const denied = await h.db.query<{ detail: { problem?: string } }>(
      "select detail from admin_events where action = 'auth.login_denied' order by seq desc limit 1",
    );
    expect(denied[0]?.detail.problem).toBe("not_in_directory");
  });

  it("never hands an administrator's account to whoever holds their address there", async () => {
    const { firm, signIn, sync } = t;
    firm.staff.push({ id: "fake", name: "Not Ada", email: "ada@acme.test", departments: [] });
    expect(await sync()).toMatchObject({ added: 0, linked: 0, skipped: 1 });
    expect((await signIn("fake")).error).toBe("identity_conflict");
    firm.staff.pop();
  });

  it("takes access from someone who left, and gives it back only if it took it", async () => {
    const { h, firm, owner, signIn, sync, members } = t;
    const wei = firm.staff.find((one) => one.id === "wei") as Staff;
    const session = (await signIn("wei")).cookie;
    wei.gone = true;
    expect(await sync()).toMatchObject({ suspended: 1 });
    expect((await h.api(session, "GET", "/api/me")).status).toBe(401);
    expect((await signIn("wei")).error).toBe("failed");
    wei.gone = false;
    expect(await sync()).toMatchObject({ restored: 1 });
    expect((await signIn("wei")).error).toBeNull();
    // Someone an administrator suspended stays so, whatever the directory says.
    const id = (await members()).find((one) => one.name === "Wei Zhang")?.id;
    await h.api(owner, "PATCH", `/api/members/${id}`, { status: "suspended" });
    expect(await sync()).toMatchObject({ restored: 0 });
    expect((await signIn("wei")).error).toBe("suspended");
    await h.api(owner, "PATCH", `/api/members/${id}`, { status: "active" });
  });

  it("does not take access from many at once until an owner says to", async () => {
    const { h, firm, sync, members } = t;
    const kept = firm.staff;
    for (let n = 0; n < 8; n++)
      firm.staff.push({ id: `temp${n}`, name: `Temp ${n}`, departments: ["20"] });
    expect(await sync()).toMatchObject({ added: 8 });
    // The application is given sight of far fewer people, by mistake or not.
    firm.staff = kept.filter((one) => !one.id.startsWith("temp") && one.id !== "lin");
    await h.db.query("update org_directories set synced_at = null");
    await h.directories.tick();
    const active = async () => (await members()).filter((one) => one.status === "active").length;
    const before = await active();
    const shown = await json<{ directory: { sync: { held: number; suspended: number } } }>(
      await h.api(t.owner, "GET", "/api/settings/directory"),
    );
    expect(shown.directory.sync).toMatchObject({ held: 9, suspended: 0 });
    // Pressing for a reading holds back as the hour's does; and going on is an owner's to say.
    expect(await sync()).toMatchObject({ suspended: 0, held: 9 });
    const ada = (await h.signIn("ada@acme.test")).cookie as string;
    expect(
      (await h.api(ada, "POST", "/api/settings/directory/sync", { confirm: true })).status,
    ).toBe(403);
    expect(await active()).toBe(before);
    expect(await sync(true)).toMatchObject({ suspended: 9, held: 0 });
    expect(await active()).toBe(before - 9);
  });

  it("believes no address a person typed in themselves, and none outside its domains", async () => {
    const { h, firm, owner, signIn, me, sync } = t;
    // Someone new to the company types in the address an administrator's invitation waits at.
    await h.api(owner, "POST", "/api/invitations", { email: "cfo@acme.test", role: "admin" });
    firm.staff.push({ id: "eve", name: "Eve", typed: "cfo@acme.test", departments: [] });
    // And the directory's keeper gives another an address that is not the organization's.
    firm.staff.push({ id: "out", name: "Out", email: "boss@elsewhere.test", departments: [] });
    const eve = await signIn("eve");
    expect(await me(eve.cookie)).toMatchObject({
      user: { email: "on_eve@cli_app1.feishu.invalid" },
      role: "member",
    });
    await sync();
    const out = await signIn("out");
    expect(await me(out.cookie)).toMatchObject({
      user: { email: "on_out@cli_app1.feishu.invalid" },
      role: "member",
    });
    firm.staff.splice(-2);
    await sync();
  });

  it("signs out an administrator who left, without taking their role", async () => {
    const { h, firm, owner, connect, sync, members } = t;
    const ada = (await h.signIn("ada@acme.test")).cookie as string;
    firm.staff.push({ id: "ada", name: "Ada", departments: [] });
    expect((await connect(ada, "ada")).to).toContain("#/admin/security");
    firm.staff.pop();
    await sync();
    expect((await h.api(ada, "GET", "/api/me")).status).toBe(401);
    expect((await members()).find((one) => one.email === "ada@acme.test")?.status).toBe("active");
    const said = await h.db.query<{ detail: { role: string } }>(
      "select detail from admin_events where action = 'directory.left'",
    );
    expect(said.map((one) => one.detail.role)).toEqual(["admin"]);
    // Said once, not on every reading.
    await sync();
    expect(
      (await h.db.query("select 1 from admin_events where action = 'directory.left'")).length,
    ).toBe(1);
    void owner;
  });

  it("keeps what it is while only the secret changes, and is one organization's", async () => {
    const { h, owner, body } = t;
    expect((await h.api(owner, "PUT", "/api/settings/directory", body)).status).toBe(200);
    expect(
      await json<{ directory: unknown }>(await h.api(owner, "GET", "/api/settings/directory")),
    ).toMatchObject({ directory: { enabled: true, verified: true } });
    // Another application is tried again before it is a way in.
    expect(
      await json(
        await h.api(owner, "PUT", "/api/settings/directory", { ...body, appId: "cli_app2" }),
      ),
    ).toMatchObject({ enabled: false, verified: false });
    expect(await json(await h.api(owner, "PUT", "/api/settings/directory", body))).toMatchObject({
      enabled: false,
      verified: false,
    });
    expect((await t.connect(owner, "boss")).to).toContain("#/admin/security");
    await h.api(owner, "PUT", "/api/settings/directory/enabled", { on: true });
    await t.firstReading();
  });

  it("says in the console why a try did not work", async () => {
    const { h, firm, owner, connect } = t;
    firm.lacks = "contact:user.base:readonly";
    expect((await connect(owner, "boss")).to).toContain("#/admin/security");
    expect(
      await json<{ directory: unknown }>(await h.api(owner, "GET", "/api/settings/directory")),
    ).toMatchObject({ directory: { tried: { reason: "permission", hint: firm.lacks } } });
    firm.lacks = undefined;
    expect((await connect(owner, "boss")).to).toContain("#/admin/security");
    expect(
      await json<{ directory: { tried: unknown } }>(
        await h.api(owner, "GET", "/api/settings/directory"),
      ),
    ).toMatchObject({ directory: { tried: null } });
  });

  it("reads a company it sees only part of", async () => {
    const { firm, sync } = t;
    const whole = (await sync()).people;
    firm.part = true;
    expect(await sync()).toMatchObject({ people: whole, suspended: 0 });
    expect(firm.asked.some((one) => one.includes("department_id=0"))).toBe(true);
    firm.part = false;
  });

  it("changes nothing when the directory cannot be read, and says why", async () => {
    const { h, firm, owner, sync, members } = t;
    const before = (await members()).filter((one) => one.status === "active").length;
    firm.lacks = "contact:contact.base:readonly, contact:contact:readonly_as_app";
    expect(await sync()).toMatchObject({
      problem: { reason: "permission", hint: firm.lacks },
      suspended: 0,
    });
    firm.lacks = undefined;
    const all = firm.staff;
    firm.staff = [];
    expect(await sync()).toMatchObject({ problem: { reason: "empty" }, suspended: 0 });
    firm.staff = all;
    expect((await members()).filter((one) => one.status === "active").length).toBe(before);
    // Removed, it is no longer a way in; the people it brought stay.
    expect((await h.api(owner, "DELETE", "/api/settings/directory")).status).toBe(200);
    expect(await json(await h.app.request("/auth/providers"))).not.toContainEqual(
      expect.objectContaining({ id: "feishu" }),
    );
    expect((await members()).filter((one) => one.status === "active").length).toBe(before);
  });
});

describe.each([
  ["wecom", wecom, "wei@wwcorp1.wecom.invalid"],
  ["dingtalk", dingtalk, "union-wei@cli_app1.dingtalk.invalid"],
] as const)("the company's directory at %s", (kind, stand, address) => {
  it("signs its people in, keeps outsiders out, and follows who is in the company", async () => {
    const t = await withDirectory(kind, stand);
    expect(await t.setUp()).toMatchObject({ people: 4, departments: 3, added: 3 });
    const wei = await t.signIn("wei");
    expect(wei.error).toBeNull();
    expect(await t.me(wei.cookie)).toMatchObject({ user: { email: address, name: "Wei Zhang" } });
    expect((await t.signIn("stranger")).error).toBe("failed");
    const departments = await json<{ name: string }[]>(
      await t.h.api(t.owner, "GET", "/api/departments"),
    );
    expect(departments.map((one) => one.name)).toEqual([
      "Engineering",
      "Engineering / Platform",
      "Sales",
    ]);
    const staff = t.firm.staff.find((one) => one.id === "wei") as Staff;
    staff.gone = true;
    expect(await t.sync()).toMatchObject({ suspended: 1 });
    expect((await t.signIn("wei")).error).toBe("failed");
    // The company gives the leaver's ID to someone new: they do not get the leaver's account.
    staff.gone = false;
    staff.name = "Someone New";
    expect(await t.sync()).toMatchObject({ restored: 0 });
    expect((await t.signIn("wei")).error).toBe("suspended");
    staff.gone = true;
    // What the service refuses is said, and changes nothing here.
    t.firm.lacks = "not allowed from this address";
    expect(await t.sync()).toMatchObject({ problem: { reason: "permission" }, suspended: 0 });
  });
});

describe("a way in beside single sign-on", () => {
  it("is named for a native app as the sign-in page named it", async () => {
    const t = await withDirectory("feishu", feishu);
    await t.setUp();
    const begin = await t.h.app.request(
      `/auth/app/start?challenge=${"a".repeat(43)}&redirect=${encodeURIComponent("muster://auth")}&provider=feishu`,
    );
    expect(begin.headers.get("location")).toBe(`${PUBLIC_URL}/auth/login/feishu`);
  });
});
