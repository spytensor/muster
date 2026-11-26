/**
 * DingTalk (钉钉), with an application the organization built for itself.
 *
 * Signing in: the person signs in on DingTalk's page and comes back with a code; the
 * token it buys says who they are across DingTalk. Whether they are in this organization
 * is then asked with the application's own token: only its own people have an account
 * there to be found.
 * https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information
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

const NEW = "https://api.dingtalk.com/v1.0";
const OLD = "https://oapi.dingtalk.com/topapi";
const HOSTS = ["api.dingtalk.com", "oapi.dingtalk.com"];
/** The application may not do this: a permission it was not given, or an address not listed. */
const NOT_ALLOWED = new Set([88, 60011, 60020, 50002, 50004]);
/** The department that is the organization itself. */
const ROOT = "1";

export function dingtalkClient(net: Net): DirectoryClient {
  const appToken = async (app: DirectoryApp): Promise<string> => {
    const answer = await callJson(net, HOSTS, `${NEW}/oauth2/accessToken`, {
      body: { appKey: app.appId, appSecret: app.secret },
    });
    const token = field.text(answer.accessToken);
    if (!token) throw new DirectoryProblem("credentials", said(answer.message));
    return token;
  };

  /** One call of the older kind: the token in the address, the answer under `result`. */
  const old = async (
    token: string,
    path: string,
    body: Record<string, unknown>,
    missing = false,
  ): Promise<unknown> => {
    const url = new URL(`${OLD}/${path}`);
    url.searchParams.set("access_token", token);
    const answer = await callJson(net, HOSTS, url.toString(), { body });
    const code = Number(answer.errcode ?? 0);
    if (code === 0) return answer.result;
    if (NOT_ALLOWED.has(code)) throw new DirectoryProblem("permission", said(answer.errmsg));
    if (missing) return null;
    throw new DirectoryProblem("unreachable", said(answer.errmsg) || `code ${code}`);
  };

  const personOf = (user: Record<string, unknown>): DirectoryPerson | null => {
    // Who they are across DingTalk, not their ID in the organization: an administrator
    // can give that one to someone else when a person leaves.
    const subject = field.text(user.unionid);
    if (!subject) return null;
    return {
      subject,
      name: field.text(user.name),
      // Only the mailbox the organization gave them: the other address is their own.
      email: field.text(user.org_email) || null,
      avatarUrl: field.text(user.avatar) || null,
      active: user.active !== false,
      departments: field
        .list(user.dept_id_list)
        .map(field.id)
        .filter((id) => id && id !== ROOT),
    };
  };

  return {
    pkce: false,

    authorizeUrl(app, { redirectUri, state }) {
      const url = new URL("https://login.dingtalk.com/oauth2/auth");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", app.appId);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },

    async identify(app, { code }) {
      const granted = await callJson(net, HOSTS, `${NEW}/oauth2/userAccessToken`, {
        body: {
          clientId: app.appId,
          clientSecret: app.secret,
          code,
          grantType: "authorization_code",
        },
      });
      const theirs = field.text(granted.accessToken);
      if (!theirs) return null;
      const who = await callJson(net, HOSTS, `${NEW}/contact/users/me`, {
        headers: { "x-acs-dingtalk-access-token": theirs },
      });
      const unionId = field.text(who.unionId);
      if (!unionId) return null;
      const token = await appToken(app);
      // Their account in this organization, which only its own people have.
      const found = field.object(await old(token, "user/getbyunionid", { unionid: unionId }, true));
      const userId = field.text(found.userid);
      // 1 is someone outside the organization whom it keeps as a contact.
      if (!userId || Number(found.contact_type ?? 0) === 1) return null;
      const record = field.object(await old(token, "v2/user/get", { userid: userId }, true));
      const person = personOf(record);
      // The record says whose it is: it must be the person who signed in.
      if (!person || person.subject !== unionId) return null;
      return {
        ...person,
        name: person.name || field.text(who.nick),
        avatarUrl: person.avatarUrl || field.text(who.avatarUrl) || null,
      };
    },

    async list(app) {
      const token = await appToken(app);
      const departments: DirectoryDepartment[] = [];
      // One level at a time, from the organization down.
      const waiting = [ROOT];
      const seen = new Set(waiting);
      while (waiting.length > 0) {
        if (departments.length >= LISTING_MOST.departments) tooMany();
        const parent = waiting.shift() as string;
        const under = field.list(
          await old(token, "v2/department/listsub", { dept_id: Number(parent) }),
        );
        for (const item of under) {
          const one = field.object(item);
          const id = field.id(one.dept_id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          departments.push({
            id,
            parentId: parent === ROOT ? null : parent,
            name: field.text(one.name),
          });
          waiting.push(id);
        }
      }
      const people = new Map<string, DirectoryPerson>();
      for (const department of [ROOT, ...departments.map((one) => one.id)]) {
        let cursor = 0;
        for (let page = 0; page < 1000; page++) {
          const got = field.object(
            // A listing that fails is no listing: half of one would read as people gone.
            await old(token, "v2/user/list", {
              dept_id: Number(department),
              cursor,
              size: 100,
              // People whose details the organization hides from colleagues are its people too.
              contain_access_limit: true,
            }),
          );
          for (const user of field.list(got.list)) {
            const person = personOf(field.object(user));
            if (person && !people.has(person.subject)) people.set(person.subject, person);
          }
          if (got.has_more !== true) break;
          if (typeof got.next_cursor !== "number" || page === 999) tooMany();
          cursor = got.next_cursor;
        }
        if (people.size >= LISTING_MOST.people) tooMany();
      }
      return { departments, people: [...people.values()] };
    },

    async check(app) {
      await appToken(app);
    },
  };
}
