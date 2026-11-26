# The marketplace: agents and what they carry, sharing, who sees what, scheduled work, memory

EPIC CHA-168 (tickets CHA-169 to CHA-178). The owner's design of 2026-11-15, taken whole:
"我不做取舍，我要完整". This file is the design the work is built to. Each section says
at its head whether it is **Built** or **Designed, not built**; a section is rewritten from
the code when its part lands, in the same pull request.

## Contents

1. [The model](#1-the-model)
2. [Who sees what: sharing](#2-who-sees-what-sharing) (CHA-169)
3. [What an agent carries](#3-what-an-agent-carries) (CHA-170)
4. [Skills](#4-skills) (CHA-171)
5. [Knowledge bases](#5-knowledge-bases) (CHA-172)
6. [Connectors: the person's own and the company's](#6-connectors-the-persons-own-and-the-companys) (CHA-173), and [MCP servers as connectors](#6a-mcp-servers-as-connectors) (MUS-22)
7. [The marketplace for members](#7-the-marketplace-for-members) (CHA-174)
8. [The marketplace for administrators](#8-the-marketplace-for-administrators) (CHA-175)
9. [Notices](#9-notices) (CHA-176)
10. [Scheduled work](#10-scheduled-work) (CHA-177)
11. [Memory](#11-memory) (CHA-178)
12. [Decisions and what they give up](#12-decisions-and-what-they-give-up)
13. [Conversations and agents](#13-conversations-and-agents) (CHA-179), and [an agent passing a step to another](#13a-an-agent-passes-a-step-to-another) (CHA-264)
14. [Known limits](#14-known-limits-after-review-and-qa-2026-11-15)

## 1. The model

**The agent is the largest thing.** A person works with an agent. An agent has instructions
and tools, and carries skills, knowledge bases and connectors. What it carries comes with
it wherever it goes.

**Four kinds of thing** can be made, shared and published: an agent, a skill, a knowledge
base, a connector. In the code each is an *item*, named by its kind and its id.

**Every item has the same three properties.**

| Property | Values |
|---|---|
| Where it came from | the platform (ships with Muster), the company (an administrator made it), a person |
| Who can see it | only its owner; named people; named departments; the whole company |
| Its place in the marketplace | not there; awaiting review; published; sent back; taken down |

**The owner's four cases** are four rows of that table:

1. An administrator builds an agent and gives it to people → from the company, published; people add it, or their department is given it.
2. A person builds one for themselves → from a person, seen only by its owner.
3. A person shares theirs with one colleague → seen by a named person. Or puts it in the marketplace → awaiting review, then published.
4. Different people see different things → what a person sees is the company's shelf, what their department was given, what was shared with them, and their own.

**Rules that hold everywhere**

- **A shared thing runs as the person using it.** Their documents, their files, their connections, their permissions, their allowance. Sharing an agent never shares its builder's data. (An agent's instructions and a skill's text and files do travel: they are the thing itself.)
- **Review is for the marketplace only** (owner, 2026-11-15). Sharing with named people or departments is the owner's own act and is not reviewed.
- **What may be shared at all** follows the rules an administrator set (section 8): who may build, who may share, who may submit.
- **The five roles stay** (owner, administrator, auditor, billing, member). There is no team lead. A department is the unit of "which team"; a person is in one department or none.
- Every share, submission, decision, take-down and change of owner is in the activity log.
- Deleting and taking down ask first and sit behind a "…" menu. Ending a share is undone by sharing again, so it does not ask; putting away something shared with you does.

## 2. Who sees what: sharing

**Built for agents** on 2026-11-15 (CHA-169): `apps/server/src/sharing.ts`, migration 11, `apps/web/src/app/Share.tsx`, the person's Agents page. Tests: "sharing what a person made" in `apps/server/src/product.test.ts`. Seen in the browser: an agent shared with a colleague, the dialog, the count on the tile. Skills and knowledge bases are shared the same way. Handing everything a person made to another owner is in section 8. Not built: "Shared with me" as one list across kinds (each kind's own page shows what was shared).

**Who it is for.** Every member who made something, and whoever they share it with.

**The job.** "Let this colleague, or this department, use what I made, and take it back when I want."

**Where it starts.** "Share" on an item's page (an agent's panel, a skill, a knowledge base). "Shared with you" in the person's own lists.

**What they see and can do**

- Share: a dialog listing who it is shared with now, a box to find a person by name or address, and the departments. Add or remove each. It says plainly what the receiver gets and what they do not (the owner's data).
- Shared with me: each thing someone shared, with who shared it and when; use it at once; "Make my own copy" (a copy the receiver owns and can change); "Remove from my list" (hides it for them without ending the share for others).
- The owner sees how many people can reach it.

**Rules**

- Only its owner shares an item, and only if the organization's rules let members share. An administrator shares anything of the company's.
- A share is to a person, a department, or (through the marketplace only) the whole company.
- The receiver must be an active member of the same organization.
- A share of an agent brings each thing it carries only as far as that thing is itself visible to the receiver; a part they may not reach is left out when they use it, and they are told which.
- Ending a share takes effect at once: the item leaves the receiver's lists; a conversation already had stays, and its agent can no longer be run by them.
- When the owner is suspended or removed, shares stand and the item keeps working; an administrator hands it to another owner (section 8).
- When an item is deleted, its shares go with it.

**Data.** `shares (id, org_id, kind, item_id, to_kind 'user' | 'department', to_id, by_user_id, created_at)`, unique on (kind, item_id, to_kind, to_id). `share_hidden (user_id, kind, item_id)` for "remove from my list". One function answers "may this person see this item, and why": owner, share to them, share to their department, published in the marketplace (and added, or given to their department).

**Wiring.** `PUT /api/app/items/:kind/:id/shares` and `DELETE …/shares/:toKind/:toId`, `GET …/shares` for the owner; `POST /api/app/items/:kind/:id/hide` for the receiver (it also takes out something added from the marketplace); `POST /api/app/agents/:id/copy`. Every list a person sees (agents, skills, knowledge) is built from the one visibility function.

## 3. What an agent carries

**Built** on 2026-11-15 (CHA-170, CHA-172, CHA-173), for skills, knowledge bases and company connectors: `carry` and `stamp` in `apps/server/src/product.ts`, `agent_parts` (migration 12), the builder and the "carries" chips in `apps/web/src/app/AgentsPage.tsx`, the run in `apps/server/src/runtime/runs.ts`. Tests: inside "skills", "knowledge bases" and "the company's connectors" in `apps/server/src/product.test.ts`.

As built, and differing from the design below in two ways: a carried skill's whole text is given to the model at the start of every run (up to six skills, 16,000 characters each), not taken up on demand; and a part the person may not reach is left out without a line saying so. An agent's version is stamped in one place and covers each carried skill's own version, so a skill that changes changes the agents that carry it; that new version is stamped the next time agents are listed, and an agent an administrator had approved then goes back to awaiting approval, with `agent.sent_back` in the activity log. A connector counts by its address and actions: changing who may use it, or switching it off and on, does not change the agents that carry it.

**Who it is for.** Whoever builds an agent: a member for their own, an administrator for the company's.

**The job.** "Make an agent that knows our way of doing this, can look things up in our documents, and can reach our system."

**What they see and can do**

- In the agent builder, three more parts beside instructions and tools: Skills, Knowledge, Connectors. Each lists what the builder can see; tick to attach.
- On an agent's page, for everyone who can see it: what it carries, by name, with what each is.

**Rules**

- An agent's version covers what it carries (the ids and versions of its parts), so an approval is of exactly that agent.
- At run time, for the person using it:
  - each carried skill the person may see is offered to the model (its name and what it is for; its text and files are read when the model takes it up);
  - each carried knowledge base the person may read is searched by one tool, `knowledge.search`;
  - each carried connector the person may use gives its tools.
- A part the person may not reach is left out, and the reply's first step says which.
- An agent's reach (its risk level) is the furthest of its tools and its connectors' actions.

**Data.** `agent_parts (agent_id, kind 'skill' | 'knowledge' | 'connector', item_id)`.

## 4. Skills

**Built** on 2026-11-15 (CHA-171), except as said under "Not built": `apps/server/src/skills.ts` (storage, `scanSkill`, routes), migration 12, `apps/web/src/app/Skills.tsx` (Agents → Skills), the "/" list in the message box (`Composer` in `apps/web/src/app/Chat.tsx`). Tests: "skills" in `apps/server/src/product.test.ts`. Seen in the browser: a skill that passed, one that did not with what was found, and the "/" list.

**Not built.** Files other than text as a skill's texts (a Word or PowerPoint template): only text files are read, in the page. A copy of a shared skill. The administrator's allow and block lists have their API (`/api/settings/skills`) and no page yet (section 8).

**Who it is for.** Anyone with a way of doing a piece of work that they repeat or want others to follow.

**The job.** "Write down how we do this once, and have any agent do it that way."

**What a skill is.** A name, a line saying when to use it, its instructions (the procedure), and files it needs (a template, an example, a checklist). It names the tools it expects.

**What they see and can do**

- My skills: create, edit, delete; try one in a conversation.
- Use one: type "/" in the message box and pick it; or it comes with an agent that carries it.
- Share and publish like any item.

**Rules**

- **A skill is scanned before anyone but its author can use it** (locked decision D-2). The scan reads its instructions and text files for: telling an agent to send or post anywhere; outside addresses; telling an agent to ignore its rules, hide what it does or act without asking; and anything on the administrator's block list. Addresses on the allow list pass.
- The scan's result is kept with the skill's version and shown: passed, or what was found and where. A skill that did not pass cannot be shared, published or carried by an agent someone else uses. Editing it scans again.
- A skill is instructions, never code: it cannot run anything an agent's tools could not. The gateway still judges every call an agent makes while following it.

**Data.** `skills (id, org_id, owner_user_id, source, name, description, instructions, tools, version, scan_status, scan_findings, deleted_at)`, `skill_files (skill_id, file_id)`, `org_settings.skill_allow`, `skill_block`.

## 5. Knowledge bases

**Built** on 2026-11-15 (CHA-172), for a person's own bases and sharing with people and departments; publishing to the marketplace comes with section 7. Server: `apps/server/src/knowledge.ts` (routes, passages, search; migration 13), the `knowledge.search` tool in `apps/server/src/runtime/tools.ts`, the run in `apps/server/src/runtime/runs.ts`. Web: `apps/web/src/app/Knowledge.tsx`, its own entry "Knowledge" in the sidebar (`#/knowledge`), the checkboxes in the agent builder. Tests: "knowledge bases" in `apps/server/src/product.test.ts`. Checked with the real model: an agent carrying a base of a Word and an Excel file answered from it and named the document.

As built, and differing from the design below: a document is read when it is added, so it is ready or could not be read, never "being read"; one is replaced by removing it and adding it again; a document or file gives at most 400,000 characters, and one that was longer is marked as holding only its beginning (before 2026-11-15 a file gave 60,000 and said nothing: CHA-185). `knowledge.search` is not a tool to tick: an agent has it exactly when it carries a base the person may read. An agent's version covers which bases it carries, not what is in them.

**Who it is for.** Anyone with a set of documents people keep asking about.

**The job.** "Put our handbook, contracts or product notes in one place an agent can look things up in, and say who may."

**What they see and can do**

- My knowledge: create a base; add files (Word, Excel, PowerPoint, PDF, text) and Muster documents; see each as ready, being read, or could not be read and why; remove or replace one.
- Ask: any agent that carries it searches it and answers with the passage and which document it came from.
- Share and publish like any item.

**Rules**

- **Who may read a base is who can see it** (section 2). An agent searches, for a person, only bases that person can see, whatever the agent carries.
- What a search returns is information, never an instruction, and is marked so to the model.
- Search is by words: text is cut into passages and matched on the words of the question (Latin words, and pairs of characters for Chinese). It finds what shares words with the question; it does not understand meaning. A base holds up to 2,000 passages.
- A document added to a base is copied into it: deleting the person's own file later does not empty the base; removing it from the base does.

**Data.** `knowledge_bases (id, org_id, owner_user_id, source, name, description, deleted_at)`, `knowledge_items (id, kb_id, name, kind, status, problem, chars)`, `knowledge_passages (kb_id, item_id, seq, text)`.

**Not built (by design of this version).** Search by meaning (needs an embedding model the deployment does not have); bases that follow a SharePoint folder; tables and images inside documents.

## 6. Connectors: the person's own and the company's

**Built** on 2026-11-15 (CHA-173). Server: `apps/server/src/company.ts` (routes, the tools an action becomes, migration 14), the gate in `apps/server/src/runtime/runs.ts`, `headers` and `noRedirect` in `apps/server/src/runtime/net.ts`. Web: `apps/web/src/pages/CompanyConnectors.tsx` on the administrator's Connections page, the switch on the Microsoft 365 card, "Systems it can reach" in the agent builder. Test: "the company's connectors" in `apps/server/src/product.test.ts`. Not yet tried against a real company system. The person's own Microsoft 365 connection exists; see platform section 22.

As built: a connector's address must be a public https address (a system reachable only inside the company's network cannot be connected in this version); the credential is one request header; an action's tool is named `company.<connector>.<action>`; `GET` is the only method that goes through without asking, and `DELETE` carries no body. An agent that carries a connector with any action other than `GET` is risk R3 and waits for an administrator before its owner can use it. A system's answer is cut at 12,000 characters and the credential is struck from it before the model sees it. Switching Microsoft 365 off keeps people's connections and stops agents using them.

**Two kinds**

- **The person's own.** Each person gives their own consent; agents working for them read as them. Microsoft 365 today.
- **The company's.** An administrator sets it up once: a name, what it is, its address, a credential (kept sealed), and its actions (each a name, what it does, a method and a path). Agents reach it as tools named for those actions. It runs with the company's credential, so what it can reach is the same for everyone allowed to use it.

**Rules**

- A company connector is used only by people in the departments the administrator named, or everyone.
- An action that only reads is let through and recorded; one that changes anything asks the person first, every time.
- An administrator can turn any connector off, the person's-own kind included, for the whole company; it stops at once.
- The credential is never shown again after it is saved, and never reaches the model.
- Requests go only to the connector's own address.

**Data.** `org_connectors (id, org_id, name, description, base_url, auth_header sealed, actions jsonb, departments, enabled)`, `org_settings.connectors_off`.

## 6a. MCP servers as connectors

**Built** on 2026-11-24 (MUS-22), not yet merged or tried against a real MCP server. Server: `apps/server/src/runtime/mcp.ts` (the client, what is kept of a tool, the tools an agent is given), `apps/server/src/mcpConnectors.ts` (the routes), `MCP_SCHEMA` and `usableConnectors` in `apps/server/src/company.ts`, `headers` on an answer and `timeoutMs` in `apps/server/src/runtime/net.ts`. Web: `apps/web/src/components/mcp.tsx` (the two dialogs), `apps/web/src/pages/CompanyConnectors.tsx`, `apps/web/src/app/MyConnectors.tsx`. Test: `apps/server/src/mcp.test.ts`, with a stand-in MCP server.

A remote MCP server is a second kind of company connector. Where the first kind reaches a system through actions an administrator writes out, this kind reaches it through the tools the server itself lists. Everything else is shared: the sealed credential, the departments, "Switched on", what an agent carries, and the gate.

**What it speaks.** The Streamable HTTP transport, and of the protocol `initialize`, `notifications/initialized`, `tools/list` (every page) and `tools/call`. Answers are read as one JSON document or as a stream of events. A session the server gives is carried, and a server that forgot it is greeted again once. It asks for protocol version 2025-06-18 and accepts 2025-11-25, 2025-03-26 and 2024-11-05.

**Not in this version.** Servers that sign in with OAuth; servers that run as a local program (stdio); the older HTTP+SSE transport; prompts, resources, sampling, elicitation and anything else a server offers besides tools; pictures and files in an answer (named, not carried); a server reachable only inside the company's network.

**How an administrator adds one**

1. Admin console → Connections → Company connectors → **Add MCP server**. A dialog asks for a name, what it is, the server address, the credential header and the credential, the departments, and "Switched on".
2. **Connect.** The button reads "Connecting…" while Muster greets the server and reads its tools. If that fails nothing is kept, and the dialog says why in the person's language, with what the server said beside it: nothing answered; it took too long; the address is not public or forwards elsewhere; the server refused the credential; what answered is not an MCP server Muster can talk to; the server answered something unusable.
3. On success the connector is kept and the dialog becomes **Tools of <name>**: the server's name and version, when it was last checked, and every tool with its name, its description in full, "What it takes" (the argument shape), and a mark when the server says it only reads. Every tool starts **off**.
4. The administrator ticks the tools agents should have. Each asks the person before every call (**Ask every time**, the default) unless the administrator chooses **Only reads: run without asking** for it. That choice is the administrator's own statement that the tool changes nothing; the server's claim that a tool only reads is shown beside it and fills in nothing. Save. At most 30 tools of one connector can be on.
5. The connector appears in the table with an "MCP" mark, the tools that are on (those that ask are marked), "N changed" when the server changed tools, and "Not reached" when the last check failed. Its menu has Tools, Connection, Check again and Delete.
6. A person adds the connector to an agent under "Systems it can reach", as with any company connector. Every tool that is on counts as one that changes something, unless an administrator said it only reads: an agent carrying any such tool is risk R3 and waits for an administrator.

**Levels.** A tool that asks is confirmed by the person on every call, in every mode, like a company connector's action that is not a `GET`; it does not run while a conversation is only planning. A tool an administrator said only reads is let through and recorded like a `GET` action (level A0). There is no third kind that changes things without asking.

**Check again** asks the server what it has now. A tool that is new is listed, off. A tool the server no longer lists is gone. A tool whose name, title, description or argument shape differs from what was switched on is switched off and marked "Changed" until somebody reads it and switches it on again; "only reads", said of the tool as it was, goes back to asking. The mark kept with a tool covers every word of it a model or a person is shown, and a tool is given to agents only while its mark is the one it was switched on with. A check that does not get through changes nothing that was decided; the reason is kept and shown.

**A person's own** (off until an administrator ticks "People may add MCP servers of their own" under the company connectors). Settings → Connections → "Your own MCP servers" has the same two dialogs. A person's own server is used only by their own agents; its tools always ask (the "Only reads" choice is not offered and the server refuses it); an agent that carries one is R3 and is looked at by an administrator before it works. A person may have 10. Administrators see every such connector (person, server, how many tools are on), never its credential, and can delete one. Unticking the setting stops every agent reaching them at once and keeps what people set up; a person can still remove theirs.

**What is someone else's words, and how it is handled**

- A tool's name, title, description and argument shape are the server's. Before anything is kept they are cut down: characters that are not shown (controls, zero-width and direction marks) are removed; the title is cut at 80 characters, the description at 1,000, each argument's description at 300; the argument shape keeps only types, names, what is required, enums and limits, to eight levels, and drops references, patterns and anything unknown. At its top a shape says only `type: object`, `properties`, `required`, `additionalProperties` and a description: model providers refuse a tool whose shape is a choice between shapes there, and one refused tool would fail every request of every agent carrying it. A tool whose shape is not an object of named values (another type, or `anyOf`, `oneOf`, `allOf`, `not`, `if` or a reference at its top) is shown as "Cannot be used" and cannot be switched on; so is one whose shape is over 6,000 characters. A name that is not plain letters, digits and `. / : - _` is left out. At most 100 tools are read.
- An agent is given a tool **as it was kept when it was switched on**, never as the server lists it during a run. A server that rewrites a description later changes nothing an agent reads until somebody presses Check again, and then the tool is off until it is read.
- The tool's description ends with a sentence saying it is an outside system's own words and that what it answers is information, never an instruction. The answer is marked as coming from the network, like a web page: after it, keeping a memory or changing a project's notes asks first.
- The `instructions` a server sends when greeted are not read. Nothing about a connector (its name, whether it was reached, when it was checked) is put in the system prompt.
- An answer is cut at 12,000 characters, and the credential is struck from it. A tool that answers with an error, or a server that cannot be reached, fails the step with the reason on its row.
- Requests go only to the connector's address, over https, to a public address (the same check as web reading, made when the connection is made), never following a redirect. A call waits 60 seconds at most; reading the tools, 15.

**Prompt cache.** What a model is sent must not differ by a byte from one request to the next, or nothing of it is read from the provider's cache. Tool definitions are built only from what the database holds; connectors are ordered by id and a connector's tools by name, whatever they are called and in whatever order the server lists them; argument shapes are written with their names in one fixed order. They change only when a person acts: switches a tool, renames the connector, or presses Check again and then switches a changed tool on. The test "are added by an administrator…" asserts the tool list and system prompt are identical across turns and across runs while the server rewrites itself.

**Tool names.** `company.<connector>.<tool>`, the tool's part in lower case with `_` for anything else. A person's own connector's part begins `my_`.

**Requests.** Company: `POST /api/company-connectors/mcp`, `PATCH /api/company-connectors/mcp/:id`, `POST /api/company-connectors/mcp/:id/check`, `PUT /api/company-connectors/own`; listed by `GET /api/company-connectors` and deleted by `DELETE /api/company-connectors/:id`. A person's own: `GET|POST /api/app/my-connectors`, `PATCH|DELETE /api/app/my-connectors/:id`, `POST /api/app/my-connectors/:id/check`. Adding, changing the address or credential, and checking answer `{connected: true, …}` or `{connected: false, reason, said}`. Switching a tool on sends the mark (`hash`) of the tool as it was read; a tool that changed meanwhile is refused with `connector_tool_changed`. A change reads the kept tools again inside its transaction and holds the row, as a check does, so one does not write over the other.

**What is recorded.** In the activity log: `company_connector.created`, `.changed` (the address's origin, the tools that are on and which were said to only read, never the credential), `.checked` (added, removed, and the tools agents had that were switched off), `.check_failed` (the reason), `.deleted`; `connector.own_allowed` and `connector.own_stopped`. A person's own carry `own: true`. Each call is a tool step in the run's trace like any other.

**Data.** Schema step 38 adds to `org_connectors`: `kind` (`http` or `mcp`), `owner_id` (null for the company's), `tools jsonb` (for each: the server's name, the kept title, description and shape, their mark, on, level (`ask` or `reads`), the mark it had when switched on, changed), `server jsonb`, `more`, `checked_at`, `check_failed jsonb`; and `org_settings.own_connectors`.

**Known limits.** A server that keeps a stream open after answering is read until the wait ends, then fails. A tool whose arguments use references is given to the agent with those parts undescribed. Tools that are switched on are not rechecked on their own: a server that changes what a tool does without changing its words is not noticed. Renaming a connector renames its tools, which the next request reads afresh.

## 7. The marketplace for members

**Built** on 2026-11-15 (CHA-174). Server: `apps/server/src/market.ts` (migration 16), and `fromMarket` inside `sharedWith` in `apps/server/src/sharing.ts`, which is how a published thing a person added becomes theirs to use everywhere. Web: `apps/web/src/app/Market.tsx`, its own entry "Marketplace" in the sidebar (`#/market`). Tests: "the marketplace" in `apps/server/src/product.test.ts`.

As built, and differing from the design below: there is no filter by most used or new, only the four shelves and search; a card does not list what an agent carries; the agents everyone has from the start were on the shelf, marked so, until 2026-11-18 (CHA-271, the owner's ruling: they are already among the person's agents, and the shelf is for what could be added; a new organization's shelf is now empty); connectors on the shelf are the company's that the person may use, ready without adding, and the person's own Microsoft 365 stays in Settings. Offering one's own is done from "What you offer" on the Marketplace page, not from each item. **A thing changed by its owner after approval is not kept in its approved form for others: nobody else has it until it is approved again** (the design kept the approved one in use; that needs stored copies of every version). A knowledge base has no version, so adding to it needs no new approval. A person who added an agent gets a knowledge base it carries only if that base is published and added, or shared with them, too. A change to something added is not announced; a take-down is.

**Who it is for.** Every member.

**The job.** "See what the company has that could do my work, add it, and offer mine to everyone."

**Where it starts.** "Marketplace" in the sidebar (`#/market`). For one day (CHA-262, 2026-11-17) it was a tab of "Customize" in the account menu; the owner took it out again on 2026-11-18 (CHA-271): what the company offers is somewhere people go to look, not a setting. The same day "Customize" was removed, and Agents, Skills and Knowledge became tabs beside Marketplace on this row. Knowledge and Notices are no longer entries of their own, which the "Built" notes in this file still say.

**What they see and can do**

- Four shelves: Agents, Skills, Knowledge, Connectors. Search across all; filter by department's own, most used, new.
- A card: name, what it does, who made it, how many people use it, what it carries and how far it reaches.
- "Add" → it is in the person's workspace; "Remove" takes it out. What their department was given is there already and marked so.
- "Publish" on something of their own → it goes to review. They see: awaiting review; published; or sent back, with the reason, and can change it and send it again.
- When something they added changes, a notice says so and what changed; when it is taken down, it leaves their workspace and a notice says why.

**Rules**

- A person sees: everything published to the company; what was published to their department; nothing else.
- Publishing needs the organization's rule to let members submit, and for a skill, a passed scan.
- What is published is one version. A change by its owner after that is a new submission; until it is approved people keep the approved one.

**Data.** `listings (kind, item_id, state, version, departments, submitted_by, submitted_at, decided_by, decided_at, reason)`, `additions (user_id, kind, item_id, added_at)`, `listing_defaults (kind, item_id, department_id)`.

## 8. The marketplace for administrators

**Built** on 2026-11-15 (CHA-175). Server: `apps/server/src/market.ts` (review, catalogue, rules, handing over) and `withinReach` in `apps/server/src/product.ts`. Web: `apps/web/src/pages/Market.tsx`, "Marketplace" in the admin console. Tests: "the marketplace" in `apps/server/src/product.test.ts`.

As built, and differing from the design below: the catalogue shows how many people added each thing, not how much it runs; an administrator publishes the company's own by making it and publishing it from the workspace's Marketplace page, where it goes straight in; handing over is on this page, for owners, and moves agents, skills and knowledge bases (not conversations, documents or files, which stay the person's). The page for a skill's allow and block lists is not built: the lists are set through `PUT /api/settings/skills` only.

**Who it is for.** Owners and administrators; auditors read.

**The job.** "Decide what the company offers its people, see what they use, and stop what should stop."

**What they see and can do**

- Review: what awaits a decision, each with who made it, what it does, what it carries, how far it reaches, its scan. Approve; or send back with a reason the maker reads.
- Catalogue: everything published, who added it, how much it runs. Take one down (asks first): it leaves everyone's workspace.
- Publish the company's own, to everyone or to named departments; mark some as what a department's new people start with.
- Rules: whether members may build their own agents, skills and knowledge; whether they may share; whether they may submit to the marketplace; the furthest reach a personal agent may have.
- Owners: when a person leaves, hand what they own to someone else.

**Rules**

- Only owners and administrators decide. A person does not review their own submission.
- A rule is enforced where the act happens, on the server; the page only shows it.

## 9. Notices

**Built** on 2026-11-15 (CHA-176): `apps/server/src/notices.ts` (migration 16), "Notices" in the sidebar with a count, the list in `apps/web/src/app/Market.tsx`. Told today: something was shared with you (or your department); your submission was approved or sent back; something you added or made was taken down; someone's things were handed to you. Scheduled work joins with section 10. Not told: a change to something you added.

One list in the workspace, with a count in the sidebar, of what happened that the person should know: something was shared with them; their submission was approved or sent back; something they added changed or was taken down; scheduled work finished, failed or is waiting for them. Each opens what it is about. A notice is for one person and is never shown to another.

**Data.** `notices (id, org_id, user_id, kind, detail jsonb, link, created_at, read_at)`.

## 10. Scheduled work

**Built** on 2026-11-15 (CHA-177). Server: `apps/server/src/schedules.ts` (`nextRun`, `Scheduler`, routes; migration 18) and the loop in `apps/server/src/index.ts`, every 30 seconds. Web: "Schedules" in the sidebar (`apps/web/src/app/Schedules.tsx`), The admin console had a "Scheduled work" page listing everyone's schedules; it was taken out on 2026-11-24 at the owner's word (MUS-42): a schedule is the person's own, set up and watched in their workspace. The server's routes for an administrator (`GET /api/schedules`, `POST /api/schedules/:id/pause`) remain and no page uses them. Tests: "scheduled work" in `apps/server/src/product.test.ts`. Checked with the real model on 2026-11-15 through "Run now": the run finished, its notice arrived, and the schedule showed it. A run started by the clock itself has only been seen in the test.

Since 2026-11-19 (quiet start, Q-7): a new schedule is answered by the person's usual agent (the one remembered in this browser, else "Assistant", else the first), said as "Muster answers it." with "Choose another"; before, it was the first agent in the list, and the list was a field to fill. "What you offer" on the marketplace is shown only to someone who has made an agent, a skill or a knowledge base (Q-6).

As built, and differing from the design below: a schedule is made on the Schedules page, not from a conversation or an agent; a person has at most 20; a run that needs the person's confirmation shows in Approvals like any other and gets no notice of its own; an administrator who pauses a schedule cannot resume it, its owner does; a one-off pauses itself once it has run. The organization's daily allowance holds for scheduled runs. A run that was due while the server was down runs once when it is back, not once for each time missed.

**Who it is for.** Any member with work that comes round: a Monday report, a daily digest.

**The job.** "Do this every morning without my asking."

**What they see and can do**

- "Schedule" from a conversation or an agent: what to do (the message), which agent, and when: once at a time; every day at a time; every week on a day; every month on a day.
- My schedules: each with when it runs next and how the last run went; pause, change, run now, delete (asks first).
- Each schedule has its own conversation; every run adds to it.

**Rules**

- A run is the person's own: their data, their allowance, the same gateway.
- **Nothing outward happens unattended.** A call that needs the person's confirmation waits for it, as in any conversation, and a notice says so; if they do not answer in time the run ends there.
- A run that fails says why in its conversation and in a notice. A schedule that fails three times in a row is paused and says so.
- When the person is suspended or removed their schedules stop. An administrator sees all schedules and can pause one.
- Times are in the time zone the person set them in.

**Data.** `schedules (id, org_id, user_id, agent_id, conversation_id, title, prompt, cadence jsonb, timezone, next_run_at, paused, failures, last_run_at, last_status)`. One loop in the server claims due schedules; with one server process per database (as deployed) each runs once.

## 10a. Follow-ups: an agent that waits and comes back

**Built** on 2026-11-17 (CHA-254). Server: `apps/server/src/followups.ts` (`setFollowUp`, `wakeTime`, `Followups`, routes; migration 26), the tool `followup.set` in `apps/server/src/runtime/tools.ts`, and the same 30-second loop in `apps/server/src/index.ts`. Web: "Waiting on" at the top of the Schedules page (`apps/web/src/app/Schedules.tsx`, `WaitingOn`), the line where an agent came back (`apps/web/src/app/Chat.tsx`, `CameBack`), "Follow-ups" in the admin console under Scheduled work (`apps/web/src/pages/Schedules.tsx`). Tests: "follow-ups" in `apps/server/src/product.test.ts`. Tried with the real model on the owner's machine on 2026-11-17: "remind me tomorrow at nine" set one for 09:00 on the person's own clock, it showed under "Waiting on", and "Look now" brought the agent back into the conversation with a question for the person. A wake by the clock itself, and a wake by an arriving mail against real Microsoft 365, have only been seen in the tests.

**Who it is for.** Any member whose work waits on someone or something: a reply, a date, a result.

**The job.** "Don't make me remember to ask again."

**What they see and can do**

- In a conversation, an agent that cannot go on now says when it will be back and what it will then do, and a step "Set a follow-up" shows in the reply. Every agent has the tool; nobody ticks it.
- The agent gives when to look as minutes from now, or as a day and time on the person's own clock. The clock is the time zone the person's browser last sent (`x-muster-timezone`, kept on `users.timezone`); until one has been seen it is UTC, and the agent is told so.
- Optionally one mail address a reply is awaited from. Then the person's Outlook is asked, every five minutes at most and only through their own Microsoft 365 connection, whether anything from that address has arrived since the follow-up was set; one that has brings the agent back sooner. Only a subject and a time are read by the server; the agent reads the mail itself when it is back.
- When it comes back there is a thin line in the conversation ("The agent came back: the time it set has come" or "…a mail from X arrived"), then the agent's reply. The message under that line is written by Muster for the agent and is never shown as the person's words. It is known for Muster's by where it came from (`messages.origin` is `followup`, migration 27), on the server, the web and the phone alike; a message a person types is theirs whatever it begins with (CHA-256). A notice ("Your agent came back about …") links to the conversation once the agent has replied.
- It wakes once. The agent is told it may set one more if what it waited for is still not there, and to ask the person after that.
- Schedules page, "Waiting on": each with what is awaited, what happens then, and when; "Open", "Look now", "End". The last few that ended are listed under them.
- At most 20 waiting per person; from 5 minutes to 90 days ahead.

**States**

- The conversation is busy when the time comes: tried again at the next look.
- It cannot start (the allowance is used up, no agent could be started, or something went wrong on the way): put back ten minutes, three times, then ended as "Could not come back" with a notice. It is never left half-started.
- Its conversation was archived, or its agent is no longer the person's to use: ended at once, with a notice. A conversation or an agent that is deleted outright takes its follow-ups with it, without a notice.
- The person was suspended or removed: everything waiting for them is ended and never wakes.
- The run had read something from outside (a page, a mailbox, a file) before setting it: the person is asked first, with what it would wait for and do, as for a memory. What a page says could otherwise leave an instruction that is read again later.
- A wake by a mail begins as a run that has read from outside, because the subject line is the sender's words: keeping a memory or setting another follow-up asks the person first. The subject cannot close the quotes it is shown in, and an address in a wake message is never taken as one the person gave, so reading it still asks.
- A mail can be waited for only when the person has connected Microsoft 365 and the agent has the mail tool; otherwise the agent is told to give a time. The person's own address is refused.
- An agent that has come back twice since the person last wrote cannot set a third: it is told to ask them.
- The server restarted mid-wake: it waits again.

**For administrators.** The console's Scheduled work page lists every follow-up that waits: what for, for whom, when it comes back; not what it will then do, which is also left out of what administrators see in Approvals and in traces. One can be ended there (`agents.manage`); its person is told. The activity log has `followup.set`, `followup.woken`, `followup.failed`, `followup.ended`.

**On the phone (CHA-256).** The iOS app sends the person's time zone, draws the line where an agent came back, and "Try again" never resends what Muster wrote (`apps/mobile/src/lib/followups.ts`, tested in `apps/mobile/test/followups.test.ts`). Built and type-checked; the screens have not been looked at on a phone or a simulator.

**Why one did not come back** is kept as a word (`conversation_gone`, `agent_gone`, `allowance`, `no_agent`, `not_started`, `member_blocked`, `by_admin`) and said in the person's language in the notice, under "Waiting on", and when "Look now" cannot bring the agent back. A reply to a wake that is gone on with after it was cut off is still a reply to Muster's message: an address in it is not the person's, and the run goes on as one that has read from outside.

**Not there.** A "Waiting on" list on iOS. Waking on a Teams message or a calendar event. Quiet hours, and a wake that ends with nothing to say. A follow-up the person sets by hand.

## 11. Memory

**Built** on 2026-11-15 (CHA-178). Server: `apps/server/src/memory.ts` (migration 17), the `memory.save` tool in `apps/server/src/runtime/tools.ts`, and in `apps/server/src/runtime/runs.ts` the memories given to the model, `OUTSIDE` and `confirmMemory` in the gate. Web: Settings → Memory in `apps/web/src/app/Settings.tsx`. Test: "memory" in `apps/server/src/product.test.ts`. Checked with the real model on 2026-11-15: asked to remember a preference, the agent kept it and it appeared in Settings → Memory. The confirmation after an outside read has only been seen in the test.

As built, and differing from the design below: memory is switched off per person in `memberships.memory_off`, not `users.memory_off`; every remembered sentence is given to the model at the start of each run; the sentence is kept out of the trace (the tool's input and the model's call are recorded without it) and out of what administrators see of an approval, but what the person typed and what the agent answered in that conversation are in its record like any other message.

**Who it is for.** Every member.

**The job.** "Don't make me say it again: how I like reports, who my manager is, what we decided."

**What they see and can do**

- An agent keeps what the person tells it to remember, and may keep a fact it judges they would want kept; either way the reply says "Remembered: …".
- Settings → Memory: everything remembered, each a plain sentence with when and in which conversation; edit, delete, delete all; turn memory off.

**Rules**

- Memory is the person's own. It goes with them to every agent they use; it is never shown to an agent's other users, to the agent's builder or to administrators; it is not in traces beyond the fact that something was remembered.
- **What came from outside cannot write memory unasked.** Once a run has read a web page, a mailbox, a file or a knowledge base, saving a memory asks the person first: text an agent read could otherwise plant an instruction that outlives the conversation.
- At most 200 memories a person, each at most 400 characters. What is remembered is given to the model as what the person said about themselves, not as instructions to obey.

**Data.** `memories (id, org_id, user_id, text, conversation_id, created_at)`, `users.memory_off`.

## 12. Decisions and what they give up

- **Review only for the marketplace.** A member can share an agent that acts outward with a colleague unreviewed. What holds it: the receiver still confirms every outward act themselves, and an administrator can forbid sharing or cap a personal agent's reach.
- **Departments, one per person.** A person in two teams sees one team's shelf. Named sharing covers the rest.
- **Search by words.** A knowledge base finds passages that share words with the question, not ones that mean the same. A deployment with an embedding model could do better; none is assumed.
- **Company connectors are described by an administrator**, action by action. Nothing is discovered from the other system.

## 13. Conversations and agents

**Built** on 2026-11-15 (CHA-179). Server: `messages.agent_id` (migration 15), `agentId` on a message in `apps/server/src/product.ts`, `start` and `stopAgent` in `apps/server/src/runtime/runs.ts`. Web: the `@` picker in the message box and the name on a guest's reply, in `apps/web/src/app/Chat.tsx`. Test: "inviting an agent into a conversation" in `apps/server/src/product.test.ts`. Checked with the real model: in a conversation with one agent, `@Writer` answered one message using what the first agent had found.

**Who it is for.** Everyone who talks to agents.

**The job.** "I am in the middle of something and need another agent for one step, without starting over."

**How conversations and agents relate**

- There is one kind of conversation. A person does not choose between "a chat" and "a conversation with an agent": every conversation has an agent of its own, the one it was started with, and the general Assistant is simply the agent a conversation has when the person picked none.
- Typing `@` in the message box lists the agents the person may use. The one picked answers that message, under its own brief, tools and carried parts, having read the conversation so far. The next message that names nobody goes to the conversation's own agent again.
- Every reply records the agent that gave it, and every message the agent it was for. A reply by a guest carries its name. An agent is told which earlier replies were another agent's.
- A run is on record (trace, approvals, usage) under the agent that did it, not under the conversation's.

**Rules**

- Only an agent the person may use can be invited: published, and theirs, the company's, or shared with them.
- An invited agent works for the person with the person's own documents, files, connections and allowance, like any agent.
- Suspending or deleting an agent stops its running replies in every conversation, its own or as a guest.

**What this foundation is for, and is not yet.** One agent handing a step to another on its own is built (13a). Agents taking up work nobody gave them is not. Agents set for a project (who answers by default there, who may be invited) is not built either; a project today gives its instructions to whichever agent works in it.

## 13a. An agent passes a step to another

**Built** on 2026-11-18 (CHA-264, the first piece of CHA-263). Server: the tool `agent.ask` in `apps/server/src/runtime/catalog.ts` and `tools.ts`; `pass`, `began`, `ended`, `turned` and the list of colleagues in `apps/server/src/runtime/runs.ts`. Web: the step and the steps under it in `StepRow`, the name on the confirmation card, in `apps/web/src/app/Chat.tsx`. Tests: "an agent passing a step to another agent (CHA-264)" in `apps/server/src/product.test.ts`. Tried with the real model on the owner's machine on 2026-11-18: asked to have the Researcher look something up, the Assistant passed the step, the Researcher searched and read pages, its request to read an address nobody gave came up as a confirmation in its own name, and the Assistant answered with what it found.

**Who it is for.** Everyone who talks to agents.

**The job.** "I say what I need once. If part of it is another agent's kind of work, the one I am talking to gets it done there; I should not have to know which agent to call."

**How it works**

- An agent working for a person is told, by name and description, of up to 12 other agents that person may use (their own first, then the company's, then colleagues'; of two with one name only the first of these is listed, and it is the one a step goes to), and has the tool `agent.ask`: the agent's name, the step, and why in a few words. Nobody ticks this tool; it is there whenever there is someone to pass to.
- The other agent works as the same person, under its own brief, carried skills, knowledge bases and company connectors, each only as far as this person may use them, and with the person's memory and profile as any agent has them. It is told the step and nothing else of the conversation.
- Every call it makes stops at the same gateway. What would ask the person asks them, and the request is on record under the agent that wants it; the card names that agent. The conversation's mode, the allowed sites and the day's allowance hold for both.
- What it answers goes back to the first agent as another agent's work to use and check. The person's reply is still the first agent's.
- The person sees a step "Passed a step on" with the agent and the reason, that agent's steps under it with its name, and can open each. Stop stops both.

**Rules**

- Only to an agent the person may use, published, and not itself: looked up at the moment of the call, not from what was listed.
- An agent that was passed a step cannot pass it on, set a follow-up, keep a memory, or change the plan the person sees.
- At most 4 steps are passed in one run (a reply that is gone on with counts again); a step is 4,000 characters at most, and at most 20,000 characters of the answer are handed back.
- An agent a colleague shared is named and described in the colleague's words: with one among those listed, and after any step has been passed, keeping a memory or setting a follow-up asks the person first, in that reply and in later ones of the conversation: the other agent's brief and answer are not the person's words.
- A reply stopped while a step was with another agent is gone on with as one whose outcome is not known: the agent is told to check before doing it again. The same holds when the server died while the step was with the other agent.

**Limits, stated so nobody assumes otherwise**

- The run is on record once, under the agent the person spoke to; the other agent's part is spans under the passed step, marked with its name. Usage by agent in the console counts it for the first agent.
- There is no administrator's switch for passing. Suspending an agent stops it being passed to from then on, but does not stop a step it is in the middle of.
- The phone app shows the step by a general name and does not mark whose steps are under it. Its confirmation card does name the agent that wants the action.
- Whether to pass is the model's judgement. It is told not to pass what it can do itself; nothing enforces that.

## 14. Known limits (after review and QA, 2026-11-15)

Found by an independent reviewer before merging and by QA after (2026-11-15). These were left as they are and are stated here so nobody assumes otherwise.

- **Rules for members apply from when they are set.** Lowering the furthest reach, or switching building or sharing off, does not touch agents and shares that already exist.
- **A connector that gains an action that changes something** raises the reach of the agents that carry it and sends them back for approval the next time agents are listed, not at the moment of the change; each such call asks the person in any case.
- **A name and a description are not part of a version.** The owner of a published skill or agent can change them without a new review. A skill's scan still runs on every save, and a personal agent cannot take the name of one of the company's. The name is compared as it reads: full-width letters are kept as ordinary ones, and letters of other alphabets that look like Latin ones do not make a different name (`sameAs` in `names.ts`).
- **A shared or published agent works with the user's memory and connectors.** Its builder wrote its instructions, so what a person adds from a colleague they should trust as they would a colleague's document. Keeping a memory always asks first under such an agent; reading through a company connector does not ask.
- **A credential is struck from a system's answer** as its whole value and as each part of eight characters or more. A system that returns it in another form (encoded, split) is not caught.
- **The skill scan reads wording, not meaning.** It now catches the plain and disguised ways QA tried (addresses without a scheme, mailboxes, look-alike letters, hiding, setting rules aside, acting without asking, in English and Chinese). A determined author can still find words it does not know; the gateway, not the scan, is what stops sending.
- **A reply that says more than was done is marked, by its wording.** When a reply ends, its words are read against its steps (`runtime/claims.ts`). One that speaks of reading, saving or sending when no tool was used, or of saving or sending when its steps only read, gets a line under it saying what the steps were (`ending` `no_steps`, `only_read`). The line is always true of the steps; whether it appears depends on wording in English and Chinese. It reads narrowly, so that it is not under every explanation: only a sentence in which the agent itself reports a finished action on something outside the reply, never one that explains, asks, supposes or denies, and never a reply that offers a draft. A claim in words the reading does not know is not marked. The mobile app does not show the line yet. Test: "says so under a reply that speaks of work its steps do not show".
- **A daily time inside the hour that a clock change skips** (02:30 on the night clocks go forward) runs an hour early that day.
- **Listing agents checks every agent's version**, three queries each. Fine for hundreds of agents; to be changed before thousands.
- **The names of what an agent carries** are shown to everyone who can see the agent, including parts they cannot open.
- **Handing over moves everything a person made.** There is no handing over of one thing, and no undoing it from the console.
- **While an administrator has suspended one of a person's agents**, in the last 30 days and whether or not they deleted it since, and has not restored it, every agent that person builds, copies or changes waits for an administrator, however little it reaches. Otherwise the stopped agent is built again under another name. Restoring the suspended agent lifts this. Test: "holds what a person builds while an agent of theirs is suspended".
- **The same document is not taken into a knowledge base twice** (`knowledge_duplicate`): same name, same length, same text. A changed copy is taken.
