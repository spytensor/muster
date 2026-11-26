# Admin console

The admin console is the part of Muster under `#/admin/...`. It is where the people who run an organization see who is in it, how they sign in, what the agents did and what that cost. It has thirteen pages in four groups. Seven of them change something (Members, Departments, Invitations, Sign-in & sessions, Agent roster, notes and saved views inside Traces, and one setting on Policies). Five only show (Overview, Activity log, Usage, Approvals, Models). One more (Connections) shows who has connected an outside service and lets an administrator end a connection; until 2026-11-15 its place held a design preview with invented data, which is gone. This file describes what the code does today, read from the source on branch `epic/cha-167-local-work`. Nothing here was checked by running the app; where the code could not settle a point, it says "Not verified:". Line numbers in the sections that branch changed (Members' invite dialog, Invitations, Sign-in & sessions, Activity log, Approvals, Policies) are that branch's; the other sections still cite `epic/cha-166-polish`, and `app.ts` has moved down by about seven lines and `product.ts` by more since.

**Roles and permissions** (`apps/server/src/roles.ts:18-59`). A person has exactly one role. The server checks the permission on every request with `need()` (`apps/server/src/app.ts:282`); the web app hides what the role cannot use, but the server is the rule.

| Permission | Owner | Administrator | Security auditor | Billing | Member | What it gates |
|---|---|---|---|---|---|---|
| `console.access` | yes | yes | yes | yes | no | Entering `#/admin`; `GET /api/dashboard` |
| `members.read` | yes | yes | yes | no | no | Listing members, departments, invitations |
| `members.manage` | yes | yes | no | no | no | Changing members, departments, invitations |
| `audit.read` | yes | yes | yes | no | no | `GET /api/audit`, `GET /api/audit/export`; checking the record and exporting it with fingerprints (`/api/audit/chain…`) |
| `settings.read` | yes | yes | yes | no | no | Sign-in settings, `GET /api/system` (Policies, Models) |
| `settings.manage` | yes | yes | no | no | no | Domain rules; the ceiling on modes (`PUT /api/settings/policy`, `apps/server/src/product.ts:177`) |
| `sessions.read` | yes | yes | yes | no | no | Listing sessions |
| `sessions.revoke` | yes | yes | no | no | no | Ending a session |
| `agents.read` | yes | yes | yes | no | no | `GET /api/agents` (roster) |
| `agents.manage` | yes | yes | no | no | no | Approve, suspend, restore an agent |
| `traces.read` | yes | yes | yes | no | no | Traces, spans, conversations, saved views, export, the Approvals page |
| `traces.annotate` | yes | yes | no | no | no | Adding and removing notes on a trace |

Two rules sit on top of the table (`roles.ts:69-82`). An owner may manage anyone and hand out any role. An administrator may manage, and hand out, only Security auditor, Billing and Member. Nobody else manages anyone. The Billing role has one more door that is not a permission: the dashboard gives it agent activity and cost but not people (`apps/server/src/observe.ts:562`, `:587`), and the menu shows it Usage (`apps/web/src/App.tsx:100`).

**Contents**

1. [Console shell and navigation](#console-shell-and-navigation)
2. [Overview](#overview)
3. [Members](#members)
4. [Departments](#departments)
5. [Invitations](#invitations)
6. [Sign-in & sessions](#sign-in--sessions)
7. [Activity log](#activity-log)
8. [Agent roster](#agent-roster)
9. [Traces](#traces)
10. [Usage](#usage)
11. [Approvals](#approvals)
12. [Policies](#policies)
13. [Models](#models)
14. [Sandbox](#sandbox)
15. [Connections](#connections)

---

## Console shell and navigation

**Who it is for.** Owner, Administrator, Security auditor, Billing. Gated by `console.access`. A Member has no access.

**The job.** "Get me to the page I need, show me only what my role can use, and let me get back to my own work."

**Where it starts.** In the workspace, the menu under the organization name has "Admin console", shown only with `console.access` (`apps/web/src/app/Workspace.tsx:257-264`); it goes to `#/admin`. Any address starting `#/admin` opens the console (`apps/web/src/App.tsx:164-166`).

**What they see and can do.**
- A left sidebar with four groups (`App.tsx:78-112`). Organization: Overview, Alerts (since 2026-11-24, with a count of new alerts; see "Alerts"), Members, Departments, Invitations. Security: Sign-in & sessions, Activity log. Agents: Agent roster, Traces, Usage, Approvals, Policies. Platform: Connections, Models, Sandbox (since 2026-11-24, MUS-54).
- Click a menu item → the address becomes `#/admin/<page>` and the page loads. No request is made by the shell itself.
- Who sees which item (`App.tsx:351-352`):

| Item | Needs | Owner | Admin | Auditor | Billing |
|---|---|---|---|---|---|
| Overview | nothing more | yes | yes | yes | yes |
| Alerts | `settings.read` | yes | yes | yes (reads only) | no |
| Members, Departments, Invitations | `members.read` | yes | yes | yes | no |
| Sign-in & sessions | `settings.read` | yes | yes | yes | no |
| Activity log | `audit.read` | yes | yes | yes | no |
| Retention | `settings.read` | yes | yes | yes | no |
| Agent roster | `agents.read` | yes | yes | yes | no |
| Traces, Approvals | `traces.read` | yes | yes | yes | no |
| Usage | `traces.read` or role Billing | yes | yes | yes | yes |
| Policies, Models, Sandbox | `settings.read` | yes | yes | yes | no |
| Connections | `members.read` | yes | yes | yes | no |

- "Back to Muster" at the foot of the sidebar → `#/`, the workspace. The organization's name is shown under it.
- Header: the page title; a language menu; an appearance menu (light, dark, system); a menu with the person's name and role. That menu shows their email and "Sign out".
- Sign out → `POST /auth/logout`, then the browser goes to `/` (`App.tsx:169-174`). In the desktop app the app ends its own session instead.
- On a narrow screen the sidebar is behind a menu button and closes when the page changes.
- The console is a frame that stays put: the sidebar and the rounded frame do not move, and the page scrolls inside the frame under its header. The document itself does not scroll and is not pulled past its ends, and a table's own sideways scroll does not carry over to the page (`App.tsx`, `components/ui/table.tsx`, `index.css`; CHA-235). Before, the whole document scrolled and the frame's edges slid with it. A new page starts at its top with the keyboard on the frame, so arrows, Page Down and Space scroll it. Up and down the document is not pulled past its ends; sideways it is left alone, so a swipe still goes back. Not built: going back does not return a page to where it was scrolled.

**Rules.**
- A person without `console.access` who opens `#/admin` sees a card: "<email> is a <role> of <org> and does not have access to the admin console", with "Back to Muster" and "Sign out" (`App.tsx:325-342`).
- An unknown page name, or a page the role may not see, silently shows Overview (`App.tsx:119-122`, `:353`). The address is not corrected.
- Every request under `/api` needs a live session (`app.ts:274-280`). The session is looked up on each request and is valid only while the person's membership is `active` (`apps/server/src/auth/session.ts:55-88`). So a role change applies at the person's next request, and a suspension or removal cuts them off at once.
- Every request that changes something must carry the site's own `Origin` (`app.ts:159-169`).
- Refusals a person can meet on any page, with the text the console shows (`apps/web/src/i18n/en.ts:105-143`; server text in `apps/server/src/errors.ts`):
  - `unauthenticated` (401): the app drops to the sign-in screen (`apps/web/src/lib/api.ts:283`).
  - `forbidden` (403): "Your role does not allow this."
  - `bad_origin` (403): "This request did not come from Muster."
  - `not_found` (404): "That no longer exists. Refresh and try again."
  - `invalid_request` (400): "The request was not valid."
  - `internal` (500): "Something went wrong on the server."
  - No connection: "Cannot reach the server. Check your connection and try again."
- Sign-out is recorded as `auth.logout` (`app.ts:252-270`).

**States.** While `/api/me` loads the screen is blank. Signed out: the sign-in screen. No console access: the card above. The current menu item is highlighted.

**How it is wired.**
- Screen: `apps/web/src/App.tsx:344` (`Console`), `:78` (`nav`), `:119` (`route`), `:325` (`NoAccess`), `:183` (`Preferences`)
- Requests: `GET /api/me` → `apps/server/src/app.ts:293`; returns user, org, role, permissions, session id. `POST /auth/logout` → `app.ts:252`; revokes the session.
- Data: `sessions`, `memberships`, `users`, `organizations` (`apps/server/src/schema.ts:27-83`). Language and appearance are kept in the browser.
- Events: `auth.logout`.
- Tests: `apps/server/src/roles.test.ts` (all five tests); `apps/server/src/app.test.ts:214` "requires a session for the API"; `:221` "refuses a state-changing request without our origin"; `:209` "ends the session on sign-out". No test covers which menu items a role sees: that logic is only in the web app.

**Rules that cannot be read.** A call is refused (`agent-scope`, with a sentence saying the rules could not be read) and the reply, or the check Muster was running, goes on; nothing is hidden and nothing is written down for the conversation.

**Not built.**
- No message when a role opens a page it may not see; it lands on Overview without a word.
- No search across the console, no breadcrumbs, no count badges on menu items (for example agents awaiting approval).
- No link from the console to the person's own settings; they must go back to the workspace.
- No organization settings page: the organization's name cannot be changed here (it comes from `MUSTER_ORG_NAME` at first sign-in, `apps/server/src/auth/admission.ts:149`).

**Design findings.**
- A Billing person who clicks "Agent roster" on Overview is sent back to Overview with no explanation (`apps/web/src/pages/Overview.tsx:208` is not gated). Smallest fix: hide that button without `agents.read`, and show "Your role cannot open this page" instead of silently falling back.
- Answered on 2026-11-14, for Policies: it now holds one setting an administrator can change, the ceiling on modes. What remains: "Models" sits in the menu like a settings page and changes nothing, and most of Policies is still read-only. Smallest fix: one line under each read-only card, "Set where the server is deployed".
- Answered on 2026-11-15: the preview with invented data is gone; Platform holds two real pages.
- Answered on 2026-11-14: the role text for Administrator now reads "Manages members, departments, invitations and sign-in rules, and approves, suspends and restores agents. Cannot touch owners or other administrators." (`apps/web/src/i18n/en.ts:98-99`). What remains: it still omits ending sessions and annotating traces.
- Answered on 2026-11-14: the role text for Billing now reads "Sees the overview, usage and cost. Changes nothing." (`en.ts:102`), which is what the dashboard gives it.

---

## Overview

**Who it is for.** Everyone with `console.access`. What is shown depends on the role.

**The job.** "In one screen, tell me whether agents are being used, whether they work, what they cost, and whether anything needs me."

**Where it starts.** `#/admin` or `#/admin/overview`; the first menu item.

**What they see and can do.**
- A period switch: Last 24 hours, 7 days, 30 days (default), 90 days. Changing it reloads the page's numbers. The choice is not kept in the address.
- Six headline numbers, each compared with the period just before (an arrow and a percentage, shown when the change is at least 0.5%): Runs; Success rate (with "N failed"); Median duration (with the 95th percentile); Cost (with cost per run); People using agents (with the count of active members, if the role may see people); Need attention (runs awaiting approval plus runs blocked by policy).
- Charts: Runs over time by how they ended; Busiest agents (top 8); Run duration (median and 95th percentile); Cost over time; What agents did (tool calls by action level A0–A4, with blocked counts); Agents by risk level R1–R4; Most used tools (top 8, by tool name such as `web.fetch`); Cost by department; Cost by model (top 4); Where runs happen (cloud or device); When agents are used (weekday by hour, UTC; the cell under the pointer is ringed and says what it is at once, "Tue 10:00 · 22 runs"; a click does nothing, since Traces cannot be filtered by weekday and hour; CHA-235).
- Hovering a chart shows the value. Clicking a bar, a point or a headline number does nothing.
- "Agent roster →" on the risk chart → `#/admin/agents`. "Usage →" on the department chart → `#/admin/usage`.
- A "People" card for roles with `members.read`: active members, pending invitations, active sessions, suspended, and active members by role. "Members →" opens Members.
- "Recent administrative activity": the six newest activity-log records, for roles with `audit.read`. "See all →" opens the Activity log. The rows open nothing.

**Rules.**
- The server decides what each role gets (`observe.ts:562-587`): Owner, Administrator and Auditor get activity and people; Billing gets activity and no people.
- Buckets are hours for "24 hours" and days otherwise, in UTC (`observe.ts:537`, `:624`).
- Cost is the sum of each run's recorded cost, in US dollars. It is zero if no price is set for the model (see Models).
- A range other than the four is refused with `invalid_request`.
- Nothing is written to the activity log for looking.

**States.** Loading text while the dashboard loads. A red notice if it fails. "No agent has run yet…" when there are no runs and no agents. The activity card shows "Nothing here for this period." when there are no records, and also when the role may not read the log.

**How it is wired.**
- Screen: `apps/web/src/pages/Overview.tsx:25` (`OverviewPage`); charts in `apps/web/src/components/charts.tsx` (`TimeBars:153`, `TimeLines:201`, `TimeArea:248`, `BarList:297`, `SegmentedBar:331`, `Heatmap:378`); headline card `apps/web/src/components/shared.tsx:87` (`Kpi`)
- Requests: `GET /api/dashboard?range=` → `apps/server/src/observe.ts:522`; reads only. `GET /api/audit?limit=6` → `apps/server/src/app.ts:804`.
- Data: `traces`, `spans` (model from `attributes->>'model'`, level from `attributes->>'actionLevel'`), `agents`, `memberships`, `departments`, `invitations`, `sessions` (`schema.ts`).
- Events: none.
- Tests: `apps/server/src/app.test.ts:574` "counts what is there"; `apps/server/src/observe.test.ts:431` "agrees with the trace list"; `:462` "shows cost to the billing role without opening traces to it".

**Not built.**
- No drill-down: no number or chart leads to the runs behind it.
- No alerts or thresholds (cost, failure rate, a queue of agents awaiting approval).
- No custom date range, no export, no scheduled report.
- No time zone choice: the heat map and daily buckets are UTC.

**Design findings.**
- "Need attention" shows a count and nothing to click. The Traces page already takes these filters in its address. Smallest fix: make the card a link to `#/admin/traces?status=awaiting_approval,blocked&range=<same>`; do the same for "N failed".
- "Need attention" counts runs in the past period that were blocked or waited. A run blocked three weeks ago needs nobody's attention today. Smallest fix: rename to "Blocked or waiting" or count only what is waiting now.
- "Agents by risk level" and its "N registered" count include agents their builders deleted (`observe.ts:610-619` has no `deleted_at` filter). Smallest fix: add `and deleted_at is null`.
- "Cost by department" files past cost under each person's department today (`observe.ts:647-654` joins the current membership). Move a person and their history moves too. Smallest fix: say "by current department" in the chart's lead.
- Labels such as "A3 · External, hard to undo", "R3 · Acts externally" and raw tool names like `web.send` appear with no explanation. Smallest fix: drop the codes from this page and show the words; show the tool's sentence (already in `en.ts:957-966`) instead of its name.
- For Billing the "Recent administrative activity" card says "Nothing here for this period.", which is untrue: they are not allowed to see it. Smallest fix: do not render the card without `audit.read`.
- "Where runs happen" always shows 100% Cloud: every run is recorded as `cloud` (`apps/server/src/runtime/runs.ts:516`). Smallest fix: hide the chart until runs on a device exist.

---

## Alerts

> Added 2026-11-24 (MUS-27). Before, the console showed failures, refusals, cost and waiting submissions only to someone who opened the right page and looked.

**Who it is for.** Owner, Administrator and Security auditor (`settings.read`). Only Owner and Administrator (`settings.manage`) acknowledge an alert, change a rule or set the webhook; the auditor reads. Billing and Member do not see the page, and its routes answer 403.

**The job.** "Tell me when something is going wrong, without my having to look. Say what, since when, and where to see it."

**Where it starts.** `#/admin/alerts`, the second item under Organization. The item carries a count of alerts nobody has acknowledged, asked for again every minute (`apps/web/src/App.tsx`, `/api/alerts/count`). The notice an owner or administrator gets ("Alert: Runs are failing. Open Alerts in the admin console.") opens the same page.

**The rules.** Six, built in (`apps/server/src/alerts.ts`, `RULES`). Each is on as it comes, and each has one number the organization can change. Three also have a window, one of 15 minutes, 1 hour, 12 hours or 24 hours: the ranges Traces can show, so the evidence link shows the same runs the rule counted.

| Rule | Opens when | Comes as | Can be set to | One alert per | Evidence opens |
| --- | --- | --- | --- | --- | --- |
| Runs are failing | the share of runs that failed in the window reaches the number, once there are 10 runs | 20% over 1 hour | 1–100% | organization | Traces, failed, same window |
| Actions keep being refused | calls the organization's policy refused in the window reach the number, for one person; or for one agent across two or more people. Counted from the gateway's `policy` steps that ended `blocked`. Not counted: calls held while a plan is being made (`plan-mode`, `plan-not-shown`), and calls the person declined or let expire, which are `approval` steps | 5 in 1 hour | 2–1000 | person, and agent | Traces, blocked, that person or agent |
| Spending is far above usual | asked once an hour, and at once after its number is changed: the last 24 hours cost the number times a usual day (the average of the 7 days before). Never below 1.00 a day, and not before 3 of those days had any spending | 3 times | 1.5–100 | organization | Usage |
| A submission is waiting for a decision | a marketplace submission has been pending for the number of hours | 24 hours | 1–720 | submission | Marketplace |
| Code cannot be run | the sandbox has not answered as ready for the number of minutes, counted from a mark kept in the database, so a restart or a second server process counts from the same moment. Says nothing on a server with no sandbox, and the page says so | 10 minutes | 1–1440 | organization | Sandbox |
| A model is failing | failed calls to one model in the window reach the number | 5 in 15 minutes | 1–1000 | model | Traces, failed, same window |

**How an alert lives.**
- The server asks every rule once a minute (`index.ts`; one pass at a time). While a rule's answer is yes there is exactly one alert for it and its subject: a unique index over alerts that are not resolved makes the second insert do nothing, so two server processes asking at once open one alert and send one notice.
- New → the alert is listed with a "New" mark, counts on the sidebar, every active owner and administrator gets one notice, and it is queued for the webhook if there is one.
- Still so a minute later → the same alert, its numbers brought up to date. Nobody is told again.
- "Acknowledge" (owner or administrator) → the mark becomes "Acknowledged" (hover says by whom), it stops counting on the sidebar and stays listed. Recorded as "Acknowledged an alert". Pressing it on one already acknowledged or resolved changes nothing and records nothing.
- No longer so → noted, and resolved once it has stayed that way for 3 minutes (`CLEAR_MINUTES`): a rate that dips under its number for one check has not gone away. So again within those minutes, the alert simply stays. A rule switched off resolves what it had open at once. Resolved, it moves to the "Resolved" tab with when, and the webhook is told. Nobody resolves an alert by hand: one resolved while still true would open again a minute later.
- So again within an hour of resolving (`REOPEN_MINUTES`) → the same alert is opened again as it was left (acknowledged stays acknowledged). No second notice, and nothing is sent to the webhook: the receiver was told it resolved and is not told it came back.
- So again later than that → a new alert and a new notice.
- Resolved alerts are kept 90 days.

**What they see and can do.**
- A card "Alerts" with two tabs. "Needs attention" (default): new ones first, then acknowledged, newest first; each row has the rule's name, a sentence with its numbers ("3 of 10 runs failed in the last hour (30%)."), since when, its state, a link to the evidence and, for a new one, "Acknowledge". Empty: "Nothing needs attention." with a line saying where alerts will appear. "Resolved": the last 100, with when each resolved; empty: "Nothing has resolved in the last 90 days." The list asks again every minute.
- A card "Rules": one line per rule, as a sentence with the number in a field ("When [20] % or more of runs fail in the last [hour]"), a line saying what the rule leaves out, and a switch. Changing the number or window shows "Save"; a number outside the range cannot be saved and the server refuses it (`invalid_alert_rule`). The switch saves at once. Each change is recorded as "Changed an alert rule" with the setting before and after. For the auditor the fields and switches are disabled.
- A card "Where alerts go": says that owners and administrators get a notice, and takes one webhook address.

**The webhook.**
- A public `https` address, checked like any address an agent fetches (`runtime/net.ts`): not this machine, not a private network, and a redirect is never followed. Refused otherwise (`invalid_alert_webhook`). Without `MUSTER_SECRET_KEY` the card says the server has no key to seal a secret with.
- Saving the first time, saving an address on another host, or "Make a new secret" in the "…" menu makes a signing secret (`whsec_…`), shows it once with "Copy", and keeps it sealed. It is never sent to a page again and never written to the activity log, which records the host only ("Set where alerts are sent").
- One POST when an alert opens and one when it resolves. Body: `{event: "alert.opened" | "alert.resolved", id, rule, state, subject, detail, openedAt, resolvedAt, organization, url}`. `subject` is the person's name, the agent's, the submission's or the model's, and `subjectId` tells two apart (`user:<id>`, `agent:<id>`): the address receives names and ids. A person's email address is never sent; someone with no name set is sent with an empty `subject`. Headers: `x-muster-delivery` (the same for every try of one delivery), `x-muster-timestamp` (seconds), `x-muster-signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>" under the secret>`.
- Any 2xx is delivered. Anything else is tried again 1, 5, 30 and 120 minutes after each failure: 5 tries in all, then given up on. Each delivery is claimed in the database before it is sent, so two processes do not send one twice. The card says how the last one went ("The last one was given up on 2 hours ago after 5 tries: HTTP 500").
- "Send a test" sends one made-up alert (`event: "test"`) now and says what the address answered. Recorded as "Sent a test alert".
- "Remove" (in the "…" menu, asks first) deletes the address and its secret and drops what was still waiting to be sent.

**Raised by other parts of the server.** `Alerts.raise(orgId, rule, subject, detail, label)` opens an alert for something the server finds out for itself, and `Alerts.clear(orgId, rule, subject?)` resolves it at once. Such an alert is told of, listed, acknowledged and sent like any other; it has no line under "Rules", cannot be switched off, and the timer never resolves it. The page has names for `audit_chain_broken` and `audit_forward_stalled`, whose evidence link opens the Activity log. Nothing raises them yet.

**Limits.** Windows and thresholds only within the ranges above. One webhook per organization. 100 rows per tab.

**Not built.** Mail and chat delivery. Rules of the organization's own. Per-person choice of which alerts to be told of. An alert for a run waiting on a person's approval (that is the person's own; the Overview counts them). Silencing a rule for a time. The spend rule compares 24-hour periods and does not know weekends from weekdays. An alert that comes back within the hour is not sent to the webhook again. Budgets and their notices are a separate piece of work (MUS-25).

**Routes.** `GET /api/alerts?state=open|resolved`, `GET /api/alerts/count`, `POST /api/alerts/:id/acknowledge`, `GET /api/alerts/rules`, `PUT /api/alerts/rules/:rule`, `PUT|DELETE /api/alerts/webhook`, `POST /api/alerts/webhook/test`. Tables `alert_rules`, `alerts`, `alert_webhooks`, `alert_deliveries`, and from a later step `alert_marks` with the indexes the rules read from (`traces_org_started_cost`, `spans_policy_blocked`, `spans_llm_error`). Tests: `apps/server/src/alerts.test.ts`, `apps/web/src/pages/alertLinks.test.ts`.

## Members

> Changed on 2026-11-15, by the owner's rules. What follows this note describes the page before it where the two differ; this note is the page as it is.
>
> - **Nobody is invited.** The company's sign-in decides who is in: anyone in the company's own directory becomes a member the first time they sign in (see platform section 1). "Invite member", the invite dialog and the Invitations page are gone from the console. The summary line says so.
> - **A row opens the person's full record** (`apps/web/src/pages/MemberDetail.tsx`, `GET /api/members/:id` in `apps/server/src/product.ts`), for `members.read`:
>   - who they are: department, when and how they joined, which sign-in they use, last sign-in;
>   - since 2026-11-17 (CHA-258), "Profile": which parts of their profile they have set (time zone, working hours, how they like answers, mail signature, language, …), by name. What any of them says is the person's alone and is not sent to this page. The activity log has "Changed their profile" with the names of the fields and nothing more;
>   - what their agents did in the last 30 days: runs, cost, tokens, failed and blocked, by agent;
>   - their latest runs, each opening its trace (only for `traces.read`);
>   - what they keep here, as counts only: conversations, documents, files, storage. What they wrote or were told is never shown;
>   - agents they built; services they connected and to which account; confirmations in 30 days;
>   - where they are signed in, each sign-in endable after a confirmation (`sessions.read`, `sessions.revoke`);
>   - what was done to their membership, from the activity log (`audit.read`);
>   - the actions: change role or department, suspend or reactivate, and behind "…" remove.
> - **Removed people are listed**, under a "Removed" filter that appears when there are any, with "Let back in" (`PATCH /api/members/:id {status: "active"}`; they return as a member with no department). A removed person stays out even though the directory still holds them. Nothing else about a removed person can be changed (404).
> - **Risky actions** (remove, here; delete and disconnect elsewhere) sit in a "…" menu and ask before acting, never as a visible button (`apps/web/src/components/more.tsx`).
> - Test: "everything the organization holds about one person" in `apps/server/src/product.test.ts`.

**Who it is for.** Reading: Owner, Administrator, Security auditor (`members.read`). Changing: Owner and Administrator (`members.manage`), within the reach rules.

**The job.** "See who is in the organization, bring someone in, give them the right role and department, and cut someone off quickly when I have to."

**Where it starts.** `#/admin/members`; the "Members →" button on Overview.

**What they see and can do.**
- A table of everyone who is active or suspended: name and email, role, department, status, the day they joined and how (Invitation, Domain rule, Created the organization), last sign-in. The person's own row carries "You". Removed people are not listed.
- A search box (name, email, department), a role filter, and All / Active / Suspended. All three filter the rows already loaded; no request is sent.
- Clicking a row does nothing.
- "Invite member" (with `members.manage`) → a dialog: work email, role, department → `POST /api/invitations`. See Invitations for what happens. The dialog offers only the roles the person may hand out.
  - Once the invitation exists the dialog does not close. It changes to a second step (`apps/web/src/pages/Members.tsx:340-413`): the title "<email> is invited"; "Muster does not send mail. The invitation lets them in; telling them is up to you."; then three numbered lines: "Send them the address of this Muster:" with the site's address and a "Copy" button; "They sign in there with <email>, through your company's sign-in."; "They join as <role>. The invitation is good for 14 days and is listed under Invitations until they use it."
  - Three buttons: "Invite another" (back to the form, with the email cleared and the role and department kept), "See invitations" (closes and goes to `#/admin/invitations`), "Close". The table behind is already up to date.
- The "…" menu on a row appears only when the person may manage that member: they have `members.manage`, it is not their own row, and the member's role is within their reach (`apps/web/src/pages/Members.tsx:151`).
  - "Change role or department" → a dialog with a role list and a department list → "Save" sends `PATCH /api/members/:id` with only what changed. The server updates `memberships.role` and/or `memberships.department_id`. Log: `member.role_changed` with from and to; `member.department_changed` with the new department's name. The person is not signed out; their new role applies at their next request.
  - "Suspend" → a confirmation ("They are signed out immediately and cannot sign in until reactivated. Their role and data are kept.") → `PATCH /api/members/:id {status:"suspended"}`. The server sets the status and ends every live session of that person, in the browser and in native apps (`app.ts:406-420`, `session.ts:97`). Once that change is committed, every run the person has in progress is stopped: each reply is kept as far as it got and marked stopped, and a confirmation it was waiting on is marked expired, so nothing more is sent (`app.ts:84-93`, `:446`; `apps/server/src/product.ts:128`; `apps/server/src/runtime/runs.ts:224-230`). Log: `member.suspended` with the number of sessions ended. If they try to sign in they see "Your account has been suspended. Contact your administrator." and the attempt is logged as `auth.login_denied`.
  - "Reactivate" (on a suspended member) → a confirmation → `PATCH … {status:"active"}`. Log: `member.reactivated`. They can sign in again with the same role and department. Their old sessions stay ended.
  - "Remove from organization" → a confirmation ("They are signed out immediately. They can only come back through a new invitation, even if their domain joins automatically.") → `DELETE /api/members/:id`. The server ends their sessions, keeps the membership row with status `removed`, role `member` and no department, and then stops every run the person has in progress, the same way as on suspension (`app.ts:449-474`). Log: `member.removed` with their former role and sessions ended.
- A card "What each role can do" with one sentence per role.

**Rules.**
- Nobody may change their own role or status or remove themselves: `self`, "You cannot change your own role or status. Ask another administrator." (`app.ts:362`).
- An administrator may not touch an owner or another administrator, nor give anyone those roles: `owner_only`, "Only an owner can manage owners and administrators." (`app.ts:363`, `:392`).
- The organization keeps at least one active owner: demoting, suspending or removing an active owner is refused with `last_owner`, "The organization must keep at least one owner.", if no other active owner remains (`app.ts:368-374`). Because the actor must be a different active owner, this check only bites in a race; the organization row is locked for each change so two owners cannot demote each other at once (`app.ts:335-365`).
- A department that no longer exists: `department_missing`, "That department no longer exists."
- A member who is already gone: `not_found`.
- A refused change writes nothing to the log (the transaction rolls back).
- Suspending or removing a person ends the runs they have in progress. After any member change that went through, the server looks whether the person still has an active membership; if not, it stops their runs (`app.ts:84-93`). A change of role or department stops nothing. Stopping a run is not itself written to the activity log; each stopped run is in Traces. The member events do not say how many runs were ended.
- A removed person is not let back in by a domain rule; only a new invitation works (`admission.ts:125-133`).

**States.** Loading; a red notice if the list fails; "No members match." when the filters leave nothing. Status badge: green Active, red Suspended. Errors from a dialog appear in red inside the dialog.

**How it is wired.**
- Screen: `apps/web/src/pages/Members.tsx:64` (`MembersPage`), `:324` (`InviteDialog`; its second step `:340-413`), `:475` (`EditDialog`), `:544` (`ConfirmDialog`)
- Requests: `GET /api/members` → `app.ts:306`. `GET /api/departments` → `app.ts:478`. `PATCH /api/members/:id` → `app.ts:376`. `DELETE /api/members/:id` → `app.ts:449`. `POST /api/invitations` → `app.ts:597`.
- Data: `memberships` (role, status, department_id, joined_at, joined_via), `users` (email, name, last_login_at), `departments`, `sessions.revoked_at` (`schema.ts:27-83`).
- Events: `member.role_changed`, `member.department_changed`, `member.suspended`, `member.reactivated`, `member.removed`; from sign-in: `member.joined`, `auth.login_denied`.
- Tests: `app.test.ts:241` "lets an administrator manage ordinary members but not owners or administrators"; `:286` auditor reads and changes nothing; `:316` members and billing kept out; `:336` no self-change; `:348` "lets one owner demote another"; `:357` "rejects malformed changes"; `:389` suspended cut off and let back; `:408` and `:417` removed stays out; `apps/server/src/product.test.ts:949` "ends their run when they are suspended, and nothing is sent". No test covers a run ended by removal. No test reaches the `last_owner` refusal.

**Single sign-on and provisioning (since 2026-11-24, MUS-30).** Two cards in the right column, for those with `settings.read`; buttons only with `settings.manage` (`apps/web/src/pages/Sso.tsx`; how it works: platform.md, section 1).

- **Single sign-on (SAML).** An owner's to set up: "Set up" opens a dialog with two fields, "Metadata address" and "Or paste the metadata", and Save. The card then shows the provider's host, until when its certificate is valid, and one of three marks: "Not tried", "Works", "On". "Try it" sends the owner through the provider and back to this page, and makes their account there theirs here. "Switch on" is greyed until that has worked once; it asks first, saying that the sign-in page will then offer only this. "Switch off" asks too. The "…" menu has Change and Remove. Once it is on, an administrator sees one button, "Connect my account": owners and administrators are never matched by their address. Under it, always: Muster's "Entity ID" and "Reply URL (ACS)", each with a copy button, for the provider's side.
- **Provisioning (SCIM).** The address to give the directory, with a copy button; the tokens as their last four characters and when each was last used; "New token" (an owner's; up to five) opens a dialog that shows the token once; "Revoke" asks first.
- Refusals shown in place: metadata that is not metadata, an address that cannot be read, switching on before it has worked, a sixth token.
- Not built: a page of what the directory last did (it is on the Activity log, actor `scim`), mapping directory groups to roles, a warning before a certificate runs out.

**Not built.**
- No page for one person: nothing shows their sessions, agents, runs, files, cost or history together.
- Removing a person deletes nothing: their conversations, documents, files and agents stay. There is no purge of a person's data and no transfer of what they own to someone else.
- No list of removed people, and no "undo remove": they return only by a new invitation.
- No bulk actions, no CSV import, no export of the member list. (Directory sync: SCIM, under Sign-in & sessions.)
- No paging: the server returns every member in one answer.
- No notice to the person affected (no email exists anywhere in Muster).
- Removing or suspending a person does not disconnect their Microsoft 365: the sealed tokens stay in `connections` until the user row itself is deleted. Their runs are ended and cannot start, so the tokens are not used. No page shows that a person has a connection.

**Design findings.**
- Answered on 2026-11-14: after "Create invitation" the dialog says what happens next, in three steps, with the address to send and a button to copy it (`Members.tsx:340-413`). What remains: the "14 days" in it is written into the sentence, not read from the server, which returns the real number (`invitationDays` in `GET /api/settings/sign-in`); the address shown is the browser's own (`location.origin`), which in the desktop app or behind a second host name may not be the one the invited person should use; and the step says "through your company's sign-in" even on a server whose only provider is Google.
- "Remove from organization" does not say what happens to the person's files, documents, conversations and agents (they all stay, and nobody can reach them from the console). Smallest fix: add to the confirmation "Their conversations, files and agents are kept on record; nothing is deleted."
- Answered on 2026-11-14: suspending or removing a person now ends the runs they have in progress (`app.ts:84-93`, `runs.ts:224-230`). What remains: the confirmations do not say so, and the log does not say how many runs were ended.
- A role change takes effect on Save with no confirmation, including making someone an Owner. Smallest fix: confirm when the new role is Owner or Administrator.
- Rows open nothing, so the only way to learn about a person is to copy their email into Traces or the Activity log by hand. Smallest fix: make the row link to `#/admin/traces?user=<email>&range=30d`.
- A row with no "…" menu gives no reason (own row, or an owner seen by an administrator). Smallest fix: a disabled menu with the reason as its tooltip.
- "Reactivate" here, "Restore" on the Agent roster, "Turn on" on domain rules: three words for bringing something back. Smallest fix: pick "Restore" for people too.

---

## Departments

> Since 2026-11-15 (CHA-222) the page is laid out like the other lists. The departments are
> a table: Department, People (how many, then each with their role where it is not Member),
> Runs in 30 days, Cost in 30 days with its bar, and the "…" menu, whose column stays in
> sight. Creating a department is a field and a button in the card's header, not a card of
> its own. "No department" stays in the column on the right. Where the text below describes
> rows with chips and a separate "Create department" card, this is what is there now.
> Across the console, a card's title, lead and filters sit closer together, and a table's
> head is a band of its own with a line above and below
> (`apps/web/src/components/ui/card.tsx`, `table.tsx`).

**Who it is for.** Reading: `members.read` (Owner, Administrator, Auditor). Changing: `members.manage` (Owner, Administrator).

**The job.** "Group people the way the company is organized, so cost can be read per department."

**Where it starts.** `#/admin/departments`.

**What they see and can do.**
- Two columns on a wide screen, so the page is not a three-column table stretched across it (the owner, 2026-11-15: "那么大的空白"). The same layout is used for the other pages that hold little: Sign-in & sessions, Connections, Models, Policies.
- Left, one block for each department: its name, how many members, its runs and cost in the last 30 days with a bar against the costliest department (from `GET /api/dashboard?range=30d`; left out for a role that may not see runs), and under it every active member as a chip with their role where it is not Member. A department with nobody says so.
- Right, "Create department": a text box and a button → `POST /api/departments {name}`. Log: `department.created`.
- Right, "No department": the active members in no department, each with "Move to…" → `PATCH /api/members/:id {departmentId}`. Log: as for any change of department.
- "Rename" → a dialog ("Members stay where they are.") → `PATCH /api/departments/:id {name}`. Log: `department.renamed`.
- "Delete" → a confirmation that says how many members become unassigned → `DELETE /api/departments/:id`. The database clears the department on those members and on any invitation that named it (`schema.ts:49`, `:59`). Log: `department.deleted`. The affected members get no log record of their own.
- People are put into a department from Members ("Change role or department") or at invitation.

**Rules.**
- A name has 1 to 60 characters after trimming: `invalid_department_name`.
- Names are unique in the organization, compared exactly: `department_exists`, "A department with this name already exists." ("Sales" and "sales" are two departments.)
- Departments are flat; a person is in one or none.
- A department only affects two things today: the label on a member, and the grouping of cost on Overview and Usage.

**States.** Loading; red notice on failure; "No departments yet." The auditor sees the table without the form and buttons.

**How it is wired.**
- Screen: `apps/web/src/pages/Departments.tsx:25` (`DepartmentsPage`), `:123` (`RenameDialog`), `:176` (`RemoveDialog`)
- Requests: `GET /api/departments` → `app.ts:478`. `POST` → `app.ts:492`. `PATCH /:id` → `app.ts:515`. `DELETE /:id` → `app.ts:546`.
- Data: `departments` (id, org_id, name), `memberships.department_id`, `invitations.department_id`.
- Events: `department.created`, `department.renamed`, `department.deleted`.
- Tests: `app.test.ts:466` "creates, renames, assigns and deletes".

**Not built.**
- No per-department permission, budget, agent or policy anywhere in the server. The page's lead no longer promises them.
- No department head, no nesting, no list of who is in a department, no moving several people at once.

**Design findings.**
- Answered on 2026-11-14: the lead now reads "Departments group members, and cost is reported by department." (`en.ts:254`), in both languages.
- The member count is a dead number. Smallest fix: link it to Members with the department in the search box.
- Deleting a department leaves no trace on the people it held: the log shows `department.deleted` only. Smallest fix: put the member count in the event's detail.
- Names differing only by case are accepted as two departments. Smallest fix: compare case-insensitively.

---

## Invitations

> Removed from the console on 2026-11-15. The owner: a company signs its people in through its own sign-in; nobody is invited. The page, its menu entry and the invite dialog are gone. The server routes (`/api/invitations`) remain and are used only by tests and by a deployment that signs in with a provider that is not the company's own directory; nothing in the console reaches them. What follows describes the page as it was.

**Who it is for.** Reading: `members.read`. Sending and withdrawing: `members.manage`, limited to the roles the person may hand out.

**The job.** "Let a named person in, with the right role, and see who has not taken up their invitation."

**Where it starts.** `#/admin/invitations`; or "Invite member" on Members, which opens the same dialog.

**What they see and can do.**
- A notice: "Invitations are not emailed. Send the sign-in address to the person." with "Copy sign-in address", which copies the site's address to the clipboard. No request.
- A table of the 200 newest invitations: email, role, department, status (Waiting for sign-in with "expires in N days", Joined, Withdrawn, Expired), invited by, and the date it was made, under "Created". Rows open nothing.
- "Invite member" → dialog (work email, role, department), whose button reads "Create invitation" → `POST /api/invitations {email, role, departmentId}`. The server stores an invitation that expires in 14 days. Log: `invitation.created` with the role. Nothing is sent to the person. The dialog then stays open on a second step, "<email> is invited", that says so and gives the address to pass on, with "Invite another", "See invitations" and "Close" (described under [Members](#members)). The table behind it has already been loaded again (`apps/web/src/pages/Invitations.tsx:138-147`).
- What the invitation does: when someone signs in with that exact address through a configured provider, and the provider says the address is verified, they become a member with the invited role and department, the invitation is marked accepted, and `member.joined` is logged with "via invitation" (`admission.ts:126-184`).
- "Withdraw" on a waiting invitation → `DELETE /api/invitations/:id` at once, with no confirmation. The server sets `revoked_at`. Log: `invitation.revoked`. The address can no longer join with it.

**Rules.**
- The email must be a plain ASCII address; it is lower-cased. Otherwise `invalid_invitation`, "Enter a valid email address and a role."
- A role beyond the sender's reach: `owner_only`. The same applies to withdrawing an invitation to such a role (`app.ts:670`).
- The address already belongs to a member of any organization, or to someone removed from a different one: `already_member` (`app.ts:617-621`). Someone removed from this organization can be invited again.
- One open invitation per address across all organizations: `already_invited`. An expired invitation of this organization is cleared automatically when a new one is sent (`app.ts:629-634`).
- A department that does not exist: `department_missing`.
- Domain rules are a separate way in; they live on Sign-in & sessions.

**States.** Loading; red notice on failure; "No invitations yet." A withdraw error shows above the table.

**How it is wired.**
- Screen: `apps/web/src/pages/Invitations.tsx:26` (`InvitationsPage`); the dialog is `apps/web/src/pages/Members.tsx:324` (`InviteDialog`)
- Requests: `GET /api/invitations` → `app.ts:578`. `POST /api/invitations` → `app.ts:604`. `DELETE /api/invitations/:id` → `app.ts:662`. `GET /api/departments` → `app.ts:485`.
- Data: `invitations` (email, role, department_id, invited_by, expires_at, accepted_at, revoked_at; unique open invitation per email, `schema.ts:54-68`).
- Events: `invitation.created`, `invitation.revoked`; on use, `member.joined`.
- Tests: `app.test.ts:79` invited person admitted; `:88` address normalized; `:96` "refuses a revoked or expired invitation"; `:116` "will not invite a member or invite the same address twice"; `:273` administrator cannot withdraw an invitation to a role it could not grant; `:71` unverified address refused even when invited.

**Not built.**
- No email, no invitation link, no reminder. The administrator must tell the person by other means.
- No "send again" or "extend": an expired invitation is replaced by making a new one by hand.
- No bulk invitation, no CSV.
- No paging or search; only the newest 200 are returned.
- The 14-day life is fixed in code (`app.ts:36`).

**Design findings.**
- Answered on 2026-11-14: the button says "Create invitation" and the column "Created"; the activity log labels `invitation.created` "Created an invitation" (`en.ts:169`); the empty state reads "No invitations yet." (`en.ts:296`); and after creating one the dialog says what to do next. What remains: the page's own notice and the dialog's second step say the same thing in two different wordings, and there is still no link the invited person can simply open.
- "Withdraw" acts on one click with no confirmation, next to rows that look alike. Smallest fix: the same confirm dialog the roster uses.
- An administrator sees "Withdraw" on an invitation to an Owner and gets "Only an owner can manage owners and administrators." after clicking. Smallest fix: hide the button when the role is out of reach (the page already has `grantable`).
- A person signing in with a different address from the one invited is refused as "This account has not joined an organization" and the administrator sees nothing: that refusal is not logged (`admission.ts:133`). Smallest fix: log `auth.login_denied` with reason `not_member` when an organization can be named, or say on this page that the address must match exactly.
- Withdrawn, expired and joined invitations stay in the list for ever and push waiting ones down. Smallest fix: a "Waiting / All" switch, waiting first.

---

## Sign-in & sessions

**Who it is for.** Reading: `settings.read` and `sessions.read` (Owner, Administrator, Auditor). Domain rules: `settings.manage`. Ending sessions: `sessions.revoke` (both Owner and Administrator).

**The job.** "Know how people get in, decide whether a whole company domain may join without invitations, and throw out a session I do not trust."

**Where it starts.** `#/admin/security`.

**What they see and can do.**
- "Sign-in": only the identity system this company signs in with, with its directory (the Microsoft tenant, or the host of the company's own provider), and how long a sign-in lasts. Ways the company does not use are not listed (the owner, 2026-11-15: a buyer's technical lead asks why several are shown; until then Google and the company's own provider were listed as "Not configured", which reads as things left undone). Read-only, and the page says where it is set. The company's own provider is listed under the name the operator gave it (`MUSTER_OIDC_LABEL`), or "Company account" when it has none or is not set up (`apps/web/src/pages/Security.tsx:30-40`). If the development sign-in is on, a red notice says anyone can sign in as any address. In the session table and in the activity log its sign-ins show as the bare word `oidc`, because the console has no name for it (`apps/web/src/i18n/en.ts:150`). It says who gets in: everyone in that directory, on first sign-in; not a guest of it. The "Domain rules" card is gone with invitations. Ending someone's sign-in asks first.
- "Domain rules" (changed 2026-11-15, CHA-182): the page no longer adds rules. Where rules set earlier still exist, a card lists each with whether it joins people automatically, and "Remove rule" in its "…" menu; with none, the card is not shown. The routes below still exist. Mailbox providers under any ending (`outlook.de`) and endings themselves (`co.uk`) are refused for automatic joining.
- Pending invitations (CHA-181): nobody is invited from the console. Any invitation still pending is listed on Members, under the member table, with who it is for, the role it gives, when it expires and "Withdraw" in its "…" menu; with none, nothing is shown.
- What follows describes the routes as they are:
  - Type a domain, "Add domain" → `PUT /api/settings/sign-in/domains/<domain> {autoJoin:false}`. The domain is stored with automatic joining off. Log: `signin.domain_set` ("invitation still required").
  - "Turn on automatic joining" → the same request with `autoJoin:true`, at once, no confirmation. From then on, anyone who signs in with an address at that domain, whose provider proves the domain manages the account, becomes a Member with no department (`admission.ts:222-231`). Log: `signin.domain_set` ("joins automatically"); each person who joins is logged as `member.joined` "via domain rule".
  - "Require invitation" → the same request with `autoJoin:false`. People who already joined stay.
  - "Remove" → `DELETE /api/settings/sign-in/domains/<domain>`, at once. Log: `signin.domain_removed`. People who already joined stay.
- "Active sessions": up to 500 live sign-ins, newest activity first: person, method, device (browser and system, guessed from the user agent), IP address, last active. The viewer's own session is marked "Current".
  - "End" on any session but the current one → `DELETE /api/sessions/:id`, at once. The server marks the session revoked. Log: `session.revoked` with the person's email. That browser or app is signed out at its next request; the person can sign in again straight away.

**Rules.**
- Sign-in methods (Google, one Microsoft directory, the company's own OpenID Connect provider), the session length (`MUSTER_SESSION_DAYS`, default 7) and the proxy setting are set where the server is deployed (`apps/server/src/config.ts`), not here. See [platform: Sign-in](platform.md#1-sign-in-admission-and-sessions).
- With the company's own provider, a domain rule admits a person only when the operator has set `MUSTER_OIDC_TRUST_EMAIL=1`: without it the provider proves no domain, and people join by invitation only (`apps/server/src/auth/oidc.ts:59-70`).
- A domain must look like `example.com`: `invalid_domain`.
- Automatic joining is refused for public mailbox domains (gmail.com, outlook.com, qq.com and others, `app.ts:39-46`): `public_domain`, "A public mailbox domain cannot join automatically: anyone could get in."
- A domain belongs to one organization: `domain_taken`.
- A rule with automatic joining off lets nobody in. Its only effect is that no other organization on the same server can claim the domain.
- An administrator may end their own sessions and those of auditors, billing and members; ending an owner's or another administrator's is refused with `owner_only` (`app.ts:788`).
- Removed and suspended people have no sessions to show: suspending and removing end them all.
- Signing in with Microsoft and connecting Microsoft 365 use the same registration of Muster with Microsoft (`MUSTER_MICROSOFT_*`). This page shows the first and nothing of the second: whether connections are offered on this server, and who has connected, are not shown anywhere in the console. The only trace is `connector.connected` and `connector.disconnected` in the Activity log.

**States.** Loading; red notice on failure; "No domain rules. Only invited people can join." One shared error line under the domain form serves domain and session actions alike.

**How it is wired.**
- Screen: `apps/web/src/pages/Security.tsx:19` (`SecurityPage`); device text from `apps/web/src/lib/events.ts:29`
- Requests: `GET /api/settings/sign-in` → `app.ts:696` (providers, domains, session days, invitation days). `PUT /api/settings/sign-in/domains/:domain` → `app.ts:711`. `DELETE …/:domain` → `app.ts:739`. `GET /api/sessions` → `app.ts:763`. `DELETE /api/sessions/:id` → `app.ts:778`.
- Data: `org_domains` (domain, auto_join), `sessions` (public_id, provider, kind, last_seen_at, expires_at, revoked_at, ip, user_agent). Providers come from configuration, not the database.
- Events: `signin.domain_set`, `signin.domain_removed`, `session.revoked`; sign-in itself writes `auth.login`, `auth.login_denied`, `member.joined`.
- Tests: `app.test.ts:133` domain admits members only when the rule says so; `:145` public mailbox domain refused; `:442` "lists live sessions and lets an administrator end one"; `:454` administrator cannot end an owner's session; `:417` removed person stays out despite a domain rule.

**Not built.**
- Nothing about sign-in can be set here: no provider setup, no session length, no idle timeout, no IP allow list, no requirement for a second factor (that is left to the identity provider).
- No "end all sessions of this person" or "end all sessions"; suspending the person is the only way to end all of theirs.
- No way to restrict sign-in to listed domains: an invitation to any address works.
- The session list does not say whether a session is a browser or a native app, though the server returns `kind` (`app.ts:761`).
- No record of failed sign-ins by strangers, and no sign-in history per person other than the Activity log.
- No list of people's connections to other services (Microsoft 365), no way to end one, and no switch to turn connections off for the organization.
- No sign that Microsoft sign-in depends on the directory sending the optional `xms_edov` claim: when it is missing every Microsoft user is refused, and this page still says "Enabled".

**Design findings.**
- "Turn on automatic joining" opens the organization to a whole domain on one click. Smallest fix: a confirmation that names the consequence: "Anyone with an @domain account managed by that company becomes a member."
- "Add domain" creates a rule that does nothing ("Invitation required"), which reads as if only that domain may be invited. Smallest fix: make "Add domain" ask the one real question ("Let everyone at this domain join?") or explain the row: "No effect until automatic joining is on."
- Answered on 2026-11-14: the card lists the company's own provider under the name the operator gave it (`Security.tsx:30-40`). What remains: in the session table and the activity log its sign-ins are named by the console's own word for it ("Company account", `t.providers.oidc`), not by the operator's label (`Security.tsx:199`, `apps/web/src/lib/events.ts:22`, `en.ts:155`).
- A person's Microsoft 365 connection is a standing way into their mailbox, held by this server, and the security page does not mention it. A security auditor asked "which accounts has Muster been given access to?" has to search the activity log for two action names and pair them up by hand. Smallest fix: a fourth card, "Connected services": person, account, since, with "Disconnect" for `sessions.revoke`.
- The owner signed in with a real Microsoft directory on 2026-11-14 and it worked. Nothing on this page would have told them why if it had not: the commonest cause, the missing `xms_edov` claim, shows only as "The sign-in provider did not confirm that this email address is yours." on the sign-in page. Smallest fix: a line under Microsoft, "Needs the optional claim xms_edov in the app registration", and log `auth.login_denied` with reason `email_unverified`.
- An administrator sees "End" on an owner's session and is refused after clicking. Smallest fix: the list already has each person's email; return the role and hide the button.
- "End" has no confirmation and a session row looks like its neighbours. Smallest fix: confirm with the person's name and device.
- A domain or session error appears under the domain form, far from the session table that caused it. Smallest fix: one error line per card.
- The domain card never says the provider must prove the domain (Google Workspace `hd`, Microsoft's verified-domain claim, the operator's word for the company's own provider, `apps/server/src/auth/oidc.ts:41-70`). A personal Google account at a company address will be refused and the administrator will not know why. Smallest fix: one sentence in the card's lead.

---

## Activity log

**Who it is for.** `audit.read`: Owner, Administrator, Security auditor.

**The job.** "Show me who did what and when, so I can answer a question from security or from a manager."

**Where it starts.** `#/admin/audit`; "See all →" on Overview.

**What they see and can do.**
- A table, newest first, 50 records at a time: time, by (email), action, on (the target's label), detail, IP address.
- A search box, "Search the whole record: a person, an action, what it was done to". 0.3 seconds after typing stops the list is loaded again from the server with `q=<the words>`. The server looks for the words, case ignored, in three places: who did it (the email), the action's own name (such as `trace.viewed` or `member.suspended`), and the label of what it was done to. The page also works out which actions have a label, in the reader's language, that holds the words, and sends their names along as `actions=`; records of those actions match too. So "Signed in" finds sign-ins, and so does `auth.login` (`apps/web/src/pages/Audit.tsx:36-48`, `app.ts:890-896`, `:923-924`).
- "From" and "To": two date boxes. Either or both narrow the list to records of those days, both days included. Changing one loads the list again.
- "Export CSV" → the browser downloads `GET /api/audit/export?<the same search and dates>` as `muster-activity-log.csv`: up to 10,000 records, newest first, with the columns time, actor, action (its own name), target_type, target, detail (as stored, in JSON) and ip. Hovering the button says "Up to 10,000 records matching the search. Exporting is itself recorded." Log: `audit.exported` with the number of rows and the search and dates used.
- "Load older records" → `GET /api/audit?limit=50&before=<seq of the last row>&<the same search and dates>`; appends them. The button disappears when a page comes back short.
- Rows open nothing.
- The detail column is a short sentence built from a few known fields (`apps/web/src/lib/events.ts:5-26`): role from → to, "to <department>", "via invitation", "N sessions ended", "joins automatically", "account suspended", the provider, a note's label, "N rows".

**Rules.**
- Records are only ever added; no code edits or deletes one. They go with the organization if it is deleted (`schema.ts:95-109`).
- Every record carries the fingerprint of the one before it, so a record changed or removed in the database is found by a check. See "The record proves itself" below.
- A record is written in the same transaction as the change it describes, so a refused change leaves no record (`apps/server/src/audit.ts:13`).
- The IP address is the connection's address, or the last `X-Forwarded-For` entry when the operator has said a proxy sets it (`app.ts:100-110`).
- `before` must be a whole number, else `invalid_request`. `limit` is capped at 100.
- `q` is trimmed and cut to 100 characters; `%`, `_` and `\` in it are plain characters, not wildcards. `from` and `to` must be written `YYYY-MM-DD` and be a day of the calendar (`2026-02-30` is refused), else `invalid_request` (`app.ts:884-897`, `:908`). `actions` is a list of at most 60 names made of lower-case letters, dots and underscores; anything else in it is dropped.
- A day is a day of the database's clock. Not verified: which time zone that is in a deployment; the page sends the date as typed.
- The search does not look in the detail column. Finding an action by its label depends on the page sending the names: a request made without `actions=` matches an action only by its own name.
- The export holds what the list would show for the same search and dates, to at most 10,000 records. It says nowhere when it was cut at 10,000. A cell that begins with `=`, `+`, `-`, `@`, a tab or a return gets a leading apostrophe, so a spreadsheet runs nothing (`app.ts:831-836`). The file starts with a byte-order mark so that a spreadsheet reads it as UTF-8.
- Exporting needs `audit.read`, the same as reading. The `audit.exported` record is written after the rows are read, so an export does not contain its own record.
- Opening someone else's run in Traces is recorded as `trace.viewed`, at most once an hour for each reader and run (`observe.ts:263-282`). Opening one's own run is not recorded.
- Every action name written anywhere in the server:

| Action | Written at | When | Label in the console |
|---|---|---|---|
| `org.created` | `auth/admission.ts:150` | First sign-in of the configured owner creates the organization | Created the organization |
| `auth.login` | `app.ts:214`, `auth/app-routes.ts:135` | A sign-in in a browser or a native app | Signed in |
| `auth.logout` | `app.ts:259` | Sign-out | Signed out |
| `auth.login_denied` | `auth/admission.ts:87`, `:115` | A suspended person, or an address linked to another account, tries to sign in | Sign-in refused |
| `member.joined` | `auth/admission.ts:176` | First entry by invitation, domain rule or as first owner | Joined |
| `member.role_changed` | `app.ts:396` | Role changed | Changed role |
| `member.department_changed` | `app.ts:435` | Department changed | Changed department |
| `member.suspended` | `app.ts:412` | Suspended | Suspended member |
| `member.reactivated` | `app.ts:412` | Reactivated | Reactivated member |
| `member.removed` | `app.ts:463` | Removed | Removed member |
| `department.created` | `app.ts:504` | | Created department |
| `department.renamed` | `app.ts:535` | | Renamed department |
| `department.deleted` | `app.ts:558` | | Deleted department |
| `invitation.created` | `app.ts:643` | | Created an invitation |
| `invitation.revoked` | `app.ts:676` | | Withdrew invitation |
| `signin.domain_set` | `app.ts:720` | Domain added or its rule switched | Set domain rule |
| `signin.domain_removed` | `app.ts:743` | | Removed domain rule |
| `session.revoked` | `app.ts:791`, `product.ts:657` | An administrator ends a session, or a person signs out one of their own devices | Ended session |
| `agent.created` | `product.ts:254` | A person builds an agent | Built an agent |
| `agent.changed` | `product.ts:302`, `:46` | A builder edits an agent; or a new release changes a platform agent (actor "muster (new release)") | Changed an agent |
| `agent.deleted` | `product.ts:329` | A builder deletes their agent | Deleted an agent |
| `agent.approved` | `product.ts:376` | Administrator approves a waiting agent | Approved an agent |
| `agent.suspended` | `product.ts:376` | Administrator suspends an agent | Suspended an agent |
| `agent.restored` | `product.ts:376` | Administrator restores a suspended agent | Restored an agent |
| `approval.approved` | `product.ts:766` | A person allows an action their agent asked for | Approved an action |
| `approval.rejected` | `product.ts:766` | A person refuses it | Rejected an action |
| `trace.annotated` | `observe.ts:341` | A note is added to a run | Annotated a trace |
| `trace.annotation_removed` | `observe.ts:366` | A note is removed | Removed an annotation |
| `traces.exported` | `observe.ts:233` | The trace list is exported as CSV | Exported traces |
| `trace.viewed` | `observe.ts:278` | Someone opens a run that is not their own; once an hour for each reader and run. The target's label is the email of the person whose run it is | Opened someone else's run |
| `audit.exported` | `app.ts:827` | The activity log is exported as CSV | Exported the activity log |
| `project.item_added`, `project.item_changed`, `project.item_removed` | `projectItemRoutes.ts:25` | Something that lives in a project (a repository, a guide, an environment, a link, a contact, a fact) is added, changed or removed, by a person on the project's page or by an agent for them (`detail.agent`). The target is the project; the detail holds the kind and the name | Added something to a project / Changed something kept in a project / Removed something from a project |
| `retention.changed`, `retention.hold_on`, `retention.hold_off` | `retention.ts` | The periods are changed; a legal hold is placed or lifted | Changed how long things are kept / Placed a legal hold / Lifted the legal hold |
| `retention.purged` | `retention.ts` | The daily purge removed something. The actor is "muster" | Purged what was past its period |
| `member.erased` | `retention.ts` | Everything of a removed member is erased | Erased a removed member's data |
| `audit.verified` | `chain.ts` | Someone checks that the record proves itself | Checked that the activity log proves itself |
| `audit.forward_set`, `audit.forward_changed`, `audit.forward_removed` | `chain.ts` | Sending the record on is set up, changed or stopped | Set the activity log to be sent on / Changed where the activity log is sent on to / Stopped sending the activity log on |
| `agents.model_changed` | `product.ts:82` | The first listing of agents (`GET /api/app/agents`) after the server came up with a different model: every agent's version is worked out again, and if any changed, one record is written (actor "muster (configuration)"; the target's label is the model now configured; the detail holds the model and how many agents changed). The same record is written when a new release changed a platform agent's instructions or tools, because that changes its version too, though the model is the same | The model all agents run on was changed |
| `file.uploaded` | `files/service.ts:131` | A person uploads a file | Uploaded a file |
| `file.created` | `files/service.ts:131` | An agent makes a file | An agent made a file |
| `file.deleted` | `files/service.ts:313` | A person deletes a file | Deleted a file |
| `policy.tool_changed` | `toolPolicy.ts` | A rule on a tool is set, changed or taken away, for everyone or a department. `detail`: `department`, `before`, `after` | Changed what agents may do with a tool |
| `policy.scope_changed` | `toolPolicy.ts` | What an agent (or every agent) may reach is changed. `detail`: `before`, `after` | Changed what an agent may reach |
| `policy.changed` | `product.ts:197` | An owner or administrator changes the most freedom people may give agents (Policies). Written only when the value changed. Target `max_mode`, labelled with the new mode's code (`ask`, `auto`, `full`); the detail holds `from` and `to` | Changed how far agents may go without asking |
| `connector.connected` | `connectors.ts:159` | A person connects their Microsoft 365. The actor is the person (their Muster email); the target's label is the Microsoft account. Written from the address Microsoft sends the person back to, which needs no session | Connected a service |
| `connector.disconnected` | `connectors.ts:181` | A person disconnects it in Settings. Not written when the connection ends by itself (consent taken back at Microsoft, or a key the server no longer has) | Disconnected a service |

- The line numbers in the table above for `app.ts` and `product.ts` rows other than the last three are from before `epic/cha-167-local-work`; the actions and what they mean have not changed.
- Not recorded on this branch's new features: making, changing or deleting a project; attaching or detaching a folder on a computer; anything an agent reads or writes in a folder (it is in the trace); anything an agent reads from Microsoft 365 (it is in the trace); a person changing a conversation's mode, "Full access" included; a connection that ended by itself.
- Not recorded: reading anything other than opening one run (the trace list with the start of each input and output, a person's conversation in Traces, the member list, the activity log itself); a refused sign-in by a stranger or with an unverified address; an action confirmation that expired; a run starting, failing or being stopped; saved views; a person clearing their conversations or editing a document.

**States.** Loading; red notice on failure; "No records match." when the search and dates leave nothing. Each change of the search or the dates shows the loading state and starts again from the newest record.

**How it is wired.**
- Screen: `apps/web/src/pages/Audit.tsx:21` (`AuditPage`; the search delay `:32-35`, the actions named by their labels `:36-42`, the dates `:72-93`, the export link `:94-99`); `apps/web/src/lib/events.ts:5` (`eventSummary`); labels `apps/web/src/i18n/en.ts:154-190`
- Requests: `GET /api/audit?limit=&before=&q=&actions=&from=&to=` → `app.ts:804`; `eventFilter` at `app.ts:884`, `listEvents` at `app.ts:900`; reads `admin_events`. `GET /api/audit/export?q=&actions=&from=&to=` → `app.ts:817`; reads up to 10,000 rows (`EXPORT_ROWS`, `app.ts:874`) and writes one `admin_events` row.
- Data: `admin_events` (seq, time, actor_user_id, actor_email, action, target_type, target_id, target_label, detail, ip). The answer leaves out `actor_user_id` and `target_id`.
- Events: `audit.exported` (rows, `q`, `from`, `to`, `actions`).
- Tests: `app.test.ts:494` "records every change with who did it"; `:541` refused change not recorded; `:550` suspended person's attempt recorded; `:559` "pages newest first"; `apps/server/src/observe.test.ts:187` "puts on the record who opened someone else's run, once, and the record can be searched and exported" (search by `q`, an empty day, a day that is not a day and a day that is not on the calendar refused, an action found by its label through `actions`, the CSV, `audit.exported` written, a member refused). No test covers the page.

**Not built.**
- No separate filter by action, person or target: one box searches all three. No search in the detail.
- The CSV export stops at 10,000 records without saying so. (The export with fingerprints says so in its first line.)
- Forwarding by syslog, and to an address on a port other than 443 or 8443 (Splunk's own default, 8088, is one): the guard on every address the server calls allows neither (`apps/server/src/runtime/net.ts`).
- A check failing or forwarding stalling is on this page and in the server's log. Whether Alerts tells anyone depends on its own rules; none was added here.
- No detail view: the full stored detail (the filters of an export, the tools of a changed agent, a file's size and hash) cannot be seen.
- No link from a record to the member, agent, trace or session it is about.
- **What the chain proves, and what it does not.** It proves that nobody changed, removed or added a record through Muster or by editing rows as a database user who can only read and write them. Against someone with the database owner's access it proves nothing by itself: they can drop the triggers and rebuild the whole record so that it agrees with itself. Two things then still show it: the place the last check signed for with the server's key (a rebuilt record fails with "not the one the last check signed for", unless they also hold `MUSTER_SECRET_KEY`), and a copy held outside: what was sent on, or an export. Against someone with both the database and the key, only the outside copy. The Integrity card says this in one sentence.
- `packages/protocol` has a `sealEvent` chain of its own for agent events. It is not what the activity log uses, and nothing writes with it yet.

### The record proves itself (MUS-29)

**What it is for.** An auditor has to be able to say that the record is what was written, and to keep a copy where nobody at the company can change it.

**How a person uses it.** On `#/admin/audit`, above the record, a card "Integrity":

- A badge: "Not checked yet", "Proves itself" (green) or "Does not prove itself" (red). Beside it "N records · checked 3 hours ago", and, once records have been purged at the end of their keeping, "· N older records purged at the end of their keeping".
- "Check now" → `POST /api/audit/chain/verify`. The button reads "Checking…" while it runs, then the badge and the time change. Needs `audit.read`, so an auditor can do it. Log: `audit.verified` (ok, records; when it failed, also why and at which record). The server also checks every organization once a day by itself (looked at hourly, `apps/server/src/index.ts`), which writes no record; a failure is printed in the server's log.
- When a check fails, a red notice under the badge: what is wrong ("A record is not what was written.", "A record does not follow the one before it: one of the two was rewritten.", "Records are missing.", "The record does not begin where it should.", "The newest records are missing.", or the note of what was purged is not this server's), then "First seen at record N, <time> (<action>)", then what to do: compare with an export or with what was sent on, and treat everything from that record on as unproven.
- "Export with fingerprints" → the browser downloads `GET /api/audit/chain/export?from=&to=` as `muster-activity-log.jsonl`, for the days chosen in the record's own date boxes. One JSON object a line, oldest first. The first line says what the file is: how many rows, whether it was cut at 100,000, where the chain ends, where it starts if older rows were purged, and how a fingerprint is made. Every other line is a record with `chain_no`, `prev_hash`, `hash` and `canonical`, the exact text that was hashed. Log: `audit.exported` (rows, from, to, `format: "jsonl"`).
- A row "Not sent anywhere else" with "Set up" (only with `settings.manage`), or "Sent on to <host> · <kind>" with a badge "Up to date", "N waiting", "Not getting through" or "Paused", the time of the last delivery, the last error with how many times it was tried, and "Change".
- "Set up" / "Change" opens "Send the record on": what is at the other end ("JSON over HTTPS" or "Splunk HEC"), the address, a token (a password box; once kept it is never shown, only "Kept. Type to replace it.", with a tick box "Send without a token from now on"), where to start (only the first time: "Only what is recorded from now on" or "Everything kept so far too (N records)"), and "Sending is on". "Save and send a test" saves the form and posts one test event that is not part of the record; the answer is shown in the dialog ("The address took the test event." or why not). "Save" → `PUT /api/audit/forward`. "Stop sending" asks first, saying that what is written from then on is not sent later → `DELETE /api/audit/forward`. Log: `audit.forward_set`, `audit.forward_changed`, `audit.forward_removed`, each with the host and never the token.

**Rules.**
- A fingerprint is `sha256(prev_hash + "\n" + canonical)` in lower-case hex. `canonical` is a JSON array the database writes from the row: its number in the chain, id, organization, time in UTC to the microsecond, who (id and email), the action, what it was done to (type, id, label), the detail, and the IP address (`admin_event_canonical`, `apps/server/src/chain.ts`). The first record's `prev_hash` is empty.
- The database links a row as it is written (the trigger `admin_events_chain`), holding a lock on the organization's head of the chain (`audit_chain`) until the writing transaction ends. So every one of the places that writes a record is chained without knowing it, two writers at once get two places, a transaction undone leaves no hole, and whoever writes a row cannot choose its place or fingerprint. The cost: two changes in one organization that both write a record wait for each other.
- Each organization has its own chain. Records written before this existed were linked by the migration, in the order they were written.
- A check walks the whole chain in the database: every row's fingerprint is made again and compared, every row must follow the one before it with no number skipped, the first must begin at the start (or at the checkpoint, below), and the last must be the head. It reports the first thing wrong. It reads one snapshot of the database (repeatable read, read only), in which a row and the head it moved are both there or both not, so nobody writing waits for it. A check that passes signs for where the record then ended (`audit_chain.signed_n`, `signed_hash`, `signed_mac`, an HMAC with the server's key); the next check fails with `anchor` if the record at that place is no longer that one. Without a server key nothing is signed, and the card says so. "Check now" is refused within a minute of the last check of the same organization (`audit_check_recent`, 429).
- When old records are purged (retention), only whole records from the front go, 5,000 in a pass, each pass in a transaction of its own, and each leaves a checkpoint row (`audit_checkpoints`) with the number and fingerprint of the last one purged, signed with the server's key (`MUSTER_SECRET_KEY`). A check starts from the newest checkpoint and refuses one whose signature is not this server's. Without a server key the activity log is not purged at all (a checkpoint anyone could have written proves nothing), and the Retention page says so. If the key is changed, checks of an organization that has purged records fail with that reason, and the purge stops.
- What a session that can only read and write rows cannot do (migration `AUDIT_FIXES_SCHEMA`): delete a record (the purge is let through only when its transaction shows a key whose hash the database was told once, `audit_guard`; the key is made from the server's secret and kept nowhere, and setting `muster.audit_purge` to anything else does nothing); change or remove that hash; move a chain's head (`audit_chain` changes only from inside the trigger that links a record; what a check found may be written beside it, and the place signed for only moves forward); write, change or remove a checkpoint. All of these are triggers, which the owner of the database can drop.
- Sending on: every 30 seconds, in order from the last one delivered, up to 12 requests of 200 records for each organization (`AuditForwarder`, `apps/server/src/chain.ts`). The organization's row is locked for a request (`for update skip locked`), so two server processes never post the same records. A request counts only when the answer is 2xx; then the place it got to is moved. An answer of 413 or 400 to more than one record is not a failure: the next request, at once, carries half as many, down to one, and stays that size until the address is changed. Anything else leaves the place where it was and is tried again after 30 seconds, then 1, 2, 4 … minutes, at most an hour. It never gives up and never skips. After 20 failures in a row the page says "Stalled"; it still tries every hour. The other end can see a record twice; `id` and `chain_no` tell.
- Sending on and retention: records past their period wait until they have been sent. If nothing has got through for 7 days (`failing_since`), they are purged unsent, and the `retention.purged` record says how many (`auditUnsent`). A retention period is a promise too, and an address that never answers must not keep the record for ever.
- The address must be public and https, on port 443 or 8443, without a username or password; a redirect is not followed (the same guard as every address the server calls). A token is sealed with the server's key and is sent only to the address it was entered with: changing to another site without entering a token again is refused (`connector_credential_again`). Without a server key a token cannot be kept (`connector_unsealed`).
- JSON: `POST` with `{"source": "muster", "events": [...]}` and `Authorization: Bearer <token>`. Splunk HEC: one `{"time", "source", "sourcetype": "muster:audit", "event"}` object after another and `Authorization: Splunk <token>`.
- Reading, checking and exporting need `audit.read`. Setting, changing, testing and stopping the sending need `settings.manage`.

**Technical reference.**
- Screen: `apps/web/src/pages/AuditChain.tsx` (`AuditChainCard`, `ForwardLine`, `ForwardEditor`), shown by `apps/web/src/pages/Audit.tsx`.
- Requests: `GET /api/audit/chain`, `POST /api/audit/chain/verify`, `GET /api/audit/chain/export`, `PUT|DELETE /api/audit/forward`, `POST /api/audit/forward/test` → `registerChain` in `apps/server/src/chain.ts`.
- Data: `admin_events.chain_no`, `.prev_hash`, `.hash`; `audit_chain` (head, and what the last check found); `audit_checkpoints`; `audit_forward` (address, sealed token, how far it got, the last error and when it is tried next).
- Tests: `apps/server/src/chain.test.ts`: rows are linked; a row cannot be given a place; the export proves itself with sha256 alone; fifty writers at once keep one chain; a row changed, a detail changed, rows missing in the middle, at the start and at the end, and a row rewritten with a fingerprint made to fit are each found; old rows are linked by the same statement the migration runs; purged rows leave a checkpoint and a forged checkpoint is refused; forwarding resumes after failures without loss or reordering, in batches, from now or from the beginning; the token is sealed and never returned; permissions.

**Not verified.** The pages were not opened in a browser. Nothing was sent to a real SIEM or a real Splunk collector: the format follows Splunk's documentation of the collector's event endpoint. Everything was run on the embedded database, which has one connection: that two writers get two places, that a check makes no writer wait, and that two processes do not post the same batch all rest on PostgreSQL's row locks and snapshots, and were not run against PostgreSQL here.

### Retention and erasure (MUS-28)

**What it is for.** A company has to be able to say how long it keeps what, to have it really gone after that, to remove everything of a person who has left when asked to, and to stop all of that the day a lawyer says to keep everything.

**Who it is for.** Reading: `settings.read` (Owner, Administrator, Auditor). Changing periods and the hold: `settings.manage`. Erasing a person: `members.manage`.

**Where it starts.** `#/admin/retention`, "Retention" under Security in the sidebar. Erasing starts on a removed member's panel in Members.

**How a person uses it.**

- The page "How long things are kept" has one row for each kind: Conversations, Files, Runs and traces, Activity log. Each has a choice: "Keep" (the default: for as long as the organization is here), 30 days, 90 days, 180 days, 1 year, 2 years, 3 years, 7 years, or "Another number of days…", which shows a box for the number. Under each, one sentence says exactly what goes and what is spared. When a saved period already has things past it, the row says so: "12 conversations past this period now; they go at the next purge."
- "Review and save" (enabled once something differs and every number is in range) first asks the server what the new periods would take now (`POST /api/retention/preview`), then opens "Save these periods?": each changed kind as "Keep → 90 days", then either a red notice "Already past these periods: 132 conversations, 40 files. They will be removed for good at the first purge." or "Nothing is past these periods yet.", then "Nothing is removed for 24 hours after saving. Change the periods back within that time and nothing is lost." The button is "Save periods" (red when something would go) → `PUT /api/retention`. Log: `retention.changed` with the periods before and after. "Discard changes" puts the form back.
- To the right, "Purging": when the next purge is ("Next purge: <time>, or up to an hour after."), and what the last one removed.
- "Legal hold": a badge "None" or "In place", and when in place the reason, who placed it and when. "Place a hold" asks why (required, 300 characters) → `PUT /api/retention/hold {on: true, reason}`. "Lift the hold" says that purging starts again 24 hours later and what came past its period meanwhile then goes for good → `{on: false}`. Log: `retention.hold_on`, `retention.hold_off`, each with the reason.
- Erasing a person: Members → a removed person → their panel now has, beside "Let back in", "Erase their data…". The dialog loads what there is (`GET /api/members/:id/erase`) and lists it: "3 conversations, with their messages", "2 files, with their versions and comments", documents, projects, things remembered, runs, schedules; then "Also their profile, connected accounts, notices, and what was shared with them."; then "What stays"; then a red notice "This cannot be undone, and there is no copy to restore from in Muster."; then a box "Type <their email> to confirm". "Erase for good" stays disabled until the address matches → `POST /api/members/:id/erase {email}`. Afterwards the dialog says it is done and that it is on the activity log. Log: `member.erased` with how many of each went.

**Rules.**
- A period is a whole number of days, 30 to 3650, or none. The activity log's is 365 at least. Anything else is `invalid_retention`.
- The purge runs once a day for each organization, looked at every hour (`Retention.tick`, `apps/server/src/retention.ts`). It does nothing until 24 hours after the periods were last changed or a hold was lifted, and that is looked at again as the run is taken, so periods saved a moment before are not purged by. It takes 500 rows at a time (5,000 of the activity log), each batch in its own transaction, at most 20,000 of a kind a day (200,000 of the log). Every batch reads the hold again and keeps it as it is until the batch ends: a hold placed while a purge runs stops it at the next batch. A purge that removed something writes `retention.purged` with the counts, by "muster". The sandbox workspace of each conversation removed is forgotten (best effort; the hourly pass releases a folder with no conversation after a day, see Sandbox).
- Conversations: removed, with their messages, requests for approval and follow-ups that have ended, when the conversation was last written in before the cut-off. Not one where a reply is still running, a schedule runs, or a follow-up is waiting. Files made in it stay (they have their own period); runs made for it stay until theirs.
- Files: the record, versions, comments, shares and content go when neither the file nor any version of it was made within the period. Kept whatever their age: a file pinned as a project's key document, a file made in a conversation that is still here, and a file attached to a message that is still here. So with no period for conversations, files made in or sent to conversations are never purged; with one, the conversation goes first and its files at the next look. The record of a file its owner already deleted goes at the same age.
- Runs: the trace, its spans and the notes on it go by when the run started. Usage and cost figures are read from traces, so they go too.
- Activity log: only from the front, up to the first record that is not old enough, leaving a signed checkpoint so that the rest still proves itself (see above). Records being sent on that have not been delivered are kept until they have.
- A hold stops the purge and refuses erasing (`on_hold`). While it is in place a file its owner deletes leaves their list and keeps its content (`Files.remove`); conversations people remove were only ever hidden. Periods can still be changed under a hold.
- Erasing is only for someone already removed from the organization (`erase_not_removed`), never oneself (`self`), and needs their address typed (`erase_unconfirmed`; case does not matter). The hold is read, and `member.erased` is written, inside the same transaction as the erasing: it cannot happen under a hold placed a moment before, nor without a record. It removes: conversations (and their sandbox workspaces), messages, approvals, follow-ups, schedules, sent drafts, files (then their content), documents, their own projects with steps, updates and key documents, memories, notices, saved views, connections, native-app sign-ins, runs made for them, their profile, what they added from the marketplace, what was shared with them, their place in other people's projects, the comments they left on other people's files, the notes they left on other people's runs, and alerts that name them.
- What other people are using is not erased but handed to the administrator who erases, and the dialog names it first: a project that has other people in it or other people's conversations in it (whole, with its steps, updates and key documents; renamed "Name (2)" if the administrator already has one of that name), and a file shared with someone else or pinned in such a project. Chosen over refusing because an administrator has no other way to take over a leaver's project, so a refusal would block every erasure it applied to; and over deleting because the other people's work is theirs. The administrator can then pass them on or delete them. `member.erased` records how many were handed on.
- What erasing leaves: the membership row marked removed with the address (so a domain rule does not let them back in), every activity log record that names them, and the agents, skills and knowledge bases they made, which others may be using.

**Technical reference.**
- Screens: `apps/web/src/pages/Retention.tsx` (`RetentionPage`, `HoldDialog`); `apps/web/src/pages/EraseMember.tsx` (`EraseMemberDialog`), opened from `apps/web/src/pages/MemberDetail.tsx`.
- Requests: `GET|PUT /api/retention`, `POST /api/retention/preview`, `PUT /api/retention/hold`, `GET|POST /api/members/:id/erase` → `registerRetention` in `apps/server/src/retention.ts`.
- Data: `retention` (the four periods, the hold with its reason, who and when, when the periods last changed, when the last purge ran and what it removed).
- Tests: `apps/server/src/retention.test.ts`: limits and permissions; the preview counts and takes nothing; a change is recorded once and purges nothing for a day; the purge takes exactly what is past its period, removes file content from the store, spares a running conversation and a key document, runs once a day; a hold stops it, keeps the content of a file deleted meanwhile, and lifting it waits a day; the activity log is purged from the front, waits for what is not yet sent on, and still proves itself; erasing needs a removed member, the typed address and no hold, takes everything of theirs and nothing of anyone else's.

**Not built.**
- Under a hold, a person can still delete their own documents, memories and projects, and those are really removed. Only purging, erasing and the content of deleted files are held.
- A period for memories, documents or projects: they are kept until their owner deletes them or the person is erased.
- Erasing does not reach copies outside Muster: what was sent on to a SIEM, exports, backups of the database, or a sandbox workspace not yet released (those go after the organization's number of idle days, seven unless changed).
- Erasing someone who is still a member, or one's own data. Handing a leaver's agents, skills and knowledge bases to someone else.
- No "purge now" button and no notice to anyone before a purge.

**Not verified.** The pages were not opened in a browser. The purge was run against the embedded database with a few rows of each kind, not against a large PostgreSQL database; how long 20,000 conversations take to remove was not measured.

**Design findings.**
- Answered on 2026-11-14: the three file events and the model change have labels in both languages (`en.ts:180-183`).
- The page says "Every sign-in and every administrative change is recorded here." It also holds what ordinary members do (files, agents they build, actions they allow), and it does not hold refused sign-ins by strangers. Smallest fix: "Sign-ins, changes by administrators, and what members build, upload and allow."
- Answered on 2026-11-14: the box now searches the whole record on the server (`q`), by the words the reader sees as well as by an action's own name, with a date range and a CSV export (`app.ts:804-860`, `Audit.tsx:30-54`). What remains: the detail column is not searched.
- "Exported traces · 2,000 rows" hides which filters were used, though they are stored. Smallest fix: let a row expand to show its stored detail.
- "Annotated a trace" here, "Notes" on the trace page. "Ended session" here, "End" there, "Sign out" in a person's own settings. Smallest fix: one word per thing: "note", "end session".
- `agent.changed` by "muster (new release)" has no IP and an actor that is not an email; it will confuse a filter by person. Smallest fix: show it as "Muster (new release)" in a distinct style.
- `policy.changed` shows the new mode as its code (`full`) in the "on" column and nothing in the detail column: the page's summary of a detail knows `from` and `to` only when they are roles (`apps/web/src/lib/events.ts:10`). The record that an administrator opened "Full access" to the organization reads as one bare word. Smallest fix: translate the two modes and show "Approve for me → Full access".
- "Connected a service" and "Disconnected a service" name the Microsoft account but not which service, and a connection that ended by itself leaves the log saying the person is still connected. Smallest fix: put the service in the label; write `connector.ended` when a renewal is refused.
- The riskiest thing a member can now do, turning on "Full access" in a conversation with an agent that reads their mail, leaves no record here. Smallest fix: record `conversation.mode_changed` when the new mode is "Full access".

---

## Agent roster

> Added on 2026-11-15: an agent's panel is its full record. Beside what it can do, its instructions and its week, it now shows the last 30 days (runs, cost, tokens, median time, conversations in all, how often it asked people to confirm and what they answered), who uses it (people by runs, for `members.read`), its latest runs each opening its trace (`traces.read`), what was decided about it from the activity log (`audit.read`), and when it was created. `GET /api/agents/:id/record` in `apps/server/src/product.ts`; never what was said to it or what it answered.

**Who it is for.** Reading: `agents.read` (Owner, Administrator, Auditor). Deciding: `agents.manage` (Owner, Administrator).

**The job.** "See every agent in the organization, who built it, how far it can reach, and stop or allow one."

**Where it starts.** `#/admin/agents`; "Agent roster →" on Overview.

**What they see and can do.**
- Four headline numbers: registered agents (split Platform / Organization / Personal); awaiting approval; high risk (R3 and above); runs in the last 7 days (with failed and blocked).
- A search box (name, description, owner) and tabs with counts: All, Awaiting approval, High risk, Suspended, Failing. All filter the loaded list; no request.
- A table: agent (name and description), owner (and source), risk (R1–R4: a scale of four bars that fills as the level rises and is grey, then full text, then amber at R3 and red at R4, with the words beside it and the code after in small type; not a pill, so the state is the only pill in the row; CHA-233), state (Draft, Awaiting approval, Published, Suspended, or "Deleted by its builder"), last 7 days (runs, people, failed), last run.
- Click a row → a side panel for that agent:
  - A box stating what the available decision does, with its button.
  - "What it can do": each tool as a sentence ("Read public web pages") with its level (A0–A4) named in words ("Write in workspace"), the same scale and the code, and "The risk level is the furthest any of these can reach. It is worked out, not chosen."
  - "Instructions": the full text the agent runs on.
  - "Use in the last 7 days": runs, people, failed, blocked; last run; "See its runs" → `#/admin/traces?agent=<id>&range=30d`.
  - "Record": owner, source with its meaning, model, the agent's ID with "Copy", and the first 12 characters of the version with "Changes whenever the instructions or tools change. An approval is of one version."
- One decision button per agent, in the row and in the panel, depending on its state (`apps/web/src/pages/Agents.tsx:47-54`). Each asks for confirmation first, showing the same sentence as the panel, then sends `PATCH /api/agents/:id {state, version}` where `version` is the one on screen.
  - **Approve** (state Awaiting approval) → state becomes `published`. Log: `agent.approved`. The agent's builder can now start it. Nobody is told.
  - **Suspend** (state Published) → state becomes `suspended`; then the server stops every run of that agent that is in progress, in every conversation (`product.ts:385`, `runs.ts:215-221`). A run waiting for a confirmation is abandoned and the confirmation is marked expired (`runs.ts:694-715`). Log: `agent.suspended`. From then on: nobody can start a conversation with it or send it a message (`agent_unavailable`, "This agent is not available to run."), and a confirmation still pending cannot be allowed (`product.ts:750`). Conversations and records are kept.
  - **Restore** (state Suspended) → state becomes `published`. Log: `agent.restored`. What is restored is what was suspended: its builder cannot change a suspended agent.
- A decision that is refused shows its reason in red at the top of the open side panel as well as on the table card (`apps/web/src/pages/Agents.tsx:113`, `:339-343`).
- A draft and a deleted agent have no button.

**Rules.**
- Risk follows from the tools (`apps/server/src/runtime/catalog.ts:53-59`): only reading is R1; writing the person's own documents or files is R2; anything that acts outside is R3; R4 is reserved and no tool reaches it today.
- When a person builds an agent, R1 and R2 are published at once; R3 and R4 wait for an administrator (`product.ts:223-224`). With today's tools, that means any personal agent given `web.send`.
- Approval is of one version. If the builder changed the agent after the administrator loaded the page, approving or restoring is refused with `agent_changed`, "This agent changed after you opened it. Look at it again before deciding." Suspending is always allowed (`product.ts:365-368`).
- A builder's edit sends an approved R3 agent back to Awaiting approval (`product.ts:292-297`). A builder cannot edit a suspended agent at all: the save is refused with `agent_suspended`, "This agent is suspended. An administrator must restore it before it can be changed." (`product.ts:279-281`). The builder can still delete it.
- A change of the server's model gives every agent a new version, suspended ones included. It is recorded once, as `agents.model_changed`, with the model and the number of agents, the first time anyone lists agents after the change (`product.ts:55-85`, `:211`). Agents that were approved stay approved.
- A draft cannot be decided: `agent_unavailable`. An unknown or deleted agent: `not_found`.
- Platform agents (Assistant, Writer, Researcher, Messenger) can be suspended and restored like any other; that stops them for everyone.
- A personal agent is usable only by its builder, whatever its state (`product.ts:213-216`, `:504`).
- The list includes agents their builders deleted; those keep their row so their runs stay readable.

**States.** Loading; red notice if the list fails; "No agents are registered."; "No agent matches. Clear the search or pick another group." A failed decision shows a red notice at the top of the table card and the list reloads.

**How it is wired.**
- Screen: `apps/web/src/pages/Agents.tsx:223` (`AgentsPage`), `:78` (`AgentDetail`), `:238` (`decide`); confirmation `apps/web/src/components/confirm.tsx:22`
- Requests: `GET /api/agents` → `apps/server/src/observe.ts:124`; every agent of the organization with its 7-day counts from `traces`. `GET /api/app/tools` → `apps/server/src/product.ts:144`; tool names and levels (open to any signed-in person). `PATCH /api/agents/:id` → `product.ts:344`; sets `agents.state`, then `runs.stopAgent` on suspend.
- Data: `agents` (name, description, source, owner_user_id, risk, state, version, model, instructions, tools, deleted_at), `traces` for counts. Live runs are held in the server's memory.
- Events: `agent.approved`, `agent.suspended`, `agent.restored`. Live: a stopped run ends on the affected person's screen through their conversation's event stream.
- Tests: `apps/server/src/product.test.ts:1035` "holds an agent that can act outside until an administrator approves it"; `:1058` "sends an agent back for approval when a change raises its risk, and gives it a new version"; `:1128` "stops a suspended agent from running, for everyone"; `:1141` "does not let a suspended agent be changed: what is restored is what was suspended"; `:1171` deleted agent's runs stay on record; `apps/server/src/observe.test.ts:344` "lists agents with their recent activity".

**Not built.**
- No way to decline a waiting agent, and no way to say why. It can only be approved or left waiting.
- No message to the builder when their agent is approved, suspended or restored.
- No way to publish an agent to the organization: nothing in the server creates an agent with source "Organization", so that count is always 0 and every built agent is personal.
- An administrator cannot edit, delete or reassign an agent, or limit who may use one.
- No history of an agent's versions or of the decisions taken on it, other than searching the Activity log by its name.
- No bulk decision; no queue view beyond the "Awaiting approval" tab.

**Design findings.**
- Answered on 2026-11-14: a suspended agent can no longer be changed by its builder (`agent_suspended`, `product.ts:279-281`), so "Restore" publishes what was suspended. What remains: the server accepts Suspend for an agent that is still waiting for approval, and Restore then publishes it with the log saying "Restored", not "Approved" (`product.ts:369-375`); the console offers Suspend only for a published agent, so this is reached only by a direct request.
- Answered on 2026-11-14: the Approve text now reads "Approving lets its builder use this agent, with exactly the instructions and tools shown here. If they change it, it must be approved again." (`en.ts:526`). What remains: it does not say that what the person writes for a project is added to those instructions in the project's conversations, unreviewed, and that a Microsoft tool on the agent reads the account of whoever talks to it.
- Answered on 2026-11-14: the headline hint now reads "Agents that act outside the organization wait here for an administrator" (`en.ts:462`).
- "Awaiting approval" here means an agent waiting for an administrator. On Traces and Approvals the same words mean a run waiting for the person who started it. Smallest fix: call the agent state "Needs review".
- A waiting agent offers only "Approve". An administrator who does not want it has no button and the builder is left in the dark. Smallest fix: a "Decline" that suspends it (the server already accepts `suspended` for a waiting agent) with a logged reason.
- Answered on 2026-11-14: a refused decision now shows its reason inside the open side panel too (`Agents.tsx:113`).
- The confirmation's button is always red, even for "Approve" and "Restore" (`confirm.tsx:50`). Smallest fix: let the caller choose the tone.
- The panel shows a model name, a 12-character version hash and a full ID. Only the ID has a use (finding it elsewhere). Smallest fix: fold these three under "Technical details".
- All usage numbers are fixed to 7 days, while "See its runs" opens 30 days. Smallest fix: open the same 7 days.
- Deleted agents count in "Registered agents" and "High risk". Smallest fix: leave them out of the headline numbers and add a "Deleted" tab.

---

## Traces

**Who it is for.** Reading: `traces.read` (Owner, Administrator, Auditor). Notes: `traces.annotate` (Owner, Administrator).

**The job.** "Find the run where something went wrong, see exactly what the agent was asked, what it did step by step, and what it answered."

**Where it starts.** `#/admin/traces`; "See its runs" in the roster; the arrow on an Approvals row. Addresses: `#/admin/traces?<filters>` (runs), `#/admin/traces/spans`, `#/admin/traces/conversations`, `#/admin/traces/t/<trace id>[/<span id>]`, `#/admin/traces/c/<conversation id>`.

**What they see and can do.**

*The bar above all three lists*
- Tabs: Traces, Spans, Conversations. Switching keeps the filters.
- Search box: applied 0.3 seconds after typing stops. Matches the run's input, output, agent name, or the start of a trace ID.
- Period: 15 minutes, 1 hour, 12 hours, 24 hours, 7 days (default), 30 days, 90 days.
- "Filters" (with a count of those in use) opens a panel: Status (Completed, Failed, Blocked by policy, Awaiting approval, Running; several may be chosen); Highest action level (A0–A4, several); Where it ran (Cloud, On device); Agent; Person (email contains); Slower than (seconds); "Clear filters".
- Filters live in the address, so a view can be linked, reloaded and bookmarked.
- "Views": "Default" clears to 7 days; each saved view applies its filters; the bin on a view deletes it at once (`DELETE /api/views/:id`); "Save current filters as a view" asks for a name → `POST /api/views`. Views belong to the person who saved them.

*Traces tab (one row per run)*
- Eight totals for everything that matches: runs, failed %, blocked, awaiting approval, median, 95th percentile, tokens, cost.
- "Columns": show or hide any of Status, Started, Trace ID, Agent, Person, Input, Output, Duration, Tokens, Cost, Steps, Ran, Level, Notes. Output and Ran are hidden at first. The choice is kept in this browser.
- Click Started, Duration, Tokens or Cost to sort; click again to reverse.
- "Export CSV" → the browser downloads `GET /api/traces/export.csv?<filters>`: up to 10,000 runs, newest first, with the full input and output of each. Log: `traces.exported` with the row count, whether it was cut off, and the filters.
- Click a row (or press Enter on it) → the trace.
- 50 rows a page, with Previous and Next.

*Spans tab (one row per step, across runs)*
- A "Kind" filter: Agent, Model call, Tool, Retrieval, Policy check, Approval.
- Columns: kind, name (such as `web.fetch` or `policy.check`), status, agent, started, duration, tokens, cost, input → output (first 200 characters each).
- Click a row → the trace, opened at that step. 50 rows a page.

*Conversations tab (runs grouped by conversation)*
- The 100 most recent conversations that match: started, agent, person, first message, turns, total time, tokens, cost, problems (runs not completed).
- Click a row → the conversation: each turn as a card with its input, output, status, time and person, and "Open trace".

*One trace*
- "Back", the agent's name and the full trace ID.
- A summary: status, highest level, the agent's risk, where it ran, the person; started, duration, tokens (in and out on hover), cost, agent version, and the conversation ID as a link to the conversation.
- "Steps": the run as a tree, each step with its kind icon, name, status if not OK, note count, duration and a bar showing when it started and how long it took. Click a step → the panel on the right.
- The step panel has three tabs. Overview: for a model call, the model, prompt tokens, completion tokens and cost; the step's input and output in full; and its error events. Attributes: every recorded attribute as name and value (for example `actionLevel`, `policyId`, `effect`, `approver`). Notes: see below.
- Notes: a list of notes on this step (or on the whole run, when the first step is selected), each with a label, an optional score, the author and age. With `traces.annotate`: a form with Label (required, up to 40 characters), Score (0 to 1, optional), Note (up to 2,000 characters) → "Add" sends `POST /api/traces/:id/annotations`. Log: `trace.annotated`. The bin on a note → `DELETE /api/annotations/:id`, at once. Log: `trace.annotation_removed`.

**Rules.**
- A trace is one run: one message from a person and everything the agent did to answer it. A span is one step inside it. These are recorded by the run service as the run happens.
- People remove their own notes; an owner may remove anyone's (`observe.ts:359-364`). Others get `not_found`.
- A filter the server does not know, or a value out of range, is refused with `invalid_request`; this happens only with a hand-edited address or a stale saved view.
- A saved view may only hold filters the list understands. Saving under a name that exists replaces that view without asking. A person may keep 50 views; the 51st is refused with `invalid_request`.
- Export cells that begin with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet does not run them (`observe.ts:103-108`).
- Opening one trace that is someone else's run is written to the activity log as `trace.viewed`, with the reader, the run and the email of the person whose run it is: at most once an hour for each reader and run, so the log says who read what without filling with repeats (`observe.ts:263-282`; the index that keeps the look-up quick is migration 7, `schema.ts:311-314`). Opening one's own run is not recorded.
- The lists (with the first 240 characters of each input and output), the Spans tab, and a conversation opened from the Conversations tab, which shows every turn's input and output in full, write nothing to the activity log (`observe.ts:448-459`). Export and notes are recorded.
- List rows carry the first 240 characters of input and output; the trace page and the export carry all of it.

**States.** Loading; the table dims while it reloads; red notice on failure. "No agent has run yet." with no runs and no filters; "No runs match these filters."; "No steps match these filters."; "No conversations match these filters."; "This step recorded no attributes."; "(empty)" for an empty input or output. Without `traces.annotate`: "Your role can read notes but not add them." A running run shows "Running"; the page does not refresh itself.

**How it is wired.**
- Screen: `apps/web/src/pages/Traces.tsx:126` (`TracesPage`), `:139` (`TraceLists`), `:431` (`SaveViewDialog`), `:560` (`TraceTable`), `:824` (`SpanTable`), `:916` (`ConversationTable`), `:991` (`ConversationDetail`), `:1095` (`TraceDetail`), `:1271` (`SpanPanel`), `:1394` (`Notes`)
- Requests (all in `apps/server/src/observe.ts`): `GET /api/traces` → `:148` (rows and summary). `GET /api/traces/export.csv` → `:192`. `GET /api/traces/:id` → `:251` (trace, spans, notes; writes `trace.viewed` when the run is someone else's). `POST /api/traces/:id/annotations` → `:315`. `DELETE /api/annotations/:id` → `:353`. `GET /api/spans` → `:380`. `GET /api/conversations` → `:420`. `GET /api/conversations/:id` → `:448`. `GET /api/views` → `:463`. `POST /api/views` → `:474`. `DELETE /api/views/:id` → `:507`. `GET /api/agents` → `:124` (for the Agent filter). Shared filter rules: `TraceFilters` `:38`, `traceWhere` `:60`.
- Data: `traces`, `spans`, `annotations`, `saved_views` (`schema.ts:127-190`); written by `apps/server/src/runtime/runs.ts`. Hidden columns: browser storage key `muster.traces.hidden`.
- Events: `traces.exported`, `trace.viewed`, `trace.annotated`, `trace.annotation_removed`.
- Tests: `apps/server/src/observe.test.ts:55`, `:65`, `:93`, `:103`, `:117`, `:123`, `:136` (the list); `:144`, `:175`, `:187` ("puts on the record who opened someone else's run, once, and the record can be searched and exported"), `:226` (one trace); `:235`, `:281` (notes); `:315`, `:330` (spans, conversations); `:360` (saved views); `:396` (export). `apps/server/src/product.test.ts:207` "answers a message, keeps it, and leaves a trace an administrator can read".

**Not built.**
- An administrator cannot stop a run from here. Only the person who started it can, from their conversation; the other way is to suspend the agent.
- No live refresh; a run in progress does not update on screen.
- No retention: traces, with the full text of what people asked and what agents answered, are kept for ever. No deletion of one trace, of one person's traces, or by age.
- No masking of personal or secret content in inputs and outputs.
- No record of who opened a conversation in the Conversations tab, or of who looked through the lists.
- Export exists only for the Traces tab; not for spans, conversations or one trace. No JSON export.
- No sharing of a saved view with colleagues; no renaming.
- Sort order, page, the span kind filter and hidden columns are not in the address, so a link does not reproduce them.
- The Conversations tab has no paging beyond its 100 rows and no totals.
- No alert on a pattern (many failures, a blocked action).

**Design findings.**
- The page speaks an engineer's language to an administrator: "Traces", "Spans", "95th pct", "Prompt tokens", "Attributes" with keys such as `policyId: confirm-external-actions`, step names like `policy.check` and `approval.user`. The workspace calls the same things "runs" and "steps". Smallest fix: name the tabs "Runs", "Steps", "Conversations" and keep the technical names inside the Attributes tab.
- Levels are shown as bare codes "A0"–"A4" in the filter chips and the Level column; the meaning is only in a hover. Smallest fix: show the words ("Read", "External, hard to undo") and put the code in the hover.
- Answered on 2026-11-14: opening someone else's run is written to the activity log as `trace.viewed`, once an hour for each reader and run (`observe.ts:263-282`). What remains: opening a conversation in the Conversations tab shows the same words in full and is not recorded, and neither are the lists.
- "Export CSV" downloads up to 10,000 runs of full conversation content on one click; the warning is only a hover. Smallest fix: a confirmation that states the row count and that it is logged.
- Deleting a saved view and deleting a note happen on one click with no confirmation. Smallest fix: confirm both.
- An administrator cannot remove another person's note, only an owner can, and the button is simply absent. Smallest fix: either allow it for `traces.annotate` or say "Only its author or an owner can remove this".
- "Where it ran: On device" and levels A2 and A4 can be filtered but never match: every run is recorded as cloud and no tool has those levels (`runs.ts:516`, `catalog.ts:11-34`). Smallest fix: offer only values that exist in the data.
- The trace page shows a conversation ID and an agent version as 12 or 13 raw characters. Smallest fix: label the link "Open conversation" and link the version to the agent in the roster.
- From a trace there is no way to act: no link to the agent's roster panel to suspend it, none to the person. Smallest fix: make the agent's name a link to `#/admin/agents` with that agent open.
- Not verified: what status a run stopped by its person is given in the list (the message is marked stopped at `runs.ts:955`; the trace status is set at `:1000`).

---

## Usage

**Who it is for.** Owner, Administrator, Auditor (`traces.read`) and the Billing role. The request itself needs only `console.access`.

**The job.** "Tell me what agents cost this period, and which department and model the money went to."

**Where it starts.** `#/admin/usage`; "Usage →" on Overview.

**What they see and can do.**
- A period switch: 24 hours, 7 days, 30 days (default), 90 days.
- Four numbers: cost in the period (with cost per run), runs, tokens, people using agents.
- A chart of cost per hour or day.
- "By department": department, people, runs, cost, share of cost. People with no department are grouped as "No department".
- "By model": model name, calls, tokens, cost, share.
- Nothing below the budgets can be clicked through; rows open nothing.
- Above all of that, whatever the period: **Budgets · <month>** (MUS-25), this calendar month's spending against the limits the company has set.
  - "The whole company": what has been spent this month, "of $X" when a limit is set, and a bar that turns amber from 80% and red at 100%. "Set limit" / "Change".
  - "Each person": the limit of everyone who has none of their own, or "No limit". "Set limit" / "Change".
  - A table of departments (people, spent this month, limit with its bar) and a table of people (spent, limit; one who goes by everyone's limit shows it with "· everyone's"). People with no spending and no limit of their own are folded behind "Show all N people". Each row has "Set limit" or "Change".
  - "Set limit" opens a small dialog: "Monthly limit: <whose>", one field "US dollars a month" (dollars and cents, above nothing; Enter saves), Cancel, Save, and "Remove limit" when there is one. A sum that is not money leaves Save off.
  - An auditor and the Billing role see all of it and no buttons.
  - When the model has no price, a notice: "The model agents run on has no price, so nothing is counted and no limit will ever be reached. Set its price under Models."

**Budget rules** (`apps/server/src/budgets.ts`).
- Four kinds of limit, each a sum of US dollars a calendar month: the company's, a department's, each person's (one sum for everyone), and one person's own, which stands in place of everyone's. Sums are kept in millionths of a dollar, whole numbers, like costs. Months begin on the 1st at 00:00 UTC, as the days of the daily allowance do.
- What counts is the cost recorded on each run (`traces.cost_micros`). A department's spending is that of the people in it now. A summary made while a reply is written, when the conversation no longer fits the model, is a call of that run like any other (an `llm` span named `summary`, since 2026-11-24, MUS-51): its tokens and cost are in the run's totals, in budgets, in usage and in alerts; before, only its tokens counted, against the day.
- **At 80%** the people concerned are told once that month, in Notices: the person for their own limit ("Your limit for agents this month is more than four fifths spent: $8.10 of $10.00."), every owner and administrator for a department's or the company's. **At 100%** they are told once more, and:
  - no new run starts for anyone the limit covers. A message is refused before the model is asked anything, with 429 and the sentence that says whose limit it is and who to ask: `budget_person` "You have reached your limit for agents this month. It starts again on the 1st. An administrator of Muster at your company can raise it.", `budget_department` "Your department has reached its budget…", `budget_company` "The company has reached its budget…". The widest limit that is reached is the one named: raising a person's limit does not help when the company's is spent. Scheduled work is not started ("This month's budget for agents was used up." on the schedule) and a follow-up does not come back (reason `budget`).
  - a run that is going stops after the model call that reached the limit, if it would have gone on to another step. The reply shows a notice "Stopped: you have reached your limit for agents this month. …" (`messages.ending` is `budget_person`, `budget_department` or `budget_company`). A reply that ends as it reaches the limit is left whole.
- Two runs at once at the limit: each reads what the others have spent again after every model call of its own, so each stops after its own next call. A limit can be passed by what the calls under way cost, and no more. There is no reservation of money before a call.
- A limit that is changed is a new limit: the month's "told" marks for it are cleared, so people are told again at 80% and 100% of the new sum.
- Nothing about a budget is put into what the model is shown: a limit is enforced around the model, never by telling it.
- Every change is on the Activity log: `budget.set` and `budget.removed`, with whose limit, the new sum and the one before.
- The daily token allowance (`MUSTER_DAILY_TOKENS_PER_USER`) is unchanged and is checked first.

**Other rules.**
- Cost is worked out when each model call is recorded, from the prices set for the model (see Models). With no price set, every cost is zero (see Models). Amounts are shown in US dollars.
- Department is the person's department now, not at the time of the run (`observe.ts:647-654`).
- The page uses the same request as Overview, so Billing receives the whole activity block (tools, levels, busiest agents) though this page shows only cost.

**States.** Loading; red notice on failure; "No agent has run yet…" when the period has no runs. "Nothing here for this period." in the model table when it is empty.

**How it is wired.**
- Screen: `apps/web/src/pages/Usage.tsx:19` (`UsagePage`)
- Requests: `GET /api/dashboard?range=` → `apps/server/src/observe.ts:522`; uses `activity.totals`, `series`, `byDepartment`, `byModel`.
- Budgets: screen `apps/web/src/pages/Budgets.tsx` (`BudgetsCard`); `GET /api/budgets` (`console.access`) and `PUT /api/budgets` `{scope, targetId, monthlyMicros | null}` (`settings.manage`) → `apps/server/src/budgets.ts` (`registerBudgets`). Enforced by `Budgets.reached` where a run starts (`product.ts`, `schedules.ts`, `followups.ts`) and by `Budgets.room` inside a run (`runtime/runs.ts`, `turned`). A person's own standing is in `GET /api/app/usage` as `month`.
- Data: `traces.cost_micros`, `spans.cost_micros`, `spans.attributes->>'model'`, `memberships.department_id`, `departments`; `budgets`, `budget_marks` (schema step 37).
- Events: `budget.set`, `budget.removed`.
- Tests: `apps/server/src/observe.test.ts:462` "shows cost to the billing role without opening traces to it"; `:431` "agrees with the trace list"; `apps/server/src/budgets.test.ts` (who may set and see; told once at 80%; refused at 100% with whose limit; a person's own limit; department and company; the calendar month; a run stopped part-way; two runs at once; no price).

**Not built.**
- No cost per person and no cost per agent, though both are in the data. An administrator's own usage page in the workspace shows only their own.
- No alert when spending rises faster than usual (a budget tells at 80% and 100% only). No budget per agent or per model. No hard reservation: a limit can be passed by the calls under way when it is reached.
- The workspace does not yet show a person their month against their limit, though the request carries it.
- Budgets are in US dollars and UTC months; a company in another zone sees its month turn at UTC midnight.
- No export, no invoice view, no month-to-date or calendar-month period, no currency other than US dollars.
- No way to see the runs behind a number.

**Design findings.**
- When no model price is set, total cost is zero and the Share column divides by zero (`Usage.tsx:89`, `:121`). Not verified: the exact text shown, expected "NaN". Smallest fix: show "–" when the total is zero, and a notice "No price is set for the model, so cost is recorded as zero" linking to Models.
- The table most finance people ask for first, cost per person, is missing while "By model" has one row (there is one model). Smallest fix: add "By person" and "By agent" from `traces`, both cheap queries.
- "People" in the department table counts people who ran an agent, not people in the department; next to Departments' "Members" column this reads as a mismatch. Smallest fix: rename the column "People using agents".
- The lead says "Costs are computed from model token prices" without saying they are estimates from configured prices, not the provider's bill. Smallest fix: say "estimated from the prices set for the model".
- "Cost per period" as a chart title says nothing. Smallest fix: "Cost per day" or "per hour", as the bucket is known.

---

## Approvals

> **Removed on 2026-11-21.** The owner, having given the choice of mode back to each person:
> "管理台这个 approves 到底什么目的呢，有必要吗，有意义吗", and then "管理台 Approvals 页也删掉吧".
> An administrator could only look at this list, never decide, and what it showed is kept
> elsewhere: each decision is `approval.approved` or `approval.rejected` in the activity
> log, and each run's record (Traces) holds the confirmation as a step. Gone: the page, its
> place in the sidebar, `GET /api/approvals`. Kept: the `approvals` table, a person's own
> list (`#/approvals` in the workspace, `GET /api/app/approvals`), and the counts on a
> member's and an agent's page. What follows is how the page was.

**Who it is for.** `traces.read`: Owner, Administrator, Auditor. Read-only for all of them.

**The job.** "See what agents asked permission to do outside the organization, who allowed it, and what was refused."

**Where it starts.** `#/admin/approvals`.

**What they see and can do.**
- Four counts over the rows loaded: Waiting for its person, Approved, Rejected, Expired.
- A table of the 200 most recent requests, waiting ones first: the action in words ("Read public web pages", "Send data to an outside address, after asking you" or, for a write on a person's computer, "Write files in those folders", with the tool's own name on hover), its level badge, then the destination address and, when something is sent, its size in bytes (hovering the address shows a preview of what would be sent); the agent; the person; when it was asked; the status, where a waiting request reads "Waiting for its person" (`apps/web/src/pages/Approvals.tsx:61-75`, `:87`).
- "See the run" at the end of a row → `#/admin/traces/t/<trace id>`, the run that asked.
- There is no Allow or Refuse button here.

**Rules.**
- A request is created in three cases (`runs.ts:656-682`): sending data out with `web.send`, always; reading a web address the person did not write themselves and whose site they have not allowed for that conversation, unless the conversation is in "Full access"; and writing a file in a folder on the person's computer (`local.write`) when the conversation is in "Ask first". For a write the row's address is the path inside the attached folder, and the preview on hover is the whole content that was to be written, up to 100,000 characters (`tools.ts:659-669`). So an administrator or auditor can read here what an agent was about to write on a person's computer. In "Approve for me" and "Full access" the same writes, and in "Full access" the same reads, make no request and do not appear on this page; they are in Traces. When a person allows a whole site for a conversation, the later reads of that site make no request and do not appear here; the allowance is on the activity log record of the approval.
- Only the person who started the run can decide, in their own conversation or their own Approvals page (`product.ts:908-973`). Their decision is logged as `approval.approved` or `approval.rejected`.
- A request that is not answered in 15 minutes expires and the action is not taken. It also expires if the person stops the run, if the agent is suspended, or if the server restarts (`runs.ts:187-195`, `:694-715`). Expiry is not logged.
- This page is about confirmations of single actions. It is not where an administrator approves an agent; that is the Agent roster.

**States.** Loading; red notice on failure; "No action has needed confirmation yet."

**How it is wired.**
- Screen: `apps/web/src/pages/Approvals.tsx:21` (`ApprovalsPage`)
- Requests: `GET /api/approvals` → `apps/server/src/product.ts:975`; reads `approvals` joined to `agents` and `users`.
- Data: `approvals` (tool, level, summary as JSON, status, requested_at, decided_at, decided_by, trace_id; `schema.ts:221-237`).
- Events: none from this page.
- Tests: `apps/server/src/product.test.ts:809` "waits, shows exactly what would be sent, and sends only after approval" (reads `/api/approvals` at `:875`); `:880` nothing sent on refusal; `:910` "can only be decided by the person who started the run"; `:926` abandoned when the run is stopped.

**Not built.**
- An administrator cannot allow, refuse or cancel a request, and cannot require that a second person approve (the person approves their own agent's action).
- No filter, search, period or paging; the counts cover only the 200 rows returned.
- When it was decided, and by whom, are stored (`decided_at`, `decided_by`) but not shown.
- No notice to anyone when a request is waiting.

**Design findings.**
- Answered on 2026-11-14: a waiting request now reads "Waiting for its person", in the count and in the row (`en.ts:999`). What remains: the page is still named "Approvals".
- Answered on 2026-11-14: the action is shown in words with the tool's name on hover, without the method (`Approvals.tsx:61-75`). What remains: the level badge ("A3") is still shown as a code, and the sentence for a send, "Send data to an outside address, after asking you", is written for the member, not for the administrator reading it.
- The row shows when a request was asked but not when it was answered, though the page exists to audit decisions. Smallest fix: add a "Decided" column from `decidedAt`, which the server already returns.
- Answered on 2026-11-14: the button now reads "See the run" (`Approvals.tsx:91-98`). What remains: the row itself is not clickable.
- The headline counts are "of the last 200", not of a period, and say neither. Smallest fix: add the period switch used elsewhere, or label them "of the latest 200".
- A person approving their own agent's outbound send is the only control. A buyer will ask how to require a second person for some destinations. That is a policy feature, not a small fix; say so on Policies.
- The page shows what asked. With modes, what did not ask is now the more interesting half: a read of an unnamed address in "Full access", a write on a computer in "Approve for me". Neither is here, and nothing on the page says the list is only the asked ones. Smallest fix: a line in the lead, and a link to Traces filtered to the policy `default-allow` on `web.fetch`.
- A write on a person's computer is listed with a path such as `Reports/summary.md` under a column made for web addresses, and its content on hover. The person was told the folder's place stays on their computer; they were not told an administrator sees the files an agent asks to write. Smallest fix: show the size only, and the content only to the person.

---

## Policies

**Who it is for.** Reading: `settings.read` (Owner, Administrator, Auditor). Changing the one thing that can be changed: `settings.manage` (Owner, Administrator).

**The job.** "Tell me what an agent is allowed to do without asking, what it must ask for, and what it can never do; and let me decide how much of the asking people may switch off."

**Where it starts.** `#/admin/policies`.

### The organization's tool policy (since 2026-11-24, MUS-26)

Two cards at the top of the page (`web/pages/ToolPolicy.tsx`, `server/toolPolicy.ts`).

**Tools.** Every tool, grouped by what it is for (files and documents, web, mail, code and
the person's computer, company connectors, memory, projects, coming back later, other agents
and knowledge). Each row has one control with three positions:

| Position | What the gateway does |
|---|---|
| Allowed | What it did before: the tool's level and the person's mode decide. No rule is kept. |
| Ask | The person is asked before every call, whatever mode they chose (policy id `confirm-org-policy`). |
| Off | The call is refused and recorded (`org-tool-off`). The person is not asked; the agent is told to say so and not to go round it. |

- A select at the top right says whose settings are on view: Everyone, or one department.
  A department's row has a fourth position, "As everyone", which is no rule of its own. A
  department's rule stands in place of everyone's, in both directions: Sales may be allowed
  what everyone else is refused.
- A company connector (HTTP or MCP) is one row for all its tools (`company.<connector>.*`).
  The API also takes a rule on one connector tool, which then outweighs the connector's; the
  page does not offer that yet.
- The person's own MCP servers, `plan.set` and the reply itself are not listed.

**What agents may reach.** One row for "Every agent" and one for each agent on the company's
shelf (the platform's, the company's, and people's that were published). "Edit" opens a
dialog: read the person's files and documents; read their mail, calendar and chats; only
these sites (host names, one a line; a host covers what is under it); only these knowledge
bases; only these connectors. An agent's own scope stands in place of "Every agent"; "Remove
limits" takes it away. A call outside the scope is refused and recorded (`agent-scope`),
never asked about. Under a site list: every hop of a page that forwards is held to the
list (`runtime/net.ts`, `onlyHosts`), and where it ended is checked again, so a listed site
cannot hand the agent on to an unlisted one; and the agent may not search the web at all
(`web.search` is refused), since a search brings back any site. "May not read the person's
files" covers every reader: their documents and files here and in Microsoft 365, the folders
on their own computer (`local.list/read/search/find`, a command there and what a running one
printed), and `code.run` when files are put in the sandbox. Writing a file is not reading.

**Where it is enforced.** In the gateway, on every call, as the rules stand at that moment
(`runtime/runs.ts`, `gate`: `effectFor`, `scopeFor`, `outsideScope`): for the reply's own
agent, for an agent a step was passed to, and for a check Muster runs itself. A knowledge
search is also narrowed to the bases in scope when it runs. Nothing of the policy is said in
an agent's instructions.

**One decision, one place.** `decideFor(rules, tool)` says what holds for a tool: the
department's rule before everyone's, a tool's own before its connector's, and for a tool on
the person's computer the stricter of its own rule and the rule of the tools it stands in
for (`DEVICE_TOOLS[name].needs`; where it needs one of several, the most that any is left).
The gateway and the list a conversation begins with both ask it, per tool.

**When the tool list is fixed.** When a conversation's first reply begins, each tool it
would be offered is asked about, and the names of those that are off are written to
`conversations.tools_off`, once. A conversation that already had a reply and has nothing
written (one from before this policy) hides nothing: its model goes on being sent what it
was sent, and the gateway refuses what is off. The page says both in the hint beside
"Tools". That conversation
is never offered those tools, in any later message, even if they are switched on again; and
it keeps being offered every other tool, even one switched off later, which the gateway then
refuses. So what a model is sent (instructions and tool definitions) is the same, to the
letter, from the first message of a conversation to the last, and a policy change costs no
prompt cache (`server/toolPolicy.test.ts`, "is refused at the gateway in a conversation that
was already going"; platform.md, "What is said once"). A tool switched on again reaches
conversations begun after that.

**Who.** `GET /api/policies/tools`: `settings.read`. `PUT /api/policies/tools`
(`{tool, departmentId, effect}`) and `PUT /api/policies/scopes/:agent|everyone`
(`{scope}` or `{scope: null}`): `settings.manage`. Each change that changes something writes
`policy.tool_changed` or `policy.scope_changed` with `before` and `after`.

**Data.** `tool_rules (org_id, department_id, tool, effect)`, `agent_scopes (org_id,
agent_id, scope jsonb)`, `conversations.tools_off text[]`.

**Not built.** A rule for one person or one agent (rules are for everyone or a department;
scopes are per agent); a rule on a single connector tool in the page; scopes for agents a
person built and did not publish (they follow "Every agent"); a preview of who a change
affects; time-limited exceptions. An agent a step is passed to is asked about knowledge
bases by its own list and its own scope (fixed 2026-11-24). The phone and desktop apps show a refused step as any
other blocked step.

> **The administrator's ceiling on modes was removed on 2026-11-21.** The owner: "目的是把
> 授权还给用户，而且不再由管理员决定要不要支持用户选择最高级别的授权，没有意义". Every person
> chooses any of the three modes in each conversation, "Full access" included. Gone: the
> control on the console's Policies page, `GET /api/app/policy`, `PUT /api/settings/policy`,
> `maxMode` in a conversation's and the system's answers, the refusal `mode_not_allowed`,
> and the gateway's reading of `org_settings.max_mode` (the column is left, unread; earlier
> `policy.changed` events stay in the activity log). A conversation stored as "Full access"
> under a lowered ceiling is "Full access" again. What this page says of a ceiling below is
> how it was until then.

**What they see and can do.**
- On top, across the page, the one control: "How far people may let agents go without asking", with the line "In each conversation a person chooses how much an agent may do before it asks them. This sets the most anyone in the organization may choose."
  - Three cards, one per mode, each with the mode's name and the same sentence a member sees: "Ask first" ("Ask before writing a file on your computer and before reading a site you did not name."), "Approve for me" ("Write in the folders you attached without asking. Still ask about a new site."), "Full access" ("Also open any web address without asking. An agent could pass on what it has read by putting it in an address.").
  - The card that is the ceiling has a coloured border and the badge "The most allowed". A card above the ceiling has the badge "Not allowed".
  - Click a card (with `settings.manage`) → it becomes the ceiling. `PUT /api/settings/policy {maxMode}`.
    - Making it looser asks first, in a dialog titled "Allow more": for "Approve for me", "People will be able to let agents write files in folders on their own computers without asking each time."; for "Full access", "People will be able to let agents read any public web page without asking. An agent that has read something private could put it in an address it then opens."
    - Making it stricter happens at once, with no dialog.
  - Under the cards: "Sending a message or a file outside your organization asks you first in every mode." and "A change takes effect at once, in conversations already open too." For a reader without `settings.manage` (the Security auditor) the cards cannot be pressed and the second sentence is "Only an owner or administrator can change this."
- "What the gateway does at each level": five rows. A0, A1 and A2: "Lets it through and records it". A3: "Stops and asks the person who started the run". A4: "Refuses it". Its lead still says: "These rules are built into this version; they cannot be loosened from here."
- A notice: reading a web address the person did not write themselves is treated as A3 and asks first.
- "Tools and their levels": the twelve tools by name with level and a sentence: `docs.list` A0, `docs.read` A0, `docs.write` A1, `files.list` A0, `files.read` A0, `files.create` A1, `web.fetch` A0, `web.send` A3, `m365.mail` A0, `m365.calendar` A0, `m365.files` A0, `m365.chats` A0.
- Nothing else can be changed, clicked or opened.

**Rules.**
- The ceiling is one value for the organization, kept in `org_settings.max_mode`. An organization that has never set it is at "Approve for me" (`apps/server/src/runtime/catalog.ts:59`, `apps/server/src/product.ts:167-172`). So out of the box nobody can choose "Full access".
- Only `settings.manage` may change it; anyone else is refused with `forbidden` (`product.ts:177-179`). Any member may read it (`GET /api/app/policy`, `product.ts:174`), because their own page needs it.
- A change is felt at the next tool call of every run, in conversations already open too: the gateway works out, at each call, the more careful of the conversation's own mode and the ceiling (`apps/server/src/runtime/runs.ts:656-662`). A conversation's stored choice is not rewritten, so raising the ceiling again gives back "Full access" to the conversations that had it.
- What the ceiling changes, and all it changes: whether a write in a folder on the person's computer asks ("Ask first" only), and whether reading an address the person did not write asks (not in "Full access"). Sending outside asks in every mode. See [workspace: Modes](workspace.md#modes-how-much-an-agent-may-do-without-asking) for the table.
- Recorded in the activity log: `policy.changed`, with the mode before and after, only when the value really changed (`product.ts:193-201`).
- The five level rules shown are a fixed list written into the request handler (`product.ts:246-252`). The rules actually enforced are in the run service (`runs.ts:649-821`): A4 is refused; A3 asks; everything else passes; and the mode moves two calls between "passes" and "asks". The list and the enforcement agree today, but one is not read from the other, and the list does not show the mode's effect.
- One rule the page does not show: a person who is asked about reading a page may allow its whole site for that conversation, after which the agent reads other `https` pages of that site without asking (`runs.ts:672-680`). No administrator setting turns this off.
- The level of each tool is fixed in code (`catalog.ts:11-42`).
- The four tools that work in folders on a person's computer (`local.list`, `local.read`, `local.search` at A0; `local.write` at A1) are not in the table: the server lists only the tools a builder can tick (`product.ts:253`; `catalog.ts:68-73`).
- No tool is A2 or A4 today, so two of the five rows never apply.

**States.** Loading; red notice on failure. A failed change shows its reason in red under the cards and the ceiling stays where it was. No empty state: the lists are never empty.

**How it is wired.**
- Screen: `apps/web/src/pages/System.tsx:227` (`PoliciesPage`), `:156` (`ModePolicy`); the mode names and sentences are the member's own, `apps/web/src/i18n/en.ts` `app.modes`; the control's words `system.modePolicy`.
- Requests: `GET /api/system` → `apps/server/src/product.ts:208`; uses `maxMode`, `rules` and `tools`. `PUT /api/settings/policy {maxMode: "ask" | "auto" | "full"}` → `product.ts:177`; writes `org_settings` and, when the value changed, `admin_events`.
- Data: `org_settings` (org_id, max_mode; `schema.ts:361-364`, migration 10). `TOOLS` in `apps/server/src/runtime/catalog.ts:11`; `MODES` at `:52`; `gate` in `apps/server/src/runtime/runs.ts:649`.
- Events: `policy.changed` (target `max_mode`, labelled with the new mode; detail `{from, to}`).
- Tests: `apps/server/src/product.test.ts:1338` "reads any public page without asking only in the freest mode, and only where the organization allows it" (a member cannot change the ceiling; an owner can; a member reads it; lowering it brings an open conversation down; both changes are recorded); `:1744` "reports how the server is really set up, to those allowed to see settings"; enforcement itself at `:334` (each call recorded with its policy decision) and `:809`. No test covers the page.

**Not built.**
- One policy can be edited, and only that one. An administrator still cannot: forbid a tool, forbid a tool to a department or role, allow or block destinations for `web.send` and `web.fetch`, require a second approver, change how long a confirmation waits, or set rules per agent.
- No ceiling per role, department, agent or project: one value for everyone.
- No switch for the things this branch added: an administrator cannot turn off folders on people's computers, cannot turn off Microsoft 365 connections (short of the operator removing the server's key), and cannot say which agents may read a connected account.
- No list of which conversations are in which mode, and no count of how many are in "Full access".
- No data rules: nothing about what content may leave (personal data, secrets), no retention rule.
- No history of policy on this page: the changes are in the activity log only.

**Design findings.**
- Answered on 2026-11-14, in part: the page now changes one thing, the ceiling on modes, with a confirmation when it is loosened and a record in the activity log (`System.tsx:156-225`, `product.ts:177-203`). What remains: everything else on the page is still read-only, and the lead of the rules card still says "they cannot be loosened from here" directly under a control that loosens two of them.
- "Full access" is one click and one dialog for the whole organization, for every agent, the one that reads mail included. The dialog says what could happen; it does not say how many people or which agents it opens it to. Smallest fix: name the agents that read private things in the dialog, or let "Full access" be allowed only for agents without such tools.
- Lowering the ceiling has no dialog and takes effect in the middle of people's work: a run that was writing files starts asking, with nothing telling the person why. Smallest fix: a line in the conversation, "Your organization now asks before this."
- The activity log shows the change as "Changed how far agents may go without asking" on `full` or `ask`: the mode's code, not its name, and not what it was before, though both are stored (`apps/web/src/lib/events.ts:5-26`). Smallest fix: show "Approve for me → Full access".
- The page cannot answer "who is using this?": there is no count of conversations in each mode, and a person's own change of mode is not recorded anywhere. Smallest fix: three numbers under the cards.
- The whole page below the control is in codes: "A0", "A3", "The gateway", `web.send`, `m365.mail`. Smallest fix: lead each row with the words already in the translations and write the rules as sentences.
- Rows A2 and A4 describe things no tool can do. Smallest fix: mark them "No tool reaches this level yet" or leave them out.
- The rule table is a hand-written copy of the enforcement code, and it now leaves out what the mode does. If one changes and the other does not, the console will state a policy that is not in force. Smallest fix: export the decision from one function used by both.
- The tools table lists reading mail, calendar, files and chats at A0, "lets it through", with no word that this is a person's own connected account and that nothing asks before an agent reads it. The head of the enterprise will read A0 as harmless. Smallest fix: a note under the table.
- The folder tools are missing from the table, so the page that says what agents may do does not mention that they can write files on people's computers. Smallest fix: list them, marked "desktop app".

---

## Models

**Who it is for.** `settings.read`: Owner, Administrator, Auditor to read. `settings.manage`: Owner and Administrator to change (MUS-25).

**The job.** "Which model do our agents run on, where does our data go, what does it cost, and let me change it without asking whoever runs the server."

**Where it starts.** `#/admin/models`.

**What they see and can do.**
- **"Models"**, the first card: one row for each model set up here, with the service it is at, its price per million tokens in and out, a badge "Agents run on this" or "Second model", "Sees images", and what its last test said. Under the title, one sentence says where the model in use comes from: "Agents run on the model chosen here…", or "Agents run on <id>, from the server's settings. Choose a model here to replace it; nothing changes until you do.", or "No model is set, so agents cannot run…".
  - "Add model" (off until there is a service): service, model name as the service spells it, four prices in US dollars per million tokens (input, output, cached input, cache write; the last two may be left empty and then cost what input costs), "It can be shown images", and under "More" the context window, the longest reply and the thinking effort.
  - "Test" on a row asks the model for one word with the key that is kept and says what came back: "It answered in 0.8 s.", "The service refused the key. (401)" with the service's own words under it, "The service does not know this model, or the address is wrong. (404)", "The key works, but the service says it is over its limit or out of credit. (429)", "The service could not be reached at this address.", "The service did not answer in 20 seconds.", "The service has no key yet." The result stays on the row ("Answered 3 minutes ago").
  - "…" on a row: "Run agents on this", "Use as second model", "Stop using as second model", "Edit model", "Remove" (not offered for a model in use). Each choice asks first. "Run agents on this" says what it does: it holds from the next message, replies being written finish on the model they began with, every agent gets a new version, and people's own agents approved at high reach wait to be reviewed again.
  - While a model is chosen here, a line under the table: "The server's settings name <id>. It is not used while a model is chosen here." and "Use the server's settings", which asks, then takes the choice away.
- **"Model services"**: where models are bought from. Name, how it is spoken to (OpenAI chat completions or Anthropic messages), address, and the key as "•••• WXYZ · Entered 3 days ago" or a red "No key".
  - "Add service" / "Edit service": name, kind, address (the usual one is filled in for the kind), key (a password field). The key is sealed when saved and never shown again; editing shows "Kept: ends in WXYZ. Type a new one to replace it." Changing the address makes the key be asked for again. "Remove" only when no model is set up at it; the key is deleted with it.
- Red notices at the top when something is wrong: "Agents cannot run: the key of the chosen model's service cannot be read. It was sealed with another server key…", "…has no key…", "The second model is not in use…". When the server has no `MUSTER_SECRET_KEY`, the key field is off and a notice says so.
- An auditor sees all of it and no buttons.
- "Model" (what is in use at this moment, read from the running server): the model's name, the host it is called at, the protocol (`anthropic` or `openai`), whether it can see images, and the price per million tokens in and out, or "Not set, so cost is recorded as zero".
- "Limits": tokens per person per day (or "No limit"), with the note that when it is reached that person's agents stop until midnight UTC; how long an action waits for confirmation (15 minutes); the largest file accepted.
- "Files": how many files are stored and their total size; the space each person has (1 GB); and the 20 people who store the most, with file count and size.
- Limits and Files are read-only.

**Rules.**
- There is one model for every agent, with at most one second model behind it.
- **Which one holds** (`apps/server/src/modelSettings.ts`, `ModelSettings.apply`): when a model is chosen in the console ("Agents run on this"), the console's choice holds whole: its model, its second model or none. The model named with `MUSTER_MODEL_*` is then not used at all, not even as the second. When nothing is chosen in the console, the server's settings hold whole, as before. Setting up services and models changes nothing until one is chosen. How long to wait for the model (`MUSTER_MODEL_FIRST_WORD_SECONDS`, `MUSTER_MODEL_SILENCE_SECONDS`) stays a setting of the server and holds for either.
- If the chosen model's key cannot be read (the server's `MUSTER_SECRET_KEY` changed) or is missing, agents do not run and the console says why. The server never goes back by itself to a model the company chose to leave: that would send the company's words to another service unasked.
- A change holds from the next run. The server reads the choice at start and after every change (`config.model` is set there and nowhere else); a run that is going keeps the model it began with.
- A key is sealed with the server's key (AES-256-GCM, the same as connector credentials, `connections.ts` `sealText`) and never leaves the server: not in any answer, not on the Activity log. The console is told only that there is one, its last four characters (for keys of 20 characters or more) and when it was entered. A key entered for one address is not sent to another.
- Prices are whole millionths of a dollar per million tokens. A run's cost is counted from the prices in force when its calls are made; changing a price does not change what is already recorded.
- The model is part of an agent's version (`product.ts` `ensurePlatformAgents`), so changing it gives every agent a new version, and people's own agents approved at reach R3 or R4 go back to "pending", exactly as when `MUSTER_MODEL_ID` is changed.
- A service's address may be inside the company's network (a model the company hosts). Only owners and administrators can set one; the test returns the service's status and the first 240 characters of its error, never a successful body.
- Every change is on the Activity log: `model_service.created` / `.changed` / `.removed`, `model.created` / `.changed` / `.removed`, `model.chosen` (first and second, before and after), `model.tested`.
- The daily allowance is one number for everyone (`MUSTER_DAILY_TOKENS_PER_USER`); reaching it refuses new messages with `budget_reached`, "You have used today's allowance for agents. It starts again tomorrow." (`product.ts:576-581`, `apps/web/src/i18n/en.ts:136`). A run the allowance stops part-way tells the person so in the conversation: "Stopped: your allowance for agents today is used up. It starts again tomorrow."
- The largest file is set with `MUSTER_MAX_FILE_MB`. The space per person (1 GB) and the confirmation wait (15 minutes) are fixed in code (`files/service.ts:18`, `runs.ts:21`).
- File totals count files that are not deleted.

**States.** Loading; red notice on failure. With no model: a red notice "No model is configured, so agents cannot run. Set MUSTER_MODEL_* where the server is deployed." The "who stores the most" table is absent when nobody has files.

**How it is wired.**
- Screen: `apps/web/src/pages/System.tsx:57` (`ModelsPage`)
- Screen for the two new cards: `apps/web/src/pages/ModelSettings.tsx` (`ModelSettingsCards`).
- Requests: `GET /api/system` → `apps/server/src/product.ts:158`; uses `model`, `limits`, `files`. `GET /api/models`; `POST|PATCH|DELETE /api/models/services[/:id]`; `POST|PATCH|DELETE /api/models/choices[/:id]`; `PUT /api/models/roles` `{first, second}`; `POST /api/models/choices/:id/test` → `apps/server/src/modelSettings.ts` (`registerModels`).
- Data: configuration (`apps/server/src/config.ts`); `model_services`, `model_choices` (schema step 37); `files` (size, user_id, deleted_at; `schema.ts:282-296`).
- Events: see Rules.
- Tests: `apps/server/src/product.test.ts:1309` (settings reported, key not leaked, member refused); `:1328` and `:1354` (the daily allowance stops agents); `apps/server/src/modelSettings.test.ts` (who may read and change; the key in no answer, row or log; a key not sent to a new address; the console's choice replacing the server's settings and giving way; an unreadable key; each outcome of a test; removal).

**Not built.**
- The daily token allowance, the file size and the space per person are still set where the server is deployed. Money limits by month are on Usage.
- One model for everyone: no choice per agent, per department or per person.
- No list of a service's models fetched from the service, no price list fetched from it: both are typed.
- A test asks once; there is no standing check of the service, and a key that stops working is found by the next run failing.
- More than one server process on one database is not supported (as everywhere); a second would not hear of a change.
- No way to see or delete a person's files, and no purge of a removed person's files.

**Design findings.**
- The page is titled "Models" but most of it is limits and file storage. An administrator looking for "how much space is used" will not look under Models. Smallest fix: rename it "System" or split out "Storage and limits".
- The texts name environment variables (`MUSTER_MODEL_*`, `MUSTER_DAILY_TOKENS_PER_USER`). An administrator of the company is often not the person who deploys the server. Smallest fix: "Set by whoever runs the server", with the variable name in a hover.
- "Who stores the most" lists people and sizes with nothing to do about it. Smallest fix: link each person to Members, and state the per-person limit next to the size ("412 MB of 1 GB").
- "Price … Not set, so cost is recorded as zero" is the reason every cost figure on Overview and Usage may read $0.00, yet those pages do not mention it. Smallest fix: the same notice on Usage when the price is unset.
- "Endpoint" shows a host name; the question behind it is "does our data leave our network?". Smallest fix: label it "Data is sent to".

---

## Sandbox

**Who it is for.** `settings.read` to see; `settings.manage` to change (MUS-54).

**The job.** "Where agents' code runs: is it up, what is running and can I stop it, what was run, how much room does it take and when does that come back, how much may each person run, what did it reach."

**Where it starts.** `#/admin/sandbox`, under Platform.

**What they see and can do.** State; Reclaim (release after N idle days, default 7; a cap for all workspaces; last and next pass); Daily limits (everyone, a department, a person); Running now, with Stop; Workspaces, with Release and Release all idle; Runs, filtered by person, ending and period; Network (the hosts code may reach, and connections by host). The whole of it, its rules and its requests are in [sandbox.md](sandbox.md), "The Sandbox page".

**Rules, in short.** A workspace is released after the organization's number of idle days, or when all together are over its cap (longest idle first); never while something runs there, never while a proposal waits to be sent, never under a legal hold. It comes back empty by itself on the next run, and the agent is told once. A person's own daily limit comes before their department's, then everyone's, then the server's settings. Everything is on the Activity log (`sandbox.*`).

**How it is wired.** `apps/web/src/pages/Sandbox.tsx`; `apps/server/src/sandboxAdmin.ts`.

## Connections

**Who it is for.** Owners, administrators and security auditors (`members.read`); ending a connection needs `members.manage`. The question it answers is the one a buyer's technical lead asks first about a product that reads mail: which outside services can agents reach here, who has let them, and can I stop it.

**The job.** See which services this server is registered with and what is asked of them; see every person who has connected and to which account; end a connection.

**Where it starts.** Platform → Connections (`#/admin/connections`). Until 2026-11-15 this place held "Extensions", a design preview with invented names and numbers; a buyer who sees invented data in an admin console stops trusting the rest, so it was removed and this page, which is real, took its place.

**What they see and can do**

- "Code host" (since 2026-11-24, MUS-20; `apps/web/src/pages/CodeHostCard.tsx`, `apps/server/src/codeHost.ts`): the company's GitHub, connected once, and the repositories agents may work on in the sandbox. Two fields: Access token (a password field; afterwards only `•••• WXYZ`) and, only for GitHub Enterprise, its API's address. "Connect" asks the code host whose token it is first and keeps nothing when that fails. Then "Repositories agents may work on": "Choose" lists what the token reaches; each is ticked, for Everyone or for one department, with two more things under it: "Other branches to start from" (work starts from the main branch unless others are listed) and "May change CI workflows" (off: a change to `.github/**` or another CI system's own files is refused; on only for a repository whose workflows need approval before they run, runbook 3c; the row then carries a warning badge and the activity log says so). "Disconnect" asks first. A notice says so when the server has no sandbox ("the work has nowhere to be done yet"). Rules: the token is sealed with `MUSTER_SECRET_KEY`, used only by the server process, never handed to the sandbox and never sent to a browser, the activity log or an error; another address needs it typed again and forgets the repositories named. `settings.read` sees it, `settings.manage` changes it. Recorded: `code_host.set`, `code_host.changed`, `code_host.removed`, `code_host.repos_changed`, and `repo.sent` when a person sends an agent's work. What happens in a conversation is in coding.md, "In the cloud". Requests: `GET`/`PUT`/`DELETE /api/code-host`, `GET /api/code-host/repositories`, `PUT /api/code-host/repos`.
- "Task tracker" (since 2026-11-24, MUS-14; `apps/web/src/pages/TrackerCard.tsx`, `apps/server/src/tracker.ts`): the company's tracker, connected once. Three fields: Address (`https://plane.example.com`), Workspace, API key (a password field; afterwards only `•••• WXYZ`). "Connect" asks the tracker for its projects first and keeps nothing when that fails; what it said is shown ("The tracker refused the key."). Then "Test" (says how many projects it reached) and "Disconnect" (asks first; unlinks every linked project and leaves steps and work items as they are). A badge says how many projects are linked. Under it, "Projects that may be linked": the tracker's projects, each with a tick, and "Save" when something changed. None ticked: no project owner is offered anything; a project already linked stays linked when its tick is taken away. Recorded as `tracker.projects_changed`. Rules: the address is public https and is asked without following redirects; the key is sealed with `MUSTER_SECRET_KEY` and never sent to a browser, the activity log or an error; another address needs the key typed again, and what was linked at the old one is forgotten. `settings.read` sees it, `settings.manage` changes it. Recorded: `tracker.set`, `tracker.changed`, `tracker.removed`, and for projects `project.tracker_linked`, `project.tracker_unlinked`, `tracker.failing`. Why a table of its own (`trackers`) and not one more company connector: a connector is a set of actions offered to agents, by department, each asked for or not; the tracker is not offered to any agent, the server itself keeps steps and tickets in step, and it has no actions to choose. What a project's owner then does with it is in workspace.md, "Steps and the tracker". Saving the connection again also sends anew what had been set aside after failing. Requests: `GET`/`PUT`/`DELETE /api/tracker`, `POST /api/tracker/test`, `GET`/`PUT /api/tracker/projects`.
- "Microsoft 365", row "Sending drafts": whether people may send what agents drafted for them ("Nobody can send" until an administrator chooses "Let people send drafts" in the "…" menu; see `drafts.md`).
- "Microsoft 365": whether the server is registered ("Registered" or "Not set up", with what an operator must do), how many people have connected, and the permissions Muster asks Microsoft for, each as Microsoft names it (`User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`, `Chat.Read`) with a plain meaning on hover, and the line that all of it is reading only.
- "Who has connected": person, service, the account connected, since when. An account that is not the person's own work address is marked "Not their work address".
  - "Disconnect" → asks to confirm → the connection is deleted; the person's agents stop reading at once; the person can connect again. Recorded as `connector.disconnected` with `by: administrator`.

**Rules**

- A person who is suspended or removed loses their connections at that moment, with their runs (`kit.onMemberBlocked` in `apps/server/src/connectors.ts`).
- The page never shows a token, nor anything an agent read through a connection.
- A member cannot see the list (403) or end anyone's connection.

**States.** Not registered: "Not set up" and nobody listed. Nobody connected: "Nobody has connected a service yet."

**How it is wired**

- Screen: `apps/web/src/pages/Connections.tsx` (`ConnectionsPage`); navigation in `apps/web/src/App.tsx`.
- `GET /api/connections` → `{ services, people }`; `DELETE /api/connections/:user/microsoft` (`apps/server/src/connectors.ts`); `Connections.all`, `removeAll` (`apps/server/src/connections.ts`).
- Test: "is seen by administrators, ended by one, and given up when the person is suspended" in `apps/server/src/product.test.ts`.

**Not built**

- Turning a service off for the whole organization, or for some people, from here: it is on for everyone once the operator registers it.
- Which agents may use a connection: any agent a person runs that holds the tools can.
- The web search service is shown on Models, not here.
- Extensions (plugins and skills an administrator approves): nothing exists, and nothing pretends to.

**Design findings**

- An administrator can end a connection but cannot prevent one. A company that wants mail kept away from agents must leave Microsoft 365 unregistered. Smallest change: a switch here, off by default.
- "Not their work address" compares the connected account with the person's Muster address. A person who signs in to Muster with one address and has their mailbox under another is flagged though nothing is wrong.
