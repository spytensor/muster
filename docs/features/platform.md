# Platform capabilities

This file describes the parts of Muster that nobody opens as a page but that every page stands on: sign-in, roles, the agent registry, runs, the gateway, tools, models, budgets, the records that are kept, file storage, the reply format, how the web app is served, configuration and the database. Each section follows `docs/features/TEMPLATE.md`; for a capability with no screen, "Who it is for" names who depends on it, "Where it starts" names what triggers it, and "What it does" replaces "What they see and can do". Every rule cites the code as it stood on 2026-11-14: sections 6, 7, 8, 16, 17, 21 and 22 on branch `epic/cha-167-local-work` (after its last commit, `6c96cf8`); the other sections on `epic/cha-166-polish`, since when `product.ts`, `runs.ts`, `tools.ts` and `app.ts` have moved down, so there the function name is what to trust. Paths are relative to the repository root; `server/` below is short for `apps/server/src/`. Each section also says which locked decision in `docs/architecture.md` (D-1 to D-7) it carries out and where the code does not yet do what the decision says.

## Contents

1. [Sign-in, admission and sessions](#1-sign-in-admission-and-sessions)
2. [Sign-in for native apps](#2-sign-in-for-native-apps)
3. [Roles and permissions](#3-roles-and-permissions)
4. [Organizations, members and departments as data](#4-organizations-members-and-departments-as-data)
5. [The agent registry](#5-the-agent-registry)
6. [Runs](#6-runs)
7. [The gateway](#7-the-gateway)
8. [Tools](#8-tools)
9. [Models](#9-models)
10. [Budgets](#10-budgets)
11. [Traces and spans](#11-traces-and-spans)
12. [The activity log](#12-the-activity-log)
13. [File storage and safety](#13-file-storage-and-safety)
14. [Reply format](#14-reply-format)
15. [Serving the web app and the content security policy](#15-serving-the-web-app-and-the-content-security-policy)
16. [Configuration](#16-configuration)
17. [Database schema and migrations](#17-database-schema-and-migrations)
18. [Shared definitions: identifiers, agent versions, the unused audit chain](#18-shared-definitions-identifiers-agent-versions-the-unused-audit-chain)
19. [Refusals: the error catalogue](#19-refusals-the-error-catalogue)
20. [Deployment and process lifecycle](#20-deployment-and-process-lifecycle)
21. [Gaps against the locked decisions, in one place](#21-gaps-against-the-locked-decisions-in-one-place)
22. [Connections to other services](#22-connections-to-other-services)

---

## 1. Sign-in, admission and sessions

> Changed on 2026-11-15 (the owner: "公司就是连接登录"). Admission has one more grant, and it is the one a company uses: **an account from the company's own directory is a member by signing in** (`fromDirectory` in `apps/server/src/auth/admission.ts` and `oidc.ts`).
>
> - Microsoft: the token is from the configured directory (`tid`), and the directory says the account is a member of it: the optional claim `acct` is 0, and there is no `idp` claim (a guest's home). `acct` is sent only when the app registration asks for it, as `xms_edov` is; without it nobody is admitted by the directory, because a guest carries the same directory in its token and nothing else tells the two apart. Not verified: against a directory that holds guests.
> - The company's own provider: only when the operator set both `MUSTER_OIDC_TRUST_EMAIL=1` and `MUSTER_OIDC_DIRECTORY=1`. Believing a provider's addresses and admitting whoever is in it are two promises: a provider people can register at may get the first and must not get the second.
> - Google and the development sign-in are not a company's directory: they admit by invitation, domain rule or bootstrap as before.
> - The person joins the one organization of the deployment as a member with no department, `joined_via = 'directory'`. With no organization yet nobody is admitted this way: the first owner makes it.
> - The address must still be verified (Microsoft: the `xms_edov` claim), or the sign-in is refused before admission is considered.
> - Someone an administrator removed is not let back in by the directory. An administrator lets them back in on Members.
> - Order of grants: an active membership; an open invitation; the directory; a domain rule; bootstrap.
> - Tests: "makes a member of anyone in the company's own directory…" in `apps/server/src/auth.test.ts`.
>
> What this gives up: a company can no longer let in only some of its directory. Everyone in it can sign in and use agents until suspended. Smallest change if that is wanted: a setting "new people start suspended".

**In plain words: one organization, many people, and what a company sets.**

- A deployment holds one organization with many people. The first sign-in of `MUSTER_BOOTSTRAP_OWNER_EMAIL` creates the organization and makes that person its owner; nothing creates a second one (`server/auth/admission.ts:233-237`), and a person belongs to one organization (`server/schema.ts:42-53`). Everyone else enters that one organization, by invitation or by a domain rule.
- For its people to sign in, a company sets at least one sign-in provider where the server is deployed, and registers the redirect address `<MUSTER_PUBLIC_URL>/auth/callback/<provider>` with it (`deploy/.env.example:17-39`):
  - Google: `MUSTER_GOOGLE_CLIENT_ID`, `MUSTER_GOOGLE_CLIENT_SECRET` (callback `/auth/callback/google`).
  - One Microsoft directory: `MUSTER_MICROSOFT_CLIENT_ID`, `MUSTER_MICROSOFT_CLIENT_SECRET`, `MUSTER_MICROSOFT_TENANT`, the directory's GUID (callback `/auth/callback/microsoft`).
  - The company's own OpenID Connect provider (Keycloak, Authing, Okta, Authentik or any other that speaks OpenID Connect): `MUSTER_OIDC_ISSUER`, `MUSTER_OIDC_CLIENT_ID`, `MUSTER_OIDC_CLIENT_SECRET`, and optionally `MUSTER_OIDC_LABEL` for the button and `MUSTER_OIDC_TRUST_EMAIL` (callback `/auth/callback/oidc`).

  One is enough; two or all three may be set together, and each gets its own button. A provider with only some of its settings stops the server at start. Besides the provider, the company sets `MUSTER_PUBLIC_URL` and `MUSTER_BOOTSTRAP_OWNER_EMAIL`.
- A company that uses only its own provider must also set `MUSTER_OIDC_TRUST_EMAIL=1`, and may do so only when every account in that provider was given its address by the company. Without it the provider proves no domain, so the first owner cannot create the organization (they are refused `not_member`), no domain rule admits anyone, and an account cannot be matched to a person who already signs in another way; such an account can only accept an invitation (`server/auth/oidc.ts:59-70`, `admission.ts:80`, `admission.ts:222`, `admission.ts:234`).
- Sign-in with real Google, real Microsoft or a real OpenID Connect provider has not been run against a real provider. It has been run only against the development provider and in tests (`server/auth.test.ts`, `server/app.test.ts`); nothing in the repository records a sign-in through a real one. The first deployment should expect to find what the tests could not.

**Who it is for.** Everyone. Every request under `/api` depends on it. Operators depend on it to decide who gets in. No permission gates sign-in itself.

**The job.** Prove who a person is through the company's identity provider, decide whether they may enter this organization, and keep them signed in until the session ends or is ended.

**Where it starts.** A browser opens `GET /auth/login/<provider>` (the sign-in page lists providers from `GET /auth/providers`). After that, every request that carries the session cookie or a bearer token.

**What it does.**

1. Lists providers. `GET /auth/providers` returns `{id, label}` for each configured provider (`server/app.ts:173`). Providers are the company's own OpenID Connect provider (`oidc`), Google, Microsoft (one directory) and, in development only, `dev`, listed in that order (`server/config.ts:176-263`). The company's own provider is found from its issuer address, whose `/.well-known/openid-configuration` describes it; its label is `MUSTER_OIDC_LABEL` cut to 40 characters, or "Company account".
2. Starts an attempt. `GET /auth/login/:provider` creates a state, a nonce, a PKCE verifier and a random 32-byte "binding" value. It stores the attempt in `login_attempts` for 10 minutes with only the hash of the binding, and puts the binding in the cookie `muster_login` (HttpOnly, SameSite=Lax, path `/auth`, 600 seconds) (`server/auth/oidc.ts:7`, `oidc.ts:116-140`, `server/app.ts:177-186`). It asks the provider for scope `openid email profile` with `prompt=select_account`.
3. Completes the attempt. `GET /auth/callback/:provider` deletes the attempt row matching state, provider and the hash of the cookie value, so each callback works once and only in the browser that started it. It then exchanges the code with PKCE, state and nonce checks and requires an ID token (`oidc.ts:148-181`).
4. Reads the identity. Each provider has its own rule for when the address can be believed (`oidc.ts:17-71`):
   - Google: `sub` is the account. `emailVerified` is the `email_verified` claim. The domain is "proven" when the address is `gmail.com`/`googlemail.com` or the `hd` claim equals the address's domain.
   - Microsoft: the token's `tid` must equal the configured directory and `oid` must be present; `oid` is the account. The address is verified and the domain proven only when the `xms_edov` claim is true.
   - The company's own provider: `sub` is the account. The address is verified when the `email_verified` claim is true, or, when the operator has set `MUSTER_OIDC_TRUST_EMAIL=1`, whenever the claim is not false (many company directories never send it). The domain is proven only by the operator's word: with `MUSTER_OIDC_TRUST_EMAIL=1` and a claim that is not false. A "verified" address from a provider anyone might register at says the person reads that mailbox, not that the company gave them the address (`oidc.ts:56-70`).
   - Development provider: verified and proven follow `email_verified`.
5. Decides admission inside one transaction (`server/auth/admission.ts:48-185`), in this order:
   - Refuse `email_unverified` when the address is not printable ASCII or the provider did not verify it (`admission.ts:57`).
   - Find the person by `(provider, subject)`, not by address (`admission.ts:62-67`).
   - If unknown at this provider but the address belongs to an existing person: link only when that person has no account at this provider and the domain is proven; otherwise refuse `identity_conflict` and record `auth.login_denied` (`admission.ts:69-99`).
   - An active membership admits. A suspended one refuses `suspended` and records `auth.login_denied` (`admission.ts:110-123`).
   - Otherwise a grant is needed (`admission.ts:195-239`): an open invitation for the address (locked `for update`, so it is used once); or, unless the person was removed, an `org_domains` row with `auto_join = true` for the address's domain when the domain is proven; or, when no organization exists at all, being `MUSTER_BOOTSTRAP_OWNER_EMAIL` with a proven domain. No grant: refuse `not_member`, and no user row is created.
   - On a grant: create the user if new, create the organization for the bootstrap owner (name from `MUSTER_ORG_NAME`, action `org.created`), insert the membership (or revive a `removed` one in the same organization), mark the invitation accepted, record `member.joined` with `via` and `role`.
6. Creates the session. A 32-byte random token is made; only its SHA-256 is stored as `sessions.id` (`server/auth/session.ts:15-49`). Any session the browser already held is revoked first (`server/app.ts:205`). `auth.login` is recorded. The cookie `muster_session` is set: HttpOnly, SameSite=Lax, path `/`, `Secure` when the public URL is https, expiring with the session (`server/app.ts:229-235`).
7. Sends the browser to `/`, or to `/?error=<reason>` with `email_unverified`, `not_member`, `suspended`, `identity_conflict` or `failed` (`server/app.ts:191-228`).
8. Authenticates each API request. `/api/*` resolves the token to a session or answers 401 `unauthenticated` (`server/app.ts:274-280`). A request with an `Authorization` header is judged by that header alone and never falls back to the cookie (`server/app.ts:247-250`).
9. Signs out. `POST /auth/logout` revokes the session, records `auth.logout`, clears the cookie (`server/app.ts:252-270`).

**Rules.**

- A session lives `MUSTER_SESSION_DAYS` days from creation, default 7. Use does not extend it. There is no idle timeout (`session.ts:32`, `config.ts:286`).
- A session resolves only when it is not revoked, not expired, and the membership is `active` (`session.ts:73`). Suspension therefore cuts access on the next request even before its sessions are revoked.
- Suspending or removing a member ends more than their sessions: once the change is committed, every run they have in progress is stopped, and a run cannot start for someone whose membership is not `active` (`server/app.ts:84-93`, `server/runtime/runs.ts:224-230`, `runs.ts:337-343`; section 6).
- `last_seen_at` is written at most once a minute (`session.ts:79-81`). The user agent is cut to 300 characters (`session.ts:44`).
- Sessions end by: sign-out; a new sign-in in the same browser; an administrator suspending or removing the member (all their sessions, `server/app.ts:411`, `app.ts:457`); an administrator ending one (`DELETE /api/sessions/:id`, needs `sessions.revoke`, and may not touch a role the actor cannot manage, `app.ts:771-800`); the person ending one of their own (`DELETE /api/app/sessions/:id`, `server/product.ts:647-666`).
- State-changing requests (not GET/HEAD/OPTIONS) must carry `Origin` equal to `MUSTER_PUBLIC_URL`, or are refused 403 `bad_origin`. Exempt: requests with `Authorization: Bearer …`, `POST /auth/app/token`, and the development provider (`server/app.ts:159-169`).
- An invitation lives 14 days (`server/app.ts:36`). There is at most one open invitation per address across all organizations (`server/schema.ts:67-68`). An address that is already a member anywhere cannot be invited (`app.ts:617-621`). Inviting a role needs the right to grant it (`app.ts:614`).
- An automatic-join domain cannot be a public mailbox domain; 41 are listed (`server/app.ts:39-46`, `app.ts:710`). A domain belongs to one organization (`schema.ts:15`).
- A removed person returns only by a new invitation, never by a domain rule (`admission.ts:125-132`, `app.ts:458-462`).
- The client IP is kept for the record only and never decides access. `X-Forwarded-For` is believed only when `MUSTER_TRUST_PROXY=1`, and then its right-most entry (`server/app.ts:100-110`).
- Microsoft's tenant must be one directory's GUID; `common`, `organizations` and `consumers` are refused at start (`config.ts:142`, `config.ts:235-244`).
- A provider is whole or absent. Google with one of its two settings, Microsoft with one or two of its three, or the company's own provider with one or two of issuer, client id and client secret, stops the server at start with "<provider> sign-in is half set: <names> is missing" (`config.ts:177-200`). `MUSTER_OIDC_LABEL` and `MUSTER_OIDC_TRUST_EMAIL` alone do not count as a provider half set.
- The company's issuer must be an `https` address (`http` is accepted only in development), else the server does not start (`config.ts:201-211`). It is kept as written, because a provider's issuer is compared letter for letter and some end in `/`; only a bare origin loses its trailing slash.
- `MUSTER_OIDC_TRUST_EMAIL` counts only when it is exactly `1` (`config.ts:218`). Even then, an address the provider marks `email_verified: false` is not believed.
- The development provider asks for no password. It exists only when `MUSTER_DEV=1`, which refuses to start next to `DATABASE_URL` or an https public URL (`config.ts:170-174`), and the server then listens on `127.0.0.1` only (`server/index.ts:56`). Its client secret is random per start (`config.ts:261`). Its codes live 60 seconds and its ID tokens 5 minutes (`server/dev/idp.ts:86`, `idp.ts:129`). An address starting with `unverified` is issued as unverified (`idp.ts:120`). In development an empty database is filled with a sample organization, "Northwind Labs" (`server/dev/seed.ts:12-27`).

**States.**

- No provider configured: the server refuses to start (`config.ts:264`).
- A provider half set: the server refuses to start and names what is missing.
- The company's own provider without the operator's word (`MUSTER_OIDC_TRUST_EMAIL`): invited people get in when the provider says it verified their address, and are refused `email_unverified` when it does not say; nobody gets in by a domain rule; the bootstrap owner is refused `not_member`.
- Provider unreachable: discovery fails, is not cached, and the person lands on `/?error=failed` (`oidc.ts:105-106`, `server/app.ts:127-129`).
- Expired or reused callback, or callback in another browser: `/?error=failed`.
- Fresh deployment: only the bootstrap owner can enter; everyone else gets `not_member`.

**How it is wired.**

- Screen: the sign-in page is the web app's (`Shell`, `Login`, `SignInPicture` in `apps/web/src/App.tsx`): the ways in on the left, one round button each with that provider's mark, and on a wide window a drawn picture of what Muster does on the right. Nobody types an address or a password into Muster. The two pages the server draws itself, confirming a native app and the development accounts, share one look (`server/auth/page.ts`).
- Requests: `GET /auth/providers`, `GET /auth/login/:provider`, `GET /auth/callback/:provider`, `POST /auth/logout` → `server/app.ts:173-270`. `GET/DELETE /api/sessions…` → `app.ts:756-800`. `GET/POST/DELETE /api/invitations…` → `app.ts:571-685`. `GET /api/settings/sign-in`, `PUT/DELETE /api/settings/sign-in/domains/:domain` → `app.ts:689-752`.
- Data: `users`, `identities`, `memberships`, `invitations`, `org_domains`, `sessions`, `login_attempts` (`schema.ts:13-93`, `schema.ts:260`).
- Events: `auth.login`, `auth.login_denied` (suspended and identity conflict only), `auth.logout`, `org.created`, `member.joined`, `invitation.created`, `invitation.revoked`, `signin.domain_set`, `signin.domain_removed`, `session.revoked`.
- Tests: `server/auth.test.ts:24-127` (what each provider's token proves; `auth.test.ts:97` "believes a company's own provider when it checked the address, or when the operator vouches for it"), `auth.test.ts:278` ("takes a company's own OpenID Connect provider, and refuses one that is half set"), `auth.test.ts:152-249` (matching to an existing person, ASCII), `server/app.test.ts:39-55` (first owner), `app.test.ts:63-145` (who may sign in), `app.test.ts:159-214` (cookie, one-use callback, browser binding, sign-out), `app.test.ts:221` (other sites), `app.test.ts:389-417` (suspend, remove), `app.test.ts:442-454` (sessions).

**Single sign-on with SAML, and provisioning with SCIM (since 2026-11-24, MUS-30).**

Set up in the console under Sign-in & sessions (admin-console.md), not in the server's settings.

- **SAML 2.0, started from Muster.** An administrator gives the identity provider's metadata (its address, read once through the guarded network, or the file's contents). Muster keeps the entity ID, the HTTP-Redirect sign-in address and up to four signing certificates in `saml_settings`, and shows its own entity ID (`<public URL>/auth/saml/metadata`, which also serves its metadata) and reply address (`<public URL>/auth/saml/acs`) to copy (`server/sso.ts`, `server/auth/saml.ts`).
- **A sign-in is three steps.** `GET /auth/login/saml` (only while it is switched on; 20 a minute per address, 5,000 on their way at most, those older than ten minutes dropped) stores a request id with the hash of a cookie only this browser holds, and sends the person to the provider with an unsigned `AuthnRequest`. The provider's page posts its answer to `/auth/saml/acs` from its own site, so no cookie of ours comes with it and the origin check lets that one address through; the answer is checked, the one request it names is looked up (it must be this organization's, waiting and unanswered), and it is kept under a one-time code. The browser is sent (303) to `/auth/saml/done?code=…`, where it does show the cookie: only the browser that began, within two minutes, once, is let in, and only if it is still switched on.
- **What an answer must be to be believed** (`readResponse`): signed by one of the configured certificates, on the answer or on its assertion, with SHA-256 or stronger (SHA-1 refused), by a signature sitting directly in the element it signs, with exactly one reference to that element; a key carried inside the answer is never used. The claims are then read from the signed bytes the signature library hands back, never from the document as it arrived, which is what defeats a second assertion wrapped around or beside the signed one. Then: status Success; issuer is the configured entity ID; audience is Muster's entity ID; a bearer confirmation whose `Recipient` is the reply address and whose `InResponseTo` is a request of ours still waiting (an answer nobody asked for is refused: no provider-initiated sign-in); `NotBefore`/`NotOnOrAfter` within two minutes' skew; the assertion's id taken once (`saml_assertions`). A document type is refused before parsing (no entities, no outside files); 256 KB at most; encrypted assertions are not read.
- **Who a person is, and what the provider's word is not enough for** (`mayEnter`, `server/sso.ts`; review of 2026-11-24). The provider's `NameID` is the person's lasting account id (`identities.provider` is `saml:<organization id>`: one name per organization, whatever provider it names, so changing the provider never makes people strangers whose addresses can be claimed again). A person it has named before comes in as before. For anyone else it has only given an address, and whoever controls the provider can give any address: so a plain member already in this organization becomes that member; an owner, an administrator or anyone with another role is never matched by address (`identity_conflict`); and someone not here yet is let in, as a member, only at an address in a domain the organization has named under Sign-in (`org_domains`), else `not_member` and no account is made. A provider answers for one organization only, and can let nobody into another.
- **Owners and administrators connect their own account, signed in.** `POST /api/settings/sso/saml/try` (the console's "Try it", and "Connect my account" once it is on) begins a sign-in tied to the person's session (`saml_requests.connect_user`). When it comes back, in the same browser still signed in as that person, the provider's account becomes theirs, whatever address it named; no session is made, nobody becomes a member, and an account that is someone else's is refused. Before it is switched on only an owner may; this is also what makes it "known to work".
- **It is an owner's, and it cannot lock the company out.** Setting or changing the provider, switching it, and removing it are refused to anyone but an owner (`owner_only`): which provider answers decides who gets into every account. Setting or changing it switches it off. It can be switched on only after an owner has connected their account through it as it is now set. While on, and while the server holds one organization, `GET /auth/providers` returns it alone, so the sign-in page offers one way in; the server's own providers still answer at `/auth/login/<id>` for whoever knows the address, which is the way back in if the provider breaks (runbook). With more than one organization on a server the page goes on offering the server's own.
- **SCIM 2.0** (`server/scim.ts`, under `/scim/v2`): `ServiceProviderConfig`, `Schemas`, `ResourceTypes`; `Users` (list with `filter=userName eq "…"` or `externalId eq "…"`, `startIndex`, `count` up to 200; create; read; replace; patch; delete) and `Groups`, which are departments (list by `displayName`, `excludedAttributes=members`; create; replace; patch members and name; delete). Patches are read the way Entra ID and Okta send them: `active` as `false` or `"False"`, with or without a path, `members[value eq "…"]`. Unknown attributes are ignored.
- **What provisioning does, and what it may not** (review of 2026-11-24). Create makes the person a member (role member) before they ever sign in, at an address in the organization's domains only: any other address is refused with the same words whether or not somebody anywhere has it. `active: false` suspends; delete removes: both end the person's sessions and whatever their agents were doing, by the same hook the members page uses (`kit.memberBlocked`), and delete nothing of theirs (retention and erasure are separate, admin-console.md). It acts on plain members only: an owner, an administrator or anyone with another role is refused (403) for anything that would change them, while saying again what is already so is let through. It gives back only the access it took away itself: someone an administrator suspended or removed stays so (read from the activity log: the last change of that kind must be SCIM's own). The address of someone who has signed in is not moved unless single sign-on is on. Each change locks the organization first, so the count of owners and the change agree. A person is in one department: adding them to a group moves them. Deleting a group deletes the department as the departments page does. `startIndex` and `count` are whole numbers; `startIndex` stops at 1,000,000.
- **The token.** Made in the console by an owner, said once, kept as a SHA-256 hash with its last four characters; five at most; revocable; "last used" to the minute. It reaches one organization's people and departments and nothing else. 600 requests a minute per token, then 429 with `Retry-After` (counted in the process, so per server process). Every change is on the activity log with actor `scim`, `detail.via = "scim"` and the token's tail.
- Events: `sso.saml_set`, `sso.saml_connected`, `sso.saml_on`, `sso.saml_off`, `sso.saml_removed`, `scim.token_created`, `scim.token_revoked`, `member.address_changed`; a refused SAML answer is `auth.login_denied` with `reason: "saml"` and a word for why (never the answer itself).
- Tests: `server/saml.test.ts` (metadata; signed assertion or answer; unsigned, wrong key, tampered, SHA-1, wrong audience, recipient, request, time, issuer, status; three wrapping shapes; the whole flow: set up, not offered until tried, another browser, replay, suspended, changed certificate), `server/scim.test.ts` (token said once; users create, find, page, rename; suspend and remove end sessions and work and delete nothing; last owner; groups; another organization out of reach; rate limit; revoke).
- Not built: signed requests, encrypted assertions, single logout, provider-initiated sign-in, more than one SAML provider per organization, refreshing metadata on a timer (a new certificate is entered by setting it again), SCIM bulk, sort, ETags, filters other than `eq`, roles from the directory (everyone arrives as a member), and a rate limit shared between server processes.
- Known limits: a person provisioned by SCIM who then signs in through one of the server's own providers that does not prove the address's domain is refused `identity_conflict`, as any first sign-in to an existing address is; SCIM is meant to go with SAML or with a provider that is the company's directory. Changing the provider's `NameID` format makes everyone a different account: members are refused `identity_conflict` until an administrator sorts it out, owners and administrators connect again. A guest at an address outside the organization's domains cannot be provisioned or let in through SAML; they are invited.

**Company directories: Feishu, Lark, WeCom, DingTalk (since 2026-11-26).**
For a company whose people work in one of these, its directory there is the organization's own way in, held to the same rules as single sign-on above.

- **What an owner gives.** The internal application the company created at the service (Feishu and Lark: App ID and App Secret; WeCom: CorpID, AgentId and the application's Secret; DingTalk: Client ID and Client Secret), with read access to contacts, and Muster's redirect address registered there (`<public URL>/auth/callback/<feishu|lark|wecom|dingtalk>`). The secret is checked against the service when it is saved, sealed with `MUSTER_SECRET_KEY`, and never shown again (`server/directory.ts`, `org_directories`). One application answers for one organization.
- **Tried before it is on.** As with SAML: "Try it" sends the owner through the service and back, makes their account there theirs here, and only then can it be switched on. A try that fails comes back to the console, which says why (`org_directories.tried`). While it is on the sign-in page offers it alone, under the service's name. Naming another application switches it off until it is tried again; the same application with a new secret stays on.
- **Who gets in.** The person signs in at the service; the code they come back with says who they are, and the company's own record is then asked for them with the application's token (`server/directory/feishu.ts`, `wecom.ts`, `dingtalk.ts`). Only someone found there, and not marked as having left or switched off, is let in: an outside contact, a member of another company, or someone outside what the application was given sight of is refused. A first sign-in makes the person a member (`joined_via = 'directory'`). A plain member already here under the same address becomes that member; an owner, an administrator or any other role is never matched by an address (`mayEnter`), they press "Connect my account".
- **Which address is believed.** Only the mailbox the company gave the person (Feishu `enterprise_email`, WeCom `biz_mail`, DingTalk `org_email`), and only in a domain the organization named as its own under Sign-in. The address a person types into their own profile is never read: it would let them become whoever holds that address here, or take an invitation waiting at it.
- **People without an address.** Everyone else is kept under an address that can never receive mail, `<their ID there>@<application>.<service>.invalid` (`addressFor`). The web app hides it where an address is shown on its own (`address()` in `apps/web/src/lib/utils.ts`) and shows the person's name; it still appears where an address is the thing itself: the activity log's export, the traces export, and the box an administrator types into to erase a person. When the directory later holds a believed address for them and it is free, it replaces the made-up one.
- **Following the directory.** While it is on, the directory is read when it is switched on, every hour (`Directories.tick`, started in `index.ts`), and when an administrator presses "Sync now" (`POST /api/settings/directory/sync`). Departments arrive named by where they sit ("Engineering / Platform", cut from the top at 60 characters) and are kept in step by the service's ID for them (`directory_departments`); one the directory drops stays here, no longer tied to it. People the application can see who are not here yet are added as members; a person's name and department follow the directory; someone who left it is suspended, their sessions ended and what their agents were doing stopped, exactly as when an administrator suspends them. The directory gives access back only to someone it suspended itself, and only if they still have the same name: WeCom lets a company give a leaver's ID to someone new.
- **What it will not do.** It never changes the role or status of an owner, an administrator or any role but member; one of them who left the directory is signed out everywhere and an event says so (`directory.left`). A reading that fails, that reaches a limit (50,000 people, 5,000 departments), or that names nobody changes nothing and is shown on the card with what the service said (a missing permission is named). A reading that would suspend more than five people and more than half of those it knows holds back, on the hour and on "Sync now" alike, until an owner presses "Suspend N people" and confirms.
- Requests: `GET/PUT/DELETE /api/settings/directory`, `PUT …/enabled`, `POST …/try`, `POST …/sync` (`{confirm: true}` is an owner's); `GET /auth/login/<kind>`, `GET /auth/callback/<kind>` (through `SignInWay.complete`).
- Events: `directory.set`, `directory.connected`, `directory.on`, `directory.off`, `directory.removed`, `directory.synced`, `directory.left`; what a reading did to people and departments is written as `member.joined`, `member.suspended`, `member.reactivated`, `member.address_changed`, `department.created`, `department.renamed` with actor `directory` and `via: "directory"`; a refused sign-in is `auth.login_denied` with `reason: "directory"` and a word for why.
- Tests: `apps/server/src/directory.test.ts`, against a stand-in for each service.
- Not built: the services' change events (the directory is read on the hour instead); roles from the directory; more than one directory per organization; signing in from inside DingTalk's or Feishu's own app without their sign-in page; hiding the made-up address in the phone app's lists; LDAP. Removing the directory leaves people it had suspended suspended, and people with no other way in locked out.
- Known limits: the whole reading is one transaction that holds the organization's row, so changes to members wait while a large company is read. WeCom names a person by an ID the company can reuse; DingTalk and Feishu by one that is theirs for good.
- Tried against the real Feishu (2026-11-26, a company whose application saw one person): accepting and refusing an application's secret, naming a missing permission, reading the directory where the application sees only part of the company, an owner's try from the console, switching on, the first reading, and signing in from the sign-in page. Two things only the real service showed: the listing mistook "nothing under the company itself" for a listing cut short, and Feishu's newer token address (`/oauth/v3/token`) refuses the proof its own authorization page asks for (error 20049), so the older `/open-apis/authen/v2/oauth/token` is used. Feishu shows its consent page at every sign-in. Not yet seen there: a new person being added, departments, and someone outside the application's sight being refused. Everything for Lark, WeCom and DingTalk follows the services' documentation and the tests' stand-ins and has not met the real thing.

**Not built.**

- Members are otherwise created only by signing in.
- More than one company provider: one `MUSTER_OIDC_*` set is read. No choice of scopes or of which claim holds the address; the provider must put `email` in the ID token.
- A run of sign-in against a real Google, Microsoft or company provider. The exchange is tested against the development provider only.
- Sending the invitation. The server has no mail code; an invitation is a row, and the invited person must be told by other means.
- Multi-factor rules, IP allowlists, device checks. These are left to the identity provider.
- Idle timeout, "sign out everywhere" for oneself in one action, and a session lifetime set in the console (it is an environment variable).
- Rate limiting of sign-in attempts or of any route.
- A record of `not_member` and `email_unverified` refusals. They are not written anywhere, because there is no organization row to attach them to (`admission.ts:133`, `admission.ts:57-59`).
- A second organization on one deployment: nothing creates one after the first (`admission.ts:234-237`).

**Design findings.**

- Access survives after the identity provider disables the account, for up to the session lifetime (7 days by default). Nothing re-checks the provider. Smallest change: document `MUSTER_SESSION_DAYS=1` as the enterprise default and add an idle timeout column check in `resolveSession`; SCIM deprovisioning is the full answer.
- Failed sign-ins by strangers leave no trace. A security team cannot see probing. Smallest change: write those refusals to the server log with address, provider and IP, or to a deployment-level events table.
- Microsoft sign-in silently depends on the optional `xms_edov` claim. If the directory administrator has not enabled it, every Microsoft user is refused `email_unverified` with no hint why (`oidc.ts:39-41`). Smallest change: say so in `deploy/.env.example` and log the reason once.
- Answered on 2026-11-14: a provider with some but not all of its settings now stops the server at start, naming what is missing (`config.ts:177-200`).
- A company's own provider is where the bootstrap rule bites hardest: without `MUSTER_OIDC_TRUST_EMAIL=1` the first owner is refused `not_member` and nothing says why (`admission.ts:234`). `deploy/.env.example` says so in a comment; the server does not. Smallest change: at start, log that the bootstrap owner cannot enter through the company's provider until the operator vouches for it, when that is the only provider.
- The bootstrap owner must sign in with a proven domain. A bootstrap address at a Google account without `hd`, or a Microsoft account without `xms_edov`, can never create the organization, and the message is only `not_member` (`admission.ts:234`). Smallest change: a distinct error reason.
- Invitations are not delivered. Smallest change: show a copyable sign-in link on the invitation row until mail exists.

**Locked decisions.** Carries out D-4 (permission assignment is governed and recorded) and D-6 (one account for every client). Gap: D-4 expects the operator to manage this in the console; providers, session lifetime and the first owner are environment variables only.

---

## 2. Sign-in for native apps

**Who it is for.** The desktop and mobile clients, and anyone signing in through them.

**The job.** Let a native app obtain a session without ever showing the identity provider inside an embedded web view and without the app seeing the person's credentials.

**Where it starts.** The app opens the system browser at `GET /auth/app/start?challenge=<S256 of its verifier>&redirect=<where to come back>`.

**What it does.**

1. Checks the request. The challenge must be 43 to 128 URL-safe characters. The redirect must be exactly `muster://auth` or match `http://127.0.0.1:<4 or 5 digit port>/callback`. Anything else answers 400 "This sign-in link is not valid." (`server/auth/app-login.ts:12-17`, `server/auth/app-routes.ts:40-46`).
2. Stores an `app_logins` row for 10 minutes and sets the cookie `muster_app` (HttpOnly, SameSite=Lax, path `/auth`, 600 seconds) (`app-login.ts:5`, `app-login.ts:27-32`, `app-routes.ts:47`).
3. If the browser is already signed in, goes to the confirmation page. If not: with one provider configured it goes straight to that provider; with several it goes to the sign-in page (`app-routes.ts:48-53`). After a normal sign-in the callback notices the pending app login and goes to the confirmation page (`server/app.ts:237-238`).
4. Shows a confirmation page served by the server: "Sign in to the Muster app?", the person's address, and Continue / Cancel. The page has no script. Its policy is `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' <the app's own address>` (`app-routes.ts:56-84`).
5. On Continue (`POST /auth/app/approve`, covered by the Origin check) it writes a one-time 32-byte code on the row and redirects the browser to the app's address with `?code=…`. On Cancel, or without a session, the row is deleted and the browser goes home (`app-routes.ts:86-107`, `app-login.ts:56-73`).
6. The app posts `{code, verifier}` to `POST /auth/app/token`. The row is deleted and matched in one statement: the code must exist, be unexpired, and its stored challenge must equal SHA-256 of the verifier. The membership must still be active. A session of kind `app` is created with the same lifetime as a browser session, `auth.login` is recorded with `app: true`, and `{token, expiresAt}` is returned (`app-routes.ts:109-150`, `app-login.ts:76-95`).
7. The app sends the token as `Authorization: Bearer <token>` on every request.

**Rules.**

- The code is useless without the verifier, works once, and dies with its row at 10 minutes from the start of the flow.
- A bad code answers 401 "This sign-in code is not valid."
- Bearer requests skip the Origin check and never use the cookie (`server/app.ts:159-169`, `app.ts:247-250`).
- App sessions appear in the session lists with `kind = app` and are revoked the same ways as browser sessions.

**States.** Invalid link (400). Not signed in (goes through sign-in first). Cancelled (home). Suspended between approval and exchange (401).

**How it is wired.**

- Screen: the confirmation page is HTML in `server/auth/app-routes.ts:73-83`.
- Requests: `GET /auth/app/start`, `GET /auth/app/confirm`, `POST /auth/app/approve`, `POST /auth/app/token` → `server/auth/app-routes.ts:40-150`.
- Data: `app_logins` (`schema.ts:249-259`), `sessions.kind` (`schema.ts:260`).
- Events: `auth.login` with `detail.app = true`.
- Tests: `server/app.test.ts:637-713` (confirm then bearer works; code without the secret gives nothing; cancel and cross-site approval issue no code; only app or loopback redirects; sign-in first when not signed in; refused when suspended meanwhile).

**Not built.**

- Refresh tokens. When the session ends the person signs in again through the browser.
- A name for the device. A session shows the user agent of the token exchange only.
- `http://localhost` or `http://[::1]` as loopback addresses; only `127.0.0.1` is accepted.
- Registration of app clients. Any program on the machine that can open a browser and listen on loopback can start this flow; the confirmation page is the only gate.

**Design findings.**

- The confirmation page cannot tell which app asked. It says "the Muster desktop app on this computer" for any loopback listener. Smallest change: show the port and require the person to match a short code the app displays.
- An app token is a full session with the person's whole role. A lost phone holds an administrator session for up to 7 days. Smallest change: let the session list show "app" prominently (it has `kind`) and add an administrator action "end all app sessions of this person".

**Locked decisions.** Carries out D-6 (desktop, mobile and web share one backend and one account). Gap: D-6 also requires a designed line between what stays on the device and what is synced. The server has no notion of device content at all; the only device-specific thing it knows is the session kind.

---

## 3. Roles and permissions

**Who it is for.** Every route that is not open to all members; owners and administrators who assign roles.

**The job.** Decide, from one fixed table, what each of five roles may read and change.

**Where it starts.** Each request: the role is read from the membership when the session is resolved (`server/auth/session.ts:66-73`), and a route calls `need(c, "<permission>")` (`server/app.ts:282-283`).

**What it does.** The table is code (`server/roles.ts:18-59`):

| Permission | owner | admin | auditor | billing | member |
|---|---|---|---|---|---|
| `console.access` | yes | yes | yes | yes | no |
| `members.read` | yes | yes | yes | no | no |
| `members.manage` | yes | yes | no | no | no |
| `audit.read` | yes | yes | yes | no | no |
| `settings.read` | yes | yes | yes | no | no |
| `settings.manage` | yes | yes | no | no | no |
| `sessions.read` | yes | yes | yes | no | no |
| `sessions.revoke` | yes | yes | no | no | no |
| `agents.read` | yes | yes | yes | no | no |
| `agents.manage` | yes | yes | no | no | no |
| `traces.read` | yes | yes | yes | no | no |
| `traces.annotate` | yes | yes | no | no | no |

Everything under `/api/app/*` (the product: conversations, own agents, documents, files, own sessions, own usage, own approvals) is open to any active member and is scoped to that member's own rows (`server/product.ts:142`).

**Rules.**

- An owner may manage anyone and grant any role. An administrator may manage and grant only `auditor`, `billing`, `member`. Nobody else may manage anyone (`roles.ts:70-82`). A violation answers 403 `owner_only`.
- Nobody may change their own role or status: 400 `self` (`server/app.ts:362`).
- The organization always keeps one active owner: demoting, suspending or removing the last one answers 409 `last_owner` (`app.ts:368-374`, `app.ts:393-394`, `app.ts:407-408`, `app.ts:455-456`).
- Member changes lock the organization row and re-read the actor's role inside the lock (`app.ts:335-365`).
- An administrator cannot withdraw an invitation to a role they could not grant (`app.ts:670`), nor end the session of someone they cannot manage (`app.ts:788-789`).
- The billing role sees cost and run totals on the dashboard but not people or traces (`server/observe.ts:562-587`).
- Only an owner may delete someone else's annotation (`observe.ts:359-364`).
- A role change takes effect on the person's next request; no session needs to be reissued.

**States.** A refused request answers 403 `forbidden` with "Your role does not allow this."

**How it is wired.**

- Requests: `GET /api/me` returns role and its permission list (`server/app.ts:293-302`). `PATCH /api/members/:id` changes role, status, department (`app.ts:376-447`). `DELETE /api/members/:id` removes (`app.ts:449-474`).
- Data: `memberships.role`, `memberships.status` (`schema.ts:43-53`).
- Events: `member.role_changed` (from, to), `member.suspended` (sessionsEnded), `member.reactivated`, `member.removed`, `member.department_changed`.
- Tests: `server/roles.test.ts:5-38`; `server/app.test.ts:241-357` (what each role may do, self-change, owners demoting each other, malformed changes).

**Not built.**

- Custom roles, per-department administrators, and permissions on single agents or single resources.
- A role that may build or approve agents without the whole of `agents.manage`.
- Separation of duty: an owner or admin holds both `audit.read` and every manage permission. Auditor is read-only, but administrators are not kept out of the record. The one thing an auditor can change in the console is their own saved filters on Traces (`POST /api/views`, `DELETE /api/views/:id`): personal, seen by nobody else, and not written to the activity log.
- A time-limited or approved elevation.

**Design findings.**

- `billing` has one permission and nothing that is billing: no export, no invoice, no budget control. Smallest change: give it the usage export when one exists, or remove the role until there is something for it.
- The grant table is compiled in. An enterprise cannot answer "who can read every employee's prompts" without reading code; the answer is owner, admin and auditor (`traces.read`). Smallest change: show the table on the console's role screen from `roles.ts`.

**Locked decisions.** Carries out D-4 (permission assignment). Gap: D-4's design proposal separates auditor from administrator; the code makes the auditor read-only but does not stop administrators reading or exporting everything.

---

## 4. Organizations, members and departments as data

**Who it is for.** Every feature that scopes rows to an organization; administrators who manage people.

**The job.** Hold who belongs where, so that every other table can say "this row is this organization's and this person's".

**Where it starts.** The first sign-in of the bootstrap owner creates the organization. Sign-ins, invitations and the member routes create and change the rest.

**What it does.**

- `organizations(id, name, created_at)`. Created once, by the bootstrap sign-in (`server/auth/admission.ts:147-157`).
- `users(id, email unique, name, avatar_url, created_at, last_login_at)`. One row per person across the deployment. Name and picture are refreshed from the provider at each sign-in (`admission.ts:241-254`).
- `identities(provider, subject → user_id)`. One row per provider account.
- `memberships(org_id, user_id unique, role, status, department_id, joined_at, joined_via)`. `user_id` is unique: a person belongs to one organization (`server/schema.ts:42-53`). `status` is `active`, `suspended` or `removed`; `joined_via` is `invitation`, `domain` or `bootstrap`.
- `departments(id, org_id, name)`, flat, name unique per organization, 1 to 60 characters (`schema.ts:20-26`, `server/app.ts:490`).
- `org_domains(org_id, domain unique, auto_join)`.

**Rules.**

- Removing a member keeps the row with `status = 'removed'`, role reset to `member`, department cleared (`server/app.ts:458-462`).
- Deleting a department sets its members' and invitations' department to null (`schema.ts:49`, `schema.ts:59`).
- Every organization-owned table references `organizations(id) on delete cascade`. Nothing in the server deletes an organization or a user.
- The member list hides removed people (`app.ts:316`).
- Departments are used for one thing beyond display: the dashboard's cost by department, using the member's department today, not at the time of the run (`server/observe.ts:647-654`).

**States.** No organization yet (fresh deployment). One organization (every deployment after bootstrap).

**How it is wired.**

- Requests: `GET /api/members` (`app.ts:306-321`), `PATCH/DELETE /api/members/:id`, `GET/POST /api/departments`, `PATCH/DELETE /api/departments/:id` (`app.ts:478-567`).
- Data: `schema.ts:7-68`.
- Events: `department.created`, `department.renamed`, `department.deleted`, plus the member events in section 3.
- Tests: `server/app.test.ts:466` (departments), `app.test.ts:494` (every change is recorded with who did it).

**Not built.**

- Renaming the organization. The name is taken from `MUSTER_ORG_NAME` once, at creation.
- A department tree, department heads, or anything keyed on department (budgets, agent visibility, policy).
- Groups or teams other than departments.
- Deleting a person's data, exporting it, or anonymising it. A removed member's user row, conversations, files, traces and log entries all stay.
- More than one organization per deployment, and membership of more than one.

**Design findings.**

- There is no offboarding. Removal ends access but keeps every file and conversation with no owner who can reach them and no administrator screen to hand them over or delete them. Smallest change: on removal, record the counts kept (files, conversations) in the `member.removed` detail and add an administrator action to delete a removed person's files.
- Cost by department moves when a person changes department, so last month's numbers change. Smallest change: store `department_id` on the trace at run time.

**Locked decisions.** Carries out D-4. No conflict found.

---

## 5. The agent registry

**Who it is for.** Members (who pick and build agents), administrators (who approve and suspend them, `agents.manage`), auditors (`agents.read`), and the run engine, which refuses anything not registered and published.

**The job.** Be the one list of agents: what each is told, what it may use, how risky that makes it, which exact version ran, and whether it may run now.

**Where it starts.** `GET /api/app/agents` (the first call in an organization creates the platform agents). `POST /api/app/agents` when a member builds one. `PATCH /api/agents/:id` when an administrator decides.

**What it does.**

1. Platform agents. Four are defined in code: Assistant, Writer, Researcher, Messenger (`server/runtime/catalog.ts:118-166`). Since 2026-11-14 the Assistant also holds the four tools that read a connected Microsoft 365 account (section 8); that is a change of its tools, so on the first listing after the upgrade its version changes and `agent.changed` and `agents.model_changed` are written, as for any new release. On the first listing they are inserted as `source = 'platform'`, `state = 'published'` (`server/product.ts:88-105`, called at `product.ts:211`). On later listings each is brought in line with its definition; a change is recorded as `agent.changed` by the actor "muster (new release)" (`product.ts:27-53`).
2. Personal agents. A member posts name (1 to 60), description (up to 300), instructions (1 to 8000) and up to 20 tool names from the catalogue (`product.ts:111-116`). The server sorts and de-duplicates tools, computes risk and version, and stores `source = 'user'` with the member as owner (`product.ts:226-264`).
3. Risk. It follows the furthest-reaching tool: only A0 → R1; A1 → R2; A2 or A3 → R3; A4 → R4 (`catalog.ts:53-59`).
4. State. R1 and R2 are `published` at once; R3 and R4 are `pending` until an administrator approves (`product.ts:223-224`).
5. Version. A 64-character SHA-256 over model id, instructions and the sorted tool list (`catalog.ts:68-69`, `packages/protocol/src/agent.ts:26-29`). Every run stores it (`traces.agent_version`).
6. Editing. Only the owner, only `source = 'user'`. A suspended agent cannot be edited: the request is refused 409 `agent_suspended`, so what an administrator later restores is what was suspended (`product.ts:279-281`). One that needs no approval is published. One that needs approval keeps its state only if the version did not change; otherwise it goes back to `pending` (`product.ts:266-312`).
7. Administrator decision. `PATCH /api/agents/:id` with `{state: "published" | "suspended", version}`. Publishing is refused 409 `agent_changed` unless the version sent equals the stored one. Suspending is always allowed and stops the agent's runs in progress (`product.ts:344-387`).
8. Deleting. The owner's delete sets `deleted_at`, sets state `suspended`, archives the agent's conversations and stops its runs. The row stays so runs and approvals still point at it (`product.ts:314-341`).
9. Listing for a member: published agents that are not personal, plus the member's own in any state, not deleted (`product.ts:213-219`). Listing for the console (`GET /api/agents`, `agents.read`): every agent including deleted ones, with instructions, tools, owner, and seven-day run counts (`server/observe.ts:124-144`).

**Rules.**

- A member's agent names are unique per owner, case-insensitive; a clash answers 409 `agent_name_taken` (`product.ts:230-234`). Platform names are unique per organization (`server/schema.ts:278`).
- Unknown tool names are refused: 400 `invalid_agent` (`product.ts:115`).
- A conversation can be opened only with a published, not deleted agent that is either not personal or the member's own (`product.ts:502-508`). A run starts only if the agent is still `published` (`server/runtime/runs.ts:344`).
- A personal agent is visible and usable only by its owner, even after an administrator approves it.
- An administrator cannot act on a `draft` (409 `agent_unavailable`, `product.ts:364`).
- Events: `agent.created`, `agent.changed` (both with `risk` and `tools`), `agent.deleted`, `agent.approved`, `agent.suspended`, `agent.restored`, and `agents.model_changed`.
- A change of model changes every agent's version, because the model is part of the fingerprint. On the first listing of agents after the server came up with another model, each agent's version is worked out again and stored with the new model, and if any changed, one `agents.model_changed` record is written for the organization: actor "muster (configuration)", the model as the target's label, and `{model, agents}` in the detail (`product.ts:55-86`). States do not change: an agent that was approved stays approved, and a suspended one stays suspended with its new version.
- The same record is also written when no model changed but a new release changed a platform agent's instructions or tools: its version is then worked out again in the same loop and counted (`product.ts:30-53`, `product.ts:61-86`).

**States.** `published` (usable), `pending` (waiting for an administrator), `suspended` (stopped; also the state of a deleted agent), `draft` (allowed by the schema; no code path produces it). `canRun: false` in the listing when no model is configured (`product.ts:219`).

**How it is wired.**

- Requests: `GET/POST /api/app/agents`, `PATCH/DELETE /api/app/agents/:id` (`product.ts:210-341`); `PATCH /api/agents/:id` (`product.ts:344-387`); `GET /api/agents` (`observe.ts:124-144`); `GET /api/app/tools` (`product.ts:144-152`).
- Data: `agents` (`schema.ts:113-125`, `schema.ts:194-195`, `schema.ts:271`).
- Tests: `server/product.test.ts:992-1153` (starting agents, low-risk agent usable at once and private, R3 held for approval, back to pending on a risk-raising change, suspended stops for everyone, `product.test.ts:1141` a suspended agent cannot be changed, validation and ownership), `product.test.ts:1171` (deleted agent keeps its runs). No test covers `agents.model_changed`.

**Not built.**

- Organization agents. The schema allows `source = 'org'`; no route creates one, and a personal agent cannot be shared with a department or the organization.
- A history of versions. Only the current definition is kept; an old version's instructions cannot be recovered from its fingerprint. The activity log keeps tools and risk for each change, not instructions.
- A reason on approval or suspension, and telling the builder why.
- Per-agent settings: model, budget, allowed users, allowed domains.
- Skills and plugins (D-2), and so the `skills` part of the fingerprint is always empty (`catalog.ts:69`).
- Drafts.

**Design findings.**

- Answered on 2026-11-14: a change of model is now written to the activity log as one organization-level event, `agents.model_changed`, with the model and the number of agents (`product.ts:77-85`). What remains: approved R3 agents are not sent back for approval, so an administrator who approved "this agent on model X" finds it running on model Y; the record is written at the first listing of agents, not at start; and the same event name is used when a release, not the model, changed the versions.
- The Messenger agent can send data outside (R3) and is published for everyone from the first day with no administrator decision (`catalog.ts:108-115`). Smallest change: seed R3 platform agents as `pending`.
- The risk mapping differs from the design proposal (`docs/design/security-and-governance.md` lines 179-182: R1 = A0/A1, R2 = A2, R3 = A3). In code A1 is already R2 and A2 is R3. The proposal is not locked, but the console and the document disagree. Smallest change: pick one and state it in both.
- An approved personal agent cannot be used by anyone else, so approval buys nothing but the builder's own use. Smallest change: say so on the approval screen until sharing exists.
- The administrator sees current instructions but approves a fingerprint; after approval there is no stored copy of what was approved. Smallest change: store the definition per version in an `agent_versions` table.

**Locked decisions.** Carries out D-5: every agent has a UUID (UUIDv7), a risk level (`risk` is `not null`), and cannot run unless registered and published. Carries out D-4 (agent management, review). Gaps: D-5 asks for a complete record; the definition behind an old version is not kept. D-2's extension gating has nothing to gate yet: there are no plugins or skills.

---

## 6. Runs

**Who it is for.** Anyone who sends a message to an agent; every client that shows a reply being written.

**The job.** Turn one message into one answer: ask the model, let it use its tools through the gateway, stream what happens, and leave a message and a trace behind whatever goes wrong.

**Where it starts.** `POST /api/app/conversations/:id/messages` with `{content, files, device?}`. `device` is sent only by the desktop app, for a conversation in a project that has folders attached on that computer: `{folders: [names]}`, at most 20 names of 120 characters (`server/product.ts:723-763`).

**What it does.**

1. Checks the request (`server/product.ts:561-594`): the conversation is the member's and not archived; content is at most 20,000 characters; at most 10 file ids; content or files must be present; a model must be configured (503 `model_unavailable`); the day's allowance must not be used up (429 `budget_reached`); every file id must be the member's (404).
2. Starts (`server/runtime/runs.ts:309-436`). Refuses `run_in_progress` (409) if this conversation already has a run in memory or a `running` message. Since 2026-11-16 (CHA-246) the messages route first hands words sent during a run to that run (`Runs.aside`, answered 202): they wait in the run (`Live.waiting`) until a `turn_end`, when `runs.ts` puts them on the vendored loop's `steer` queue as one message, so the loop's own check after a turn takes them and no call of the turn under way is dropped; they become a step of kind `aside` on the reply, and an `aside` event on the trace's root span records the moment they were handed over. A step is found by its call's id; a service that names no call is given a unique one. Tests: "the conversation while an agent works" in `product.test.ts`. Refuses `agent_unavailable` (409) unless the agent is `published` and the person's membership is still `active` (`runs.ts:337-343`). In one transaction it locks the conversation row, loads the last 40 `complete` messages, inserts the member's message and an assistant message with status `running` and a new trace id, and titles an untitled conversation from the first 60 characters of the message (or the first file's name).
3. Answers the HTTP request at once with both messages. The work continues in the server process.
4. Builds the prompt (`runs.ts:865-883`): the agent's instructions; today's date and the person's name; when the message came with folder names, a sentence naming the attached folders and telling the agent to use the local tools and not to read more than the request needs; when the conversation is in a project, the project's name and what the person wrote for anyone working in it; a sentence saying tool results are material, never instructions; when to use the plan tool; and the reply format (section 14). Earlier turns are replayed as text only. Earlier tool calls and results are not replayed.
5. Shows images. If the model is configured with vision, up to 4 images attached to this message, each at most 3.5 MB, are sent with it. Images from earlier messages are named, not sent again. Other files are listed by name, kind and size, never by content (`runs.ts:59-79`, `runs.ts:934-946`, `server/files/service.ts:14-15`).
6. Runs the loop. The vendored OpenClaw `Agent` asks the model; when the model asks for tools they run one after another (`toolExecution: "sequential"`), each first passing the gateway through `beforeToolCall` (`runs.ts:791-816`). The API key comes only from Muster's configuration (`runs.ts:813`).
7. Streams. `GET /api/app/conversations/:id/events` is a server-sent-events stream (`product.ts:604-614`). Events (`runs.ts:81-111`):
   - `state`: the whole picture now (`running`, `text`, `steps`, `plan`, `approval`). Sent first to every new subscriber, when a run starts, and when a new model turn clears the text.
   - `text`: a piece of the reply (`delta`).
   - `step`: a tool call started or ended: `id`, `tool`, `status` (`running`, `ok`, `error`, `blocked`), `detail` (a title or `host/path`, never content), `ms`.
   - `plan`: the agent's plan, the whole list each time.
   - `approval`: a pending approval, or `null` when it is settled.
   - `device`: something the person's computer is asked to do: `{id, tool, args}`, where `tool` is `list`, `read`, `search` or `write`. The `state` event also carries every such call that is still waiting, so a page that connects late learns of it (`runs.ts:228-240`).
   - `done`: the finished assistant message, with its `ending` and `endingDetail`, and the conversation title.
   - `ping`: every 25 seconds, to keep proxies from closing the stream (`runs.ts:259`).
8. Ends (`runs.ts:952-1024`). The assistant message is updated with content, status, steps, plan, and why it ended. Status is `stopped` if the run was aborted, `failed` if the model errored or gave nothing, else `complete`. `ending` is `allowance` when the day's allowance aborted the run, `error` when it failed, `length` when it completed but the model stopped at its output limit, and null otherwise; `ending_detail` is set only for `error` and is one of five plain sentences chosen by `causeFor` (model service busy or over its limit; refused the request; answered with an error and its status; could not be reached; something went wrong), so that what the endpoint itself said, which can name internal addresses, stays in the trace (`runs.ts:143-154`, `runs.ts:956-968`). A step still `running` becomes `error`. The trace is saved a last time and `done` is sent.
8a. The device channel (`runs.ts:899-943`). A run whose message came with folder names is given a way to ask the person's computer. For each call the run makes an id, keeps `{id, tool, args, session}` in memory with the session the message came from, sends the `device` event, and waits. The desktop app's page that has the conversation open does the work through the desktop app and answers with `POST /api/app/conversations/:id/device/:call` `{ok, text}` (`product.ts:765-782`). The answer is taken only from the member whose conversation it is and only from the session the message was sent from; anyone else gets 404 (`runs.ts:320-332`). The wait ends in four ways: an answer with `ok: true`, whose text reaches the model cut to 60,000 characters with a note that there is more (`runs.ts:165`, `:929-938`); an answer with `ok: false`, whose text (cut to 2,000 characters) becomes the tool's error; 60 seconds without an answer, "The person's computer did not answer. The desktop app must be open on this conversation." (`runs.ts:163`); or Stop. The server never opens a file on anyone's computer and never learns where a folder is: it relays what was asked and what was said. Both are in memory only while they wait, and afterwards in the trace as the tool span's input and output, each cut to 4,000 characters.
9. Stops on request. `POST /api/app/conversations/:id/stop` aborts the run and waits for it to finish (`product.ts:596-601`, `runs.ts:288-293`). Archiving a conversation, clearing history, suspending or deleting the agent stop its runs too. So does suspending or removing the person: the member routes tell the run engine once the change is committed, and it stops every run of that person (`server/app.ts:84-93`, `product.ts:128`, `runs.ts:224-230`).
10. Recovers after a restart. Runs live in memory. On start, `recover()` marks every `running` message `failed`, every `pending` approval `expired`, and every `running` or `awaiting_approval` trace `error` (`runs.ts:188-196`, called at `server/index.ts:41`).
11. Shuts down cleanly. On SIGINT or SIGTERM every run is stopped, which records its message and trace, then the database is closed (`index.ts:77-85`).

**Rules.**

- One run per conversation at a time. A person may have several conversations running at once.
- One server per database. With PostgreSQL the process takes session advisory lock `741000165` before anything else; a second server prints "another Muster server is already running on this database" and exits; losing the lock's connection also exits (`index.ts:16-34`).
- History given to the model: the last 40 complete messages (`runs.ts:22`). Failed and stopped assistant messages are left out.
- One model reply is at most 4,096 output tokens. One model request may take up to 15 minutes, but not 90 seconds of silence (`server/runtime/models.ts`; section 9).
- A failure while ending a run never takes the process down; the message is marked `failed` if it can be (`runs.ts:408-413`, `runs.ts:989-998`).
- Muster sets no limit on how many model turns or tool calls one run may take; the only brakes are the person's Stop, the daily allowance, and the model's own behaviour.
- A run that works in folders on a person's computer still runs on the server: the model call, the loop, the gateway and the record are the server's. Only the four folder actions are done on the computer. The trace's venue stays `cloud` (`runs.ts:555`).
- Calls waiting on a computer are lost with the process, like the run itself.

**States.** No model: 503. Busy: 409. Agent not published, or the person no longer active: 409. Over allowance: 429 before the run, or a `stopped` message with `ending = 'allowance'` mid-run. Failed: a `failed` message with `ending = 'error'` and a cause. Cut off at the output limit: a `complete` message with `ending = 'length'`. Waiting for approval: the `approval` event is set and the trace is `awaiting_approval`. After a restart: the interrupted message shows as `failed`.

**How it is wired.**

- Requests: `POST …/messages`, `POST …/stop`, `GET …/events` (`product.ts:561-614`); `GET /api/app/conversations/:id` returns messages with `steps`, `plan`, `attachments`, `ending`, `endingDetail` and pending approvals (`product.ts:517-534`).
- Data: `conversations` (with `allowed_hosts`, `schema.ts:309`), `messages` (`schema.ts:196-219`, `schema.ts:264-265`, `schema.ts:298`; `ending`, `ending_detail`, `schema.ts:303-304`), `traces`, `spans`, `approvals`. Memory only: `live`, `listeners`, `waiting` maps (`runs.ts:171-173`).
- Code taken from OpenClaw: `vendor/openclaw/agent-core`, `llm-core`, `normalization-core`, tag `v2026.9.8`; what was taken, left out and changed is in `vendor/openclaw/UPSTREAM.md`.
- Tests: `server/product.test.ts:207-323` (answers and leaves a trace; what the model is told; streaming; second message refused; failed reply with its ending and cause; no model), `product.test.ts:680-713` (images), `product.test.ts:729-787` (plan and steps), `product.test.ts:926` (stop while waiting), `product.test.ts:949` (a suspended person's run ends and nothing is sent), `product.test.ts:1354` (the allowance ending), `product.test.ts:1222` (nobody reaches another's stream). No test covers `recover()`, the one-server lock, the `length` ending, or a run refused because the person is no longer active.

**Not built.**

- Resuming a run after a restart, and more than one server process (so no rolling deploys without interrupting runs).
- Scheduled, event-triggered or background runs. A run starts only from a person's message.
- Sub-agents, and one agent calling another.
- Keeping context across long conversations: no summarising; turns beyond the last 40 are dropped, and there is no check that 40 turns fit the model's context.
- Carrying tool results from one turn to the next.
- A limit on turns, tool calls or wall time per run.
- A queue or a cap on concurrent runs per person or per server.
- Replaying missed events: a client that reconnects gets one `state` snapshot, not the events it missed.
- A run on a device: nothing of the loop runs on the person's computer, nothing works without the server, and a run does not continue when the desktop app is closed (its folder calls then time out after 60 seconds each).
- A device channel for iOS, or for a browser.

**Design findings.**

- A deploy or crash fails every reply in progress, and the person must ask again. Smallest change: the web app offers "Try again" on a `failed` message whose trace output is empty (the mark of a restart).
- A run can loop for as long as the model keeps calling tools, on an organization with no daily allowance set (the default). Smallest change: a fixed ceiling on model turns per run (for example 40), recorded as a stop reason.
- An agent forgets what it read one turn ago: "summarise that page" works, "now compare it with the other one" re-fetches or guesses. Smallest change: replay the previous turn's tool results, cut to a budget.
- Single process is a hard availability limit and is enforced, not just documented. An enterprise will ask for the plan. Smallest change: state it on the system page (`/api/system`) and in the runbook with the restart behaviour.

**Locked decisions.** Carries out D-2: the loop is OpenClaw's, taken piece by piece, with the upstream version recorded; OpenClaw's transports and tools were not taken. Carries out D-5 (every run is tied to an agent UUID and version). Gap against the system overview ("runtime → tool gateway → sandbox"): there is no sandbox; tools run inside the server process. D-6, first half: since 2026-11-14 a run can read and write in folders on the person's computer through the device channel, without the files being uploaded. Gap against D-6 that stays: every run is `venue = 'cloud'`; nothing runs on a device, and what the computer answers passes through the server to the model and is kept in part in the trace.

---

## 7. The gateway

**Who it is for.** Everyone whose agent can act: it stands between the model and every tool. Administrators and auditors read what it decided.

**The job.** Before any tool call happens, decide from its action level whether to allow it, ask the person, or refuse, and leave a record of the decision.

**Where it starts.** The loop's `beforeToolCall` hook, for every tool call the model makes (`server/runtime/runs.ts:815`).

**What it does.**

1. Reads the mode (`runs.ts:656-662`). The conversation's own mode (`ask`, `auto` or `full`; `conversations.mode`) and the organization's ceiling (`org_settings.max_mode`, `auto` when the organization has no row) are read from the database at every call, and the more careful of the two is the mode the call is judged under. So a change by the person or by an administrator applies to the next call of a run already under way.
1a. Finds the level (`runs.ts:663-682`). A tool's level comes from the catalogue, for a folder tool from the device catalogue; `plan.set` is A0; a tool neither knows is A3 (`server/runtime/tools.ts:712-719`). Two calls are raised to A3:
   - `web.fetch` to an address the person did not write, unless the mode is `full`, or it is an `https` address on a site the person allowed for this conversation, or a search gave that exact address in this run (section 23);
   - `local.write` (A1 in the device catalogue) when the mode is `ask`.
2. Applies the rule for the level (`runs.ts:636-648`):

   | Level | Effect | Policy id written |
   |---|---|---|
   | A0, A1, A2 | allow | `default-allow` |
   | A3 | ask the person who started the run | `confirm-external-actions`; `confirm-unlisted-address` for a raised `web.fetch`; `confirm-local-write` for a raised `local.write` |
   | A4 | deny, always | `no-policy-for-a4` |

3. Records the decision as a `policy` span named `policy.check` under the tool's span, with `actionLevel`, `effect` and `policyId` (`runs.ts:618-634`).
4. When asking (`runs.ts:648-752`): builds a summary from the call itself, never from the model's words: the whole destination address with its query, the method, the content type, the size in bytes and everything that would be sent (`tools.ts:657-689`); for `local.write`, the path, the method `WRITE`, and the content to be written, up to 100,000 characters (`tools.ts:659-669`). Inserts an `approvals` row, sends the `approval` event, saves the trace as `awaiting_approval`, and waits.
5. The wait ends in one of four ways: `approved`, `rejected`, `expired` after 15 minutes (`runs.ts:21`, `runs.ts:687`), or `stopped` when the person stops the run. Expired and stopped both store `expired` on the approval. If the person's decision was committed just as the timer fired, the stored decision wins (`runs.ts:694-717`).
6. Records the outcome as an `approval` span named `approval.user` with the outcome and the approver's address (`runs.ts:720-740`).
7. Approved: the tool runs. Anything else: the call is blocked and the model is told "The person chose not to allow this. Do not try again; tell them it was not done." or "The person did not answer in time, so it was not done." A denied A4 call tells the model "This action is not allowed by the organization's policy." The trace ends as `blocked`.

**Rules.**

- Only the person who started the run can decide: `POST /api/app/approvals/:id` with `approve` or `reject`, and optionally `remember`, matches on their user id (`server/product.ts:720-779`). A second decision answers 409 `already_decided`. Approving for an agent that was suspended or deleted meanwhile answers 409 `agent_unavailable` (`product.ts:750`). The waiting run continues only after the decision is committed (`product.ts:776-777`).
- Until 2026-11-21 (the route and its page were removed that day, see [admin-console: Approvals](admin-console.md#approvals)): Administrators and auditors can watch all approvals (`GET /api/approvals`, `traces.read`) but cannot decide them (`product.ts:781-793`).
- Addresses the person wrote: every `http(s)://` address in the person's current message and in their earlier messages within the 40-message history. Any address that also appears in an assistant message of that history is removed, so an address the agent wrote first is never the person's, even if the person sends it back (`runs.ts:579-584`, `tools.ts:414-423`). Comparison is exact on the normalised address, path and query included (`tools.ts:425-431`): writing `https://example.com` does not cover `https://example.com/pricing`.
- A site allowed for a conversation. Approving a `web.fetch` with `remember: true` adds the address's host, lower case, to `conversations.allowed_hosts` (at most 50 hosts a conversation; `product.ts:755-765`). From then on the gateway does not raise a `web.fetch` in that conversation whose address is `https` and whose host is on the list: it passes as A0 with policy `default-allow` and makes no approval (`runs.ts:599-616`). Three limits hold it in:
  - `remember` on anything but an approved `web.fetch` is ignored; `web.send` always asks.
  - The host is matched exactly, port included; a subdomain or the parent domain is another site. An `http` address of an allowed host still asks.
  - A page read only because its site was allowed must stay on that site: the request is made with `sameSite`, and a redirect to another origin is not followed; the tool fails with "The page forwards to another site, which was not allowed." (`runs.ts:587`, `runs.ts:613`, `runs.ts:804`, `server/runtime/tools.ts:118-123`, `server/runtime/net.ts:170-174`). A read the person allowed as itself, or wrote, follows redirects as before.
- Nothing takes a host off the list, and no administrator setting forbids or narrows the choice.
- Modes (`server/runtime/catalog.ts:45-59`). `ask`: ask before writing a file on the person's computer and before reading an address they did not write. `auto`: write in attached folders without asking; still ask about an unwritten address. `full`: also read any address without asking. `web.send` asks in every mode. What "full" sets aside is the rule in the paragraph above this list of limits: an address can carry out what the agent has read, which is why an unwritten address is raised at all. In `full` an agent that has read a document, a folder file or a mail can put it in an address and open it with nobody asked, and only the trace shows it. The page says so to the person and to the administrator; the code does nothing else about it.
  - Since 2026-11-21 there is no ceiling: every mode is the person's to choose, and the two lines below about it are how it was (see [workspace: modes](workspace.md)).
  - A person sets a conversation's mode with `PUT /api/app/conversations/:id/mode`; a mode above the ceiling is refused, 403 `mode_not_allowed` (`server/product.ts:701-712`). A new conversation asked to start above the ceiling starts at the ceiling (`product.ts:640-650`).
  - An administrator sets the ceiling with `PUT /api/settings/policy {maxMode}` (`settings.manage`), recorded as `policy.changed` with the value before and after (`product.ts:177-203`). Any member reads it at `GET /api/app/policy`.
  - The ceiling is applied when a call is judged, not stored into conversations: lowering it brings every conversation down at once; raising it again gives a conversation back the mode it had stored.
  - In `full`, a `web.fetch` to an unwritten address is an ordinary A0 call with policy `default-allow`, indistinguishable in the trace from a read of an address the person wrote. The network safety rules below still apply.
- Network safety applies to every `web.fetch` and `web.send`, after the gateway (`server/runtime/net.ts`):
  - Only `http` and `https`; no user name or password in the address; ports 80, 443, 8080, 8443 or none (`net.ts:15`, `net.ts:79-102`).
  - No `localhost`, `*.localhost`, `*.internal`, `*.local`, and no literal private address.
  - Every address the name resolves to must be public, checked at connection time so a name that changes its answer gains nothing. Refused ranges: 0/8, 10/8, 127/8, 100.64/10, 169.254/16, 172.16/12, 192.168/16, 192.0.0/24, 198.18/15, 224/4 and above; IPv6 loopback, unspecified, unique-local, link-local, multicast, IPv4-mapped private, IPv4-compatible, 6to4 and NAT64 (`net.ts:19-76`).
  - 15 seconds per request, at most 3 redirects, each hop checked again. A POST is never re-sent to a redirect target. At most 1,000,000 bytes of a response are read (`net.ts:12-14`, `net.ts:129-203`).
- Approval decisions are written to the activity log as `approval.approved` and `approval.rejected`. An approval that allowed a site carries `siteAllowedForConversation` with the host in its detail. Expiry is not written.
- `/api/system` reports the five level rules and the ceiling (`maxMode`) to administrators (`product.ts:246-254`). It does not report what a mode changes.

**States.** Waiting (approval pending, trace `awaiting_approval`). Expired. After a restart, pending approvals become `expired` (`runs.ts:190-192`).

**How it is wired.**

- Code: `gate` in `server/runtime/runs.ts:649-821`; levels in `server/runtime/catalog.ts:11-42` and `:68-73`; modes in `catalog.ts:45-59`; summary and address rules in `server/runtime/tools.ts:657-719`; network guard in `server/runtime/net.ts`.
- Requests: `GET /api/app/approvals`, `POST /api/app/approvals/:id` `{decision, remember?}` (`product.ts:895-973`); `GET /api/approvals` (`product.ts:975`); `GET /api/app/policy` (`product.ts:174`); `PUT /api/settings/policy` (`product.ts:177`); `PUT /api/app/conversations/:id/mode` (`product.ts:701`).
- Data: `approvals` (`schema.ts:221-237`); `conversations.allowed_hosts` (`schema.ts:309`); `conversations.mode` (`schema.ts:360`); `org_settings.max_mode` (`schema.ts:361-364`); `spans` of kind `policy` and `approval`.
- Events: live `approval`; activity log `approval.approved`, `approval.rejected`, `policy.changed`.
- Tests added on `epic/cha-167-local-work`: `server/product.test.ts:1307` "asks before writing on their computer unless they said it need not"; `:1338` "reads any public page without asking only in the freest mode, and only where the organization allows it".
- Tests: `server/product.test.ts:334` (each call recorded with its policy decision), `product.test.ts:410` (no private network), `product.test.ts:451-503` (unlisted address asks; listed does not; an address the agent wrote first is not the person's), `product.test.ts:528` (agent taken away while waiting), `product.test.ts:809-926` (waits, shows exactly what would be sent, sends only after approval; rejection; only the starter decides; stop abandons), `product.test.ts:1403` ("asks once for a site the person allowed for the conversation, and again for another site", which also checks that the second read is made with `sameSite`), `product.test.ts:1522-1550` (public and private addresses, address check).

**Not built.**

- Administrator policy beyond one value. The ceiling on modes is the only thing an administrator can set. There is still no allowlist or blocklist of domains, no per-agent or per-department rule, no way to make A2 ask, no way to allow A4, no way to make reading a connected mailbox ask. The level rules are constants in code.
- A record of a person's change of mode: it is not written anywhere. (Answered on 2026-11-16, CHA-236: each `policy.check` span now carries `mode`, the mode in force when that call was judged, after the organization's ceiling was applied. Test: "says on each policy decision which mode the call was judged under".)
- Approval by someone other than the requester (a manager, a second person), and delegation.
- Allowing a site beyond one conversation, allowing a domain with its subdomains, allowing a site for sending, and taking a site back.
- Data classification and content inspection of what is sent (DLP). The person sees the body; nothing else checks it.
- A sandbox for tools.
- An audit record in the shared format of `packages/protocol` (see section 12 and 18).
- A gateway check on the model call itself: the prompt, file text and images go to the model endpoint without a policy decision or a record of what class of data left.

**Design findings.**

- The only control on sending data out is the same person who asked, clicking Allow, on an agent that may have been steered by a web page. There is no second line. Smallest change: an organization setting "domains agents may send to"; anything else is refused before the person is asked.
- The model endpoint is the largest outbound flow and passes no gateway. With `MUSTER_MODEL_BASE_URL` pointing at a third party, every document an agent reads goes there. Smallest change: show the model host on the system page (already there) and in the member-facing agent screen, and record bytes sent per `llm` span.
- A2 exists in the scale but no tool uses it and it is allowed silently, where the design proposal says "allow and record, the organization may switch to approval". Smallest change: none until a tool is A2; then add the switch.
- Fifteen minutes is fixed and silent. A person at lunch returns to "did not answer in time". Smallest change: make `APPROVAL_MINUTES` configurable and have clients notify.
- `http` is allowed for fetch and send, so approved content can travel in clear text. Smallest change: `web.send` over `https` only.
- `full` sets aside, for every site, the reason reads are raised at all. It is off until an administrator allows it, and then it is on for every agent a person talks to, the Assistant with its Microsoft tools included. The page warns; nothing checks. Smallest change: refuse `full` for a call when the run has already read from a document, a folder or a connection (the run knows which tools it has called), and ask instead.
- The mode is read from the database on every tool call (`runs.ts:656-662`): one more query on the allow path, which D-3 says must add no I/O. Smallest change: read it once per run and again when the mode or the ceiling changes.
- Allowing a site sets aside, for that site, the reason reads are raised at all: an address can carry out what the agent has read. After one click the agent may open any `https` address on the site, query included, that it writes itself, for the rest of the conversation, and only the trace shows which. The card says so; an organization cannot forbid it or limit it to sites it trusts. Smallest change: a setting that turns the choice off, or a list of sites for which it may be offered.

**Locked decisions.** Carries out D-3 (security first; the allow path adds a function call and no I/O, the ask path waits only for A3) and the overview's "every tool call … passes one gateway that checks policy". Gaps: the overview also says the gateway "writes an audit record"; it writes spans in a trace, which are rewritten on every save and are not the audit format (section 12). "Policy" is three constants and, since 2026-11-14, one setting (the ceiling on modes) that D-4's control plane can change. D-3's "must not cost performance" has no measurement.

---

## 8. Tools

**Who it is for.** Builders choosing what an agent may use; the gateway, which reads each tool's level; the model, which reads each tool's description.

**The job.** Give agents a small, known set of things they can do, each with a declared reach.

**Where it starts.** A run builds the agent's tools from the names stored on the agent, and adds the folder tools when the person's computer is there (`server/runtime/tools.ts:537-650`). `GET /api/app/tools` lists name, level and summary for builders (`server/product.ts:154-162`); it lists the twelve tools of the catalogue and not the four folder tools, which nobody ticks.

**What it does.** The catalogue is `server/runtime/catalog.ts:11-42`; the device catalogue `catalog.ts:61-81`; behaviour is `server/runtime/tools.ts:119-535` and, for the folder tools, `tools.ts:574-623` on the server and `apps/desktop/src/local.ts` on the computer.

| Tool | Level | What it does | What it returns | Limits |
|---|---|---|---|---|
| `docs.list` | A0 | Lists the person's documents, newest first | `- title (N characters)` lines, or "The person has no documents." | 200 documents |
| `docs.read` | A0 | Reads one document by exact title | The content; a note when cut | First 60,000 characters |
| `docs.write` | A1 | Creates a document or replaces the one with that title; on a replacement it keeps what the document held and when that was last changed (`previous_content`, `previous_at`) | "Created the document …", or "Replaced the document … The person can bring back what it held before." | Title 1 to 120; content up to 200,000 characters; one earlier version kept |
| `files.list` | A0 | Lists the person's files | `- name (kind, N bytes)` lines | 500 files |
| `files.read` | A0 | Reads the text of one file by exact name (newest of that name) | Text; sheets as `--- Sheet` blocks, slides as `--- Slide` blocks, PDF as `--- Page` blocks | 60,000 characters; 20 sheets, 500 rows, 60 columns; 300 PDF pages |
| `files.create` | A1 | Makes a `.docx`, `.xlsx`, `.pptx`, `.html`, `.md`, `.txt` or `.csv` from content the model supplies; replaces an earlier agent-made file of the same name | "Made the file … (N bytes)" | Workbook 1 to 20 sheets, 5,000 rows a sheet (`server/files/make.ts:21-22`); upload size limit and the person's quota apply |
| `web.search` | A0 | Asks the search service the operator chose (section 23); present only where one is set up | Up to 8 results: title, address, extract. Each address may then be read without asking | Query 2 to 200 characters; 15 seconds |
| `web.fetch` | A0, raised to A3 for an address the person did not write, unless its site was allowed for the conversation or a search gave it | GETs a public page; a page read only because its site was allowed does not follow a redirect to another site | "Content of <final address>:" then the text; HTML is reduced to text without scripts and styles | 40,000 characters shown of at most 1,000,000 bytes read; status 400 and above is an error |
| `web.send` | A3 | POSTs a body to a public address | "Sent. The address answered with status N." | 100,000 bytes; content type `application/json` (default) or `text/plain`; no custom headers; a redirect sends nothing |
| `plan.set` | A0, always present | Shows the person the agent's plan | "The person now sees this plan." | 1 to 12 steps; titles cut to 120 characters; statuses `pending`, `in_progress`, `done` |
| `m365.mail` | A0 | Searches the person's Outlook mail (`query`), lists the latest (nothing), or reads one message (`id`) | A list: date, sender, subject, the start of the body, `id`; or one message with sender, recipients, date and body as text | 15 messages a list; 40,000 characters of a body |
| `m365.calendar` | A0 | Reads the person's calendar between two days (`from`, `to` as `YYYY-MM-DD`; by default today and the six days after, as UTC days) | One line an entry: time, title, place, organizer, those invited | 60 entries; 12 attendees an entry |
| `m365.files` | A0 | Searches the person's OneDrive (`query`), lists the files used lately (nothing), or reads one file's text (`id`) | A list: name, size, last change, `id`; or "Content of <name>:" and the text | 15 files a list; a file of at most 20 MB, of a kind the server can read (section 13) |
| `m365.chats` | A0 | Lists the person's recent Teams chats, or the latest messages of one (`id`) | A list: topic or kind, the last message's start, `id`; or one line a message: time, sender, text | 20 chats; 30 messages, 1,500 characters each |

The four `m365.*` tools read the Microsoft 365 account the person running the agent has connected (section 22). Without a connection they fail with "Microsoft 365 is not connected for this person. Tell them to connect it in Settings, under Connections, and then ask again." They only read: every request they make to Microsoft Graph is a GET (`server/connections.ts:287-333`). An `id` must be one from an earlier result: it must match a pattern of letters, digits and a few signs, so "." and ".." and a slash cannot turn it into another address (`graphId`, `tools.ts:49-53`).

The device tools. They are not in the catalogue above and no builder ticks them. A run gets them only when the message came from the desktop app with folder names, and only as far as the agent's own tools reach. "Needs" is that reach: an agent gets a device tool when it holds at least one of the tools named (`deviceToolsFor`, `catalog.ts:78-81`).

| Device tool | Level | Needs (any one of) | What it does on the person's computer | Limits (enforced on the computer) |
|---|---|---|---|---|
| `local.list` | A0 | `files.list`, `files.read` | Lists a folder, or with no path the attached folders | 500 entries |
| `local.read` | A0 | `files.read` | Reads a text file | The first 256 KB; not a file that is not text |
| `local.search` | A0 | `files.read` | Finds files whose name or text contains some words | 60 matches; 4,000 files looked at; files over 512 KB not looked into |
| `local.write` | A1; asks first (as A3) when the conversation's mode is `ask` | `files.create`, `docs.write` | Makes a text file or replaces the whole content of one | 1 MB; never through a link; not in `.git`, `node_modules`, `.vscode`, `.idea`, `.github`, `.husky` |

On the server a device tool does nothing but hand the call to the run's device channel (section 6, step 8a) and return what comes back (`onDevice`, `tools.ts:605-623`). The rules that keep a call inside the attached folders (no `..`, no link that leads out, no file that looks like keys or passwords) are in the desktop app (`apps/desktop/src/local.ts:46-58`, `:92-126`); the server does not repeat them. See [clients-and-operations: Desktop app](clients-and-operations.md#desktop-app).

**Rules.**

- Every tool is bound to the organization and user of the run; a tool cannot name another person (`tools.ts:17-29`, `runs.ts:796-809`).
- A name the catalogue does not know is dropped when tools are built (`tools.ts:359`), and would be treated as A3 if called (`tools.ts:434-435`).
- A tool that fails returns its error text to the model, which may recover; the step shows as `error` (`tools.ts:367-374`).
- Network tools, the four `m365.*` tools and the four device tools mark their results as coming from the network (`resultContentSource: "network"`, `tools.ts:612`, `:633`), and the system prompt tells the model that tool results are never instructions (`runs.ts:879`).
- Of the starting agents only the Assistant holds the `m365.*` tools (`catalog.ts:118-166`). Any member may tick them on an agent of their own; all four are A0, so such an agent is R1 and usable at once. Whoever talks to an agent reads their own account through it, never the builder's.
- Tool names contain a dot; on the wire to the model it becomes two underscores and is mapped back (`server/runtime/models.ts:383-385`).
- `files.create` writes `file.created` to the activity log (through `Files.add`). `docs.write` writes nothing to the activity log; it appears only as a span.
- What `docs.write` replaced can be brought back by the person: `POST /api/app/documents/:id/restore` swaps `content` and `previous_content`, so bringing back can itself be undone (`server/product.ts:447-459`). The person's own save through `PUT /api/app/documents/:id` clears the earlier version (`product.ts:439`). Neither is written to the activity log.

**States.** Not applicable beyond errors returned to the model, for example "There is no document titled …", "That is too much to send at once (100,000 bytes at most)."

**How it is wired.**

- Data: `documents` (`schema.ts:238-247`; `previous_content`, `previous_at`, `schema.ts:306-307`), `files`, the file store.
- Tests added on `epic/cha-167-local-work`: `server/product.test.ts:1003` "folders on the person's computer" (the call is handed to the computer and its answer to the agent; an agent without a writing tool gets no `local.write`; nothing is offered without folder names); `:1113` "a person's Microsoft 365" (`m365.mail` only). No test calls `m365.calendar`, `m365.files` or `m365.chats`. `apps/desktop/src/local.test.ts` holds the rules of the four folder actions.
- Tests: `server/product.test.ts:334-431` (documents, readable errors, web page as text, private network, one person's documents kept from another's runs), `product.test.ts:570-658` (files in a conversation), `product.test.ts:787` (bad plan), `product.test.ts:1379` (what a document held before an agent replaced it is kept and given back), `server/files/office.test.ts:14-147` (making files and reading them back).

**Not built.**

- Connectors beyond one, and writing through any. Reading a person's Microsoft 365 (mail, calendar, OneDrive, Teams chats) is the only connector. Nothing sends mail, books or changes a meeting, uploads or edits a file, or posts a message. No Feishu, WeCom, DingTalk, Slack, Google Workspace, CRM, ticketing or database.
- Reading Word, Excel, PowerPoint or PDF files in a folder on the person's computer: `local.read` takes text files only, though the server can read those kinds when they are uploaded or come from OneDrive.
- A choice, per agent, of which connected account or which folders it may use, and a choice per conversation: an agent that holds the tool may use it whenever the person is connected.
- Paging in any `m365.*` list: the agent cannot ask for the next 15.
- Search (web or internal knowledge), code execution, browser automation, image generation.
- Tools added by an administrator, by a plugin, or by MCP. The catalogue is a constant.
- Credentials for outside services: `web.send` cannot carry a header, so it cannot call an API that needs a token.
- Editing an existing Office file in place; reading `.doc`, `.xls`, `.ppt`; reading text in images (OCR).

**Design findings.**

- Answered on 2026-11-14, in part: an agent can read the person's Microsoft 365 mail, calendar, OneDrive files and Teams chats once they connect it, and can read and write text files in folders on their computer from the desktop app. What remains: the connector is read-only, so an agent can say what a mail asks and cannot answer it; and it is Microsoft only.
- Reading a connected mailbox is A0, the same level as listing the person's own documents: the gateway lets it through without a word, in every mode. The level scale measures how far an effect reaches, and a read reaches nowhere; but it is the first tool that brings other people's words (a sender's mail) into a run that may also hold `web.fetch`. Smallest change: have the first `m365.*` call of a conversation ask once.
- `m365.files` says it reads "OneDrive and the SharePoint sites they can see" (`tools.ts:267-270`), and every request it makes is to the person's own drive (`/me/drive/…`, `tools.ts:279-303`). Not verified: whether a file that lives in a SharePoint site can be found or read this way. Smallest change: test it against Microsoft; if not, use the item's own drive id from the search result.
- `local.read` refuses Office and PDF files, which is most of what a work folder holds, while `files.read` and `m365.files` read them. Smallest change: let the device channel carry bytes for one read, to the server's reader, without storing them.
- The folder rules are enforced by the desktop app alone. A server that is compromised, or a page that is, can ask the desktop app for any file inside an attached folder. Smallest change: none on the server; the desktop app is the right place, and it should also ask before a write (see clients-and-operations).
- Answered on 2026-11-14: `docs.write` now keeps what a document held before as one earlier version, and the person can bring it back (`tools.ts:98-107`, `product.ts:448`). What remains: it is still A1 with no question and no activity-log entry; one version only, so a second replacement loses the person's own text; `files.create` still replaces an agent-made file of the same name with nothing kept.
- Answered on 2026-11-15: `web.fetch` gives the model 12,000 characters at a time and takes an `offset` to read on. A research run that read eleven whole pages took ten minutes, most of it the model re-reading them at every step.

**Locked decisions.** Carries out D-2 (nothing arrives by default from OpenClaw; none of OpenClaw's tools were taken) and D-3 (each tool declares a level; undeclared is A3). Gap: D-2's two gates (administrator-approved plugins, scanned skills with allow and block lists) do not exist because there is no extension mechanism. The Microsoft connector does not change that: it is code in the server (`server/connections.ts`, four entries in the catalogue), switched on by the operator's registration and key, not an extension an administrator installs or approves.

---

## 9. Models

**Who it is for.** The run engine; operators who choose and pay for the model.

**The job.** Call one configured model endpoint, in the format it speaks, and report text, tool calls, token counts and cost back to the loop.

**Where it starts.** Each model turn of a run: the loop calls the `StreamFn` made by `createStreamFn` (`server/runtime/models.ts:40-146`).

**What it does.**

1. Configuration (`server/config.ts:113-139`). One model per deployment. It is configured when `MUSTER_MODEL_ID` or `MUSTER_MODEL_API_KEY` is set; then `MUSTER_MODEL_API` must be `anthropic` or `openai` and both id and key are required. The base URL defaults to `https://api.anthropic.com` or `https://api.openai.com/v1`. With no model, agents cannot run and the server says so at start.
2. Describes the model to the loop: context window 128,000 (a constant, not the real model's), maximum output 4,096 tokens, input `text` or `text` and `image`, provider name `muster` (`models.ts:25-38`).
3. OpenAI format (`models.ts:255-381`): `POST <base>/chat/completions` with `Authorization: Bearer <key>`, `stream: true`, `stream_options.include_usage`, `max_tokens: 4096`, the system prompt as a `system` message, tool results as `tool` messages, tools as functions. Images go as `image_url` data addresses.
4. Anthropic format (`models.ts:403-513`): `POST <base>/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`, `max_tokens: 4096`, `system` at the top level, tool results as `tool_result` blocks inside a user turn, roles alternating. Images go as base64 `image` blocks before the text.
5. Reads the stream as server-sent events and turns it into text and tool-call events. Tool arguments that are not valid JSON become an empty object, which validation then rejects (`models.ts:166-176`).
6. Detects a cut-off: a stream that ends without `[DONE]`/a finish reason (OpenAI) or `message_stop` (Anthropic) is an error, "The model's reply was cut off before it finished." (`models.ts:377`, `models.ts:511`). A reply stopped by the token limit is marked `length`. The reader also tells whoever asked how much the model has thought (`Hearing.onThinking`, passed with the call's options by `runs.ts`), which becomes the live `thinking` event; thinking is not part of the reply, so no event of the reply carries it (CHA-246). A model that thinks before it answers (its thinking arrives as `reasoning_content` and counts against the limit) can spend the whole limit thinking and say nothing; that is not left to end the reply (CHA-234). On an OpenAI-style endpoint, a call that has thought away half of what it may write with no word and no tool call is given up there, and one that ends on `length` with nothing said is treated the same: it is asked again once with `reasoning_effort: "none"`. If that says nothing either, or the service refuses the setting, the reply is marked `length` as before. What the first try spent is added to the call's tokens and cost; thinking that was cut short is counted from the characters that arrived, three to a token. Told to think "low", the model this was found with (`deepseek-flash`, 2026-11-16) thought just as long, so that step is not tried. A tool call made by a turn that did not think is replayed with `reasoning_content: ""`: DeepSeek keeps a model's thinking itself and answers 400 ("The `reasoning_content` in the thinking mode must be passed back") when such a turn reaches a call that does think. Which turns those are is kept in memory (`unthought`); if the refusal comes anyway, after a restart, the call is asked again with empty thinking on every tool turn. `MUSTER_MODEL_REASONING_EFFORT` (none, minimal, low, medium, high, xhigh, max) sets how hard the model thinks on every call and is not sent when not set. A second model takes the setting only when it is on the same service and protocol as the first; on another service it is not sent, since that service may not know it. A deployment that already sets "none" is not asked again. Only a 400 that comes before anything was said counts as the service refusing the setting; any other failure of the second try (a 5xx, a reply that breaks off, the call out of time) fails the reply as it would have, and can go to the second model. A try given up before the service reported its prompt is counted with the next try's prompt. After the refusal for want of `reasoning_content` the turns are remembered, so later calls are asked once. The half-allowance cut is counted in characters at three to a token: thinking in Chinese runs nearer one and a half, so there the cut comes late, and the tokens counted for it come out low. Not built: a reply cut off in the middle of what it was writing still waits for Continue. Tests: "a model that thinks before it answers" in `models.test.ts`.
7. Never throws: a failure becomes an `error` event with stop reason `error`, or `aborted` when the person stopped (`models.ts:130-142`).

**Rules.**

- Retries: a request that fails before any answer (no connection) is tried up to 3 times in a row with no delay. A 502, 503 or 504, which is a gateway in front of the model giving up before the model said anything, is tried again the same way, after 1.5 and then 3 seconds, a wait that Stop ends at once (`models.ts:298`). Any other HTTP error status (400, 401, 429, 500 and so on) is not retried; it fails the run with "The model endpoint answered <status>: <first 300 characters>". When a second model is set (`MUSTER_MODEL_FALLBACK_ID`), a call the first model's service failed on after those tries (unreachable, silent before its first word, cut off before a word, 408, 429 or 5xx) is put to the second; a request the first model refused (400, 401, 403, 404, 413, 422: too long, not allowed, a wrong key) is not, and fails as before. A silent first model is waited for twice before the second is asked (two first-word waits, 6 minutes by default), and each later call of the run asks the first model first again. A second model that cannot see gets a line of text in place of each image, and the reply and its cost are recorded under the second model's name (`createModelFn` in `models.ts`); System shows which it is. A failure after the model began to answer is never retried here: the reply ends as failed and can be gone on with (see "Continue" in workspace.md).
- Timeout: silence is what is timed. Once the model has begun, 90 seconds with nothing arriving ends the call. Before its first word it is given 180 seconds, and if it had not said a word it is asked once more, since nothing was said or done. Both waits are the deployment's to set: `MUSTER_MODEL_FIRST_WORD_SECONDS` (default 180) and `MUSTER_MODEL_SILENCE_SECONDS` (default 90), each 5 to 900; a company with a fast hosted model lowers them, one that hosts a slow model keeps them (CHA-187). With the defaults one call can hold a person for up to six minutes, and a run of several calls for longer; QA measured 6 to 12 minutes on a day the service stalled (CHA-187). Since 2026-11-15 the conversation says so after 30 seconds of nothing: how long it has been, and that the person can wait or stop. The reply then ends with "The model service stopped answering. Nothing was lost: try again.", or, when something had already been saved or sent, with words that say so and tell the person to look at the steps before trying again (CHA-215). (`SILENCE_SECONDS`, `FIRST_WORD_SECONDS`, `MODEL_SILENT` in `models.ts`; `causeFor` in `runs.ts`). The whole request may take 15 minutes. Before 2026-11-15 the whole request had 180 seconds, which cut off a long document being written and still let a stalled model hold a person for three minutes. Tests: "a model that goes silent" in `models.test.ts`.
- Cost: `input tokens × input price / 1,000,000 + output tokens × output price / 1,000,000` US dollars, with prices from `MUSTER_MODEL_INPUT_PRICE` and `MUSTER_MODEL_OUTPUT_PRICE` (default 0). Stored per model call in millionths of a dollar (`models.ts:101-114`, `server/runtime/runs.ts:864`). Cached-token prices are not modelled.
- Token counts come from the endpoint. An OpenAI-compatible endpoint that does not send `usage` in the stream yields zero tokens and zero cost.
- **What is said once (prompt cache; since 2026-11-24, MUS-40).** A model's service charges less, and answers sooner, for the beginning of a request that is the same to the letter as one it has just seen. Three things keep that true:
  - **The instructions and the tool list do not change within a conversation.** `promptParts` in `server/runtime/runs.ts` holds only what stays the same from one message to the next. What moves (the clock, what the person asked to be remembered, the skills this message calls for, the other agents that have replied, the project's notes, steps, latest update and key documents, how an attached repository stands, the language the message is written in) is `turnParts`: it is appended to the person's message for this reply only, after their words, under `TURN_NOTE` ("[From Muster, not from the person. …]"). The conversation as kept holds only what the person wrote, so the next request begins exactly as this one did up to that message. Before this, the clock alone (to the minute, in the middle of the instructions) made every message after the first pay for the whole conversation again.
  - **Rule for anything new:** nothing that can differ between two messages of one conversation goes into `promptParts` or into a tool's definition. State is said in `turnParts`, or through a tool's result. `server/cache.test.ts` holds this: it changes memory, steps, notes and the clock between two messages and requires the instructions and tools to be identical.
  - **Anthropic's format is told where to keep**: `cache_control: {type: "ephemeral"}` on the last tool, on the instructions, and on the last block of the last message (`models.ts`, `anthropicMessages`). OpenAI-compatible services (OpenAI, DeepSeek) keep a matching beginning on their own.
- **What was read from the cache is counted and priced.** `usage.input` is the whole prompt; `usage.cacheRead` and `usage.cacheWrite` are parts of it, read from `prompt_tokens_details.cached_tokens` (OpenAI), `prompt_cache_hit_tokens` (DeepSeek), or `cache_read_input_tokens` / `cache_creation_input_tokens` (Anthropic, which counts them apart: they are added to its `input_tokens`). Cost is `(input − read − written) × input price + read × cached price + written × write price + output × output price`. The two cache prices are `MUSTER_MODEL_CACHED_INPUT_PRICE` and `MUSTER_MODEL_CACHE_WRITE_PRICE` (and `MUSTER_MODEL_FALLBACK_…`), per million tokens; unset, each is the input price, so a deployment that sets nothing is charged as before. Stored as `traces.cached_tokens`, `traces.cache_write_tokens` and the same on `spans`. A person sees their own under Settings → Usage ("Read from cache", workspace.md).
- Vision: on only when `MUSTER_MODEL_VISION=1`.
- The key is sent only to the configured base URL and is never returned by any route; `/api/system` shows the model id, format, host, vision flag and prices (`server/product.ts:168-175`).

**States.** Not configured (agents cannot run; `canRun: false`). Endpoint error (run `failed`, trace `error`, the message in the `llm` span's events).

**How it is wired.**

- Code: `server/runtime/models.ts`, `server/config.ts:21-32`, `config.ts:113-139`.
- Data: `agents.model` (the model id at the time the version was stamped), `spans.attributes.model`, `spans.prompt_tokens`, `completion_tokens`, `cost_micros`.
- Tests: `server/runtime/models.test.ts:109-221` (OpenAI: request shape, text and usage and cost, tool calls in pieces, bad arguments, refused request, stop, length limit), `models.test.ts:234-309` (Anthropic: request shape, text and tool call, mid-stream error), `models.test.ts:336-360` (images). No test covers the retry.

**Not built.**

- More than one model, a model per agent, a fallback model, or choosing a model in the console.
- Changing the model, key or prices without a restart; key rotation; more than one key.
- Reasoning or extended thinking, temperature or any sampling setting. (Prompt caching: see "What is said once" below.)
- Backoff, and retry on 429 or 5xx.
- A real context window: 128,000 is assumed for every model.
- Prices in a currency other than US dollars.
- Azure OpenAI's or Bedrock's authentication; only a bearer key or `x-api-key`.

**Design findings.**

- A 429 from the provider fails the person's reply at once. Under load this is the most common failure. Smallest change: retry 429 and 5xx up to twice, honouring `Retry-After`.
- "At worst it is billed twice" (`models.ts:233-234`) is accepted in a comment; a finance reviewer will want it counted. Smallest change: record the attempt count on the `llm` span.
- Prices default to 0, so cost reports read zero until someone sets two variables, and nothing warns. Smallest change: log a warning at start and show "prices not set" on the dashboard.
- All agents share one key and one model: a change is a restart that fails every run in progress. Smallest change: none small; say so in the runbook.

**Locked decisions.** Carries out D-2 (OpenClaw's transport package, about 34,000 lines with four vendor SDKs, was left out and replaced by two small transports). Partly carries out D-4: usage is metered per call, per user and per agent. Gap: D-4 lists model management as a console function; it is environment variables and a restart.

---

## 10. Budgets

**Who it is for.** Operators who must cap spend; members, who hit the cap.

**The job.** Stop one person's agents for the day once they have used a set number of tokens.

**Where it starts.** `MUSTER_DAILY_TOKENS_PER_USER` at server start. Checked when a message is sent and after every model reply inside a run.

**What it does.**

1. Counts. "Used today" is the sum of prompt and completion tokens of the person's traces that started since midnight UTC (`server/runtime/runs.ts:233-244`). A run in progress counts as far as its last saved trace.
2. Before a run: if used today is at or above the allowance, the message is refused with 429 `budget_reached`, "You have used today's allowance for agents. It starts again tomorrow." (`server/product.ts:576-581`).
3. Inside a run: the amount used before the run is read once at the start; after each model reply the run's own tokens are added; at or above the allowance the run is aborted (`runs.ts:476-477`, `runs.ts:837-842`). The message ends `stopped` with `ending = 'allowance'`, which the conversation shows as "Stopped: your allowance for agents today is used up. It starts again tomorrow.", and the trace output reads "Stopped: today's allowance for agents is used up." (`runs.ts:956-960`, `runs.ts:1002-1004`).
4. Shows it. `GET /api/app/usage` returns `today: {tokens, limit}` and totals by agent and by day for 7, 30 or 90 days (`product.ts:669-703`). `/api/system` shows the allowance to administrators (`product.ts:176-180`).

**Rules.**

- Default 0, which means no limit (`server/config.ts:280-282`). The value must be a positive whole number.
- One number for every person. The day is UTC.
- The cap is on tokens, not money.

**States.** No limit (default). Under. Reached (429 on send; `stopped` mid-run).

**How it is wired.**

- Data: `traces.prompt_tokens`, `traces.completion_tokens`, `traces.started_at`, `traces.user_id`. No table of its own.
- Events: none in the activity log.
- Tests: `server/product.test.ts:1328` (stops a person's agents for the day and says so), `product.test.ts:1354` (stops a run part-way, and the reply carries `ending: "allowance"`), `product.test.ts:1269` (own usage only).

**Not built.**

- Budgets per agent, per department, per role or for the whole organization; monthly budgets; budgets in money.
- Changing the allowance in the console or for one person; raising it for today.
- A warning before the cap; a notice to administrators when someone hits it; a log entry.
- Days in the organization's time zone.

**Design findings.**

- The cap is not exact. A person with several conversations running at once has each run measure from its own starting point, so together they can pass the allowance by up to one model reply each (`runs.ts:477`). Smallest change: re-read `usedToday` after each model reply instead of adding to a number read once.
- With an endpoint that reports no usage, tokens are zero and the cap never triggers (section 9). Smallest change: refuse to start with an allowance set if the first reply reports zero tokens, or estimate from text length.
- A run stopped by the cap is recorded with trace status `ok`, like any stopped run (`runs.ts:999-1000`), so it does not show under errors or blocked. Smallest change: a `stopped` trace status, or `blocked` when the cap stopped it.
- The whole organization has no ceiling: 1,000 members times the personal allowance is the real exposure. Smallest change: one more variable for an organization-wide daily cap, checked the same way.

**Locked decisions.** Partly carries out D-4 ("usage is metered per user and per agent from the start, because billing and budgets depend on it"): metering is per user and per agent. Gap: budgets exist per user only, are set outside the console, and there is no billing.

---

## 11. Traces and spans

**Who it is for.** Administrators and auditors (`traces.read`), who review what agents did; the dashboard; the budget check. Members do not read traces.

**The job.** Keep, for every run, what was asked, what the agent decided, which tools it called, what the gateway ruled, what it cost, and how it ended.

**Where it starts.** Every run. The trace is written when the run starts and rewritten as it goes.

**What it does.**

1. One `traces` row per run: organization, agent id and version, user, conversation, venue (always `cloud`), status, start time, duration, input and output (each cut to 20,000 characters), prompt and completion tokens, cost in millionths of a dollar, span count, and the furthest action level reached (`server/runtime/runs.ts:512-538`).
2. `spans` rows under it (`runs.ts:117-132`):
   - `agent`: the root, one per run, named after the agent; attributes `venue`, `user` (email), `risk`, `model` (`runs.ts:486-501`).
   - `llm`: one per model reply, named `decide` when it asked for tools and `answer` when it did not; tokens, cost, stop reason; input is the person's message or the last tool result, output is the text plus each call as `name(arguments cut to 300)` (`runs.ts:843-865`).
   - `tool`, or `retriever` for `web.fetch`: arguments as JSON, the result text, `actionLevel`, the tool's summary; an `exception` event on error (`runs.ts:866-929`).
   - `policy`: the gateway's decision (section 7).
   - `approval`: the wait and its outcome.
   Span input and output are cut to 4,000 characters (`runs.ts:23`, `runs.ts:156-157`).
3. When it is saved (`runs.ts:569-578`): at the start with status `running`; when an approval is requested (`awaiting_approval`); after every tool call ends (`running`); at the end (`ok`, `error`, or `blocked` when any call was denied or not approved). Each save deletes the trace's spans and inserts them again in one transaction (`runs.ts:539-565`). Saves are queued one after another; a failed save is logged and the run goes on.
4. Reading (`server/observe.ts`): a filtered, sorted, paged list with totals, error and blocked counts, median and 95th percentile duration, tokens and cost (`observe.ts:148-190`); one trace with its spans and annotations (`observe.ts:251-295`); spans across traces (`observe.ts:380-416`); runs grouped by conversation (`observe.ts:420-459`); a CSV export of up to 10,000 rows (`observe.ts:192-249`); the dashboard (`observe.ts:522-697`).
5. Annotations: a label (1 to 40 characters), an optional score from 0 to 1 and a note up to 2,000 characters on a trace or one span (`observe.ts:308-351`). Saved views: named filter sets, per person, at most 50 (`observe.ts:463-518`).

**Rules.**

- Filters: range (`15m`, `1h`, `12h`, `24h`, `7d` default, `30d`, `90d`), status, level, venue, agent, user email, free text over input, output, agent name and trace id, minimum duration. Unknown filters are refused 400 (`observe.ts:10-47`, `observe.ts:113-120`). Page size 1 to 100, offset up to 100,000.
- Exporting is recorded as `traces.exported` with row count, whether it was cut at 10,000, and the filters. Cells that a spreadsheet would run as a formula are prefixed with `'` (`observe.ts:103-108`, `observe.ts:229-244`).
- Annotating and removing an annotation are recorded (`trace.annotated`, `trace.annotation_removed`).
- Opening one trace that is someone else's run is recorded in the activity log as `trace.viewed`: the reader, the trace as target, the email of the person whose run it is as the target's label, and the IP. It is written at most once an hour for each reader and trace, and not at all when the reader is the person whose run it is (`observe.ts:263-282`). A partial index on `admin_events` keeps that look-up cheap (migration 7, `schema.ts:311-314`).
- Listing traces or spans, and opening a conversation's runs through `GET /api/conversations/:id` (which returns every turn's input and output), are not recorded (`observe.ts:448-459`).
- A member's "clear history" archives conversations and leaves traces untouched (`server/product.ts:616-629`).
- Trace statuses: `running`, `awaiting_approval`, `ok`, `error`, `blocked` (`schema.ts:267-269`). A run the person stopped ends `ok`.

**States.** Running (visible while in progress). After a restart, interrupted traces are `error`. Empty lists return zeros.

**How it is wired.**

- Requests: `GET /api/traces`, `GET /api/traces/export.csv`, `GET /api/traces/:id`, `POST /api/traces/:id/annotations`, `DELETE /api/annotations/:id`, `GET /api/spans`, `GET /api/conversations`, `GET /api/conversations/:id`, `GET/POST /api/views`, `DELETE /api/views/:id`, `GET /api/dashboard` → `server/observe.ts`.
- Data: `traces`, `spans`, `annotations`, `saved_views` (`schema.ts:127-190`).
- Tests: `server/observe.test.ts:55-136` (list, filters, search, sort, range, bad filters, closed to others), `observe.test.ts:144-226` (span tree, sums; `observe.test.ts:187` who opened someone else's run is on the record, once), `observe.test.ts:235-281` (annotations), `observe.test.ts:315-344`, `observe.test.ts:360` (views), `observe.test.ts:396` (export), `observe.test.ts:431-462` (dashboard agrees; billing sees cost only); `server/product.test.ts:207` (a run leaves a trace), `product.test.ts:1171` (a deleted agent's runs stay).

**Not built.**

- Retention: nothing ever deletes or shortens a trace. There is no setting for how long content is kept.
- Hiding content from reviewers: input, output and tool results are stored and shown in clear text, including what the person typed and what their documents and web pages contained (up to the cut lengths).
- A record of who opened a conversation's runs, or looked through the lists; a record of every opening rather than one an hour.
- The full prompt: the system prompt and the replayed history are not stored, only the latest input of each model call.
- Export to an outside system (OpenTelemetry, SIEM), and alerts.
- A member's view of their own trace.
- Tamper evidence. Nothing prevents a later change to a trace or its spans. (Since 2026-11-16, CHA-236, spans are no longer deleted and re-inserted during a run: they are brought up to date by id.)

**Design findings.**

- Answered on 2026-11-14: `GET /api/traces/:id` now writes `trace.viewed` to the activity log when the run is someone else's, once an hour for each reader and run (`observe.ts:263-282`). What remains: `GET /api/conversations/:id` returns the same words and writes nothing, the lists carry the first 240 characters of every input and output unrecorded, and there is still no setting to store digests instead of content.
- Content is kept forever. Smallest change: one variable, days to keep trace content, and a daily job that blanks `input`/`output` past it.
- Answered on 2026-11-16 (CHA-236): a span annotation made while a run is still going used to be deleted by the next save, because every save deleted the run's spans and annotations go with their span. Spans are now written once and brought up to date by id (`insert … on conflict (id) do update` in `runs.ts`); nothing is deleted. Test: "keeps what was said about a step while the run was still going".
- Truncation is silent in review: a 4,000-character cut hides what was sent in a large `web.send` body from the trace (the approval row keeps up to 100,000). Smallest change: store the SHA-256 and the full length beside the cut text.
- Answered on 2026-11-16 (CHA-236): a run that ended without finishing used to read as `ok`. It is now `stopped`: stopped by the person, stopped by the allowance, or cut off at the longest a reply can be; the trace's output says which. The run's own span carries the same status; steps that finished stay `ok`. `stopped` is a filter in Traces, a count in the totals and a grey series in "Runs over time" (migration 24 widens the two status checks). Migration 24 also corrects runs recorded before the change whose own reply says they did not finish (a stopped message, or one ended at the length limit), so the share of finished runs does not fall on the day of the change. A run the person stopped is `stopped` even when a call was still waiting to be allowed; a call refused in a run that then finished is still `blocked`. The overview's success rate is of the runs that were let finish: stopped ones are left out of it. The development seed writes its sample events with their times, since a row of the log can no longer be changed. Test: "does not call a run that was stopped a finished one".

**Locked decisions.** Carries out D-4 (review and tracing, what each user consumes) and D-5 (records attributable to the agent's UUID and version, including how users use each agent). Gaps: D-5 says "complete"; content is cut, the full prompt is not kept, and the record can be rewritten. D-5's implication that the audit record format is the shared one in `packages/protocol` is not met: traces use their own shape.

---

## 12. The activity log

**Who it is for.** Owners, administrators and auditors (`audit.read`).

**The job.** Keep a line for every administrative or sign-in action: who did what to what, when, and from where.

**Where it starts.** Any code that changes something calls `recordEvent` in the same transaction as the change (`server/audit.ts:14-32`).

**What it does.**

- Appends one `admin_events` row: `id`, `seq` (a database-generated increasing number), `org_id`, `time`, `actor_user_id`, `actor_email`, `action`, `target_type`, `target_id`, `target_label`, `detail` (JSON), `ip` (`server/schema.ts:95-109`).
- Lists newest first, 1 to 100 a page (default 50), paged by `before=<seq>` (`server/app.ts:804-931`).
- Narrows the list (`eventFilter`, `app.ts:884-897`; the query, `app.ts:900-931`): `q`, up to 100 characters, is looked for, case ignored and with `%` and `_` as plain characters, in the actor's email, the action's name and the target's label; `actions`, up to 60 action names, also matches any record with one of those actions, which is how the console finds an action by the label a reader sees; `from` and `to` are days, both included, and must be real days written `YYYY-MM-DD`, else 400 `invalid_request`.
- Exports. `GET /api/audit/export` takes the same `q`, `actions`, `from` and `to` and answers a CSV file, `muster-activity-log.csv`, of up to 10,000 records, newest first: time, actor, action, target_type, target, detail (JSON) and ip. Cells that a spreadsheet would run as a formula are prefixed with `'`. Taking the file is itself recorded as `audit.exported` with the row count and the filter (`app.ts:817-860`, `app.ts:874`).
- What writes to it:

  | Action | Written by |
  |---|---|
  | `auth.login`, `auth.logout` | `server/app.ts:217`, `app.ts:262`, `server/auth/app-routes.ts:138` |
  | `auth.login_denied` (reason `suspended` or `identity_conflict`) | `server/auth/admission.ts:90`, `admission.ts:118` |
  | `org.created`, `member.joined` | `admission.ts:153`, `admission.ts:179` |
  | `member.role_changed`, `member.suspended`, `member.reactivated`, `member.department_changed`, `member.removed` | `app.ts:399-466` |
  | `department.created`, `department.renamed`, `department.deleted` | `app.ts:507-561` |
  | `invitation.created`, `invitation.revoked` | `app.ts:646`, `app.ts:679` |
  | `signin.domain_set`, `signin.domain_removed` | `app.ts:723`, `app.ts:746` |
  | `session.revoked` | `app.ts:794`, `server/product.ts:660` |
  | `agent.created`, `agent.changed`, `agent.deleted`, `agent.approved`, `agent.suspended`, `agent.restored` | `product.ts:49`, `product.ts:257-380` |
  | `approval.approved`, `approval.rejected` | `product.ts:769` |
  | `traces.exported`, `trace.annotated`, `trace.annotation_removed` | `server/observe.ts:233`, `observe.ts:344`, `observe.ts:369` |
  | `trace.viewed` (someone opened a run that is not their own; once an hour for each reader and run) | `observe.ts:278` |
  | `audit.exported` (rows and the filter used) | `app.ts:827` |
  | `agents.model_changed` (the model, and how many agents got a new version; actor "muster (configuration)") | `product.ts:82` |
  | `file.uploaded`, `file.created`, `file.deleted` | `server/files/service.ts:134`, `service.ts:316` |
  | `policy.changed` (an administrator changes the ceiling on modes; detail `{from, to}`) | `server/product.ts:197` |
  | `connector.connected`, `connector.disconnected` (a person connects or disconnects their Microsoft 365; the actor is the person, the label the Microsoft account) | `server/connectors.ts:159`, `connectors.ts:181` |

**Rules.**

- The record is written in the same transaction as the change, so a refused or failed change leaves no line (`audit.ts:13`).
- The actor's email is stored as text, so a line still reads after the person is gone.
- The IP follows the rule in section 1.
- Not written: tool calls and gateway decisions (they are spans), `docs.write`, document and conversation changes by members, an approval that expired, a budget stop, a run ended because its person was suspended or removed, a file download, reading the log itself, reading the trace lists or a conversation's runs, refused sign-ins of strangers, and refused requests in general.
- `trace.viewed`, `audit.exported` and `agents.model_changed` describe no change to a row, so they are written on their own, not inside a transaction with something else.

**States.** Empty. Paged.

**How it is wired.**

- Requests: `GET /api/audit?before=&limit=&q=&actions=&from=&to=` → `server/app.ts:804-815`; `GET /api/audit/export?q=&actions=&from=&to=` → `app.ts:817-860`. Both need `audit.read`.
- Data: `admin_events`, index `(org_id, seq desc)`, and a partial index for `trace.viewed` look-ups (`schema.ts:311-314`). The search is `ilike` over three columns with no index of its own.
- Tests: `server/app.test.ts:494-559` (every change recorded with who did it; a refused change is not recorded; a suspended person's attempt is; newest first); `server/observe.test.ts:396` (trace export recorded); `observe.test.ts:187` (`trace.viewed` written once; the log searched by `q` and by `actions`; a day that is not a day refused; the CSV; `audit.exported` written; a member refused); `server/files.test.ts:52`.

**Not built.**

- Tamper evidence. `packages/protocol` contains a hash-chained audit format with `sealEvent` and `verifyChain`; nothing in `apps/` calls it. Since 2026-11-16 (CHA-236, migration 24) the database itself refuses to change, remove or empty rows of `admin_events` (triggers `admin_events_append_only` and `admin_events_no_truncate`; a row goes only when its whole organization is removed). That stops the application and an ordinary database user by mistake or on purpose; it is not tamper evidence, since whoever owns the database can drop the trigger and no row proves it is unchanged. Before that, `admin_events` was an ordinary table that any database user could update or delete.
- A filter by one column (only this actor, only this action), search in the detail, and an export beyond 10,000 records or one that says it was cut.
- Forwarding to a SIEM or a syslog target.
- Retention rules and legal hold.
- A record of read access to sensitive data beyond the opening of one run: not the trace lists, a conversation's runs, a file, or the log itself.

**Design findings.**

- The log an auditor is shown is not the log the architecture promises. The promised one (per-tenant sequence, digests, chain) is code that is tested and unused. Smallest change: seal each `admin_events` row with the protocol's chain at insert and add a verify command.
- An agent sending data outside is the most important event in the product and is in the log only as "approval.approved · Messenger · web.send", without the destination. Smallest change: put `destination` and `bytes` from the approval summary into `detail`.
- `on delete cascade` from `organizations` would erase the log with the organization. Nothing deletes one today. Smallest change: remove the cascade on `admin_events`.
- Answered on 2026-11-14: `GET /api/audit` now takes `q` (actor, action, target), `actions`, `from` and `to`, and the same filter can be exported as CSV (`app.ts:804-931`). What remains: the words are looked for in all three columns at once, so "only what this person did" also returns what was done to them.

**Locked decisions.** Carries out D-4 for administrative actions. Gaps: the overview says the gateway "writes an audit record"; it does not write here. D-5's implication (the audit record format is the shared definition in `packages/protocol`) is not carried out. Open question Q-1 (tamper evidence) is acknowledged in the architecture as open.

---

## 13. File storage and safety

**Who it is for.** Members (their files), agents (through `files.*` tools), the viewers in the web app, operators (disk and limits).

**The job.** Keep people's files, refuse what should not be kept, and read their content for agents and viewers without letting a hostile file harm the server.

**Where it starts.** `POST /api/app/files?name=<name>` with the file as the request body; `files.create` from an agent; any read of a file's content, text or sheets.

**What it does.**

1. Takes the upload. The body is read up to the size limit and refused 413 `file_too_large` beyond it, by declared length first and by counted bytes after (`server/files.ts:13-37`, `files.ts:72-88`).
2. Cleans the name: NFC, slashes to `_`, control characters removed, 1 to 200 characters, not only dots; else 400 `invalid_file_name` (`server/files/kind.ts:113-121`).
3. Identifies the file by its ending and its first bytes together (`kind.ts:20-99`). Accepted endings: `docx`, `xlsx`, `xlsm`, `pptx` (zip), `doc`, `xls`, `ppt` (OLE), `pdf` (`%PDF-` in the first 1,024 bytes), `png`, `jpg`, `jpeg`, `gif`, `webp` (their signatures), `html`, `htm`, `md`, `txt`, `csv`, `json` (text: UTF-16 with a mark, or no zero bytes and valid UTF-8 or GB18030). An empty file, an unknown ending or a mismatch is refused 415 `unsupported_file`. A newer Office ending over OLE bytes (password or encrypting sensitivity label) is refused 415 `protected_file` with its own message (`kind.ts:107-110`, `server/files/service.ts:87-89`).
4. Keeps it, in one transaction (`service.ts:93-142`): takes a per-person lock; for an agent-made file marks earlier agent-made files of the same name deleted; adds up the person's kept bytes and refuses 409 `file_quota` beyond 1 GiB; inserts the `files` row with kind, mime, size, SHA-256, source (`upload` or `agent`) and conversation; writes `file.uploaded` or `file.created`; writes the bytes. If the bytes cannot be written, nothing is recorded.
5. Stores bytes on disk under `<MUSTER_FILES_DIR>/<org id>/<file id>`, mode 0600. Keys are built from ids only, and a key that would leave the folder is refused (`server/files/store.ts:19-52`).
6. Sends a file back (`files.ts:39-47`, `files.ts:90-99`): only PDF and the four image types may open in place; everything else, and anything with `?download`, is an attachment. Headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`.
7. Reads text for agents and viewers in a worker thread with a 30-second limit, a 512 MB heap limit and a 4 MB stack (`server/files/reading.ts:5-64`). A worker that runs out of time or memory is ended and the file is reported "too large or too complex to open here".
8. Checks archives before any parser sees them (`server/files/extract.ts:24-47`): counts the bytes that really come out; refuses more than 2,000 entries, more than 100 MB unpacked (40 MB for workbooks), or more than 200 times the file's size plus 1 MB.
9. Extracts (`extract.ts:134-200`): Word through mammoth, Excel through exceljs (20 sheets, 500 rows, 60 columns for text; 2,000 rows by 100 columns for the grid view), PowerPoint from the slide XML with notes, PDF page by page up to 300 pages, HTML reduced to text, text decoded as UTF-8, UTF-16 or GB18030. At most 60,000 characters are returned, with a flag when cut. `.doc`, `.xls`, `.ppt` and images are stored but answer "cannot be read here".
10. Caches what it worked out under `<org id>/derived/<sha256>.text.json` and `.sheets.json`, including a failure, so a file is read once however often it is asked for (`service.ts:200-223`).
11. Deletes (`service.ts:302-333`): marks the row deleted, writes `file.deleted`, removes the bytes, and removes the derived entries unless another kept file in the organization has the same content.

**Rules.**

- A file belongs to one person. Every route and tool looks it up by organization and user; nobody else, including administrators, can list, read or delete it through the API (`service.ts:148-155`, `files.ts:55-59`).
- Limits: one upload at most `MUSTER_MAX_FILE_MB` (default 25 MB); 1 GiB per person (`service.ts:18`), fixed in code; 500 files listed.
- An agent-made file of the same name replaces the agent's earlier one; it never replaces an upload (`service.ts:96-103`).
- CSV made by an agent has formula-like cells marked as text; Excel cells given as text are stored as text (`server/files/make.ts:139-143`, `make.ts:53-55`).
- `/api/app/files/limits` tells clients the size limit, the quota and the accepted endings (`files.ts:61-67`). `/api/system` shows administrators the organization's file count, bytes and the top 20 holders (`server/product.ts:161-195`).

**States.** Refusals: `invalid_file_name` (400), `file_too_large` (413), `unsupported_file` (415), `protected_file` (415), `file_quota` (409), `unreadable_file` (422, sheets view), `not_found` (404). Text view of an unreadable file returns `{text: "", problem}` with status 200.

**How it is wired.**

- Requests: `GET /api/app/files/limits`, `GET/POST /api/app/files`, `GET /api/app/files/:id/content`, `…/text`, `…/sheets`, `DELETE /api/app/files/:id` → `server/files.ts:61-132`.
- Data: `files` (`schema.ts:282-296`), `messages.attachments` (`schema.ts:298`); disk under `MUSTER_FILES_DIR`.
- Events: `file.uploaded`, `file.created`, `file.deleted` (with kind, size, sha256).
- Tests: `server/files.test.ts:23-41` (what a file is; names), `files.test.ts:52-220` (upload, list, download, delete; never opens a page in place; refusals; one person's only; grids; read once and cached; encodings and protected files; delete removes derived), `server/files/office.test.ts:157-188` (archive bombs, entry counts, damaged files).

**Not built.**

- Virus or malware scanning. `.xlsm` (macros) and `.html` are accepted, stored and handed back as downloads.
- Encryption at rest by Muster, and object storage (S3 or similar). The store is one local folder, which also ties the deployment to one machine.
- Retention, legal hold, and an administrator's ability to see, hand over or delete a member's files.
- A quota that can be configured, per person or for the organization.
- A record of downloads.
- Sharing a file with another person; folders; versions.
- Reading scanned PDFs or images (OCR); reading the old Office formats.
- Cleaning up: the `files` row of a deleted file stays forever; a derived `.pdf` key is still removed on delete (`service.ts:330`) though nothing writes one since the converter was removed.

**Design findings.**

- No malware scan on a product whose purpose is passing Office files around, and whose agents hand files to "a manager or a customer". Smallest change: an optional `clamd` address; refuse on a hit, record `file.refused`.
- A file that failed to read once is unreadable forever, even when the cause was a busy server hitting the 30-second limit, because the failure is cached under the content hash (`service.ts:219-221`, `reading.ts:26-35`). Smallest change: do not cache the "too large or too complex" outcome.
- Files sit in clear text on one disk and backups are the operator's problem; the compose file gives them a Docker volume. Smallest change: say in the runbook that disk encryption and backup of `files` and `db` volumes are required, and what restoring one without the other does.
- A person who leaves keeps 1 GiB that nobody can reach. See section 4.
- The quota counts only kept files, so upload-delete cycles are unlimited, and the derived cache is not counted at all. Smallest change: none needed now; note it.

**Locked decisions.** Carries out D-3 (hostile files are refused or contained without a cost to ordinary uploads: reading happens once, in a worker). Gaps: the overview says "every … file access passes one gateway"; an agent's file tools pass the gateway, but as A0 and A1 they are always allowed and a file read is recorded only as a span. D-6's "local content does not all go to the cloud" has no counterpart: every file a person attaches is uploaded and stored.

---

## 14. Reply format

**Who it is for.** Every client that shows a reply; the model, which is taught the format in every run.

**The job.** Have agents answer in a small set of named components that each client draws itself, so a reply cannot carry arbitrary markup, colours or scripts.

**Where it starts.** `replyFormatPrompt()` is appended to the system prompt of every run (`server/runtime/runs.ts:788`). Clients pass the stored reply text through `toRenderable` before drawing it.

**What it does.**

- Defines twelve components with `@openuidev/lang-core` (`packages/ui-schema/src/index.ts:28-156`):

  | Component | Arguments, in order |
  |---|---|
  | `Stack` | `children`: the root list |
  | `Text` | `text`, `tone` (`body`, `muted`) |
  | `Heading` | `text` |
  | `Callout` | `title`, `text`, `tone` (`info`, `warning`, `success`) |
  | `List` | `items`, `ordered` |
  | `Table` | `columns`, `rows` (text cells) |
  | `Facts` | `items` of `{label, value}` |
  | `Code` | `code`, `language` |
  | `Diagram` | `title`, `code` (Mermaid source) |
  | `Chart` | `title`, `kind` (`bar`, `line`, `area`), `labels`, `series` of `{name, values}`, `unit` |
  | `Sources` | `items` of `{title, url}`; the address must be http or https with no credentials |
  | `FollowUps` | `items` of `{label, text}`; tapping one sends `text` as the next message |

- Since 2026-11-16 (CHA-237), five components a person fills in (`index.ts`, with the functions that read and check them in `packages/ui-schema/src/forms.ts`):

  | Component | Arguments, in order |
  |---|---|
  | `Form` | `name`, `title`, `submit` (the button's words), `fields`. Accepted by `Stack`; one a reply |
  | `TextField` | `name`, `label`, `value`, `required`, `long` |
  | `SelectField` | `name`, `label`, `options` (strings; the words shown are what is sent), `value`, `required` |
  | `DateField` | `name`, `label`, `value` (`YYYY-MM-DD`), `required` |
  | `NumberField` | `name`, `label`, `value`, `required`, `min`, `max`, `unit` |

  A field exists only inside a `Form`. A form has no behaviour the model chooses: its one button sends the person's answers (see "A message that answers a form" below). The model is told to ask with a form when two or more facts are missing, after one `Text` that says what it needs; that a form is written in the reply and is never called as a tool; and never to use one to confirm an action or to ask for a secret.
- Teaches the form components only to a run whose client draws them: `replyFormatPrompt(ui)` (`index.ts`), where `ui` is the component set the client announced with the message (`UI_VERSION`, now 3: 3 added the Walkthrough, see [`coding.md`](coding.md#how-a-reply-that-changed-code-ends-c1)). Without it a run is taught the reply components alone. The Walkthrough is taught only to a run that also works on the person's code (`replyFormatPrompt(ui, coding)`). The form components add about 1,850 characters to the instructions of a run that has them (9,263 without).
- Teaches the model: write only OpenUI Lang, first line `root = Stack([...])`, arguments by position, everything reachable from root, only real addresses in Sources, never invent numbers for a chart (`index.ts:162-176`).
- Repairs what the model wrote (`index.ts:185-201`): a reply with a root is used as is; statements without a root get one; plain prose becomes one `Text`; while a reply is still arriving, text that may yet become a statement is left alone.
- Gives a reply as plain words for copying (`readableText`, `index.ts:222-237`).

**Rules.**

- The package holds no rendering code; each client binds its own renderer to the names (`index.ts:4-12`).
- The order of a component's props is its wire format; shipped components must not be reordered.
- The model cannot choose colours, sizes or markup. Bold in `Text` is the only inline formatting.
- The reply is stored as the model wrote it, in `messages.content`; nothing validates it on the server, except a form at the moment it is answered.
- A reply can call nothing and open nothing. Every client hands the renderer no tool provider and no handler for actions, so a `Query`, a `Mutation` or a step such as `@OpenUrl` that a model writes anyway does nothing; the library drops a component it does not know (`apps/web/src/app/reply.test.tsx`, "a reply that writes what nobody taught it").
- **A message that answers a form** (`apps/server/src/forms.ts`). `POST /api/app/conversations/:id/messages` takes `action {messageId, form, values}` in place of `content`. The server reads the form again from the stored reply (`formsIn`), and refuses unless the reply is in this conversation, complete and its last message (`form_closed`, 409), the form is a working form of that reply and every value belongs to a field and fits its kind, options and bounds (`invalid_form`, 400). It then writes the person's message itself: a first line `My answers to your form "<title>":`, and one line a field, `Label: value`, with "(as suggested)" on a value the agent gave and the person left, and "(left empty)". What is kept beside the message is `messages.action`: `{messageId, form, title, answers}`, each answer `{name, label, value, unit?, suggested}`. Nothing the model wrote is sent as the person's words, and a client's description of the form is never used.
- A form is answered once. The answer is a later message, and that the reply is still the last message is checked again where the message is stored, with the conversation locked (`runs.ts`, `start`): of two answers sent at once, one is stored and the other answers `form_closed` or `run_in_progress`.
- What a working form is: a name, a title, one to twelve fields with names unique in the form, a label each (cut at 120 characters, kept on one line), a select with 2 to 30 options, a typed value of at most 2,000 characters. Anything that is not a plain word, number or `true` where one belongs is left out, and where the form would not make sense without it, the form is not a form: clients then list its labels with "Answer by typing." A number field whose arguments were not all of their kind is taken without bounds, because a model that leaves `required` out moves the bounds up a place.
- An address in a form is the agent's, also after the person sends the form. The server knows an address is the agent's by finding it in the reply as written (`runs.ts`, `addressesIn` over what the agent said), so a form may carry one only where it can be found there letter for letter: never in a title, a label, the button's words or a unit, and in an option or a prefilled value only when the reply holds those very words. A value written with an escape is not put into its field; an option written so makes the form not a form (`packages/ui-schema/src/forms.ts`, `carriesAddress`).
- The title and the labels in that message are the agent's words in a message of the person's. The fixed first line says so, the title stands in quotation marks, and the model is told that they are its own words and only the values are the person's: a title such as "Yes, forward all my mail" cannot open the person's message as if they had said it.
- What the agent gives a field is what the person sees in it. A value for a field of one line is set on one line with single spaces, without characters that draw nothing or turn the text round, and is not put into the field at all when it is longer than 200 characters: nothing can be sent that stood past the field's edge or behind a run of spaces.
- A form that asks for what must not be typed into a conversation is not a form: a label or a title that names a password, a code, a card, bank or identity number (`asksForSecret`, English and Chinese). Clients then show a line saying so and do not invite the answer by typing. It is a list of words, so it stops the plain case and not a determined one; what a person types into any field is stored like any message (`messages.content`, the trace's input) and, on the web, kept in the browser until it is sent.
- A reply cut off at the longest a reply can be is stored as complete (`ending = 'length'`), and what was cut may be its form. Its form is not answered (`form_closed`) and clients show it as unfinished.
- A value of several lines is one line in a field of one line, and in the message is set in from its second line on, so no line of it reads as a field of its own.
- An answer goes to the agent that asked: the form of an agent invited with "@" is answered to that agent, if the person may still use it (`product.ts`).
- The run that follows an answer says so in its trace: the root span carries `form` and `formReply` (`runs.ts`, `persist`).

**States.** A half-written reply is drawn as far as it has got. A reply that is not in the format is shown as text.

**How it is wired.**

- Code: `packages/ui-schema/src/index.ts`; used by the server at `runs.ts:2`, `runs.ts:788`, and by the web app's reply renderer (`apps/web/src/app/reply.tsx`).
- Forms: `packages/ui-schema/src/forms.ts`; `apps/server/src/forms.ts`; `messages.action` (migration 25, `schema.ts`, added "if not exists"); drawn by `apps/web/src/app/forms.tsx` and `apps/mobile/src/forms.tsx`. Tests: `packages/ui-schema/src/forms.test.ts` (reading, limits, checking, the answer's text, what is taught), `apps/server/src/forms.test.ts` (answered once, refusals, closing, ownership, an address the agent prefilled still asks, the component set), `apps/web/src/app/reply.test.tsx` (the states on the page, with the library running), `apps/mobile/test/forms.test.ts`. Evals: `automation/eval-forms.mjs`, run against the configured model.
- Tests: `packages/ui-schema/src/index.test.ts:23-54` (a reply using the components parses; all are taught to the model; links are plain web addresses), `index.test.ts:70-103` (`toRenderable`), `index.test.ts:111` (reply as words).

**Not built.**

- Input beyond a short form: checkboxes, picking several, people and file fields; a figure that recomputes when an assumption is moved; a table whose cells can be corrected (steps 2 of `docs/design/interactive-replies.md`).
- Live data in a reply: no reply can call a tool. Step 3 of the same design, which first needs the gateway opened to a second caller and an amendment to `docs/architecture.md`.
- A form in the middle of a run, with the agent waiting for it; a form in a scheduled run or a shared reply.
- An administrator's switch for forms.
- Components for files, images, approvals or progress; those are drawn by the client from other data.
- Server-side validation of a reply against the schema.
- Versioning beyond one number: a client says the newest set it draws, and a run is taught that set or the first one. An older app opening a conversation that already holds a form drops the form and shows the `Text` before it.

**Design findings.**

- Answered on 2026-11-14: `Diagram` and `Chart` were missing from the list of components `Stack` accepts and from the test that parses "each of them"; both are now there (`packages/ui-schema/src/index.ts`, `index.test.ts`).
- `readableText` filters setting words `ok`, `warn`, `bad`, `bullet`, `number` that no component uses, and does not filter `warning` and `success`, which `Callout` does use (`index.ts:204-216`); a copied reply can contain a stray "warning". Smallest change: derive the set from the enums.
- Answered on 2026-11-16 (CHA-237): a member can be asked to fill something in. `Choices` puts a decision as rows to press, and `Form` puts two or more questions as fields with one button.
- What a person types into a form reaches the agent as their own message. A page or a mail the agent read can still talk it into asking for something sensitive in an ordinary text field; there is no field for a secret, the model is told never to ask for one, and getting the answer out of the organization still needs `web.send` (always asks) or a read of an address nobody wrote (asks, except in `full`). Smallest change: mark a reply that was written after the run read something from outside.
- The model sometimes writes a form's arguments a place off (seen with `NumberField`). The reader drops what does not fit and the form still works, but a wrong bound of the right kind would not be noticed. Smallest change: name the arguments in the instructions with one worked example.

**Locked decisions.** Carries out D-1 (OpenUI is the core of interaction; one definition shared by every client, which also serves D-6). Gap: D-1 says "interfaces are generated through OpenUI where OpenUI can express them"; today OpenUI expresses the reply and, since 2026-11-16, a short form in it. Approvals and files are hand-built client screens, deliberately so for approvals: nothing in a reply can decide one.

---

## 15. Serving the web app and the content security policy

**Who it is for.** Everyone using a browser; operators, for whom one process is the whole deployment.

**The job.** Serve the built web app from the same server as the API, and tell the browser to load nothing from anywhere else.

**Where it starts.** Server start: `serveWeb(app, dir)` with `MUSTER_WEB_DIR`, or `apps/web/dist` next to the server when unset (`server/index.ts:50-53`). Then any GET that is not under `/api`, `/auth` or `/dev-idp`.

**What it does.**

1. At start, walks the folder once and keeps a map from URL path to file. If there is no `index.html`, it serves nothing and the server logs "not serving the web app: no build was found" (`server/web.ts:44-55`).
2. For a GET: a path under `/api`, `/auth` or `/dev-idp` is left to the server (`web.ts:37`, `web.ts:59`). A path in the map is sent with its content type and `nosniff`; files under `/assets/` are cached for a year as immutable, others `no-cache` (`web.ts:60-70`). A missing path with a file ending falls through to 404. Any other path gets `index.html` (`web.ts:71-76`).
3. Sends `index.html` with these headers (`web.ts:25-34`):
   - `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
   - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`.

**Rules.**

- A request is looked up in the map made at start and is never turned into a path on disk, so nothing outside the folder can be served.
- The page may load scripts only from the server (plus WebAssembly, for the PDF engine), and images and fonts only from the server or from memory. It cannot load an image from another site, so a reply cannot make the browser call out.
- The page cannot be framed, and forms post only to the server.
- In development the web app comes from the Vite dev server on port 5173, which forwards to the server, and `serveWeb` is not used unless the public URL's port is the server's own (`index.ts:48-50`).

**States.** Serving. No build found. Served by the dev server.

**How it is wired.**

- Code: `server/web.ts`, `server/index.ts:48-53`. People's files have their own stricter headers (section 13); the app-login page has its own policy (section 2).
- Tests: `server/web.test.ts:20-51` (page, assets, any path inside the app; server paths left alone; nothing outside the folder; no build).

**Not built.**

- `Strict-Transport-Security`. TLS is ended by a proxy the operator provides; the server sends no HSTS header.
- Security headers on API responses (JSON), and `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- CSP reporting (`report-to`).
- Compression and `ETag`s: files are read and sent whole on every request.
- Picking up a new build without a restart.

**Design findings.**

- `style-src 'unsafe-inline'` is allowed. With `default-src 'self'` and no remote images the risk is small, but a security review will list it. Smallest change: note the reason (Word viewer inline styles) beside the header; it is already in the comment.
- Mermaid diagrams are drawn in the page from model-written source. Not verified: whether the web app renders Mermaid with its strict security level; the CSP blocks script and remote loads either way.
- No HSTS is easy to fix and easy to be marked down for. Smallest change: send it when the public URL is https.

**Locked decisions.** Carries out D-3 (the browser is locked down with no cost to performance) and D-6 (one backend serves every client). No conflict found.

---

## 16. Configuration

**Who it is for.** Operators.

**The job.** Set everything about a deployment through environment variables, checked at start, with a clear error when something is wrong.

**Where it starts.** Server start: `loadConfig()` (`server/config.ts:151-311`). A variable set to nothing counts as not set (`config.ts:145-148`).

**What it does.** Variables read by the server:

| Variable | Default | What it changes |
|---|---|---|
| `MUSTER_DEV` | off | `1` turns on development mode: embedded database, the passwordless development provider, sample data, listen on `127.0.0.1`. Refuses to start with `DATABASE_URL` or an https public URL. |
| `PORT` | `7410` | The port the server listens on. Positive whole number. |
| `MUSTER_PUBLIC_URL` | development: `http://localhost:5173`; otherwise required | The origin people open. Must be a bare origin (scheme, host, optional port). Used for the Origin check, redirect addresses and the `Secure` cookie flag. |
| `DATABASE_URL` | none; required outside development | PostgreSQL connection string. Empty means the embedded database. |
| `MUSTER_DATA_DIR` | empty (in memory) | Folder for the embedded database, development only. |
| `MUSTER_WEB_DIR` | empty (falls back to `apps/web/dist` beside the server) | Folder of the built web app. The Docker image sets `/app/web`. |
| `MUSTER_FILES_DIR` | development: `<temp>/muster-dev-files`; otherwise `data/files` | Folder where people's files are kept. The Docker image sets `/data/files`. |
| `MUSTER_MAX_FILE_MB` | `25` | Largest single upload, in megabytes. |
| `MUSTER_DAILY_TOKENS_PER_USER` | none (no limit) | Tokens one person's agents may use in a UTC day. Positive whole number. |
| `MUSTER_BOOTSTRAP_OWNER_EMAIL` | development: `owner@muster.test`; otherwise required | The one address allowed to create the organization. Lower-cased. |
| `MUSTER_ORG_NAME` | `Muster` | The organization's name, used once at creation. |
| `MUSTER_SESSION_DAYS` | `7` | How long a session lives. |
| `MUSTER_TRUST_PROXY` | off | `1` means `X-Forwarded-For` is believed (right-most entry) for the recorded IP. |
| `MUSTER_MODEL_API` | none | `anthropic` or `openai`. Required when a model is configured. |
| `MUSTER_MODEL_ID` | none | The model's id. With the key, configures the model. |
| `MUSTER_MODEL_BASE_URL` | `https://api.anthropic.com` or `https://api.openai.com/v1` | The endpoint. Trailing slashes are removed; must start with `http://` or `https://`. |
| `MUSTER_MODEL_API_KEY` | none | The key. |
| `MUSTER_MODEL_INPUT_PRICE` | `0` | US dollars per million input tokens. |
| `MUSTER_MODEL_OUTPUT_PRICE` | `0` | US dollars per million output tokens. |
| `MUSTER_MODEL_VISION` | off | `1` means images are sent to the model. |
| `MUSTER_GOOGLE_CLIENT_ID`, `MUSTER_GOOGLE_CLIENT_SECRET` | none | Both set: Google sign-in. Redirect URI `<public URL>/auth/callback/google`. |
| `MUSTER_MICROSOFT_CLIENT_ID`, `MUSTER_MICROSOFT_CLIENT_SECRET`, `MUSTER_MICROSOFT_TENANT` | none | All three set: Microsoft sign-in for one directory. The tenant must be a GUID. Redirect URI `<public URL>/auth/callback/microsoft`. With `MUSTER_SECRET_KEY` also set, the same registration lets people connect their Microsoft 365; that needs a second redirect URI, `<public URL>/api/app/connectors/microsoft/callback`, and the delegated Graph permissions listed in section 22. |
| `MUSTER_OIDC_ISSUER`, `MUSTER_OIDC_CLIENT_ID`, `MUSTER_OIDC_CLIENT_SECRET` | none | All three set: sign-in with the company's own OpenID Connect provider. The issuer is the address whose `/.well-known/openid-configuration` describes the provider; it must be `https` (any scheme in development) and is kept as written. Redirect URI `<public URL>/auth/callback/oidc`. |
| `MUSTER_OIDC_LABEL` | `Company account` | What the sign-in button says for the company's own provider. Cut to 40 characters. |
| `MUSTER_SECRET_KEY` | none; in development one is made and kept in `<files dir>/.secret-key` | What seals the tokens of people's connections to other services (section 22). At least 32 characters, else the server does not start. Not set: the server starts, and connections are not offered to anyone ("Not set up on this server"). Changed or lost: every stored connection can no longer be opened, is deleted the next time it is used, and each person must connect again. Used only when Microsoft is also configured, since Microsoft 365 is the only service (`config.ts:273-284`, `server/connections.ts:67-72`). |
| `MUSTER_SEARCH1API_KEY`, `MUSTER_TAVILY_API_KEY`, `MUSTER_SEARXNG_URL` | none | Where agents search the web: Search1API, Tavily, or a SearXNG the company runs. One at most, else the server does not start. None: agents have no search (section 23). |
| `MUSTER_SANDBOX_URL` | none; `http://sandbox:7420` in the compose file | Where agents' code is run: the sandbox service beside the server ([`sandbox.md`](sandbox.md)). Not an http or https address: the server does not start. None: agents cannot run code. |
| `MUSTER_OIDC_TRUST_EMAIL` | off | `1` means the operator vouches that every account in the company's provider was given its address by the company. Addresses are then believed unless the provider marks them unverified, and the provider proves the domain, which the first owner, domain rules and matching to an existing person all need. |

Variables read by the deployment files, not the server: `POSTGRES_PASSWORD` (required by `deploy/compose.yaml`, which gives it to the database and passes it to the server as `PGPASSWORD`, beside a `DATABASE_URL` that holds no password, so it may contain any character; `deploy/compose.yaml:38-40`; the `pg` library reads `PGPASSWORD` when the address has no password), `MUSTER_BIND` (default `127.0.0.1`) and `MUSTER_PORT` (default `7410`) for the published port. The Docker image sets `NODE_ENV=production`, `PORT=7410`, `MUSTER_WEB_DIR` and `MUSTER_FILES_DIR` (`Dockerfile`). Tooling only: `MUSTER_SERVER` (where the Vite dev server forwards, default `http://127.0.0.1:7410`, `apps/web/vite.config.ts:6`) and `MUSTER_TEST_DATABASE_URL` (run the server tests against PostgreSQL, `server/test-support.ts:56`).

**Rules.**

- Start fails with a message when: the public URL is missing or not a bare origin; `DATABASE_URL` is missing outside development; development mode is combined with a database or https; no provider is configured; the bootstrap owner is missing; a number is not a positive whole number; a price is negative or not a number; the model is half-configured or its format is unknown; a sign-in provider has some of its settings and not the others ("… sign-in is half set: … is missing"); the company's issuer is not an `https` address; the Microsoft tenant is not a GUID (`config.ts:97-111`, `config.ts:113-139`, `config.ts:149-269`).
- `pnpm dev` loads `.env` from the repository root and expands `${NAME}` references to variables already in the shell (`scripts/dev.mjs:10-21`).
- `MUSTER_SECRET_KEY` shorter than 32 characters stops the start: "MUSTER_SECRET_KEY must be at least 32 characters" (`config.ts:276-277`).
- The key is passed by `deploy/compose.yaml` and explained in `deploy/.env.example` and `apps/server/README.md`, with the second redirect URI and the Graph permissions. `docs/runbook.md` does not mention it. Left empty, no connection is offered and the start log says nothing.
- Nothing in the start log says whether connections are offered (`server/index.ts:62-76` reports the web app and the model only).
- Fixed in code, not configurable: the ceiling on modes when no administrator has set one (`auto`); the wait for a person's computer (60 seconds); the life of a connection attempt (10 minutes); approval wait 15 minutes; invitation life 14 days; sign-in attempt and app-login life 10 minutes; history 40 messages; model output 4,096 tokens and timeout 180 seconds; quota 1 GiB per person; network limits; the gateway's rules.

**States.** Not applicable; the server starts or does not.

**How it is wired.**

- Code: `server/config.ts`; examples `.env.example` (development) and `deploy/.env.example` (deployment); `deploy/compose.yaml`.
- Requests: `GET /api/system` (`settings.read`) reports the model, limits, file totals, gateway rules, tool levels and the ceiling on modes the server is actually using (`server/product.ts:208-257`); `GET /api/settings/sign-in` reports providers, session days and invitation days (`server/app.ts:696-709`). Since 2026-11-14 one value is set through a request and kept in the database, not the environment: the ceiling on modes, `PUT /api/settings/policy` (`product.ts:177`, `org_settings`).
- Tests: `server/auth.test.ts:267-356` (production configuration; `auth.test.ts:278` the company's own provider taken, and a provider half set refused; bare origin; positive numbers; development mode never beside a real database or site; Microsoft tenant; required values), `server/product.test.ts:1309` (system report).

**Not built.**

- Any setting changeable in the console or without a restart, but one: the ceiling on modes (section 7).
- Any way to rotate the key without every person connecting again.
- Secrets from a file or a secret manager; key rotation; more than one model key.
- Validation that the model endpoint or the providers are reachable at start.
- A setting for anything in the "fixed in code" list above.

**Design findings.**

- Answered on 2026-11-14: `deploy/compose.yaml` now passes `MUSTER_SESSION_DAYS` (default 7) and `deploy/.env.example` lists it (`deploy/compose.yaml:55`, `deploy/.env.example:41-42`).
- `deploy/.env.example` sets `MUSTER_TRUST_PROXY=1` while the compose default is `0`; a deployment without a proxy that copies the example records an IP the client can forge. Smallest change: leave it empty in the example with the comment.
- Secrets are plain environment variables visible to anyone who can inspect the container. Smallest change: accept `MUSTER_MODEL_API_KEY_FILE` and the two client-secret equivalents.
- `MUSTER_SECRET_KEY` is one more such secret, and the one whose loss is felt by every person: without it the sealed tokens are noise. The runbook does not mention it, so nothing tells an operator to back it up with the database. Smallest change: a line in the runbook's backup section.
- The development key is a file in a temp folder beside people's files (`config.ts:278-284`). That is right for development; it also means a developer's connections to a real Microsoft account end when the machine clears its temp space. Smallest change: say so in the development section.
- An operator cannot see the effective configuration except through `/api/system`, which omits session days, public URL, proxy trust and file folder. Smallest change: add them (not secrets) to that response.

**Locked decisions.** Supports D-3 (development sign-in cannot reach production; the server refuses unsafe combinations). Gap against D-4: "all back-office information is managed" in the console, "including model management … permission assignment"; here it is managed by environment variables and restarts, with one exception since 2026-11-14, the ceiling on modes.

---

## 17. Database schema and migrations

**Who it is for.** Everything. Operators, who back it up.

**The job.** Hold every durable fact in one PostgreSQL database with a schema that moves forward only.

**Where it starts.** Server start: the database is opened and migrated before anything else uses it (`server/db.ts:17-39`, `db.ts:41-77`).

**What it does.**

1. Opens PostgreSQL through a `pg` pool when `DATABASE_URL` is set, or embedded PGlite otherwise (development and tests: one process, one connection). Both sit behind one small interface: `query`, `tx`, `close` (`db.ts:7-14`).
2. Migrates (`db.ts:79-96`). `schema_migrations(version, applied_at)` records what has run. Each entry of `MIGRATIONS` is a list of statements run in one transaction and then recorded. On PostgreSQL the whole migration step holds transaction advisory lock `727074001` (`db.ts:71-75`).
3. Ten migrations exist (`server/schema.ts`):
   - 1 (`schema.ts:6-110`): `organizations`, `org_domains`, `departments`, `users`, `identities`, `memberships`, `invitations` (with the one-open-per-address index), `sessions`, `login_attempts`, `admin_events`.
   - 2 (`schema.ts:112-191`): `agents`, `traces`, `spans`, `annotations`, `saved_views`.
   - 3 (`schema.ts:193-261`): `agents.instructions`, `agents.tools`; `conversations`, `messages`, `approvals`, `documents`, `app_logins`; `sessions.kind`.
   - 4 (`schema.ts:263-279`): `messages.steps`, `messages.plan`; trace status `running`; `agents.deleted_at`; renames and suspends duplicate platform agents; unique platform agent name per organization.
   - 5 (`schema.ts:281-299`): `files`; `messages.attachments`.
   - 6 (`schema.ts:300-310`): `messages.ending` and `messages.ending_detail` (why a reply ended when it did not simply finish); `documents.previous_content` and `documents.previous_at` (what a document held before an agent replaced it); `conversations.allowed_hosts` (sites a person allowed an agent to read for the rest of a conversation, a text array, empty by default).
   - 7 (`schema.ts:311-314`): a partial index on `admin_events (org_id, actor_user_id, target_id, time)` for `trace.viewed`, so finding whether a reader already opened a run this hour does not read the whole record.
   - 8 (`schema.ts:315-331`): `projects` (`id`, `org_id`, `user_id`, `name`, `instructions`, `created_at`, `updated_at`; unique on `(user_id, lower(name))`); `conversations.project_id`, which points at a project and becomes null when the project is deleted (`on delete set null`), with a partial index for conversations that have one.
   - 9 (`schema.ts:332-356`): `connections` (`id`, `org_id`, `user_id`, `provider`, `account`, `scopes`, `access_token`, `refresh_token`, `expires_at`, `created_at`; one row per person and provider; the two tokens are stored sealed, see section 22); `connection_attempts` (`state` as its SHA-256, `org_id`, `user_id`, `provider`, `code_verifier`, `expires_at`), a connection being made.
   - 10 (`schema.ts:357-365`): `conversations.mode` (`ask`, `auto` or `full`; `ask` by default, so every conversation that existed before starts there); `org_settings` (`org_id`, `max_mode` with default `auto`), one row per organization, made the first time an administrator sets the ceiling.

**Rules.**

- A shipped migration is never edited; new ones are appended (`schema.ts:1-4`). There are no down migrations.
- All ids are UUIDs made by the server (UUIDv7), except `sessions.id` (SHA-256 of the token), `login_attempts.state` and `app_logins.id` (random text).
- Every organization-owned table has `org_id … references organizations(id) on delete cascade`. Isolation between organizations and between people is by `where org_id = … and user_id = …` in each query; there is no row-level security.
- `projects`, `connections`, `connection_attempts` and `org_settings` all go with their organization, and the first three with their user row (`on delete cascade`). Nothing deletes a user row, so a removed or suspended person's `connections` row stays, sealed.
- `connection_attempts.code_verifier` is stored as it is, for the ten minutes the attempt lives; rows past their time are deleted when the next attempt starts (`server/connections.ts:116`).
- Soft deletes: `agents.deleted_at`, `files.deleted_at`, `conversations.archived_at`, `memberships.status = 'removed'`, `invitations.revoked_at`, `sessions.revoked_at`. No route hard-deletes an organization, a user, a conversation, a message, a trace, a log entry or a file row. Hard deletes exist for departments, documents, annotations, saved views, automatic-join domains, expired sign-in attempts, projects, connections and connection attempts.
- Values are constrained by checks: a conversation's mode and an organization's ceiling, roles, membership status, agent source, risk and state, trace venue and status, span kind and status, action levels, message role and status, approval level and status, file source, session kind.
- `traces.conversation_id`, `messages.trace_id` and `approvals.trace_id` have no foreign key.
- A dropped idle connection is logged and does not crash the process (`db.ts:44-45`).

**States.** Fresh (all migrations run). Up to date (none run). A failed migration rolls back and the server does not start.

**How it is wired.**

- Code: `server/schema.ts`, `server/db.ts`, `server/index.ts:35-37`.
- Tests: every server test file opens a fresh migrated database (`server/test-support.ts:50-70`); CI also runs them against PostgreSQL through `MUSTER_TEST_DATABASE_URL` (`.github/workflows/ci.yml:47`). No test migrates from an older schema with data in it.

**Not built.**

- Encryption of sensitive columns (conversation text, trace content, document content, file names, a project's instructions). They are plain text. The exception is the two token columns of `connections`, sealed with AES-256-GCM under a key that is not in the database.
- Retention and purging of any table; partitioning of `traces`, `spans`, `admin_events`, which only grow.
- Row-level security; a read-only database role for auditors.
- Backups and restore procedures in code (left to the operator).
- A check that the running code matches the schema version (a newer database with older code is not detected).
- Search indexes: trace text search is `ilike` over `input` and `output` (`server/observe.ts:73-79`).

**Design findings.**

- Tenant isolation rests on every query remembering its `where`. One forgotten clause leaks across people. Today there is one organization per deployment, which limits the damage to "across members". Smallest change: a test that runs every `/api/app` route as a second member against the first member's ids (partly there: `server/product.test.ts:1222`, `server/files.test.ts:113`).
- `spans` grows by several rows per run and is rewritten on each save; `ilike` search scans. At enterprise volume the trace pages will slow first. Smallest change: partition `traces`/`spans` by month when retention lands.
- Conversation and document content is readable by anyone with database access, and by backups. Smallest change: state it in the runbook; column encryption is the larger answer.
- What an agent read from a person's mailbox or from a folder on their computer is in `spans.output` in plain text, the first 4,000 characters of each read, and the content of a confirmed write on their computer is in `approvals.summary`. The tokens are sealed; what they fetched is not. Smallest change: keep a digest, not the text, for the output of `m365.*` and `local.*` spans.
- A backup holds the sealed tokens and not the key. Restored with the key they work again; restored without it every connection is dropped on first use. Smallest change: say in the runbook that the key is part of what must be kept.

**Locked decisions.** Supports D-5 (UUIDs everywhere; agent rows are never removed, so records stay attributable). No conflict found.

---

## 18. Shared definitions: identifiers, agent versions, the unused audit chain

**Who it is for.** Every component that must agree on what an id, an agent version and an audit record are.

**The job.** Hold the definitions the architecture says are shared, in one package, `packages/protocol`.

**Where it starts.** Imported by the server wherever an id is made or checked, and where an agent version is computed.

**What it does.**

- Ids: `newId()` makes a UUID version 7 (48-bit millisecond timestamp, then random bits), so ids sort in creation order to the millisecond; `isId()` accepts only that shape (`packages/protocol/src/ids.ts:13-34`). Routes refuse any id that is not one.
- Agent version: `agentFingerprint({model, instructions, skills, tools})` is a SHA-256 over the canonical form with tools sorted and de-duplicated (`packages/protocol/src/agent.ts:8-29`). The server always passes `skills: {}` (`server/runtime/catalog.ts:68-69`).
- Audit record and chain: `AuditEvent` (tenant, sequence, time, actor with user, agent, version and run, action with an arguments digest and a data class, decision with a policy id and approver, outcome) and `sealEvent`/`verifyChain` for a per-tenant hash chain (`packages/protocol/src/events.ts`, `packages/protocol/src/chain.ts`).

**Rules.** The audit record stores digests of arguments, never content (`events.ts:19-27`).

**States.** Not applicable.

**How it is wired.**

- Used by the server: `newId`, `isId`, `agentFingerprint` only. Nothing under `apps/` imports `sealEvent`, `verifyChain`, `AuditEvent`, `canonicalJson` or `digestOf`.
- Tests: `packages/protocol/src/ids.test.ts`, `digest.test.ts`, `chain.test.ts`.

**Not built.** Any use of the audit record format or the chain by the server, the gateway or the clients.

**Design findings.** The strongest governance claim Muster could make (a tamper-evident record of every agent action, with digests instead of content) exists as tested code that nothing calls. See sections 11 and 12 for the smallest change.

**Locked decisions.** D-5: "Identity and the audit record format are shared definitions every component uses (`packages/protocol`)". Identity: carried out. Audit record format: not carried out.

---

## 19. Refusals: the error catalogue

**Who it is for.** Every client, which translates refusals by code.

**The job.** Give every refusal one code, one HTTP status and one plain message.

**Where it starts.** A route calls `fail(c, code)`, or throws `Refusal(code)` inside a transaction so everything rolls back before the refusal is sent (`server/app.ts:63-64`, `app.ts:112-134`, `server/errors.ts:50-54`).

**What it does.** Every refusal answers `{error: {code, message}}`. Two were added for forms on 2026-11-16: `form_closed` (409, "This form can no longer be answered: it was answered already, or the conversation has moved on.") and `invalid_form` (400, "These answers do not fit the form. Check each field and send it again."). The catalogue had 38 codes before them (`server/errors.ts:2-53`); the four added on `epic/cha-167-local-work` are `mode_not_allowed` (403, "Your organization does not allow agents that much freedom."), `connector_unavailable` (409, "This service is not set up on this server. An operator has to register Muster with it first."), `invalid_project` (400, "A project needs a name of 1 to 60 characters.") and `project_exists` (409, "You already have a project with this name."). The others, among them `bad_origin` (403), `unauthenticated` (401), `forbidden` (403), `owner_only` (403), `self` (400), `last_owner` (409), `not_found` (404), `invalid_request` (400), `agent_unavailable` (409), `agent_suspended` (409, "This agent is suspended. An administrator must restore it before it can be changed."), `agent_changed` (409), `run_in_progress` (409), `already_decided` (409), `budget_reached` (429), `model_unavailable` (503), `file_too_large` (413), `unsupported_file` (415), `protected_file` (415), `unreadable_file` (422), `file_quota` (409). Anything unexpected answers 500 `{code: "internal", message: "Something went wrong on the server."}` and is written to the server's console; a failure in the middle of sign-in redirects to `/?error=failed` instead (`app.ts:122-134`).

**Rules.** A row another person owns answers `not_found`, never `forbidden`, so its existence is not revealed.

**States.** Not applicable.

**How it is wired.** Code: `server/errors.ts`. Tests: refusals are asserted throughout `server/app.test.ts` and `server/product.test.ts`; `app.test.ts:541` checks that a refused change leaves no record.

**Not built.** Request ids on errors; structured server logs (errors go to `console.error`); messages in languages other than English (clients translate by code); rate-limit responses.

**Design findings.** A support engineer cannot tie a person's "Something went wrong" to a log line. Smallest change: put a short random id in the 500 body and in the log line.

**Locked decisions.** None directly.

---

## 20. Deployment and process lifecycle

**Who it is for.** Operators.

**The job.** Run Muster as one container beside one PostgreSQL, and start and stop it without losing records.

**Where it starts.** `docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build`, or `node dist/index.js`.

**What it does.**

1. The image (`Dockerfile`): Node 22, the built server and the built web app, run as user `node`, port 7410, files under `/data/files`. Its health check fetches `/auth/providers` every 30 seconds.
2. The compose file: PostgreSQL 17 with a volume, and one `muster` container with a `files` volume, published on `127.0.0.1:7410` by default so that a TLS proxy the operator provides is the only way in. The server is given the database's address without the password and the password on its own as `PGPASSWORD`; the sign-in settings, the company's own provider among them, and `MUSTER_SESSION_DAYS` are passed through from `deploy/.env` (`deploy/compose.yaml:36-55`).
3. Start order (`server/index.ts`): load configuration; take the one-server lock; open and migrate the database; in development seed sample data; create the file store and the run engine; mark what a previous process left open as failed (`recover`); register routes; serve the web app; listen on `0.0.0.0` (or `127.0.0.1` in development); log what is and is not configured.
4. Stop: on SIGINT or SIGTERM, stop every run (recording each), close the database, exit 0 (`index.ts:77-85`).

**Rules.** One `muster` container per database; a second refuses to start (`index.ts:16-34`). TLS is not ended by the server.

**States.** Starting. Serving. Refused to start (configuration error; another server holds the lock). Lost the lock connection (exits 1 and is restarted by Docker's `unless-stopped`).

**How it is wired.** `Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example`, `apps/server/src/index.ts`, `docs/runbook.md`. No test covers start-up, the lock or shutdown.

**Not built.** High availability, horizontal scaling, zero-downtime deploys; a readiness endpoint separate from `/auth/providers`; metrics (Prometheus or other); structured logs; a TLS proxy in the compose file; backup jobs; Kubernetes manifests.

**Design findings.**

- One process, one disk, no metrics: an operations team has nothing to monitor but the health check. Smallest change: a `/healthz` that checks the database and the files folder, and a count of live runs.
- Shutdown waits for every run to stop with no upper bound; a run waiting on a slow model call delays the stop until Docker kills the container, which then leaves records to `recover`. Smallest change: none needed; `recover` covers it. State it in the runbook.

**Locked decisions.** D-6 (one backend). Gap against D-4's enterprise expectation of an operable control plane: operation is start, stop and environment variables.

---

## 21. Gaps against the locked decisions, in one place

| Decision | What the code does | Where it falls short |
|---|---|---|
| D-1 Enterprise agent workspace, OpenUI at the core | Replies are OpenUI components shared by all clients (section 14). | Since 2026-11-16 a reply can hold a short form the person answers with one press (section 14); there is still no figure that recomputes, no table to correct and no live data in a reply. "Go deep into office work": answered on 2026-11-14, in part: a person can connect their Microsoft 365 and an agent can read their mail, calendar, OneDrive files and Teams chats (sections 8, 22). What remains: reading only; Microsoft only (no Feishu, WeCom, DingTalk, Google); calendar, files and chats have not been run against Microsoft. |
| D-2 Derived from OpenClaw, slimmed; gated extensions | Three OpenClaw packages vendored piece by piece with the upstream tag and five import edits recorded; OpenClaw's transports and tools left out (sections 6, 9). | Still open. No plugin or skill mechanism exists, so neither gate (administrator approval, mandatory scan with allow and block lists) exists. The Microsoft connector added on 2026-11-14 is not an extension: it is code in the server (`server/connections.ts`, `server/connectors.ts`, four tools in the catalogue). What stands in for a gate is outside Muster: an operator registers the app with Microsoft and sets `MUSTER_SECRET_KEY`, and the directory's administrator grants the permissions. Inside Muster no administrator approves it, sees who uses it, or can turn it off, and a member can give its tools to an agent of their own without review (they are A0). The overview's sandbox does not exist; tools run in the server process, and the four folder tools run in the desktop app's main process on the person's computer, also without a sandbox, held in by path rules (`apps/desktop/src/local.ts`). |
| D-3 Security first, no performance cost | Gateway on every tool call; network guard; file containment; strict browser policy; safe sign-in defaults, among them a company's own provider that proves a domain only on the operator's word, and a provider half set stopping the start (sections 1, 7, 13, 15). | Policy is three constants and one setting; A3 control is the requester's own click; the model call passes no gateway; no malware scan; no measurement behind "no performance cost", and the gateway now reads the mode from the database on every tool call. New on 2026-11-14: in the mode `full`, which an administrator must first allow, reading an address the person did not write no longer asks, so an agent that read a mail, a folder file or a document can carry it out in an address; this is by design and is stated to the person and the administrator, and nothing in code limits it. What an agent reads from a mailbox or a folder is kept in part in the trace in plain text. |
| D-4 Control plane governs everything | Members, roles, sessions, agents (approve, suspend), traces, dashboard, activity log (sections 3, 5, 11, 12). | Models, keys, prices, budgets, session lifetime, providers and the gateway's level rules are environment variables or code. Answered on 2026-11-14, in one part: an administrator can now change one setting in the console, without a restart: the most freedom a person may give agents in a conversation (the ceiling on modes: `ask`, `auto`, `full`; `auto` until set), recorded as `policy.changed` (section 7). It is the only one. The control plane does not govern the two other things added the same day: it cannot see or end a person's Microsoft 365 connection, cannot turn connections or folders off, and cannot say which agent may use them. No billing. Budgets per user only. No per-agent budget. Administrators are not separated from the record. Answered on 2026-11-14, in part: an administrator opening someone else's run is itself recorded (`trace.viewed`), and the activity log can be searched, narrowed by date and exported (sections 11, 12); administrators still read and export everything, and a conversation's runs can be read without a record. |
| D-5 UUID, risk level, complete record | UUIDv7 ids; risk computed from tools and required; version fingerprint on every run; agent rows never removed (sections 5, 11, 18). | The audit format and hash chain in `packages/protocol` are unused. Tool calls are recorded as spans that are rewritten and cut to 4,000 characters. Old versions' definitions are not kept. Answered on 2026-11-14: a model change, which re-stamps every agent's version, is now written to the activity log as `agents.model_changed` (section 5); what remains is that approved agents are not looked at again. |
| D-6 One backend for all clients; local content not all in the cloud | One API; bearer sessions for native apps (section 2). | A first device half exists since 2026-11-14 (sections 6 and 8; [clients-and-operations: Desktop app](clients-and-operations.md#desktop-app)). What exists: in the desktop app a person attaches folders on their computer to a project; the list of folders is kept on that computer only and the server is never told where they are; an agent working in that project can list, read, search and write text files in them through a channel the server relays (`device` events out, `POST …/device/:call` back); the work is done by the desktop app, inside the attached folders only; nothing is uploaded to file storage. What does not exist: no sync in either direction (a folder is not mirrored to the server and the library is not mirrored to a folder); nothing offline (the model, the loop, the gateway and the record are all on the server, and the desktop app must be open on the conversation for the whole run); Word, Excel, PowerPoint and PDF files in a folder cannot be read (text files only); nothing on iOS, and nothing in a browser tab; no run on a device (`venue` is always `cloud`); no index of local content; no line a person or an administrator can set between what stays local and what may leave. What is read does leave the computer: it goes through the server to the model for that answer, and the first 4,000 characters of each read, and the whole content of a write that asked first, are kept on the server in `spans` and `approvals`. Not yet run in the real desktop app: the server side and the folder rules are held by tests; the desktop app's part has only been read. |
| D-7 Tracker and working standard | Not a runtime capability. | Not assessed here. |

---

## 22. Connections to other services

**Who it is for.** A member who wants their agents to read what they have in another service; the four `m365.*` tools, which depend on it; operators, who must register Muster with the service and hold the key.

**The job.** Hold, for each person, their own consent to read their account at another service, use it only in their own runs, and let them take it back.

**Where it starts.** `POST /api/app/connectors/microsoft/start`, from Settings → Connections or the + menu of a message box; then the service sends the person's browser to `GET /api/app/connectors/microsoft/callback`. In a run, a call to an `m365.*` tool.

**What it does.** One service exists: Microsoft 365, through Microsoft Graph, delegated to the person.

1. Says what is there (`GET /api/app/connectors`, `server/connectors.ts:126`, `server/connections.ts:94-109`): one entry, `{id: "microsoft", available, connected}`. `available` is true when the server has a Microsoft provider configured and a secret key (`connections.ts:67-72`). `connected` is the account's address and since when, for this person.
2. Starts (`connections.ts:111-137`). Makes a random state and a PKCE verifier, deletes attempts past their time, stores the attempt (`connection_attempts`: the state's SHA-256, the person, the verifier, ten minutes), and answers with the address of Microsoft's authorize page for the configured directory: the client id, `response_type=code`, the redirect `<public URL>/api/app/connectors/microsoft/callback`, the scopes, the state, the S256 challenge and `prompt=select_account`. When nothing is configured it answers 409 `connector_unavailable`.
3. Asks for reading, and since 2026-11-15 for `Mail.Send` and `ChatMessage.Send`, which no agent tool uses: they serve the person's own Send on a draft (`drafts.md`). (`connections.ts`): `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`, `Chat.Read`.
4. Finishes (`connectors.ts:136-176`, `connections.ts:172-228`). The callback is the one address under `/api` that needs no session: the desktop app opens the system's browser, which may hold none (`server/app.ts:76`, `:277-288`); when the browser does hold a session it is noted. The attempt is taken by its state, once, if it is not past its time. The code is exchanged at Microsoft's token endpoint with the client secret and the verifier. Muster asks Graph who the account is (`/me`). Then the check that ties the consent to the person: it counts only when the browser it arrived in is signed in to Muster as the person who began, or the account's mail address or sign-in name equals that person's Muster email; otherwise nothing is stored (`WrongPerson`, `connections.ts:196-209`). The access and refresh tokens are sealed and stored in `connections`, replacing any earlier connection of that person (`connections.ts:211-227`). `connector.connected` is written to the activity log, by the person, labelled with the account.
5. Answers the browser with a page of its own (`connectors.ts:70-111`): what was connected and what it allows, or why it was not. The page holds everything it shows, loads nothing and runs nothing; it is sent with `default-src 'none'; style-src 'unsafe-inline'` and `no-store`. English or Chinese by the browser's `Accept-Language`. Status 200 when connected, 400 otherwise.
6. Serves a run (`connections.ts:239-333`). `graph(user, path)` and `download(user, path, most)` find the person's row, open the access token, and call `https://graph.microsoft.com/v1.0` with it. A token with less than two minutes left is renewed first with the refresh token; two calls that need it at once share one renewal. A download reads the answer as it arrives and stops past the limit.
7. Ends. `DELETE /api/app/connectors/microsoft` deletes the person's row and writes `connector.disconnected` (`connectors.ts:178-190`). A renewal that Microsoft refuses with `invalid_grant`, `interaction_required` or `consent_required` deletes the row too, without a record; any other failure keeps the row and tells the agent to try again shortly (`connections.ts:47`, `:267-285`). A row whose refresh token the server's key cannot open is deleted (`connections.ts:256-260`).

**Rules.**

- A connection is used only for the person it belongs to: every call is made with the organization and user of the run (`server/runtime/tools.ts:57-60`, `connections.ts:239-252`). There is no shared or organization-wide connection.
- One connection per person and service (`schema.ts:345`).
- Sealing: AES-256-GCM, a fresh 12-byte nonce for each value, the key the SHA-256 of `MUSTER_SECRET_KEY` (`connections.ts:62`, `:77-92`). The database, or a backup of it, does not give access to anyone's account without the key. The key lives in the server's environment.
- The state is stored as its hash, works once and lives ten minutes. The PKCE verifier is stored as it is for those ten minutes.
- The directory is the one configured for sign-in (`MUSTER_MICROSOFT_TENANT`); accounts of other directories and personal Microsoft accounts cannot consent.
- Graph's answers are never trusted as instructions: the tools mark them as network content (section 8). Graph's errors are passed to the agent in one of three sentences (403, 404, any other status with Microsoft's message cut to 200 characters; `connections.ts:287-303`).
- Requests to Microsoft have time limits: 15 seconds for a token, 20 for a Graph call, 30 for a download.
- These requests do not go through the network guard of section 7 (`net.ts`): they go to two fixed hosts, `login.microsoftonline.com` and `graph.microsoft.com`, with the server's own `fetch` (`connections.ts:64`).
- Disconnecting in Muster does not revoke anything at Microsoft.
- What is recorded: `connector.connected` and `connector.disconnected` in the activity log; each read as a tool span in the run's trace, with its arguments and the first 4,000 characters of what came back.

**States.** Not available (no Microsoft provider, or no key): `available: false`, start answers 409. Available, not connected. Connected. Connected but refused by Microsoft for one kind of data (403 on that tool). Ended by itself (consent gone, or the key changed): the next call finds no usable row and the agent is told the person is not connected.

**How it is wired.**

- Code: `server/connections.ts` (`Connections`: `list` `:94`, `start` `:111`, `finish` `:172`, `remove` `:230`, `accessFor` `:239`, `renew` `:267`, `graph` `:305`, `download` `:309`); `server/connectors.ts` (`registerConnectors` `:114`, `page` `:70`); the one address let through without a session, `server/app.ts:76`, `:284-287`; made at start and handed to the run engine, `server/index.ts:42-43`, `:49`.
- Requests: `GET /api/app/connectors`; `POST /api/app/connectors/microsoft/start`; `GET /api/app/connectors/microsoft/callback`; `DELETE /api/app/connectors/microsoft`.
- Data: `connections`, `connection_attempts` (`schema.ts:332-356`, migration 9). Configuration: `MUSTER_MICROSOFT_CLIENT_ID`, `MUSTER_MICROSOFT_CLIENT_SECRET`, `MUSTER_MICROSOFT_TENANT`, `MUSTER_SECRET_KEY`, `MUSTER_PUBLIC_URL`.
- What the operator sets up at Microsoft is in [clients-and-operations: Server settings](clients-and-operations.md#server-settings).
- Tests: `server/product.test.ts:1113` "a person's Microsoft 365": "is connected by the person's own consent, read by their agent, and taken back" and "renews a token that has run out, and is not offered where the server is not registered", both against a stand-in for Microsoft's token endpoint and Graph (`service` in the test; the harness takes it as `options.service`, `server/test-support.ts:71-79`, `:106-110`). The stand-in answers the token endpoint, `/me` and `/me/messages`, and 404 for everything else.
- Run for real: on 2026-11-14 the owner connected a real Microsoft account and an agent read real mail through it. Not verified: `m365.calendar`, `m365.files` and `m365.chats` against Microsoft; no test calls them either. Not verified: a renewal that fails for a reason other than lost consent, two runs renewing at once, a download past 20 MB, and the wrong-person refusal when the account's address differs, against Microsoft (the wrong-person refusal is covered against the stand-in).

**Not built.**

- Any service but Microsoft 365, and any way to add one without writing server code.
- Writing: sending, replying, drafting, booking, uploading, posting.
- Application permissions (a connection for the organization, without each person's consent), shared mailboxes, delegated calendars, Teams channels, meeting transcripts, mail attachments.
- A list for administrators of who is connected, a way for an administrator to end a connection, and a switch to turn connections off for the organization.
- A choice of which permissions to ask for; a choice per agent or per conversation.
- Revoking at Microsoft on disconnect; ending a person's connection when they are suspended or removed.
- Rotation of the secret key without every person connecting again.
- Keeping what was read out of the trace.
- A sync or an index: every question is a fresh request to Microsoft, 15 to 60 items at a time.

**Design findings.**

- The server now holds standing tokens to people's mailboxes. The key that seals them is one environment variable, absent from the runbook. A buyer's security team will ask where the key is kept, who can read it, and how it is rotated; the answers today are "the container's environment", "anyone who can inspect it" and "it cannot". Smallest change: document it; accept the key from a file; support two keys at once so one can be retired.
- An administrator has no view of connections and no stop. The head of the enterprise will not accept "search the activity log". Smallest change: `GET /api/connections` for `sessions.read` and `DELETE` for `sessions.revoke`, shown on Sign-in & sessions.
- Suspending or removing a person ends their sessions and runs and leaves their tokens. They cannot be used, since no run starts for that person; they are still there to be used if the membership is restored, or by a fault. Smallest change: delete the person's `connections` rows in the same step that ends their runs.
- What an agent reads is kept in the trace in plain text (4,000 characters a read), where administrators and auditors may open it. The tokens are sealed and the content is not. Smallest change: for `m365.*` spans keep the request and a digest of the answer.
- Reading asks for `Files.Read.All` and `Sites.Read.All`, which a directory administrator reads as "every file and site this person can open". The tool uses the person's own drive only. Smallest change: ask for `Files.Read` until SharePoint reading is shown to work.
- All four kinds are asked for together. A person who wants their calendar read must also hand over mail and chats. Smallest change: ask for the scopes of the kinds the person ticks.
- The callback needs no session, and that is held in by two checks (signed in as the person, or the account's address is theirs). A person whose Microsoft address differs from their Muster email, connecting from the desktop app, is refused unless the browser is signed in to Muster. That is the right default; the page explains it. Smallest change: none; say it before the browser opens.

**Locked decisions.** Serves D-1 ("go deep into office work"): the first connector to where office work is kept. Follows D-3 in what it asks for (reading only; tokens sealed; consent tied to the person; a page that runs nothing). Gaps: D-2: the connector is not an extension and passes no gate inside Muster. D-4: the control plane cannot see, end or forbid a connection. D-3: what is read is kept in the trace in plain text, and in the mode `full` it can leave in an address without a question.

## 23. Searching the web

**Who it is for.** An agent that has `web.search`, and through it the person who asked for something that needs looking up. The operator chooses where searches go.

**The job.** Find pages on the open web, so an agent reads what exists instead of guessing addresses, and so reading what a search found does not stop to ask the person once for every site.

**Where it starts.** The model calls `web.search` with a query. The platform's Assistant and Researcher have the tool; a person can give it to an agent of their own.

**What it does**

- `web.search` (A0): takes `query`, 2 to 200 characters after spaces are collapsed. Answers with up to 8 results, each a title, an `https` address and an extract of at most 400 characters (`server/runtime/tools.ts`, `server/runtime/search.ts`). A longer query is refused before anything is asked: a search is a few words, and a long one is a way to carry something out.
- Three services, chosen by the operator (`server/config.ts`), one at most or the server does not start:
  - `MUSTER_SEARCH1API_KEY`: Search1API, the owner's choice of 2026-11-15 for a search that does not fail. `POST https://api.search1api.com/search` with the key as a bearer token and `{ query, max_results: 8, crawl_results: 0 }`; one credit a search, since the service is not asked to crawl the pages (an agent reads the ones it wants itself). Its results are `title`, `link`, `snippet` and, where known, `published_date`, which the agent is shown beside the title. Written from the service's published description (`https://api.search1api.com/openapi.json`). Run against the real service on 2026-11-15 with the owner's key: results came back with titles, dates and extracts, and the pages were then read without a confirmation.
  - `MUSTER_SEARXNG_URL`: a SearXNG the company runs. `GET <url>/search?q=…&format=json&safesearch=1`. It may be a private address: the operator named it, and it is reached directly, not through the guard that keeps agents off the private network. The compose file can run one: it is off unless the operator sets `COMPOSE_PROFILES=search`, `MUSTER_SEARXNG_URL=http://searxng:8080` and a `SEARXNG_SECRET` of its own (`deploy/compose.yaml`, `deploy/.env.example`). It is not published, sits on a network it shares only with Muster (not with the database), and its image is pinned by digest. `deploy/searxng/settings.yml` turns the JSON format on and names the engines asked (Google, Bing, DuckDuckGo, Brave, Startpage, Mojeek, Baidu, Wikipedia), so a search goes to few services and not to the dozens of the default set.
  - `MUSTER_TAVILY_API_KEY`: Tavily, `POST https://api.tavily.com/search` with the key as a bearer token.
  - None set: there is no search, the tool is not shown to any model (`named` in `tools.ts`), and agents read only addresses people give them.
- Results that are not `https`, that repeat, or whose address is longer than 2,000 characters are dropped. 15 seconds for the service to answer.
- Words only. The marks a search service reads as commands of its own at the start of a word (`!site`, `!!site`, `:lang`, a backslash) are taken off before the query is sent, and the request to the service never follows a redirect (`redirect: "error"`). Seen on 2026-11-15: SearXNG answers `!!g secret` with a redirect to Google carrying "secret"; followed, that would have sent the search to any of thousands of sites, or on to a private address, with no confirmation.

**Rules**

- An address a search gave in this run is read by `web.fetch` without asking, in every mode (`searched` in `server/runtime/runs.ts`). The reason the gateway asks about an unwritten address is that the agent could have written into it what it read; an address the search service wrote cannot carry that. Two limits:
  - Only the exact address counts. One the agent alters, by a single character or an added query, asks as before.
  - An address whose query part is longer than 64 characters is not counted, since a search can echo what was asked into such an address.
  - Nor is one that says back a word of the search of 12 characters or more, anywhere in it: a service that builds an address from the search (`/search/<words>`) would carry that word out. Long words are what secrets look like; the words in an article's address are short.
- It holds for the run in which the search was made, not the conversation: a later message searches again.
- What is searched for leaves for the service the operator chose, and nowhere else. An agent that has read something private could put up to 200 characters of it in a query. The tool's description tells the model not to; nothing enforces it. The service is trusted the way the model's provider is.
- The step shows the query to the person (`stepDetail`); the trace keeps the query and the results like any tool call.

**States.** No service set up: the tool is absent. Service unreachable: the agent is told "The search service could not be reached just now." and can go on. The key refused (401, 403), the credits used up (402) or asked too often (429): the agent is told which, in words that say an operator must act, so the person hears it in the reply. Any other error: its status. Nothing found: "Nothing was found for …".

**How it is wired.** `server/runtime/search.ts` (`createSearch`, `Search`, `SearchError`); `server/index.ts` gives it to `Runs`; `ToolContext.search` and `found`; the gateway's `searched` set. `GET /api/system` returns `search: { provider, host }` or null, shown on the admin Models page (`web/src/pages/System.tsx`). Tests: "searching the web" in `apps/server/src/product.test.ts` (three tests, with a stand-in service).

**Not built**

- A choice of search service per agent or per person; any record of how many searches were made, or a cap on them.
- Search inside the company's own systems. This is the open web only.
- Reading a result that is not a page: a PDF a search finds is read as whatever text the address returns.

**Design findings**

- Run on 2026-11-15 with a real model and a local SearXNG: a research request made three searches and read eleven pages with no confirmation; before, the same request stopped six times and never finished. Not verified: Tavily (no key was available), and SearXNG inside the compose stack.
- Several of SearXNG's engines answered "too many requests", "access denied" or a CAPTCHA within an hour of testing from one address; by the end only Bing answered. An instance that scrapes public engines is free and private but not dependable: a company searching all day will be throttled. For a first version that must not fail, a paid search service is the dependable choice; on 2026-11-15 the owner chose Search1API. Smallest change otherwise: show the last failure on the Models page and say so in the runbook.
- Search is off until the operator turns it on, so an upgrade does not start sending queries out. Once on, the platform's Assistant and Researcher have it at once, with an `agent.changed` record and no administrator's approval; an administrator cannot turn it off for one agent short of suspending it.
- A query is the one way out that does not ask. 200 characters is a bound, not a wall. Smallest change: record queries in a form an auditor can list, apart from traces.
