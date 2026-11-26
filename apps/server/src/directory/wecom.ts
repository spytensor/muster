/**
 * WeCom (企业微信), with an application the corporation built for itself.
 *
 * Signing in: the person scans a code on WeCom's page, or is already inside WeCom, and
 * comes back with a code that names their account in the corporation. Someone who is not
 * a member comes back as an outside contact and is not let in.
 * https://developer.work.weixin.qq.com/document/path/98152
 *
 * WeCom answers an application only from addresses the corporation listed as trusted,
 * and sends people back only to a domain it has verified: both are set at WeCom.
 */
import type { Net } from "../runtime/net.js";
import {
  callJson,
  type DirectoryApp,
  type DirectoryClient,
  type DirectoryPerson,
  DirectoryProblem,
  field,
  LISTING_MOST,
  said,
  tooMany,
} from "./types.js";

const API = "https://qyapi.weixin.qq.com/cgi-bin";
const HOSTS = ["qyapi.weixin.qq.com"];
/** The secret or the corporation's ID is not right. */
const BAD_CREDENTIALS = new Set([40001, 40013, 40056, 40091]);
/** Not allowed: the address is not trusted, or the application may not see this. */
const NOT_ALLOWED = new Set([48002, 60011, 60020, 301002]);
/** The department that is the corporation itself. */
const ROOT = "1";

export function wecomClient(net: Net): DirectoryClient {
  const ok = (answer: Record<string, unknown>, missing = false): boolean => {
    const code = Number(answer.errcode ?? 0);
    if (code === 0) return true;
    if (BAD_CREDENTIALS.has(code)) throw new DirectoryProblem("credentials", said(answer.errmsg));
    if (NOT_ALLOWED.has(code)) throw new DirectoryProblem("permission", said(answer.errmsg));
    if (missing) return false;
    throw new DirectoryProblem("unreachable", said(answer.errmsg) || `code ${code}`);
  };

  const appToken = async (app: DirectoryApp): Promise<string> => {
    const url = new URL(`${API}/gettoken`);
    url.searchParams.set("corpid", app.appId);
    url.searchParams.set("corpsecret", app.secret);
    const answer = await callJson(net, HOSTS, url.toString());
    const token = field.text(answer.access_token);
    if (Number(answer.errcode ?? 0) !== 0 || !token) {
      if (NOT_ALLOWED.has(Number(answer.errcode)))
        throw new DirectoryProblem("permission", said(answer.errmsg));
      throw new DirectoryProblem("credentials", said(answer.errmsg));
    }
    return token;
  };

  const personOf = (user: Record<string, unknown>): DirectoryPerson | null => {
    const subject = field.text(user.userid);
    if (!subject) return null;
    return {
      subject,
      name: field.text(user.name),
      // Only the mailbox the company gave them, which WeCom shows an application only
      // where the person agreed: the other address they type in themselves.
      email: field.text(user.biz_mail) || null,
      avatarUrl: field.text(user.thumb_avatar) || field.text(user.avatar) || null,
      // 1 active, 2 switched off, 4 not yet joined, 5 left.
      active: Number(user.status ?? 1) === 1 && user.enable !== 0,
      departments: field
        .list(user.department)
        .map(field.id)
        .filter((id) => id && id !== ROOT),
    };
  };

  return {
    pkce: false,

    authorizeUrl(app, { redirectUri, state, inApp }) {
      if (inApp) {
        // Inside WeCom nobody scans anything: its own browser says who is using it.
        const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
        url.searchParams.set("appid", app.appId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", "snsapi_base");
        url.searchParams.set("state", state);
        url.searchParams.set("agentid", app.agentId ?? "");
        return `${url.toString()}#wechat_redirect`;
      }
      const url = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      url.searchParams.set("login_type", "CorpApp");
      url.searchParams.set("appid", app.appId);
      url.searchParams.set("agentid", app.agentId ?? "");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async identify(app, { code }) {
      const token = await appToken(app);
      const asked = new URL(`${API}/auth/getuserinfo`);
      asked.searchParams.set("access_token", token);
      asked.searchParams.set("code", code);
      const who = await callJson(net, HOSTS, asked.toString());
      // A code that is spent or made up; or an outside contact, who has no `userid`.
      const userId = field.text(who.userid) || field.text(who.UserId);
      if (!ok(who, true) || !userId) return null;
      const about = new URL(`${API}/user/get`);
      about.searchParams.set("access_token", token);
      about.searchParams.set("userid", userId);
      const record = await callJson(net, HOSTS, about.toString());
      if (!ok(record, true)) return null;
      const person = personOf(record);
      return person && person.subject.toLowerCase() === userId.toLowerCase() ? person : null;
    },

    async list(app) {
      const token = await appToken(app);
      const asked = new URL(`${API}/department/list`);
      asked.searchParams.set("access_token", token);
      const answer = await callJson(net, HOSTS, asked.toString());
      ok(answer);
      const all = field
        .list(answer.department)
        .map(field.object)
        .map((one) => ({
          id: field.id(one.id),
          parentId: field.id(one.parentid),
          name: field.text(one.name),
        }))
        .filter((one) => one.id);
      if (all.length > LISTING_MOST.departments) tooMany();
      const departments = all
        .filter((one) => one.id !== ROOT)
        .map((one) => ({
          ...one,
          parentId:
            one.parentId && one.parentId !== ROOT && one.parentId !== "0" ? one.parentId : null,
        }));
      const people = new Map<string, DirectoryPerson>();
      for (const department of all) {
        const members = new URL(`${API}/user/list`);
        members.searchParams.set("access_token", token);
        members.searchParams.set("department_id", department.id);
        const got = await callJson(net, HOSTS, members.toString());
        // A listing that fails is no listing: half of one would read as people gone.
        ok(got);
        for (const user of field.list(got.userlist)) {
          const person = personOf(field.object(user));
          if (person && !people.has(person.subject)) people.set(person.subject, person);
        }
        if (people.size >= LISTING_MOST.people) tooMany();
      }
      // People the application sees one by one, not through a department, are in no
      // department's listing. Every ID it may see is asked for, and those not met yet
      // are looked up. Where the corporation does not let the application ask, the
      // departments' listings stand.
      let cursor = "";
      for (let page = 0; page < 1000; page++) {
        const ids = new URL(`${API}/user/list_id`);
        ids.searchParams.set("access_token", token);
        let got: Record<string, unknown>;
        try {
          got = await callJson(net, HOSTS, ids.toString(), {
            body: { limit: 10000, ...(cursor ? { cursor } : {}) },
          });
          ok(got);
        } catch (error) {
          if (error instanceof DirectoryProblem && error.reason === "permission") break;
          throw error;
        }
        for (const one of field.list(got.dept_user)) {
          const userId = field.text(field.object(one).userid);
          if (!userId || people.has(userId)) continue;
          const about = new URL(`${API}/user/get`);
          about.searchParams.set("access_token", token);
          about.searchParams.set("userid", userId);
          const record = await callJson(net, HOSTS, about.toString());
          ok(record);
          const person = personOf(record);
          if (person) people.set(person.subject, person);
          if (people.size >= LISTING_MOST.people) tooMany();
        }
        cursor = field.text(got.next_cursor);
        if (!cursor) break;
        if (page === 999) tooMany();
      }
      return { departments, people: [...people.values()] };
    },

    async check(app) {
      const token = await appToken(app);
      // A token is given to anyone; a request from an address the corporation did not
      // list as trusted is what gets refused. A made-up code finds that out.
      const asked = new URL(`${API}/auth/getuserinfo`);
      asked.searchParams.set("access_token", token);
      asked.searchParams.set("code", "check");
      ok(await callJson(net, HOSTS, asked.toString()), true);
    },
  };
}
