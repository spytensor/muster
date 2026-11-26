/**
 * Feishu, and Lark: the same service under another name and other hosts.
 *
 * Signing in: the person authorizes at the accounts host, the code is exchanged for a
 * token of theirs, and that token says who they are. Whether they are the company's own
 * is then asked of the company's record with the application's own token: only someone
 * the application was given sight of is found there.
 * https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
 */
import type { Net } from "../runtime/net.js";
import {
  callJson,
  type DirectoryApp,
  type DirectoryClient,
  type DirectoryDepartment,
  type DirectoryPerson,
  DirectoryProblem,
  field,
  LISTING_MOST,
  said,
  tooMany,
} from "./types.js";

const SITES = {
  feishu: { accounts: "https://accounts.feishu.cn", open: "https://open.feishu.cn" },
  lark: { accounts: "https://accounts.larksuite.com", open: "https://open.larksuite.com" },
};
const HOSTS = ["feishu.cn", "larksuite.com"];
/** "The application lacks a permission", for a call made as the application or as a person. */
const NO_PERMISSION = new Set([99991672, 99991679, 99991401]);
/** Asked about someone or something the application was not given sight of. */
const OUT_OF_SIGHT = new Set([40004, 40014, 41050]);
/** The department that is the company itself. */
const ROOT = "0";

export function feishuClient(net: Net): DirectoryClient {
  const site = (app: DirectoryApp) => SITES[app.kind === "lark" ? "lark" : "feishu"];

  /** Throws for an answer that is a refusal; `missing` lets "no such thing" through as null. */
  const data = (
    answer: Record<string, unknown>,
    /** True: any refusal is "no such thing". A set: only these codes are. */
    missing: boolean | ReadonlySet<number> = false,
  ): Record<string, unknown> | null => {
    const code = Number(answer.code);
    if (code === 0) return field.object(answer.data);
    if (NO_PERMISSION.has(code)) {
      // The service names the permissions that would do, in brackets.
      const named = /\[([a-z0-9_:.,\s]+)\]/i.exec(field.text(answer.msg))?.[1] ?? "";
      throw new DirectoryProblem("permission", said(named) || said(answer.msg));
    }
    if (missing === true || (missing !== false && missing.has(code))) return null;
    // Outside what the application was given sight of: a permission, said as one.
    if (OUT_OF_SIGHT.has(code)) throw new DirectoryProblem("permission", said(answer.msg));
    throw new DirectoryProblem("unreachable", said(answer.msg) || `code ${code}`);
  };

  const appToken = async (app: DirectoryApp): Promise<string> => {
    const answer = await callJson(
      net,
      HOSTS,
      `${site(app).open}/open-apis/auth/v3/tenant_access_token/internal`,
      { body: { app_id: app.appId, app_secret: app.secret } },
    );
    const token = field.text(answer.tenant_access_token);
    if (Number(answer.code) !== 0 || !token)
      throw new DirectoryProblem("credentials", said(answer.msg));
    return token;
  };

  const personOf = (user: Record<string, unknown>): DirectoryPerson | null => {
    const subject = field.text(user.union_id);
    if (!subject) return null;
    const status = field.object(user.status);
    const avatar = field.object(user.avatar);
    return {
      subject,
      name: field.text(user.name),
      // Only the address the company gave them: the other one they type in themselves.
      email: field.text(user.enterprise_email) || null,
      avatarUrl: field.text(avatar.avatar_240) || field.text(avatar.avatar_72) || null,
      active: !(
        status.is_resigned === true ||
        status.is_frozen === true ||
        status.is_exited === true
      ),
      departments: field
        .list(user.department_ids)
        .map(field.id)
        .filter((id) => id && id !== ROOT),
    };
  };

  /** Every page of a listing, by the service's own token for the next one. */
  const pages = async (
    token: string,
    address: (pageToken: string) => string,
    most: number,
    missing: boolean | ReadonlySet<number> = false,
    /** What the answer calls its list. */
    under = "items",
  ): Promise<Record<string, unknown>[]> => {
    const all: Record<string, unknown>[] = [];
    let next = "";
    for (let page = 0; page < 2000; page++) {
      const got = data(
        await callJson(net, HOSTS, address(next), {
          headers: { authorization: `Bearer ${token}` },
        }),
        missing,
      );
      // Nothing there to list: that is an answer, not a listing cut short.
      if (!got) return all;
      for (const item of field.list(got[under])) all.push(field.object(item));
      next = field.text(got.page_token);
      if (got.has_more !== true) return all;
      if (!next || all.length >= most) tooMany();
    }
    return tooMany();
  };

  return {
    pkce: true,

    authorizeUrl(app, { redirectUri, state, challenge }) {
      const url = new URL(`${site(app).accounts}/open-apis/authen/v1/authorize`);
      url.searchParams.set("client_id", app.appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async identify(app, { code, redirectUri, verifier }) {
      const open = site(app).open;
      // The older of Feishu's two token addresses: the newer one does not yet take the
      // proof that its own authorization page asks for (tried against the real service).
      const granted = await callJson(net, HOSTS, `${open}/open-apis/authen/v2/oauth/token`, {
        body: {
          grant_type: "authorization_code",
          client_id: app.appId,
          client_secret: app.secret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
      });
      const theirs = field.text(granted.access_token);
      // A code that is spent, made up, or another application's: nobody is identified.
      if (Number(granted.code) !== 0 || !theirs)
        throw new DirectoryProblem(
          "sign_in",
          said(granted.error_description) || said(granted.error) || `code ${granted.code}`,
        );
      const asked = await callJson(net, HOSTS, `${open}/open-apis/authen/v1/user_info`, {
        headers: { authorization: `Bearer ${theirs}` },
      });
      const who = data(asked, true);
      const openId = field.text(who?.open_id);
      if (!who || !openId)
        throw new DirectoryProblem("sign_in", said(asked.msg) || `code ${asked.code}`);
      // The company's own record of them, which only the company's people have.
      const record = data(
        await callJson(
          net,
          HOSTS,
          `${open}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id&department_id_type=open_department_id`,
          { headers: { authorization: `Bearer ${await appToken(app)}` } },
        ),
        true,
      );
      const person = record && personOf(field.object(record.user));
      if (!person || person.subject !== field.text(who.union_id)) return null;
      return {
        ...person,
        name: person.name || field.text(who.name),
        avatarUrl: person.avatarUrl || field.text(who.avatar_url) || null,
      };
    },

    async list(app) {
      const open = site(app).open;
      const token = await appToken(app);
      const get = (path: string) =>
        callJson(net, HOSTS, `${open}/open-apis/contact/v3/${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      // What the application was given sight of: departments (for the whole company, its
      // top ones), people named one by one, and groups of people.
      const roots: string[] = [];
      const singles: string[] = [];
      const groups: string[] = [];
      let nextScope = "";
      for (let page = 0; page < 50; page++) {
        const got = data(
          await get(
            `scopes?department_id_type=open_department_id&user_id_type=open_id&page_size=100${
              nextScope ? `&page_token=${encodeURIComponent(nextScope)}` : ""
            }`,
          ),
        );
        roots.push(...field.list(got?.department_ids).map(field.id).filter(Boolean));
        singles.push(...field.list(got?.user_ids).map(field.id).filter(Boolean));
        groups.push(...field.list(got?.group_ids).map(field.id).filter(Boolean));
        nextScope = field.text(got?.page_token);
        if (got?.has_more !== true) break;
        if (!nextScope || page === 49) tooMany();
      }

      const departments = new Map<string, DirectoryDepartment>();
      const add = (item: Record<string, unknown>) => {
        const id = field.text(item.open_department_id);
        if (!id || id === ROOT || field.object(item.status).is_deleted === true) return;
        const parent = field.text(item.parent_department_id);
        departments.set(id, {
          id,
          parentId: parent && parent !== ROOT ? parent : null,
          name: field.text(item.name),
        });
      };
      for (const root of roots) {
        if (root !== ROOT) {
          const own = data(
            await get(
              `departments/${encodeURIComponent(root)}?department_id_type=open_department_id`,
            ),
            true,
          );
          if (own) add(field.object(own.department));
        }
        const under = await pages(
          token,
          (next) => {
            const url = new URL(
              `${open}/open-apis/contact/v3/departments/${encodeURIComponent(root)}/children`,
            );
            url.searchParams.set("department_id_type", "open_department_id");
            url.searchParams.set("fetch_child", "true");
            url.searchParams.set("page_size", "50");
            if (next) url.searchParams.set("page_token", next);
            return url.toString();
          },
          LISTING_MOST.departments,
        );
        for (const item of under) add(item);
        if (departments.size >= LISTING_MOST.departments) tooMany();
      }

      const people = new Map<string, DirectoryPerson>();
      const seen = new Set<string>();
      const keep = (user: Record<string, unknown>) => {
        const person = personOf(user);
        seen.add(field.text(user.open_id));
        if (person && !people.has(person.subject)) people.set(person.subject, person);
      };
      // The company itself is always asked for the people directly under it: an
      // application that sees only part of the company is told so, and that is all right.
      for (const department of [ROOT, ...departments.keys()]) {
        const members = await pages(
          token,
          (next) => {
            const url = new URL(`${open}/open-apis/contact/v3/users/find_by_department`);
            url.searchParams.set("department_id", department);
            url.searchParams.set("department_id_type", "open_department_id");
            url.searchParams.set("user_id_type", "open_id");
            url.searchParams.set("page_size", "50");
            if (next) url.searchParams.set("page_token", next);
            return url.toString();
          },
          LISTING_MOST.people,
          department === ROOT ? OUT_OF_SIGHT : false,
        );
        for (const user of members) keep(user);
        if (people.size >= LISTING_MOST.people) tooMany();
      }
      // People the application sees through a group of people, not a department.
      for (const group of new Set(groups)) {
        const members = await pages(
          token,
          (next) => {
            const url = new URL(
              `${open}/open-apis/contact/v3/group/${encodeURIComponent(group)}/member/simplelist`,
            );
            url.searchParams.set("member_type", "user");
            url.searchParams.set("member_id_type", "open_id");
            url.searchParams.set("page_size", "100");
            if (next) url.searchParams.set("page_token", next);
            return url.toString();
          },
          LISTING_MOST.people,
          false,
          "memberlist",
        );
        for (const member of members) singles.push(field.text(member.member_id));
      }
      const alone = [...new Set(singles)].filter((openId) => openId && !seen.has(openId));
      if (alone.length > 5000) tooMany();
      for (const openId of alone) {
        const record = data(
          await get(
            `users/${encodeURIComponent(openId)}?user_id_type=open_id&department_id_type=open_department_id`,
          ),
          true,
        );
        if (record) keep(field.object(record.user));
      }
      return { departments: [...departments.values()], people: [...people.values()] };
    },

    async check(app) {
      await appToken(app);
    },
  };
}
