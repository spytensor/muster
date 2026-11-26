# The workspace

This file describes every feature of the workspace: the part of Muster that any signed-in
member uses to talk to agents, keep documents and files, confirm actions and manage their
own account. It says what the code does on branch `epic/cha-167-local-work`, read from the
web app (`apps/web/src/app`), the desktop app (`apps/desktop/src`), the server
(`apps/server/src`) and the reply schema (`packages/ui-schema`). Every request under
`/api/app` needs a signed-in session and nothing more: there is no permission that gates
the workspace (`apps/server/src/product.ts:152`, `apps/server/src/app.ts:277`), with one
exception that needs no session at all, the address a connected service sends a person
back to (`app.ts:76`, `:281`). The admin console (`#/admin`) is described elsewhere. Paths
are relative to the repository root.

Line numbers: the sections changed for `epic/cha-167-local-work` (sign-in, sidebar, start
page, projects, folders, modes, confirmations, the library, agents, connections, settings)
cite the lines of that branch. The other sections still cite the lines of
`epic/cha-166-polish`; in `product.ts`, `runs.ts`, `tools.ts`, `Chat.tsx` and
`Workspace.tsx` those have moved down since. The file and the function name are what to
trust.

## Contents

1. [Sign-in page](#sign-in-page)
2. [Sidebar and navigation](#sidebar-and-navigation)
3. [Start page (new conversation)](#start-page-new-conversation)
4. [Conversation](#conversation)
5. [Projects](#projects)
6. [Folders on your computer](#folders-on-your-computer)
7. [Progress while an agent works: steps and the plan](#progress-while-an-agent-works-steps-and-the-plan)
8. [Confirmations (an agent asks before an action)](#confirmations-an-agent-asks-before-an-action)
9. [Modes: how much an agent may do without asking](#modes-how-much-an-agent-may-do-without-asking)
10. [Replies as generated UI](#replies-as-generated-ui)
    - [A form in a reply](#a-form-in-a-reply)
11. [Attaching files to a message, and images a model can see](#attaching-files-to-a-message-and-images-a-model-can-see)
12. [Files: upload, list, view, download, delete](#files-upload-list-view-download-delete)
13. [Files an agent makes](#files-an-agent-makes)
14. [Documents (notes agents read and write)](#documents-notes-agents-read-and-write)
15. [Agents page and building a personal agent](#agents-page-and-building-a-personal-agent)
16. [Connections (Microsoft 365)](#connections-microsoft-365)
17. [Settings and the account menu](#settings-and-the-account-menu)
18. [Language and theme](#language-and-theme)
19. [Notifications](#notifications)

Limits that appear in more than one section:

| Limit | Value | Where it is set |
|---|---|---|
| Message text | 20,000 characters | `apps/server/src/product.ts:729` |
| Files per message | 10 | `apps/server/src/product.ts:730` |
| One file | 25 MB by default (`MUSTER_MAX_FILE_MB`) | `apps/server/src/config.ts:303` |
| One person's files in total | 1 GB | `apps/server/src/files/service.ts:18` |
| Images shown to a model per message | 4, each at most 3.5 MB | `apps/server/src/files/service.ts:14-15` |
| Wait for a confirmation | 15 minutes | `apps/server/src/runtime/runs.ts:31` |
| Earlier messages sent to the model | the last 40 complete ones | `apps/server/src/runtime/runs.ts:32` |
| One model turn's output | 4,096 tokens | `apps/server/src/runtime/models.ts:21` |
| One model request | 180 seconds | `apps/server/src/runtime/models.ts:22` |
| Daily allowance per person | off by default (`MUSTER_DAILY_TOKENS_PER_USER`), counted per UTC day | `apps/server/src/config.ts:300`, `apps/server/src/runtime/runs.ts:259` |
| Session length | 7 days by default (`MUSTER_SESSION_DAYS`) | `apps/server/src/config.ts:306` |
| Project name; what agents in it are told | 60 characters; 8,000 characters | `apps/server/src/product.ts:444-448` |
| Folders attached to one project on one computer | 20 | `apps/desktop/src/main.ts:208` |
| One file read from a folder; one file written there | the first 256 KB; 1 MB | `apps/desktop/src/local.ts:13-14` |
| Wait for the person's computer to answer an agent | 60 seconds | `apps/server/src/runtime/runs.ts:163` |
| Wait for a person to finish connecting a service | 10 minutes | `apps/server/src/connections.ts:29` |

---

## Sign-in page

**Who it is for.** Anyone who opens Muster without a session. No permission.

**The job.** "Let me in with my work account."

**Where it starts.** Any address when `GET /api/me` answers 401, or after any request
answers 401 (`apps/web/src/lib/api.ts:283`). After a refused sign-in the server sends the
browser back to `/?error=<reason>`.

**What they see and can do.**
- The Muster mark, "Sign in to Muster", and one line: "Use your work account. Your
  organization's administrators decide who can enter."
- One button per company account the server is set up with, each a white button with a
  thin border, the provider's own mark and "Sign in with Microsoft", "Sign in with
  Google" or "Sign in with <label>" for the company's own OpenID Connect provider (the
  label is `MUSTER_OIDC_LABEL`, or "Company account" when none is set;
  `apps/server/src/config.ts:221`). Microsoft's mark is its four squares, Google's its
  "G", the company's own provider a key (`apps/web/src/App.tsx:277-309`). The buttons
  look the same in the light and the dark theme. The company's own provider is listed
  first.
- Under the buttons, one line: "Single sign-on: you sign in on your company's own page.
  Muster never sees your password."
- In development only, under a dashed rule and the words "Development only": a small
  quiet button "Sign in with a development account". It is kept apart from the company
  buttons so it is never taken for a way in (`App.tsx:365-381`).
- Press a provider button → the page remembers the address the person was headed to
  (`sessionStorage` key `muster.return`) and leaves for `/auth/login/<provider>`. All
  buttons are disabled once one is pressed (`App.tsx:322-327`).
- After a successful sign-in the browser returns to `/`; the remembered `#/…` address is
  restored if the address has no hash (`App.tsx:142-144`).
- Under the card: a language menu and an appearance menu (see
  [Language and theme](#language-and-theme)).
- In the desktop app the screen is different: one button "Sign in with your browser",
  a "Use another server" link, and "Finish signing in in your browser, then come back
  here." while it waits.
- A signed-in person who opens `#/admin` without `console.access` sees "You are signed
  in": their email, organization and role, a "Back to Muster" button and "Sign out".

**Rules.**
- Sign-in is OpenID Connect only. There is no password form.
- The providers are those set where the server is deployed: Google, one Microsoft
  directory, the company's own OpenID Connect provider, or any of these together. A
  provider with only some of its settings stops the server at start, so a button is never
  silently missing (`apps/server/src/config.ts:183-265`). See
  [platform: Sign-in](platform.md#1-sign-in-admission-and-sessions).
- The callback is honoured once and only in the browser that started it (a cookie bound
  to the attempt, 10 minutes) (`apps/server/src/app.ts:182-200`).
- A session the browser already held is ended when someone signs in
  (`apps/server/src/app.ts:208`).
- Recorded in the activity log: `auth.login` with the provider; `auth.logout`. A refused
  sign-in by a suspended person or an identity conflict is also recorded
  (`apps/server/src/auth/admission.ts:91`, `:119`).
- Reasons a person can be refused, each shown in a red box above the buttons
  (`App.tsx:335-339`; `apps/web/src/i18n/en.ts` `login.errors`):
  - `not_member`: "This account has not joined an organization. Ask your administrator
    for an invitation."
  - `suspended`: "Your account has been suspended. Contact your administrator."
  - `email_unverified`: "The sign-in provider did not confirm that this email address is
    yours." With the company's own provider this is what a person sees when the provider
    does not say it checked the address and the operator has not set
    `MUSTER_OIDC_TRUST_EMAIL=1` (`apps/server/src/auth/oidc.ts:56-70`). With Microsoft it
    is what every person sees until the directory sends the optional `xms_edov` claim
    (`oidc.ts:38-41`).
  - `identity_conflict`: "This email address is linked to a different account. Contact
    your administrator."
  - `failed` or any unknown code: "Sign-in did not complete. Please try again."

**States.**
- Loading: the page is blank until `/api/me` answers (`apps/web/src/App.tsx:159`). The
  buttons appear when `/auth/providers` answers.
- No providers, or the list could not be loaded: "Sign-in options could not be loaded."
- `/api/me` failed for a reason other than 401 (server down): the sign-in screen is shown
  with "Cannot reach the server. Check your connection and try again."

**How it is wired.**
- Screen: `apps/web/src/App.tsx:311` (`Login`), `:277` (`ProviderMark`), `:246`
  (`DesktopLogin`), `:386` (`NoAccess`), `:232` (`Shell`), `:134` (`App`).
- Requests:
  - `GET /api/me` → `apps/server/src/app.ts:300`; reads the session.
  - `GET /auth/providers` → `apps/server/src/app.ts:176`; the configured providers.
  - `GET /auth/login/:provider` → `apps/server/src/app.ts:182`; writes `login_attempts`.
  - `GET /auth/callback/:provider` → `apps/server/src/app.ts:191`; `admit` in
    `apps/server/src/auth/admission.ts`; writes `sessions`, `admin_events`.
  - `POST /auth/logout` → `apps/server/src/app.ts:255`.
- Data: `sessions` (`schema.ts:70`, `kind` at `:260`), `login_attempts` (`:84`),
  `users`, `identities`, `memberships`, `invitations`, `org_domains`.
- Events: `auth.login`, `auth.logout`.
- Tests: `apps/server/src/app.test.ts` "who may sign in" (`:62`), "the sign-in exchange"
  (`:158`), "signing in from a native app" (`:598`); `apps/server/src/auth.test.ts`
  "believes a company's own provider when it checked the address, or when the operator
  vouches for it" (`:97`), "takes a company's own OpenID Connect provider, and refuses one
  that is half set" (`:278`). The sign-in exchange is tested against the development
  provider only. The owner ran Microsoft sign-in against a real directory on 2026-11-14
  and it let them in; no automated check repeats that, and Google and a company's own
  provider have still not been run against a real one. No test covers the page itself.

**Not built.**
- No email-and-password or magic-link sign-in.
- No "request access" action for a person who is refused: the message tells them to ask
  an administrator but names no one.
- No choice of organization (one organization per person, `schema.ts:42`).
- No "remember this device" or session-length choice.
- No "use another account" hint: a person signed in to the wrong Microsoft account in
  their browser is refused `not_member` and has to sign out at Microsoft themselves.

**Design findings.**
- Answered on 2026-11-14: the buttons now look like single sign-on (the provider's mark
  and name on a white button), a line says the password never reaches Muster, and the
  development account is set apart under "Development only" (`App.tsx:340-381`).
- The page does not say which organization or server the person is signing in to. In an
  enterprise with a test and a production server this matters. Smallest fix: show the
  host name under the title.
- The same sentence, "Sign-in did not complete. Please try again.", covers a cancelled
  sign-in, an expired attempt and a server error. Smallest fix: keep it, but add "If it
  keeps happening, contact your administrator."
- The error stays in the address (`/?error=suspended`) after it is shown, so reloading
  shows it again even when the cause is gone. Smallest fix: remove the query with
  `history.replaceState` after reading it.
- "Sign-in options could not be loaded." has no retry button. Smallest fix: add one.
- Before the first paint the screen is empty, with no mark and no spinner. Smallest fix:
  show the mark while `/api/me` is loading.
- The company buttons are white with fixed dark text in both themes
  (`App.tsx:349`). In the dark theme they are the brightest thing on the page. That is how
  the providers ask for their marks to be shown; a picky user will still see a glare.
  Smallest fix: none needed; or a dark variant where the provider's guidelines allow one.
- The head of the enterprise will ask what "your company's own page" is when the button
  says "Sign in with Company account". Smallest fix: require `MUSTER_OIDC_LABEL` in
  production so the button names the real provider.

---

## Sidebar and navigation

> **Since 2026-11-19 (quiet start, Q-6; `docs/design/quiet-start.md`).** The sidebar grows
> with the person: Library is shown once they have a file or a document, Inbox once
> anything has ever waited for them or been told to them; Schedules and Marketplace
> always (Schedules since 2026-11-24, MUS-42: what runs on its own is set up, paused and
> watched in the person's own workspace, and the administrators' table is for oversight). A place is also shown while it is the page in front, so an address
> still opens every page. A place that appears for the first time carries a small dot
> until it is opened; the first time this is worked out in a browser, every place then on
> view counts as seen (`muster.places.seen`). The sidebar now also loads
> `/api/app/schedules` (`apps/web/src/app/Workspace.tsx`, `apps/web/src/app/discovery.ts`).

**Who it is for.** Every member.

**The job.** "Start a conversation, get back to one, or go to what I made, what waits for
me and what runs on its own."

**Where it starts.** It is the left column of every workspace address: `#/` (start page),
`#/c/<id>`, `#/documents`, `#/documents/<title>`, `#/approvals`, `#/notices`,
`#/schedules`, and the four under "Marketplace" (`#/market`, `#/agents`, `#/agents/skills`,
`#/knowledge`). Below 768 px
it is hidden and opens as a sheet from the menu button in the top bar.

**What they see and can do.**
- Top: the mark and "Muster".
- First row (CHA-262): "New" (read out as "New conversation"), named, with its shortcut beside it → `#/`. The
  shortcut is `⇧⌘O` / `Ctrl+Shift+O` in a browser and `⌘N` / `Ctrl+N` in the desktop app,
  where `⇧⌘O` works as well. Below 768 px, where the sidebar is hidden, a square-pen button
  beside the menu button in the top bar does the same.
- Second row: "Search conversations", with `⌘K` / `Ctrl+K` beside it, which puts the cursor
  in it (in a narrow window it opens the menu that holds it, then does). The shortcuts
  take Command on a Mac and Control elsewhere, and do nothing under an open dialog. It filters the list as the
  person types: the conversation's title and its agent's name, among the conversations
  already loaded, and a project's name. Escape empties it.
- Four places: Library (`#/documents`), Inbox, Schedules, Marketplace (`#/market`; a row of its own again since 2026-11-18, CHA-271, at the owner's word). Inbox gathers Approvals and
  Notices as two tabs above the page; its number is both together, amber while an approval
  waits and grey when there is only something unread; it opens on Notices when nothing
  waits and something is unread, else on Approvals.
- What agents are and can do is the Marketplace row's four tabs: Marketplace, Agents,
  Skills, Knowledge. "Customize", which held the last three in the account menu from
  2026-11-17, was taken out at the owner's word on 2026-11-18. Every page keeps the
  address it had (`#/agents`, `#/agents/skills`, `#/knowledge`, `#/market`, `#/approvals`,
  `#/notices`, `#/schedules`). Who answers a conversation is not chosen before speaking:
  it is the person's usual agent, and "@" in the message box calls another.
- "Projects", with a folder-plus button → the dialog that makes a project (see
  [Projects](#projects)). With no project yet: one quiet row, "Create a project".
  - Each project is a row with an arrow, a folder and its name. Click the row → its
    conversations fold away or come back. All projects start open; which are folded is
    not remembered after a reload.
  - Under an open project: its conversations, indented, each with its title and a pulsing
    dot while a reply is being written (the agent's name is not shown here). A project
    with none says "No conversations yet".
  - With the pointer over a project row, or with the keyboard on it: a pencil → "Project
    settings" (the same dialog), and a square-pen → "New conversation in <name>", which
    goes to the start page with that project chosen.
- The conversations that are in no project, in three groups by when each was last
  updated: Today, Yesterday, Earlier. A row shows the title (or "New conversation" when
  it has none) and a pulsing dot while a reply is being written; the agent's name is in
  the row's tooltip, not on it. Click a row → open the conversation.
- Bottom: a row with the person's initial, name and organization → opens the account
  menu: their email; Settings (with the shortcut `⌘,` or `Ctrl+,`); Usage; "Admin
  console" (only with `console.access`); "Sign out".
- In the top bar of a conversation, at 1024 px and wider: a "Details" button that opens
  and closes the right-hand panel. The choice is remembered in this browser.

**Rules.**
- The list holds at most the 200 most recently updated conversations
  (`apps/server/src/product.ts:490`). There is no "load more".
- The lists (conversations, projects, pending approvals, documents, files) are loaded
  together when the workspace opens, on every change of address, after every change made
  in the page, and every 15 seconds (`apps/web/src/app/Workspace.tsx:91-118`).
- Day groups use the browser's local midnight (`Workspace.tsx:165`).
- A conversation is listed once: under its project when it has one the page knows, else
  by day (`Workspace.tsx:166-181`).
- While the person searches, a project is shown only if its name or one of its
  conversations matches, and it is shown open (`Workspace.tsx:277-282`).
- A conversation belongs to one person. Nobody else can list or open it.
- The workspace is the window: it is fixed to the edges of the window and never scrolls
  as a whole; only the lists inside it do (`Workspace.tsx:433-434`).

**States.**
- No conversations: "No conversations yet."
- No projects: the row "Create a project".
- Search with no match: "No conversation matches."
- Loading: the list is empty until the first load answers; no placeholder is shown.
- A load that fails shows nothing: the error from `useLoad` is not rendered
  (`Workspace.tsx:91`).

**How it is wired.**
- Screen: `apps/web/src/app/Workspace.tsx:65` (`Workspace`); search and grouping
  `:160-181`; one conversation row `:182-199`; the sidebar `:201-396`; the projects in it
  `:253-340`; the account menu `:352-392`; the window that does not scroll `:434`.
- Requests:
  - `GET /api/app/conversations` → `apps/server/src/product.ts:601`; reads
    `conversations` (with `projectId`), `agents`, and whether a `messages` row is
    `running`.
  - `GET /api/app/projects` → `product.ts:450`.
  - `GET /api/app/approvals` → `product.ts:889`.
  - `GET /api/app/documents` → `product.ts:507`.
  - `GET /api/app/files` → `apps/server/src/files.ts:69`.
- Data: `conversations` (`schema.ts:196`: `title`, `updated_at`, `archived_at`;
  `project_id` `:329`, migration 8), `projects` (`:318`), `messages.status`. In the
  browser: `localStorage` `muster.panel`, `muster.project`. Which projects are folded is
  kept in the page's memory only.
- Events: none.
- Tests: `apps/server/src/product.test.ts` "what one person can reach of another's"
  (`:1656`), "projects" (`:948`). No test covers the sidebar itself.

**Not built.**
- No search inside messages: only titles, agent names and project names are matched.
- No pinning, tags or archive view. A deleted conversation cannot be restored by the
  person.
- No moving of a conversation into a project, out of one, or between two: the project is
  set when the conversation is made and no request changes it. No dragging.
- No order for projects other than by name, and no count of conversations on a folded
  project.
- No rename or delete from the list: both are done inside the open conversation.
- No paging past 200 conversations.
- No keyboard shortcut for a new conversation or for search.
- No unread mark for a conversation whose reply finished while the person was elsewhere.

**Design findings.**
- A person with more than 200 conversations cannot reach the older ones, and search does
  not find them, with no sign that the list is cut. Smallest fix: show "Showing the 200
  most recent" at the end of the list; later, search on the server.
- Search looks like it searches conversations but only matches titles. Titles are the
  first 60 characters of the first message, so much is missed. Smallest fix: change the
  placeholder to "Search titles", or search message text on the server.
- When the lists fail to load (server restart, network), the sidebar is silently empty
  and reads "No conversations yet." Smallest fix: render the `useLoad` error as a notice
  with a retry.
- The row shows a dot while a reply runs but nothing when it has finished unseen.
  Smallest fix: a bold title until the conversation is opened.
- "Usage" in the account menu and "Settings" both open the same dialog on different
  sections; there is no entry for the more common "Language". Smallest fix: leave as is,
  or replace Usage with the two most used sections.
- The Approvals number updates only every 15 seconds for requests raised in other
  conversations. Smallest fix: acceptable; say so in the Approvals page lead, or use one
  workspace-wide event stream.
- A conversation started outside a project can never be put in one, so a person who made
  their project after a week of work has that week left out of it. Smallest fix: "Move to
  project" in the conversation's top bar, as one `PATCH` of `project_id`.
- Inside a project the row drops the agent's name, so two conversations with the same
  first words cannot be told apart. Smallest fix: show the agent's name on hover (it is in
  the row's `title` already) or as a second quiet line.
- The pencil and the new-conversation button of a project appear only under the pointer;
  on a touch screen they cannot be reached. Smallest fix: show them always below 768 px.
- Folded projects open again on every reload. Smallest fix: keep the folded set in
  `localStorage`.
- Searching for a project by its name shows the project with "No conversations yet"
  under it, because its conversations are filtered by their own titles
  (`Workspace.tsx:277-282`, `:333-337`), and above it the list may say "No conversation
  matches." Smallest fix: when the project's name matches, show all its conversations.

---

## Start page (new conversation)

> Since 2026-11-15 (the owner: "已经没有哪家公司还区分这个了……最多就是我们之前的那种艾特的形式")
> nobody chooses an agent before speaking. There is no agent chip or list on the start
> page. A new conversation is answered by the person's usual agent: the general
> Assistant, unless they set another in Settings ("Agent for new conversations").
> Typing "@" in the box lists the agents the person may use, each with its face and
> description, and calls one for that message; on the start page the list opens under
> the line being typed (`apps/web/src/app/Chat.tsx`, `Home` and `Composer`). "Call in a
> new conversation" in an agent's details opens the start page with that agent called, shown
> as an "@Name ×" chip in the row under the text (no chip when it is the usual agent);
> it holds for that conversation only, does not change the usual agent, and gives way
> to an agent called with "@". While the "@" list is open, Enter calls the first agent
> listed and sends nothing (CHA-230), as Enter takes the first skill while the "/" list
> is open; with no agent listed Enter does nothing. The line under the box reads "Type @ to call a
> specific agent, / to use a skill.", or the called agent's description. Where the text
> below speaks of chips above the box or of choosing who answers, this is what is there now.
>
> **Since 2026-11-19 (quiet start, Q-1 to Q-5; `docs/design/quiet-start.md`).** The line
> under the box ("Type @ to call a specific agent, / to use a skill.") is gone; under the box
> there is a line only for an agent called from its own page. The project chip is shown
> only when the person has a project, and the mode chip only once the mode is not "Ask
> first" or the person has chosen one in this browser. The four suggestions are a short
> course: first those for what the person has not used yet (a file, a document, a
> schedule), each giving way once used, then the everyday ones. The schedule suggestion
> opens the new-schedule form with its words in it, weekly on Monday at 09:00, instead of
> filling the box. While the person writes four characters or more, a skill whose name the
> text plainly speaks of is offered in a faint line under the box: Tab or a click takes it
> as a chip and keeps the words, Escape puts it away for this message
> (`skillFor` in `apps/web/src/app/discovery.ts`). The `+` menu lists only connections
> already connected; one not connected is asked for by the card that needs it (the mail
> card's "Connect Microsoft 365"). Under a finished reply in which another agent did a step,
> one quiet line says that agent can be called with "@" next time: once per agent, under
> the first such reply this browser shows (`CallTip` in `apps/web/src/app/Chat.tsx`).
>
> **Since 2026-11-17 (CHA-249).** The greeting, the box and the suggestions sit together a
> little above the middle of the page, whatever the window's height; before, they hung a
> fixed distance from the top (`apps/web/src/app/Chat.tsx`, the start page's wrapper).

**Who it is for.** Every member.

**The job.** "Say what I need and get an agent working on it."

**Where it starts.** `#/`: after sign-in, the "New" row of the sidebar or its shortcut, "Start a
conversation" on an agent's tile, "New conversation in <project>" on a project in the
sidebar, "Ask an agent to make something" in an empty library, or after deleting a
conversation.

**What they see and can do.**
- A greeting with the first word of the person's name (or the part of their email before
  the `@`): "What can I do for you, Mia?"
- A row of chips, one per agent the person may use (published agents of the organization
  and their own published agents). Click a chip → that agent is chosen and remembered
  for next time in this browser. Hovering a chip shows the agent's description. "All
  agents" → `#/agents`.
- A large message box (three lines high, grows to about 12 lines) with the placeholder
  "Say what you need. Drop files here, or add them with +." Enter sends; Shift+Enter adds
  a line; Enter while composing Chinese confirms the word. Files can be dropped on the
  box or pasted. See
  [Attaching files](#attaching-files-to-a-message-and-images-a-model-can-see).
- In the box's bottom row, from the left:
  - **+** → a menu that opens below the box (`apps/web/src/app/PlusMenu.tsx:59`):
    - "Files · or drop them here" → the computer's file chooser.
    - "Connections": one row for Microsoft 365. Connected: the account's address and a
      green tick; click → Settings on Connections. Not connected: "Not connected" and a
      "Connect" pill; click → Microsoft's consent page opens in a new tab (the system's
      browser in the desktop app). The tab is opened within the click and sent to the
      consent page once its address is known, so the browser does not block it
      (`PlusMenu.tsx:35-55`). Not set up on this server: "Not set up on this
      server", greyed out. What is connected is asked of the server each time the menu
      opens. See [Connections](#connections-microsoft-365).
    - "Manage connections" → Settings on Connections.
  - The project chip: "Choose project", or the chosen project's name on a filled chip.
    Click → a menu: "New project"; every project of the person (a search box appears
    when there are more than five; the chosen one has a tick); and, when one is chosen,
    "Project settings" and "No project". The choice is remembered in this browser and is
    where the next conversation starts. See [Projects](#projects).
  - The mode chip: "Ask first", "Approve for me" or "Full access" (amber). Click → the
    three modes with one line each, all of them the person's to choose (until 2026-11-21
    one above an administrator's ceiling was greyed out). Under them: "Sending a message or
    a file outside your organization asks you first in every mode." The choice is remembered in this
    browser for new conversations. See
    [Modes](#modes-how-much-an-agent-may-do-without-asking).
  - On the right: the send button.
- Under the box: the chosen agent's name and description. If the agent has the
  `web.send` tool, the line adds "It asks you before anything leaves the organization."
- Four starter chips. Click one → its text is put in the message box and the box takes
  focus. Nothing is sent.
- "Recent documents": up to six of the person's documents with when each was last
  changed. Click one → `#/documents/<title>`, which opens it in the editor.
- Send → a conversation is created with the chosen agent, in the chosen project and
  mode, the message is sent, and the page moves to `#/c/<id>`.

**Rules.**
- Which agent is chosen when the person has not chosen: the one remembered in this
  browser, else the one named "Assistant", else the first in the list
  (`apps/web/src/app/Chat.tsx:436-439`).
- Which project is chosen: the one remembered in this browser (`muster.project`), if it
  is still one of the person's. Making a project chooses it; deleting the chosen one
  forgets it (`apps/web/src/app/Workspace.tsx:467-480`, `Chat.tsx:423`, `:429-432`).
- Which mode is chosen: the one remembered in this browser (`muster.mode`), "Ask first"
  when none is, and never more than the organization allows (`Chat.tsx:424-428`;
  `apps/web/src/app/ModeChip.tsx:17-24`). The server applies the same ceiling again when
  it makes the conversation, so a remembered choice the organization no longer allows
  becomes the most it does allow (`apps/server/src/product.ts:640-650`).
- A conversation is started in a project of the person's own, or in none: another
  person's project, or one that no longer exists, is refused with `not_found`
  (`product.ts:624-631`).
- A message sent from the desktop app in a project with folders attached also carries
  the names of those folders, which is what lets the agent work in them
  (`Chat.tsx:57-61`, `:447-455`). See [Folders on your computer](#folders-on-your-computer).
- A message needs text or at least one uploaded file. The send button is disabled while a
  file is still uploading.
- The server refuses a conversation with an agent that is not published, was deleted, or
  is another person's own agent: `agent_unavailable`, "This agent is not available to
  run." (`product.ts:632-638`).
- Sending is refused with `model_unavailable` when no model is configured and with
  `budget_reached` when the day's allowance is used: "You have used today's allowance
  for agents. It starts again tomorrow."
- A refused first message loses nothing: the words go back in the message box, unless the
  person has typed something else meanwhile, and the attached files go back in the tray
  (`Chat.tsx:147-160`, `apps/web/src/app/attach.tsx:49-57`).
- When the server refused the first message, the conversation that was made for it is
  removed again (archived, like any deleted conversation), so no empty "New
  conversation" is left in the sidebar. When the connection was lost instead, the
  conversation stays, because the message may have arrived (`Chat.tsx:440-466`).
- Nothing is written to the activity log for creating a conversation or sending a
  message. The run is recorded as a trace.

**States.**
- No model configured: a notice, "No model is configured on this server, so agents
  cannot run yet. Ask an administrator to set one.", and the message box is disabled.
- No usable agent: the box is disabled.
- Agents failed to load: a red notice with the reason.
- Sending: the box is disabled until both requests answer.
- Message refused: the reason in red above the box, and the words and files back in the
  box.
- No documents: the "Recent documents" block is not shown.
- Until the organization's ceiling has loaded the mode chip shows "Ask first" and the
  other two modes greyed out (`Chat.tsx:427`); a message sent in that moment starts its
  conversation in "Ask first".
- The + menu before the server has answered: the Connections heading with no row under
  it. If the answer fails the row stays missing; nothing says why
  (`PlusMenu.tsx:86-90`).

**How it is wired.**
- Screen: `apps/web/src/app/Chat.tsx:417` (`Home`), `:104` (`Composer`);
  `apps/web/src/app/PlusMenu.tsx:59` (`PlusMenu`), `:35` (`connectMicrosoft`);
  `apps/web/src/app/Projects.tsx:191` (`ProjectPicker`);
  `apps/web/src/app/ModeChip.tsx:31` (`ModeChip`).
- Requests:
  - `GET /api/app/agents` → `apps/server/src/product.ts:261`; reads `agents`, creates the
    four starting agents on first use; returns `canRun`.
  - `GET /api/app/policy` → `product.ts:174`; `{maxMode}`, the organization's ceiling.
  - `GET /api/app/connectors` → `apps/server/src/connectors.ts:126`; asked when the +
    menu opens.
  - `POST /api/app/connectors/microsoft/start` → `connectors.ts:130`; answers with the
    address of Microsoft's consent page.
  - `POST /api/app/conversations` `{agentId, projectId?, mode?}` → `product.ts:614`;
    inserts `conversations`.
  - `POST /api/app/conversations/:id/messages` `{content, files, device?}` →
    `product.ts:723`; see [Conversation](#conversation).
  - `DELETE /api/app/conversations/:id` → `product.ts:714`; sent by the page when the
    server refused the first message, to remove the conversation just made
    (`Chat.tsx:456-461`).
- Data: `agents` (`schema.ts:113`, `:194-195`, `:271`), `conversations` (`:196`;
  `project_id` `:329`; `mode` `:360`), `org_settings.max_mode` (`:361`). In the browser:
  `localStorage` `muster.agent`, `muster.project`, `muster.mode`.
- Events: none in the activity log.
- Tests: `product.test.ts` "a conversation" (`:206`), "says so when no model is
  configured" (`:323`), "a message that only brings files" (`:1876`), "projects"
  (`:948`), "how much a person lets agents do without asking" (`:1306`). No test covers
  the page, the + menu or the two chips.

**Not built.**
- No choice of model, no "thinking" or "search the web" switches.
- No voice input.
- No starters set by the organization or tied to the chosen agent: the four are fixed
  text in the translation files.
- No recent files on the start page, only recent documents.
- No draft kept if the person leaves the page before sending.
- No picking, from the + menu, of a file already in the library, and no attaching of a
  folder from there: folders are attached in the project's settings, in the desktop app
  only.
- No way to say "this message may use Microsoft 365" or "may not": an agent that holds
  the Microsoft tools may use them in any conversation once the person is connected.

**Design findings.**
- Answered on 2026-11-14: a refused first message is put back in the message box with its
  files, and the empty conversation made for it is removed (`Chat.tsx:147-160`,
  `:456-461`). What remains: the two steps are still two requests, and no test covers
  it (the behaviour is in the web app only).
- Answered on 2026-11-14: files, the project and connections are reached from the message
  box, each in one place: + for files and connections, a chip for the project, a chip
  for the mode (`Chat.tsx:142-146`, `:519-539`). What remains is below.
- The Microsoft row in the + menu looks like a thing to add to this message, but it adds
  nothing: clicking a connected account opens Settings. A person will expect "use my
  mail for this one". Smallest fix: move connections out of the + menu to a quiet
  "Connected: Microsoft 365" line under the box, or make the row a per-conversation
  switch.
- The mode chip shows three words ("Approve for me") with no object. Approve what? The
  menu explains it, the chip does not. Smallest fix: a `title` that is the mode's own
  line, not the menu's question.
- "Full access" is amber in the chip and its line now says what it risks ("An agent
  could pass on what it has read by putting it in an address."), but choosing it asks
  nothing, and it is remembered
  for every new conversation in this browser (`ModeChip.tsx:21`, `Chat.tsx:535-538`).
  The head of the enterprise will ask why the riskiest choice sticks. Smallest fix: do
  not remember "Full access"; start each new conversation at most at "Approve for me".
- The project chip says "Choose project" even to a person who has none, and the first
  item is "New project": two words for one thing ("Create a project" in the sidebar).
  Smallest fix: one phrase.
- Three of the four starters end with a colon and expect more typing, but nothing tells
  the person so, and one says "the attached spreadsheet" when nothing is attached.
  Smallest fix: place the cursor at the end (already done) and open the file chooser for
  the starter that needs a file.
- The names and descriptions of the four starting agents are English text stored by the
  server (`apps/server/src/runtime/catalog.ts:118`), so a person using Chinese sees
  "Assistant", "Writer" and English descriptions beside Chinese chrome. Smallest fix:
  translate the platform agents' names and descriptions in the web app by name, as tool
  names already are.
- With many agents the chip row wraps without limit and pushes the message box down.
  Smallest fix: show the first five and put the rest behind "All agents".
- The line "It asks you before anything leaves the organization." appears only for
  agents with `web.send`. An agent with `web.fetch` also asks before reading an address
  the person did not write (unless the mode is "Full access"), and nothing says so until
  it happens. Smallest fix: add a matching line for `web.fetch`.
- The enterprise owner will ask why the default is hard-wired to an agent named
  "Assistant". Smallest fix: let an administrator mark one agent as the default.

---

## Conversation

**Who it is for.** Every member, for their own conversations.

**The job.** "Ask, watch the reply arrive, correct course, and keep the result."

**Where it starts.** `#/c/<id>`: a row in the sidebar, the start page after sending, or
"Open conversation" on the Approvals page.

**What they see and can do.**
- Top bar: the title, the agent's name and a bin button. The agent's risk badge is no
  longer shown here.
  - Click the title → it becomes a text field (120 characters). Enter or leaving the
    field saves; Escape cancels.
  - Bin → a dialog "Delete this conversation? Its messages are removed from your list."
    → on confirm the conversation leaves the list and the page goes to `#/`.
- The person's messages on the right, with chips for the files they attached. Click a
  chip → the file viewer.
- Each reply on the left: its plan (collapsed), its steps (collapsed), the reply itself
  (see [Replies as generated UI](#replies-as-generated-ui)), chips for files the agent
  made, then a copy button.
  - Copy → the reply's words without notation go to the clipboard; a tick shows for 1.5
    seconds.
  - A reply says why it ended when it did not simply finish (`Chat.tsx:801-820`):
    - Stopped by the person: "Stopped before finishing."
    - Stopped because the day's allowance ran out part-way: a notice, "Stopped: your
      allowance for agents today is used up. It starts again tomorrow."
    - Failed: "This reply did not finish because something went wrong.", and under it
      one of a few plain causes, for example "The model service is busy or over its
      limit. Try again in a moment."
    - Cut off at the length limit: the reply is shown, and under it a notice, "This reply
      reached the longest a single reply can be and was cut off. Ask it to continue."
      When it was cut off while thinking or writing a call, after finished steps,
      "Continue" is under it too (below). One cut off in the middle of its answer is
      not gone on with: it would write the same answer again.
  - "Try again" appears under the last reply only when it stopped or failed. It sends the
    person's last message again, with the same files, and the work starts from the
    beginning.
  - "Continue" (since 2026-11-15, CHA-227) appears beside it, as the main button, when
    that reply had finished at least one step before it stopped, failed, or was cut off
    at the length limit. It goes on in
    the same reply from the last finished step: the steps and the plan stay, no second
    question appears, and no finished step is done again
    (`Chat.tsx:1220`, `product.ts:1338`). How it works:
    - When a reply ends as failed or stopped, what the agent had asked for and been
      given in that run is kept with the reply, up to the last result; what the model
      was saying when it broke off is not. It is also put down each time the model is
      asked again during the run, so a reply cut off by a server restart can be gone on
      with too (`runs.ts:88`). More than 1.5 MB of it is
      not kept, and then there is only "Try again".
    - Continue gives the model the conversation as it stood, the same message, and that
      kept work, and lets it carry on. The reply goes back to "being written"; its old
      ending is cleared.
    - It is refused with "There is nothing to go on with here. Send the message again
      to start over." when the last reply finished, or failed before any step. The same
      checks as sending apply: the agent is still the person's to use, today's allowance,
      one run at a time.
    - A step that changes something (a file, a document, a memory, something sent, a
      company tool that writes) and was cut off while it ran may or may not have taken
      effect. The model is told so in place of its result, "Whether it took effect is not
      known. Do not do it again blindly: check first whether it already happened, or ask
      the person." This covers a step cut off by Stop, and a step that was running when
      the server died.
    - The skills picked with "/" for the message are kept with the work and apply again,
      as far as they are still the person's to use.
    - What is kept is the tools' results in full (file text, connector data), in the
      reply's row. It is never sent to the browser and goes when the conversation goes.
    - Sending any new message in the conversation drops the kept work: only the latest
      reply can be gone on with.
- While a reply is being written: one line for the steps, the text as it arrives,
  "Working…" until the first text, and a confirmation card when the agent needs one. While
  the model is still writing a long call (a whole document or deck takes it minutes), a
  line says so: "Writing the file", the file's name once the model has given it, and how
  many characters are written so far, counted up as they arrive (the `writing` event,
  sent at most every 400 ms; `apps/server/src/runtime/runs.ts`). A step's time is how long
  the work took: the time the person took to answer a confirmation is left out. The
  live plan is in the reply being written, just above the line for the steps.
  - The steps are one line of small grey text by default, with no frame and an arrow at
    its end, running or finished (the owner's rule of
    2026-11-15: most people do not need every call). While a step runs the line says
    what is being done now and about what ("Read a web page… example.com/a") with the
    count so far; otherwise it says how many steps and what they were, counted by kind
    ("Searched the web ×3 · Read a web page ×11 · Made a file"). Pressing the line opens
    the whole list, each step with its detail and time, in a box that scrolls on its
    own. Only a step that was not allowed puts a warning mark on the line; a page that
    would not load is in the list and not flagged (`Activity` in
    `apps/web/src/app/Chat.tsx`). The plan, when the agent made one, is the progress a
    person follows. The send button becomes a stop button.
  - Stop → the run is aborted; what was written so far is kept and marked stopped.
- The message box at the bottom: "Message <agent>". Same keys, drop and paste as on the
  start page, and the same **+** menu (files, connections). Beside the +:
  - when the conversation is in a project, a chip with the project's name → the
    project's settings (name, what agents are told, folders). The project of a
    conversation cannot be changed here.
  - the mode chip → the three modes; choosing one changes this conversation at once and
    is remembered as the choice for new conversations. See
    [Modes](#modes-how-much-an-agent-may-do-without-asking).
- Follow-up buttons at the end of a reply (when the agent offers them) → send their text
  as the person's next message.
- The right-hand panel (1024 px and wider, toggled by "Details"):
  - "Agent": its description and what it can do, as the same few plain abilities the
    Agents page shows, one line each ("Reads and writes the documents you keep in
    Muster", "Reads public web pages", "Reads your Outlook mail and calendar, … once you
    connect Microsoft 365 in Settings"). Tool names are no longer shown.
  - "Documents in this conversation": every document or file the agent read, saved or
    made in this conversation, newest first, each marked "read" or "saved". Click one →
    a file opens in the viewer; a document opens in the editor on the Documents page.
- The conversation's own list scrolls to the newest content whenever something is added.
  Nothing else moves: the sidebar, the top bar and the message box stay where they are.

**Rules.**
- Only the list of messages scrolls. The page sets that list's own scroll position; it
  no longer asks the browser to bring the end "into view", which also slid every box
  around the list and the whole app with it (`Chat.tsx:724-730`, `:862`;
  `apps/web/src/app/Workspace.tsx:434`).
- One run per conversation at a time. A second message while one is being answered is
  refused: `run_in_progress`, "Wait for the current reply to finish, or stop it." (Since 2026-11-16, CHA-246, only for a file, a skill or another agent: words alone are added to the reply being written.) In the
  page the send button is replaced by stop, so this is met only from another tab.
- The agent of a conversation cannot be changed.
- The title is set from the first message (first 60 characters), or from the first
  attached file's name when the message has no text (`runs.ts:385-388`). The person can
  rename it at any time (1 to 120 characters).
- The model is sent the agent's instructions, today's date, the person's name, and the
  last 40 complete messages. Stopped and failed replies are not sent as history. In a
  project it is also told the project's name and what the person wrote for anyone working
  in it; from the desktop app with folders attached, the folders' names
  (`apps/server/src/runtime/runs.ts:865-879`).
- What an agent asks of the person's computer is answered by the desktop app's page that
  has the conversation open, once for each call. A page in a browser says nothing, and
  the server takes an answer only from the session the message was sent from
  (`Chat.tsx:656-682`, `runs.ts:320-332`). See
  [Folders on your computer](#folders-on-your-computer).
- Deleting archives the conversation (`archived_at`); its messages and the trace of each
  run stay in the database and remain visible to administrators and auditors. A running
  reply is stopped first.
- The daily allowance is checked before a message is accepted and again after every
  model turn inside a run; when it is reached mid-run the run is stopped
  (`runs.ts:837-842`).
- A model turn is capped at 4,096 output tokens. A reply cut off by that cap is stored as
  complete, with the reason kept beside it (`runs.ts:953-965`; `models.ts:124-127`).
- A reply that did not simply finish keeps why in `messages.ending`
  (`runs.ts:956-968`): `allowance` on a stopped reply the allowance ended; `length` on a
  complete reply the output cap cut off; `error` on a failed reply, with the cause in
  `messages.ending_detail`. A reply the person stopped, one stopped because the person
  was suspended or the agent taken away, and a reply that finished have no ending.
- The cause shown for a failed reply is one of five sentences, chosen by the server from
  what went wrong (`causeFor`, `runs.ts:143-154`):
  - the model endpoint answered 429: "The model service is busy or over its limit. Try
    again in a moment."
  - it answered 401 or 403: "The model service refused the request. An operator needs to
    check its key."
  - it answered any other error status: "The model service answered with an error
    (<status>)."
  - it could not be reached: "The model service could not be reached."
  - anything else, a timeout after 180 seconds included: "Something went wrong while the
    agent was working."
  What the endpoint itself said can name internal addresses, so it stays in the trace,
  for those who may read traces. The sentences are the server's English text and are not
  translated.
- A message that is refused is not lost: its words go back in the message box, unless
  the person has typed something else meanwhile, and its files go back in the tray
  (`Chat.tsx:119-123`).
- If the server process stops during a run, the reply is marked failed on the next start
  (`runs.ts:188`).
- Refusals a person can meet here: `not_found` ("That no longer exists. Refresh and try
  again."), `invalid_request` ("The request was not valid.": empty message, more than
  20,000 characters, more than 10 files, an empty title), `model_unavailable`,
  `budget_reached`, `run_in_progress`, `agent_unavailable`.
- Nothing here is written to the activity log. Each run is a trace with spans.

**States.**
- Loading: a spinner until the conversation loads.
- Not found or not the person's: a red notice, "That no longer exists. Refresh and try
  again.", above an empty, disabled message box.
- Agent suspended: a notice "Suspended by an administrator." and the message box is
  disabled. Agent waiting for approval: "Waiting for an administrator's approval."
- Reply states: `running`, `complete`, `failed`, `stopped`. Endings that change how a
  reply looks: `allowance` (on `stopped`), `length` (on `complete`), `error` with its
  detail (on `failed`).
- A reply failed by a server restart has no ending and no detail: it shows only "This
  reply did not finish because something went wrong." (`runs.ts:188`).
- The live stream reconnects by itself; on each connection the server first sends the
  whole current state, so a page opened mid-run shows the run so far.

**How it is wired.**
- Screen: `apps/web/src/app/Chat.tsx:600` (`Conversation`), `:104` (`Composer`), `:408`
  (`Panel`), `:1023-1033` (the agent in the panel), `:985-1019` (the project and mode
  chips), `:656-682` (answering the person's computer), `:724-730` (scrolling);
  `apps/web/src/app/reply.tsx:331` (`Reply`), `:268` (`FollowUpButtons`).
- Requests:
  - `GET /api/app/conversations/:id` → `apps/server/src/product.ts:655`; reads
    `conversations`, `messages` (with `ending` and `endingDetail`), `agents`, pending
    `approvals`; also returns `projectId`, `mode` (never more than the organization
    allows now) and `maxMode`.
  - `GET /api/app/conversations/:id/events` (server-sent events) → `product.ts:792`;
    `Runs.subscribe` `apps/server/src/runtime/runs.ts:275`. A `ping` every 25 seconds.
  - `POST /api/app/conversations/:id/messages` `{content, files, device?}` →
    `product.ts:723`; `Runs.start` `runs.ts:359`; inserts two `messages` rows, updates
    the title, starts the run, writes `traces` and `spans`.
  - `POST /api/app/conversations/:id/device/:call` `{ok, text}` → `product.ts:765`;
    `Runs.deviceAnswered` `runs.ts:320`.
  - `PUT /api/app/conversations/:id/mode` `{mode}` → `product.ts:701`.
  - `POST /api/app/conversations/:id/stop` → `product.ts:784`.
  - `PATCH /api/app/conversations/:id` `{title}` → `product.ts:685`.
  - `DELETE /api/app/conversations/:id` → `product.ts:714`; sets `archived_at`.
- Data: `conversations` (`schema.ts:196`; `project_id` `:329`; `mode` `:360`), `messages`
  (`:208`; `steps`, `plan` `:264-265`; `attachments` `:298`; `ending`, `ending_detail`
  `:303-304`, migration 6), `traces` (`:127`), `spans` (`:150`). Runs in progress, and
  what each is waiting for from the person's computer, live in the server's memory only
  (`runs.ts:152-161`, `:195`).
- Events: live events `state`, `text`, `step`, `plan`, `approval`, `device`, `done`,
  `ping` (`runs.ts:91-125`); `state` carries the calls still waiting on the person's
  computer; `done` carries the reply's `ending` and `endingDetail`. No activity-log
  actions.
- Tests: `product.test.ts` "a conversation" (`:206`: answers and keeps, streams, refuses a
  second message, "records a failed reply as failed, in the message and in the trace"
  `:307`, which also checks `ending: "error"` and the cause "The model service answered
  with an error (500)."; no model), "naming a
  conversation" (`:1469`), "what one person can reach of another's" (`:1221`), "the
  allowance inside a run" (`:1353`: the stopped reply carries `ending: "allowance"`);
  `packages/ui-schema/src/index.test.ts` "a reply as words" (`:110`). No test covers the
  `length` ending or the putting back of a refused message.

**Not built.**
- No editing of a sent message, and no branching.
- No "regenerate" for a reply that completed: "Try again" exists only after a stop or a
  failure.
- No sharing a conversation with a colleague, and no link another person can open.
- No export of a conversation (PDF, Markdown, print view).
- No thumbs up or down, and no way to report a bad reply to administrators.
- No voice input or read-aloud.
- No switching agent or model inside a conversation, and no moving it to another project.
- No timestamps on messages, though `createdAt` is loaded.
- No search inside a conversation.
- No "Continue" button for a reply cut off by the output cap: the notice tells the
  person to ask in words.
- The right-hand panel does not exist below 1024 px: there is no other way to see it on
  a phone or a narrow window.

**Design findings.**
- Answered on 2026-11-14: a reply the allowance stopped part-way is stored with
  `ending = 'allowance'` and shows the allowance sentence in place of "Stopped before
  finishing." (`runs.ts:957-960`, `Chat.tsx:812-817`).
- Answered on 2026-11-14: a failed reply stores one of five plain causes
  (`ending_detail`) and shows it under "something went wrong" (`runs.ts:143-154`, `:968`,
  `Chat.tsx:802-810`). What remains: the causes are the server's English text and are
  not translated; a timeout is not told apart from other failures; a reply failed by a
  restart has no cause.
- Answered on 2026-11-14: a reply cut off at 4,096 tokens is stored with
  `ending = 'length'` and says it was cut off (`runs.ts:963-964`, `Chat.tsx:818-820`).
  What remains: there is no "Continue" button, only the words "Ask it to continue."
- "Try again" sends the same message as a new message, so the conversation shows the
  question twice. Partly answered on 2026-11-15: "Continue" goes on in place. "Try again"
  still shows the question twice.
- Continue: the trace of the reply covers only the part after Continue; the first part
  stays under its own trace, still counted in usage. Kept work has no expiry of its own.
  A schedule whose reply was continued by hand still shows its last run as failed.
  Recorded on CHA-227.
- Continue is not offered for a reply that failed before its first finished step:
  there is nothing to go on from, and "Try again" is the same thing then.
- Answered on 2026-11-14: when sending is refused the words go back in the message box,
  unless the person has typed on, and the files go back in the tray (`Chat.tsx:119-123`,
  `:627-645`; `attach.tsx:49-57`).
- Answered on 2026-11-14: the risk badge is gone from the top bar and the panel shows
  plain abilities in place of tool names (`Chat.tsx:845-860`, `:1023-1033`;
  `apps/web/src/app/AgentsPage.tsx:84`).
- Answered on 2026-11-14: a conversation scrolls its own list and never the whole app
  (`Chat.tsx:724-730`). What remains: the list jumps to the end on every piece of
  arriving text, so a person who scrolled up to read is pulled back down while a reply
  is being written. Smallest fix: follow the end only while the person is already at it.
- The mode chip changes what the running reply may do without a word in the
  conversation: nothing in the list of messages records "from here on, Full access".
  Later the person, or an auditor reading the trace, cannot tell which mode a step ran
  under except from the policy named on its span. Smallest fix: a quiet line in the
  conversation when the mode changes, and the mode on the trace.
- The title is a button with no sign that it can be edited until the pointer is over it.
  Smallest fix: a small pencil on hover, and a "Rename" item beside the bin.
- Delete says the messages "are removed from your list", which is honest, but the person
  is not told that administrators still see them here; that sentence is only in
  Settings › Your data. Smallest fix: add "Administrators keep the record."
- "Documents in this conversation" is built from step details by name. A file that was
  later deleted or replaced still appears; clicking it goes to the Documents page, where
  nothing opens and nothing is said (`Chat.tsx:906-910`). Smallest fix: mark such rows
  "deleted" and disable them.
- The panel title says "Documents" but lists files too. Smallest fix: "Documents and
  files in this conversation".
- Nothing tells the person that only the last 40 messages are remembered. Smallest fix: a
  quiet line in long conversations, "Earlier messages are no longer sent to the agent."

---

### Since 2026-11-15: a word at once and along the way, the side panel, the composer (CHA-221)

Changed on the owner's word, after watching a request sit on "Working…" for two minutes
beside a panel that listed what the agent can do. What is above still holds except where
this says otherwise.

**Who the page says the person is talking to (CHA-271, 2026-11-18, the owner's ruling).**
A conversation nobody called an agent for is with Muster, not with one of four agents
called Assistant: the bar over the conversation and the message box say "Muster" ("Message
Muster") when the conversation's agent is the general one the platform provides, which
the server says (`agent.general` in the conversation, `answers` in
`apps/web/src/app/Chat.tsx`). A colleague's agent of the same name is not it, and a
person who made another agent their usual one sees that agent's name. A conversation with a called
agent names that agent. A confirmation, a reply by a guest and the record still name the
agent itself. The phone app says Muster on its start page only.

**Muster everywhere (2026-11-24, the owner: "不要叫 assistant，就叫 muster").** The general
agent is still stored and looked up as "Assistant", and is named "Muster" wherever its name
reaches a person or a model. It is named so **at the source**, by the server:

- Which agent is the general one is said by its row, not by its name alone: the company's
  (`source = 'platform'`) and kept under that name (`isGeneral`, `shownOf`, `shownSql` in
  `apps/server/src/runtime/catalog.ts`). A person's own agent named "Assistant" from
  before that name was refused (2026-11-15) is theirs and keeps its name everywhere.
- Wherever the server names an agent beside something else, it sends the shown name: who
  replied, who wants an approval (live and on a page opened later), who a conversation or
  a schedule or a follow-up is with, who a project's step is given to, the agent of a
  trace, a sandbox run, an alert, a tool rule, a person's and a member's usage. A client
  draws what it is given.
- What is kept as words for later reading is kept under the shown name from now on: who a
  step of a reply was passed to, who wrote a project's notes, a step or an update, and the
  name of a trace's root span. Rows written before that say "Assistant"; they are read as
  Muster where they are read (`legacySql`, `legacyByline`). The one thing left as written
  is a label in the activity log, since the log's chain was made over it; the console
  reads it as Muster when it shows it (`logLabel`, `apps/web/src/lib/agentName.ts`).
- A model is told the same: its own name among other agents, the agents it may pass a step
  to, who gave it a step, who answered one ("What the agent "Muster" answered"), who could
  not finish one, and who wrote the project's latest update. Nothing of this changes from
  one message to the next.
- A list of agents is the one place a client applies the rule itself, from the row's
  `source` or the server's `general` mark: `shownAgent` and `generalOf` in
  `apps/web/src/lib/agentName.ts`, `shownName` and `generalOf` in
  `apps/mobile/src/lib/types.ts`. The picker after "@" finds it by either name; its chip
  says Muster.
- **Two that would both read Muster.** Nobody's own agent can be named "Muster" from now
  on (`nameTaken`, `apps/server/src/product.ts`), and a copy of a colleague's agent goes
  through the same check, so a copy of an older "Muster" is "Muster (2)". An agent that
  already had the name keeps it, but in what a model is told the general agent is the one
  line that says Muster and the person's own of that name is left out; a step passed to
  "Muster" goes to the general agent whoever else has that name. A step passed to
  "Assistant" goes to the person's own agent of that name when they have one, and to the
  general agent otherwise.

**Quiet where nothing is wrong (CHA-271).** An approvals page with nothing waiting says
"Nothing waits for your decision." in one line; the mark, heading and paragraphs that
explained approvals there are gone (`apps/web/src/app/Pages.tsx`). The note with a border
that a reply can hold (`Callout` in `packages/ui-schema/src/index.ts`) is described to the
model as for something the person has to do now (a decision only they can make, a part of
the request that could not be done), rare, at most one in a reply. Until 2026-11-22 it was
also for what the person "can no longer rely on" and "a figure that may be wrong": models
then ended most replies with a warning box of doubts and things to verify ("一处需要核实的",
"两点值得注意"), and the owner found that it made Muster read as untrustworthy, the
opposite of its purpose. Now caveats, doubts and offers to double-check are named as what a
Callout is never for, and the reply format tells every agent to answer with confidence: to
check what matters with its tools before answering, or say once, plainly, in the sentence
it concerns, that it could not. This is guidance to the model; nothing enforces it.

**A word at once and along the way.**

- Since 2026-11-18 (CHA-270, found by an outside review): the list goes down with what is
  being written only while the person is at its end (within 80 px). Once they scroll up to
  read, their place stays from the first movement up (the wheel, a touch, Page Up, the up
  arrow, Home), and only coming back down to the end follows again; a small "Latest"
  button over the end of the list takes them back. An action that begins to wait for the
  person takes them to the end, wherever they were reading. Sending a message, and opening another conversation, start at
  the end. Before, every piece of text that arrived pulled the list to the bottom
  (`following`, `toLatest` in `apps/web/src/app/Chat.tsx`). Tried on a finished
  conversation in a browser; not yet watched while a long reply was arriving.

- Since 2026-11-18 (CHA-268, found by the owner on the live site): once a reply is over,
  what the agent said along the way is no longer shown above the plan and the answer. A
  long piece of work left a dozen such lines there. They are in the list of steps, each
  in its place. What the person added while it worked stays in sight, and so do the
  agent's words in a reply that has no steps to hold them. While the reply is being
  written the last two are shown, as before.

- The moment a message is taken, the reply's place shows a line in words with a turning
  mark: "On it. Working out what to do…", then "Doing that now…" once the agent has said
  what it will do, then "Going through what came back…" after a step. From five seconds it
  shows how long this part has taken. It does not wait for the run's stream: the answer to
  the send is enough (`Doing` in `Chat.tsx`). The 30-second "nothing has come from the
  model" note stays.
- An agent is told to say, in one short sentence in the person's language, what it is
  about to do before it uses a tool, and to say so again when the work takes several steps
  (`runs.ts`, the instruction beginning "Work the way a good assistant does"). What it says
  in a turn that goes on to use a tool is kept as a step of its own kind (`note`): shown as
  the agent's own line while the reply is being written, and it stays above the steps, in
  a quieter colour, when the reply is over. It is not counted as something done. "Let me
  know if…", "I'll be here…", "我来解释一下：…" are answers and are left alone; if telling
  the agent to go on gives nothing, what it first said is the reply.
- A model sometimes says "I'll check your mail now." and stops. Such a reply (one short
  sentence that names an action a tool does, with nothing after it, when nothing has been
  done yet in the run and the agent has tools) is kept as a `note` and
  the agent is told once, in words marked as Muster's and not the person's, to do it
  (`ANNOUNCES` in `runs.ts`). Seen with the real model on 2026-11-15: it stopped after the
  announcement, was told, and read the mailbox.
- If the page missed the end of a run (the stream dropped), it finds out: while a reply is
  being written it asks every 20 seconds whether it still is, and a conversation loaded
  with a reply still being written shows it as such.

**The side panel** is closed until the person opens it (the button at the right of the
conversation's bar, "This piece of work"), and remembers that. It holds this piece of
work, in this order, each part only when it has something: "Waiting for you" (an action
that waits for an answer; drafts not yet sent, each a jump to its card), "Made and sent"
(drafts sent, documents and files saved), "Read" (documents and files read, the pages
read, by site). With nothing yet it says so in one line. What the agent can do is one line
at the bottom, "What <agent> can do", which opens in place.

**The composer** in a conversation has the same shape as on the start page: the text on
top, and under it the +, the project, the mode and, at the right, Send or Stop.

- Tests: `apps/server/src/product.test.ts`, "an agent that says what it is doing (CHA-221)".
- Not built: the line of words is the page's, not the model's, until the model speaks, and
  how soon the model speaks is the model's. The mobile app shows neither the agent's words
  along the way nor the new panel.

## Projects

**Who it is for.** Every member, for their own projects and for those a colleague
brought them into (see "A project's people" below). No permission.

**The job.** "Keep everything about one piece of work together, and tell every agent
working on it what I want, once."

**Where it starts.**
- The sidebar: the folder-plus button beside "Projects", the row "Create a project", or
  the pencil on a project.
- The project chip in the message box of the start page: "New project", or "Project
  settings" once one is chosen.
- The project chip in the message box of a conversation that is in a project.
A project is a dialog and a group in the sidebar; it has no address of its own.

**What they see and can do.**
- The dialog, titled "New project" or "Project settings", with the line "A project keeps
  the conversations of one piece of work together, and tells every agent working in it
  what you want."
  - Name (60 characters; the placeholder is "Q4 launch"). Enter in the field saves.
  - "What agents working in this project should know and do" (5 rows, 8,000 characters;
    the hint: "The background, who it is for, the tone, what to avoid. Every agent in
    this project reads this first.").
  - "Folders on this computer": see
    [Folders on your computer](#folders-on-your-computer). In a browser this is one
    sentence saying the desktop app can attach folders.
  - In the desktop app, on a new project, the folders are picked here, before the project
    is made (since 2026-11-18; the owner, beside another app's dialog: "我找半天都不知道
    怎么选择文件夹" — the dialog said "Create the project, then attach its folders" and
    showed no button). A dashed box with "Add a folder" → the system's own dialog → the
    folder is listed, with a cross that takes it off again; a project with no name yet
    takes the first folder's name. What was picked is held by the desktop app, which
    attaches only that once the project exists (`muster:pick-folder`, `muster:attach-picked`
    in `apps/desktop/src/main.ts`): the page still cannot name a path. A pick holds for
    ten minutes, under the server it was made under, and is forgotten when it is taken
    off the list, when the dialog is closed without making the project, and on signing
    out. No more than 20 can be picked, as many as a project holds. These messages, like
    all about folders, are taken from the window's own page only, not from a frame in it.
  - "New project" (on a new one) or "Save" → the project is stored, the folders picked
    are attached, and the dialog closes. If a folder could not be attached the dialog
    says which and stays open on the project made, as its settings. A desktop app older than this page
    cannot pick before the project is there: "Add a folder" then makes the project first
    (it asks for a name if there is none) and opens the system's dialog at once, and the
    dialog stays open as the project's settings.
  - On an existing project, "Delete" → a dialog "Delete the project “<name>”? Its
    conversations are kept, no longer grouped." → on confirm the project is removed.
- A project just made becomes the one the next conversation starts in.
- In the sidebar a project is a group that folds, with its conversations under it (see
  [Sidebar](#sidebar-and-navigation)).
- On the start page the project chip chooses where the next conversation starts, or "No
  project" (see [Start page](#start-page-new-conversation)).
- In a conversation that is in a project, the chip shows the project's name and opens
  its settings.

**Rules.**
- A project belongs to one person. Nobody else can list it, start a conversation in it,
  change it or delete it; an attempt answers `not_found`
  (`apps/server/src/product.ts:450-501`, `:624-631`).
- A name is 1 to 60 characters after trimming, and unique for the person with case
  ignored: a second "q4 LAUNCH" is refused with `project_exists`, "You already have a
  project with this name." (`product.ts:444-448`, `:463-468`, `:476-480`;
  `schema.ts:327`).
- What agents are told is at most 8,000 characters. A name or text that breaks the
  limits is refused with `invalid_project`, "A project needs a name of 1 to 60
  characters."
- A conversation belongs to one project or none, set when it is made. No request changes
  it afterwards.
- Every run in a project's conversation is told, after the agent's own instructions and
  the date: `This conversation is part of the person's project "<name>".` and, when the
  person wrote something, `What they asked of anyone working in it:` followed by their
  text (`apps/server/src/runtime/runs.ts:873-878`). This is read at the start of each
  run, so a change applies from the next message, in every conversation of the project.
- It applies to every agent the same way: the organization's, the person's own, and one
  an administrator had to approve. It is added to what the agent was approved with; the
  agent's version does not change.
- Deleting a project deletes only the project. Its conversations stay, with no project
  (`schema.ts:329`: `on delete set null`), and are listed by day again.
- The list is in order of name. The server also counts each project's conversations
  (`product.ts:450-458`); no screen shows the count.
- Nothing about projects is written to the activity log, and the trace of a run does not
  say which project it ran in.
- Folders attached to a project are kept on the computer that attached them, not with
  the project on the server. See the next section.

**States.**
- No project: "Create a project" in the sidebar; "Choose project" on the chip, with "New
  project" as the menu's only item.
- Saving failed: the reason in red in the dialog, which stays open.
- A project with no conversations: "No conversations yet" under it.
- A project deleted in another tab while it is the remembered one: the chip falls back to
  "Choose project", because the remembered id is no longer among the person's projects
  (`apps/web/src/app/Chat.tsx:432`).

**How it is wired.**
- Screen: `apps/web/src/app/Projects.tsx:42` (`ProjectDialog`), `:191`
  (`ProjectPicker`), `:35-39` (the remembered project); the sidebar group
  `apps/web/src/app/Workspace.tsx:253-340`; where the dialog is mounted and what happens
  after it closes `Workspace.tsx:467-480`; the chips `apps/web/src/app/Chat.tsx:519-530`
  (start page) and `:991-1001` (conversation).
- Requests:
  - `GET /api/app/projects` → `apps/server/src/product.ts:450`; the person's projects with
    `name`, `instructions`, `updatedAt` and a count of conversations.
  - `POST /api/app/projects` `{name, instructions}` → `product.ts:460`; answers `{id}`.
  - `PUT /api/app/projects/:id` `{name, instructions}` → `product.ts:471`.
  - `DELETE /api/app/projects/:id` → `product.ts:491`.
  - `POST /api/app/conversations` with `projectId` → `product.ts:614`.
- Data: `projects` (`schema.ts:318`, migration 8: `name`, `instructions`, `user_id`,
  unique `(user_id, lower(name))`), `conversations.project_id` (`:329`). In the browser:
  `localStorage` `muster.project`.
- Events: none.
- Tests: `apps/server/src/product.test.ts` "projects" (`:948`): "keeps conversations
  together and tells every agent in it what the person asked" (a second project of the
  same name in other letters is refused; the model's instructions hold the project's name
  and text; another person cannot start a conversation in it, see it or delete it;
  deleting it keeps the conversation). No test covers changing a project, the dialog or
  the sidebar group.

**Not built.**
- No sharing a project with a colleague or a team: it is one person's.
- No documents or files that belong to a project. The library is one list for the
  person; an agent in a project sees all the person's documents and files, and one
  outside it sees the same.
- No moving a conversation into, out of or between projects.
- (Built since: a project has a page. See "A project's page" below.)
- No agent tied to a project, and no project-only agents.
- No archive: a finished project is deleted or stays in the sidebar.
- No memory across a project's conversations: an agent in one conversation knows nothing
  of what was said in another, beyond what the person wrote in the project's text.
- The activity log records a project's link to the tracker and every change to what
  lives in it (below); its name, instructions, notes, steps and updates are not recorded.

**Design findings.**
- A project promises to keep "one piece of work together" but holds only conversations.
  The deck an agent made in it sits in the library with everything else, and the next
  conversation cannot find it by project. Smallest fix: store the project on files and
  documents made in its conversations and add a project filter to the library.
- "What agents working in this project should know and do" is added to every agent's
  instructions without any review, including an agent an administrator approved as an
  exact version. The head of the enterprise will ask what the approval then covers.
  Smallest fix: record the project text's hash on the trace, so what an approved agent
  was told can be shown later; say on the roster that project text is the person's own.
- Text over 8,000 characters is refused with "A project needs a name of 1 to 60
  characters.", the wrong reason (`product.ts:444-448`). The field stops at 8,000, so
  this is met only by pasting through the limit in another client. Smallest fix: a
  second sentence in the refusal.
- In the desktop app a new project's dialog stays open after "New project", with the
  button now reading "Save". Nothing says "Created". A person may press Save again or
  think it failed. Smallest fix: a line "Project created. Attach its folders, or close."
- Deleting a project in the desktop app leaves its folders in the app's list on that
  computer (`apps/desktop/src/store.ts:80-86` is not called on delete). They are
  unreachable, since no project has that id, but they are not cleaned up. Smallest fix:
  call `removeFolder` for each when a project is deleted.
- The project's settings are opened by clicking the project's name in a conversation's
  message box. A click there reads as "choose another project", and the person lands in
  a settings form. Smallest fix: a small menu with "Project settings" and "Move to…".
- Translations hold words for things that do not exist: "Folders on this computer",
  "Project settings" and "Work in a new project" under the + menu, and "The conversation
  starts in this project." (`apps/web/src/i18n/en.ts` `app.plus`, `app.projects.startsIn`).
  Smallest fix: remove them.

### A project's page: what is happening, and what lives in it

**Who it is for.** Everyone in a project: its owner, and the colleagues brought in to
work in it or to see it.

**The job.** "Show me what this project is made of and how it is going, and let Muster
know the same without my saying it again."

Rebuilt 2026-11-24 (MUS-59). The owner, of a page that was steps, updates and notes in
one column: "这个 UI 肯定不符合一个项目该有的东西吧，一个是 PM，如果是 devops 呢？肯定项目下面有很多仓库
和指引吧", and then: "你要知道这里停留着啥，需要 muster 知道啥，不同的人他们常驻在这里的都是啥，既要 AI
可以操作，也可以用户手动编辑". A project manager, an engineer who runs services and a
salesperson keep different things in a project. So the page has **no kinds of project to
choose from**: it has kinds of things, and shows the kinds a project has something of.

**What they see and can do** (`apps/web/src/app/ProjectPage.tsx:57`).
- The top: the project's name; under it one line, the first line of "What Muster should
  know"; "Add" (a menu of the kinds below, and in the desktop app "Folder on this
  computer" for the owner), the people button, "New conversation", and settings for the
  owner. Under that, small counts, each only when there is something to count: "Steps
  5 / 12", "4 repositories", "1 check failing", "3 pull requests open", "Update 2 hours
  ago".
- From 1024 px wide, two columns. Narrower, one column with the right one **first**: what
  a project is comes before how it is going.
- **Left: what is happening.** "Now" (conversations that wait for the person or are
  working); the steps, in brief: those being done or waiting, and the first still to do,
  with "All 12 steps" opening the whole list in place and "Show less" closing it
  (`ProjectSteps`, `compact`); the latest update, older ones behind "Earlier"; "Where it
  stands", the notes by their first eight lines with "Show all"; files made in the
  project; its conversations.
- **Right: what lives in it** (`apps/web/src/app/ProjectLives.tsx:256`), kind by kind in
  this order, a kind with nothing in it not shown at all:
  - **Repositories**: a repository on the company's code host, named "owner/name". When
    the code host can be asked, its row says how it stands: a mark for the last run of
    its checks on the main branch (passing, failing, running), and "2 PRs" or the name of
    its main branch. In the desktop app the folders attached on this computer are rows
    of the same list, marked "This computer"; their paths stay on the computer.
  - **Guides**: first "What Muster should know", the project's own instructions, edited
    in place by its owner (it was in the settings dialog only). Then the files pinned in
    the project (its "key documents", pinned from a file's row as before, unpinned here
    by the owner), and guides written here: a name, an address, and what to know.
  - **Environments**: where something runs, with what runs there now (a version) and
    since when. The version is said by a person or an agent; nothing reads it from a
    deployment system.
  - **Links**: a board, a dashboard, a folder in a drive.
  - **Contacts**: someone outside, or a team: who, how to reach them, what for.
  - **Facts**: one thing worth knowing that fits none of the others: a decision, a
    constraint, a deadline.
  - Then **People**, one row with their count, opening the people dialog.
- A row is an icon, a name, and one muted fact at its end (pull requests, a version, a
  pinned file's kind, where an address leads). Pressing it opens its address beside the
  app (`noopener`), or the file; one with neither opens what is written of it. A pencil
  on hover, or reached with Tab, opens it for writing in its place: name, address, "What
  Muster should know about it", a repository's name on the code host, an environment's
  version; with up and down among those of its kind, a bin, and who changed it last and
  when ("Changed 2 hours ago by Muster"). Escape closes it.
- An empty project says so small and in the middle: "Nothing lives here yet", one line,
  and the "Add" above it is the one thing to do.
- The phone shows the same groups and counts to look at, each row opened with a tap
  (`apps/mobile/src/screens/Project.tsx`, `apps/mobile/src/lib/lives.ts`).

**Rules.**
- The project's owner and whoever works in it add, change, move and remove; whoever only
  sees it reads (`project_view_only`); to anyone else it is not there (`not_found`)
  (`apps/server/src/projectItemRoutes.ts:57`). Pinning a file and the project's own
  instructions stay the owner's, as before.
- A thing has a name of at most 120 characters, up to 2,000 characters of what to know,
  and an address that begins with `https://` or `http://` and carries no name or
  password (`itemUrl`, `apps/server/src/projectItems.ts:123`). A repository is named as
  its host names it and is in a project once, whatever the case of its letters
  (`item_exists`). What kind a thing is does not change. A project keeps 60 things, 20 of
  a kind (`too_many_items`).
- Someone to reach (a contact) may carry an **email** and a **phone** (digits, spaces
  and dashes, a `+` before a country's code, 30 characters); anything may carry a
  **day that matters** for it (`due`, YYYY-MM-DD: a milestone, a renewal, when a report
  is due); a repository a **branch**. Each is taken away with `""`
  (`ItemState`, `apps/server/src/projectItems.ts`).
- **No key and no password.** A name, what is said of a thing, a version or a branch
  that looks like one is refused (`item_secret`, 422: "That looks like a key or a
  password; keep where it is found, not the secret itself."), by hand and from an agent
  alike: what lives in a project is shown to everyone in it and told to a model with
  every conversation. The shapes are those the repository's own scan refuses (a cloud
  key, a code host's token, a private key, a signed token) and a word for a secret
  followed by a value of letters and digits ("password: …", "密码是 …"). A commit's name
  is a version like any other, and "in 1Password, vault Payments" is where it is found
  (`looksSecret`).
- **A number is a thing's for good.** Things are numbered as they are kept, and a number
  whose thing was removed is not given to another (`projects.item_seq`, schema step 56):
  an agent that names "[4]" from an earlier answer cannot reach what took its place.
  The project is held while a thing is counted, numbered or moved (`select … for
  update`), so several added at once each get a number and a place, and the limits hold
  without leaning on a collision.
- **An agent does the same through two tools**, offered in every conversation that is in
  a project: `project.keep` adds a thing or changes one by its number, `project.drop`
  removes one (`apps/server/src/runtime/tools.ts:367`, `projectKeep` in
  `apps/server/src/runtime/runs.ts`). `project.keep` takes what the page's form takes
  (`branch`, `email`, `phone`, `due`) and `to`, the thing's place among those of its
  kind. A number that no thing can have is refused in words. What is kept and its line
  in the activity log are written together or not at all.
  Whether the person may change the project is asked at each call, so someone left only
  to see it while a reply was being written has nothing changed for them. Once a reply
  has read something from outside, keeping asks the person first, like the notes: what
  is kept is told to every later conversation. The call shows in the conversation as a
  step ("Kept something in the project").
- **What Muster is told.** Every conversation in the project is told what lives there:
  each thing by its number, its name as a quoted string (a name cannot close its own
  quotes), where it is, and what was said of it, **on one line** whatever breaks were
  written in it, under the same names the page uses (Repositories, Guides,
  Environments, Links, Contacts, Facts) (`itemsForAgent`,
  `apps/server/src/projectItems.ts`). A repository is told with its branch and, when
  the project's page has read them, whether its last checks passed and how many pull
  requests are open (`CodeHosts.lastKnown`: what was last read, never asked of the host
  for a message; a run still in progress and when it was read are not said, so this is
  told again only when the repository's state changed). A project that is shared is
  told who is in it and what each may do. Anything in it that would pass for Muster's
  own heading is struck (`notMusters`), in the notes, the steps and the latest update
  too. A conversation whose person was taken out of the project is told none of it any
  more, in new messages or in the earlier ones as they are sent again (`OF_A_PROJECT`). It is said **with the message, not in the
  instructions** (`runs.ts:2401`, a piece of the turn note of kind `lives`), and said
  again only when something changed; the instructions and the tools are the same
  before and after, so a model's service reads them from its cache
  (`apps/server/src/projectItems.test.ts`). Pinned files are named in the list of key
  documents, as before. Where the company's code host is connected, it is told that a
  repository listed can be opened with `repo.open` if the organization lets the person
  work on it.
- **How a repository stands** is asked of the code host after the page is shown
  (`GET /api/app/projects/:id/repos`), only for repositories this person may work on
  (the company's key reaches more than a person is shown), at most once in five
  minutes for each (a failure, once a minute). The answer is
  `{ facts: { "<owner/name>": { branch, pulls, checks, asOf } }, absent: { "<owner/name>":
  "no_host" | "not_allowed" | "failed" }, reason }`: each repository is in one or the
  other, `asOf` is when it was read from the host, and `reason` is the one word for
  the page's one quiet line when every repository lacks its facts for the same reason
  (no code host is connected; this person may not work on it; the host did not
  answer), else null. Nothing of the host's answer and never the key is in it
  (`CodeHosts.standing`, `apps/server/src/codeHost.ts`).
- Each change is written in the activity log: `project.item_added`,
  `project.item_changed`, `project.item_removed`, with the kind and the name, and the
  agent when one did it (`recordItem`, `projectItemRoutes.ts:25`).

**How it is wired.** Table `project_items` (schema step 55). Pinned files stay in
`project_docs`, because what keeps a pinned file from being cleared away reads them
there; the page and the agent are given the two as one list (`lives`,
`projectItems.ts:477`). Routes: `GET/POST /api/app/projects/:id/items`,
`PATCH/DELETE /api/app/projects/:id/items/:item` (a `to` in the body moves it),
`GET /api/app/projects/:id/repos`. The list of projects also says how many things and
repositories each has and when its last update was written.

**Not built.**
- An environment's version is not read from anywhere: a person or an agent says it.
- No dragging: a thing is moved with the up and down in its editor.
- Pinned files keep the order of what they are pinned as; they are not moved among the
  written guides.
- A repository's row links nowhere unless it was given an address.
- The phone shows; it does not change.

---

## Folders on your computer

**Who it is for.** A member using the Muster desktop app, with an agent whose own tools
already read or write the person's files or documents. No permission. A browser tab
cannot use folders.

Since 2026-11-18 an agent can also run commands, change a piece of a file, and search by
pattern there: see [`coding.md`](coding.md), which is the record for all of that and for
what in this section it changed (search has a share for each folder; a file is changed
only as the agent last read it).

**The job.** "Work on the files I already have on this computer, where they are, without
uploading them one by one."

**Where it starts.** Project settings, in the desktop app: "Folders on this computer" →
"Attach a folder". After that, any message sent from the desktop app in a conversation
of that project.

Not yet run in the real desktop app. The server's side and the folder rules are held by
tests; the desktop app's dialog, its channels and the page's part have only been read.

**What they see and can do.**
- In the project's settings (desktop app, after the project exists): "Agents working in
  this project can look in these folders, read and search their text files, and write
  files there. Where the folders are stays on this computer; what an agent reads is sent
  to the model for that answer."
  - "Attach a folder" → the system's own folder chooser (a new folder can be made
    there). The folder joins the list with the name agents use (the folder's own name;
    a second folder of the same name becomes "Reports (2)") and its full path.
  - Choosing the home folder, anything above it, or the system's app-data folder
    (`~/Library` on a Mac and anything in it) → a warning from the system, "That folder
    cannot be attached … Choose the folder the work is in.", and nothing is attached.
  - × on a row → "Detach": the folder leaves the list. Nothing on disk changes.
- In a browser the same place says: "In the Muster desktop app you can attach folders on
  your computer, so agents can read and write the files in them." Before a new project
  is saved it says "Create the project, then attach its folders."
- In a conversation of that project, sent from the desktop app, the agent can:
  - look in a folder ("Look in a folder on your computer"): folders first, then files
    with their size in bytes, 500 entries at most;
  - read a text file ("Read a file on your computer"): code, Markdown, CSV, JSON, plain
    text; the first 256 KB;
  - search ("Search your folders"): files whose name or text contains the words, 60
    matches at most, each with its line;
  - write ("Write a file on your computer"): make a text file or replace the whole
    content of one, 1 MB at most.
- Each of these is a step in the reply, like any other tool. The step names the action
  only, not the file.
- Before a write, in the mode "Ask first": the confirmation card, with the path under
  "Where" and the whole new content in the box. "Allow" → the file is written. In
  "Approve for me" and "Full access" the write happens without asking. See
  [Modes](#modes-how-much-an-agent-may-do-without-asking).

**Rules.**
- Folders belong to a project on one computer and one server. They are kept in a file in
  the desktop app's own data folder, apart for each server address, so a project of one
  server never opens the folders of another (`apps/desktop/src/store.ts:61-86`). The same
  project opened on a second computer has no folders until they are attached there.
- A project holds at most 20 folders on a computer (`apps/desktop/src/main.ts:222`).
- Only the person can name a folder, and only in the system's chooser. A page cannot
  pass a path to attach: the request to attach carries a project id and nothing else
  (`main.ts:198-225`, `apps/desktop/src/preload.ts:20-21`).
- Some folders cannot be attached at all: the home folder, any folder that holds it (the
  disk included), and the folder two levels above the desktop app's own data (on a Mac,
  `~/Library`) with everything in it, which is where the system keeps keychains and
  browser profiles (`apps/desktop/src/local.ts:76-87`, `main.ts:206-220`).
- The server is never told where a folder is. A message carries the folders' names only
  (`apps/web/src/app/Chat.tsx:57-61`; at most 20 names of 120 characters,
  `apps/server/src/product.ts:731-736`), and the agent is told those names
  (`apps/server/src/runtime/runs.ts:868-872`).
- Which of the four an agent gets follows from the tools its builder gave it, never from
  the folder (`apps/server/src/runtime/catalog.ts:61-81`):
  - look in a folder: the agent holds `files.list` or `files.read`;
  - read and search: it holds `files.read`;
  - write: it holds `files.create` or `docs.write`.
  An agent that may not write the person's documents may not write their folders either.
  Of the four starting agents the Assistant, Writer and Researcher get all four; the
  Messenger's tools are not listed here (Not verified: read `PLATFORM_AGENTS` in
  `catalog.ts:118` for it).
- They are offered only in a run whose message came with folder names, which only the
  desktop app sends. A message from a browser, or in a conversation outside a project,
  gives the agent none of them (`runs.ts:899-943`, `apps/server/src/runtime/tools.ts:605-623`).
- The work is done on the person's computer, never on the server. The server sends the
  call to the page that has the conversation open; that page has the desktop app do it
  and sends the answer back (`runs.ts:903-941`, `Chat.tsx:656-682`,
  `main.ts:239-259`).
- Only the computer the message was sent from answers. The server keeps the session the
  message came from with each call and takes an answer only from that session; another
  person, or the same person signed in elsewhere, gets `not_found`. A page in a browser
  does not answer at all (`apps/server/src/product.ts:757`, `:765-782`; `runs.ts:320-332`;
  `Chat.tsx:660-661`).
- A call can arrive before the page knows which project the conversation is in; the page
  waits up to 10 seconds for that, then gives up without answering (`Chat.tsx:663-667`).
- The computer has 60 seconds to answer. After that the agent is told "The person's
  computer did not answer. The desktop app must be open on this conversation." Stop ends
  a waiting call at once (`runs.ts:163`, `:903-924`).
- An answer is at most 400,000 characters on the way in; the page cuts what it sends at
  380,000. The agent is given the first 60,000 characters, as with a document read on
  the server, and is told there is more and to search instead; a refusal is cut to 2,000
  (`product.ts:770-773`, `Chat.tsx:674`, `runs.ts:165`, `:929-938`).
- Inside the folders (`apps/desktop/src/local.ts`):
  - A path starts with an attached folder's name. `..` is refused ("A path cannot step
    out of its folder."), and so is any path that, once links are followed, lies outside
    the folder ("That path leads outside the attached folder.") (`local.ts:92-126`).
  - Files that look like keys or passwords are not read, written or searched: `.env` and
    `.env.*`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.config`, `id_rsa` and its
    kin, anything ending `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, `.jks`, `.kdbx` or
    `.ovpn`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `credentials` and
    `credentials.json`, and the history files of shells and database clients: "That file
    is protected: it looks like it holds keys or passwords." The check runs on the path
    as asked and again on the real path once links are followed, so a link cannot give a
    secret an innocent name (`local.ts:23-37`, `:46-58`, `:105`, `:124`).
  - `node_modules`, `.git`, `.svn`, `.hg`, `.DS_Store` and `__pycache__` are left out of
    listings and searches, and are refused by read and write too: "That is inside a
    folder agents stay out of (.git, node_modules and the like)." (`local.ts:21`, `:50-53`).
  - Nothing is written in `.vscode`, `.idea`, `.github` or `.husky`: "Nothing is written
    there: tools on this computer run what is in that folder." They can be read
    (`local.ts:39`, `:54-57`).
  - Only an ordinary file is read: not a device or a pipe (`local.ts:164`).
  - A file that is not text is not read: "That file is not text (a Word, Excel,
    PowerPoint, PDF or image file, for example). Ask the person to attach it to the
    conversation so it can be read." A file counts as not text when its first 8,000
    bytes hold a zero byte (`local.ts:128`, `:169-172`).
  - A search needs two characters, ignores case, looks at 4,000 files at most, does not
    look inside files over 512 KB or files that are not text, and does not follow links
    (`local.ts:182-225`).
  - A write is text only, replaces the whole file, and needs the file's folder to exist
    already; it does not make folders. It answers "Created" or "Replaced" with the size.
    A write never goes through a link: a name that is a link, to a file that exists or
    one that does not yet, is refused with "That is a link to somewhere else. Write to
    the file itself." (`local.ts:227-269`). What the file held before is not kept.
- What a file says is treated as material, like a web page: the agent is told it is
  never an instruction (`tools.ts:611-612`, `runs.ts:879`).
- What reaches the server from a folder, and stays there:
  - the call and the computer's answer pass through the server's memory on the way to
    the model;
  - the trace of the run keeps the first 4,000 characters of each call's arguments and
    of each answer (`runs.ts:33`, `:1015`, `:1055`), for those who may read traces. For a
    write the arguments are the path and the new content; for a read the answer is the
    file's text;
  - a write that asked first keeps the path and the whole content (up to 100,000
    characters) on its approval row, which the person's Approvals page and the admin
    Approvals list show (`tools.ts:659-669`, `runs.ts:722-744`).
  Nothing is put in the person's files or documents unless an agent, or the person,
  saves it there.
- A write is recorded like any tool call: a step in the reply, spans in the trace with
  the policy that let it through (`default-allow` or `confirm-local-write`), and, when
  it asked, `approval.approved` or `approval.rejected` in the activity log. Reads and
  writes that did not ask are not in the activity log.

**States.**
- In a browser: the sentence about the desktop app; no agent can reach a folder.
- Desktop app, project not yet saved: "Create the project, then attach its folders."
- No folder attached: only the "Attach a folder" button. Messages then carry no folder
  names and the agent gets no folder tools.
- The conversation is also open in a browser tab, or in the desktop app on a second
  computer: those pages hear the call and do nothing; only the session the message was
  sent from is listened to.
- The desktop app was closed, or moved to another conversation, during a run: the call
  waits 60 seconds and fails with the sentence above.
- A folder that was moved or deleted after it was attached stays in the list; the agent
  is told `"<path>" does not exist.` when it looks.
- An agent asks for a file outside, a protected file or a file that is not text: the step
  fails and the agent is told why in one sentence, which it can pass on.

**How it is wired.**
- Screen: `apps/web/src/app/Projects.tsx:112-163` (the folders in the project dialog);
  `apps/web/src/app/Chat.tsx:57-61` (`deviceFor`), `:656-682` (answering a call);
  `apps/web/src/lib/desktop.ts:1-25` (what the desktop app offers a page).
- Desktop app: `apps/desktop/src/local.ts:271` (`runLocal`), `:92` (`locate`), `:46`
  (`allow`), `:76` (`attachable`), `:60` (`rootNames`);
  `apps/desktop/src/main.ts:175-260` (the four channels
  `muster:folders`, `muster:add-folder`, `muster:remove-folder`, `muster:local`);
  `apps/desktop/src/preload.ts:16-30`; `apps/desktop/src/store.ts:61-86`.
- Requests:
  - `POST /api/app/conversations/:id/messages` with `device: {folders: [names]}` →
    `apps/server/src/product.ts:723`.
  - `GET /api/app/conversations/:id/events`: the live `device` event with `{id, tool,
    args}`; the `state` event repeats calls still waiting, for a page that connects late
    (`apps/server/src/runtime/runs.ts:228-240`, `:940`).
  - `POST /api/app/conversations/:id/device/:call` `{ok, text}` → `product.ts:765`;
    `Runs.deviceAnswered` `runs.ts:320`.
- Tools: `local.list`, `local.read`, `local.search`, `local.write`
  (`apps/server/src/runtime/catalog.ts:68-73`; what the model is told about each,
  `apps/server/src/runtime/tools.ts:574-602`; `onDevice` `:605`).
- Data: on the computer, `folders.json` in the desktop app's data folder: server address
  → project id → list of paths. On the server: nothing of its own; `spans` and
  `approvals` as above; waiting calls in memory (`runs.ts:158`).
- Events: live `device`; trace spans; `approval.approved` and `approval.rejected` for a
  write that asked.
- Tests: `apps/desktop/src/local.test.ts` "working in the folders a person attached":
  "names folders by their own name, and tells two of the same name apart", "lists, reads
  and searches inside them", "writes a new file and replaces an old one, inside the
  folder only", "refuses to leave the folder, by any road", "does not open files that
  hold secrets, or files that are not text", "does not write through a link, even one to
  a file that does not exist yet", "is not fooled by a link that gives a secret an
  innocent name", "stays out of .git and node_modules, and writes nothing where tools
  run things", "does not let the home folder, the disk or the app's own records be
  attached", "says so when nothing is attached".
  `apps/server/src/product.test.ts` "folders on the person's computer" (`:1003`): "asks
  the computer, hands its answer to the agent, and records the call like any other"
  (another person cannot answer for this computer, and neither can the same person from
  another session), "offers nothing on the computer without the desktop app, and no
  writing to an agent that may not write"; "asks before writing on their computer unless
  they said it need not" (`:1307`). No test drives the
  desktop app's dialog or channels, or the page that answers.

**Not built.**
- Word, Excel, PowerPoint and PDF files in a folder cannot be read. The agent is told to
  ask the person to attach the file to the conversation. Images cannot be read either.
- Nothing in a browser tab, and nothing on iOS.
- No sync: a folder is not copied to the server, and nothing the server holds is copied
  to the folder, except a file an agent writes there with the write tool.
- Nothing works while the computer is away: the desktop app must be open, on that
  conversation, for the whole run. No offline work, no queue.
- No making or changing of Office files in a folder; a write is text.
- No making of folders, no rename, no move, no delete.
- No undo of a write: what the file held before is gone. No "show me the difference".
- No list of what agents read or wrote in a folder, on the computer or in the project.
- No read-only attachment: a folder that is attached can be written by any agent that
  may write.
- No choice of which agent may use which folder: every agent in the project's
  conversations gets the folders, as far as its own tools reach.
- No watching of a folder for changes.
- No control for an administrator: no way to forbid folders, to see who attached what,
  or to name the folders that may be attached.

**Design findings.**
- Office and PDF files, which are most of what is in a work folder, cannot be read. The
  agent says "attach it to the conversation", which is the upload the feature was meant
  to save. Smallest fix: have the desktop app send such a file's bytes to the server's
  existing reader for that one answer, without storing them.
- A write replaces the whole file and keeps nothing. In "Approve for me" it does so
  without showing anything first. One wrong step loses the person's work, and the reply
  says only "Wrote a file on your computer". Smallest fix: before replacing, copy the
  old file beside it (`name.bak`) or to the system's bin, and put the path in the step.
- The confirmation card for a write shows the new content only, not what changes, and
  does not say whether a file that exists is replaced
  (`apps/web/src/app/approval.tsx`). Smallest fix: "Replaces a file that exists" when it does.
- What an agent reads from a folder is kept in the trace (the first 4,000 characters of
  each read), and a confirmed write keeps the whole content on its approval. The
  project's dialog says only "what an agent reads is sent to the model for that answer".
  A person, and a security auditor, will read that as "and nowhere else". Smallest fix:
  say in the dialog that administrators can see what agents read in the record of each
  run; or stop keeping the output of folder reads in the trace.
- The protected list is a list of names, longer since the review but still names. A
  file called `passwords.txt` or `tokens.csv`, or a private key without an ending, is
  read like any other. Smallest fix: say so in the dialog ("Do not attach a folder that
  holds passwords"), and look at the first bytes for a key's header.
- The warning for a folder that cannot be attached is English text in the desktop app
  (`main.ts:212-218`), whatever language the person uses. Smallest fix: take the words
  from the page's translations.
- The desktop app does what the server's page asks in the attached folders, writes
  included (`main.ts:226-234`). The question "may it write without asking?" is answered
  on the server only. The head of the enterprise will ask what a compromised server
  could do: it could read and write every attached folder of every person with the app
  open, within the rules above (no links out, no protected names). Smallest fix: have the desktop app itself ask before a write unless the person
  chose otherwise on that computer.
- Folders are per computer and nothing says so. A person who set a project up at the
  office finds it without folders at home. Smallest fix: in the dialog, "Attached on
  this computer only."
- The enterprise cannot turn this off, and cannot see that it is used except in traces.
  Smallest fix: a second line under Policies, "People may attach folders: yes / no",
  and an activity-log record when a folder is attached (its name, not its path).

---

## Progress while an agent works: steps and the plan

**Who it is for.** Every member.

**The job.** "Show me what it is doing and how far along it is, so I know whether to
wait."

**Where it starts.** Automatically, inside a conversation, when the agent calls a tool or
sets a plan.

**What they see and can do.**
- Steps. One line per tool call: an icon (turning while it runs, a green tick when done,
  a red triangle when it failed, an amber "no" sign when it was not allowed), a phrase
  ("Read a document…" while it runs, "Read a document" when done, "Read a document:
  failed", "Read a document: not allowed"), a detail
  in small type (the document's title, the file's name, or the host and path of an
  address), and how long it took.
  - While the reply runs the list is open and cannot be closed.
  - A step passed to another agent (CHA-264, `marketplace.md` 13a) reads "Passed a step on"
    with that agent's name and the reason, in words rather than small type. What that agent
    then did is the steps under it, set in and marked with its name at the right. A
    confirmation one of them needs names that agent, not the conversation's own.
  - After the reply the list is one line: "3 steps" and the steps' names joined with
    dots; an amber triangle shows when any step failed or was not allowed. Click → the
    list opens.
- While an agent works (CHA-246, the owner's rule of 2026-11-16: the plan is for reading; the one line under it, outside it, is what is pressed, and what it opens is as detailed as the record is).
  - **The line says what is happening now.** Between two steps the line for the steps carries the words that used to be a line of their own ("Going through what came back…") and how long it has been. While a model that thinks before answering is thinking, it says "Thinking…", the time, and about how many tokens it has thought (characters received, three to a token), told at most every 400 ms by the `thinking` event. "Nothing has come from the model for N seconds" is then not shown, since something is coming; it still appears after 30 seconds in which nothing at all arrives. Before the first step there is no steps line, and the same words are a line of their own.
  - **A step opens.** Pressing a step in the open list shows, under it: the level of the action in words, whether it was allowed without asking, and the mode it was judged in; "What it asked for" (the arguments, laid out to be read); "What came back". Each is what the run's record keeps, cut at 4,000 characters, and the cut is said. A step that is still running, or a step of a reply written before 2026-11-16, says that nothing is kept. `GET /api/app/conversations/:id/steps/:call` → `product.ts`; it answers only the person whose conversation it is (404 to anyone else) and reads the span whose `callId` is the step's id. The line in the list is still a title, never content.
  - **The person can add to it.** While a reply is being written the message box says "Add something while it works…" and Enter sends. Words sent then do not start a second run and are not refused: `POST …/messages` answers 202 `{aside: true}`, they wait until the turn the agent is on is over, with every call of that turn carried out, and are then handed to it as one message (marked as added mid-way, with the instruction not to start over). They interrupt nothing: handing them over at once made the loop drop every call of the turn it had not begun, one the person had just allowed among them (found by the independent review, 2026-11-16). Words that arrive as the agent writes its answer are handed over when that answer ends, with the instruction to write the answer again in full; words that arrive after the loop last looked get one more turn. They appear in their place in the reply as the person's own words and stay there after the reply. No second message is stored: they are a step of kind `aside` on the reply, and for every later turn they are part of what the person asked ("[Added while the reply was being written]" after that message). A reply that is gone on with (Continue) says again what was added and not yet answered. Once the agent has finished and the reply is being saved, words are answered `run_in_progress` and go back in the box. A file, a skill or another agent sent while a run is going is still refused (`run_in_progress`) and waits for the reply; at most 4,000 characters. The stop button stays beside the send arrow.
  - What the agent says before it goes to work is shown once, as a step in its place, and no longer a second time as the reply so far.
  - The send arrow is greyed, with the reason, when what is in the box cannot be added mid-way: a file, a skill, another agent, or more than 4,000 characters. Not built: taking an added message back; adding a file mid-way; the iOS app does not offer it (its message box waits while a run is going; if a run was begun elsewhere it handles the 202 and leaves the added words out of the step count, and does not show them); the elapsed time of the whole run on the line.
- The plan. It is not announced: no title, no bar (the owner's rule of 2026-11-16: the
  plan belongs in the conversation and should not call attention to itself; CHA-232).
  - While the reply runs it is a short list in a thin frame, in the reply, just above the
    line that says what is being done: each step pending (dashed circle), in progress
    (turning, in full text) or done (a grey tick, greyed text). It scrolls with the
    conversation. Nothing is pinned above the message box.
  - After the reply it is one line of small grey text at the same place, "3 of 4 done",
    with an arrow. Click → the list opens under it. A step that was still "in progress"
    when the reply ended is shown as pending.
- "Working…" with a spinner is shown until the first text arrives, unless a confirmation
  card is on screen.

**Rules.**
- Every agent has the `plan.set` tool, whatever tools it was given. It changes nothing
  but the list the person sees (`apps/server/src/runtime/catalog.ts:37-41`).
- The agent is told to use the plan only for work of three or more steps, to send the
  whole list each time, and to mark steps done as it goes (`runs.ts:787`).
- A plan has 1 to 12 steps; a title is cut to 120 characters; a status is `pending`,
  `in_progress` or `done`. A plan that breaks these rules is refused and the run carries
  on (`apps/server/src/runtime/tools.ts:339-353`).
- A call to `plan.set` is not shown as a step (`runs.ts:892`).
- A step's detail is never content: a title, a file name, or the host and path of an
  address without its query (`tools.ts:438-454`).
- A step still running when the run ends is stored as failed (`runs.ts:970-972`).
- A new model turn replaces the text shown so far: what the agent said while working is
  not kept in the final reply (`runs.ts:821-827`).
- Steps and the final plan are stored with the reply (`messages.steps`, `messages.plan`).

**States.**
- No steps and no plan: neither block is shown.
- Step statuses: `running`, `ok`, `error`, `blocked`.
- Plan item statuses: `pending`, `in_progress`, `done`.

**How it is wired.**
- Screen: `apps/web/src/app/Chat.tsx:213` (`StepRow`), `:244` (`Activity`), `:288`
  (`PlanList`), `:323` (`PlanCard`), `:870` (the live plan above the message box).
- Requests: none of its own. It reads the live events of
  `GET /api/app/conversations/:id/events` and the `steps` and `plan` of each message from
  `GET /api/app/conversations/:id`.
- Data: `messages.steps`, `messages.plan` (`schema.ts:264-265`); the live run in memory
  (`runs.ts:134-141`).
- Events: live `step` (`runs.ts:901`, `:927`), `plan` (`runs.ts:805-808`), `state`.
- Tests: `product.test.ts` "the plan and the steps of a reply" (`:728`): "shows the
  agent's plan as it changes, keeps it with the reply, and does not count it as a step",
  "refuses a plan that is not a plan, and the run carries on".

**Not built.**
- No way to see what a step returned (the document text read, the page fetched). Only
  administrators see that, in the trace.
- No way to see why a step failed: the row says "failed" and nothing more.
- No elapsed time for the whole reply, and no estimate.
- The person cannot edit the plan, skip a step or approve a plan before work starts.
- No per-step cancel: Stop ends the whole run.

**Design findings.**
- A failed step reads "Read a web page: failed" with no reason, though the tool's error
  text is known ("The page answered with status 404."). Smallest fix: keep a short
  `error` on the step and show it on hover or on a second line.
- A step that was not allowed reads "…: not allowed" for three different cases: the
  person said no, the person did not answer in 15 minutes, or policy denied it. Smallest
  fix: three phrases.
- While a step runs, the phrase is the imperative with an ellipsis ("Read a web page…"),
  which reads like the past tense in English. Smallest fix: add a `toolDoing` set
  ("Reading a web page…").
- The collapsed summary repeats the same phrase when a tool is used several times ("Read
  a web page · Read a web page · Read a web page"). Smallest fix: group repeats ("Read 3
  web pages").
- A reply that finished finishes its plan (2026-11-22): its steps still open are marked
  done when it is saved. A model often set the plan at the start and never ticked it, and
  a finished reply stood under "0 of 4 done". A reply stopped or failed keeps its plan as
  it was, so where it stopped still shows (`runs.ts`, before the reply is saved).
- The live plan is above the message box and the finished plan is above the reply, so it
  jumps when the reply ends. Smallest fix: keep it in one place.
- An unfinished plan after a stop shows the abandoned step as "pending", which hides
  where it stopped. Smallest fix: mark the interrupted step "stopped here".
- Whether a plan appears depends on the model following an instruction. An enterprise
  owner cannot rely on it. Smallest fix: none in the UI; note it in the administrator's
  documentation.

---

## What a reply made, as cards; a decision as choices

Since 2026-11-15 (CHA-225).

- Who: anyone who asked an agent for a file. Job: see the result itself, not a file
  name, and go on from it.
- Under a reply, each file the reply made or changed is a card (three to a row)
  (`apps/web/src/app/results.tsx`):
  - which file a card is for is said by the step that made or changed it, by the file's
    id (CHA-269, 2026-11-18: `Step.file`, set through `made` in `runtime/tools.ts` and
    `runs.ts`). A file sent later under the same name is another file and no earlier
    reply's card opens it. A file that was deleted since leaves a line saying so in
    place of its card: which are gone is said by the server (`gone` in the conversation),
    not worked out from the page's list of files, which holds the newest 500 and is read
    again only after a reply ends. A file that exists but is not in that list has no
    card and is not called deleted. A reply written before that date is matched by name, as before.
    The phone app does the same, and now gives a card to a reply that changed a file
    (`apps/mobile/src/lib/files.ts`);
  - the thing itself in small, read from the person's file when the card comes into
    view: a deck's first slide (drawn as the viewer draws it), a workbook's first
    rows with "5 sheets · 8 rows in the first", the first lines of a document, a CSV or
    a text file, a picture, a web page in its locked frame. It is a picture of the
    file: nothing in it can be reached; pressing it opens the viewer. A file that
    cannot be read shows its type's mark;
  - the type's mark, the name, "v4" when it has been changed, and a line: kind, "15
    slides", size, and for a changed file what the last change was ("Slide 2 replaced");
  - "Change it": a line opens in the card ("Say what to change…"); sending it sends
    "Change “<file name>”: <what was typed>" as the person's next message, so the agent
    changes that file in place and the new version comes back as a card. The exact
    words are shown under the line before they are sent ("This sends: …"), because a
    file's name is not the person's own words;
  - "4 versions" (when there is more than one) opens the viewer, where versions are
    listed and brought back; a download button.
- `Choices(question, options)` is a reply component (`packages/ui-schema/src/index.ts`):
  the question and two to four ways to go, each a numbered row with a title and one
  sentence. Pressing a row sends its title as the next message. The agent is told to use
  it when the choice is the person's, and never to confirm an action. Since 2026-11-16 a
  decision is for the moment it was asked: once anything is said after its reply, its rows
  cannot be pressed and a line under them says "The conversation has moved on from this
  question." (`reply.tsx`, `ChoiceButtons`).
- A web page an agent wrote, or one that was uploaded, is shown under one policy in both
  the card and the viewer (`apps/web/src/app/page.ts`, `LockedFrame.tsx`, the one frame both use): nothing is loaded from anywhere,
  no script runs, and the frame has no origin, so it cannot read this app's cookies or
  storage or call its API. Seen on 2026-11-15 with a page that tried all three.
- The work panel shows "v4" beside a file the agent has changed.
- On the phone a made file is a chip that opens it; `Choices` is the question, the
  options as text, and a chip for each.
- Known gaps: a chart in a page must be drawn as SVG or CSS, since no script runs; the
  card of an earlier reply shows the file as it is now and says "now at version 4"
  (only the newest card of a file carries "v4" and what the last change was); the preview of a PDF is its text, not its first page; previews are not
  kept, so each is read again when the conversation is opened.

## A form in a reply

Since 2026-11-16 (CHA-237). Design: `docs/design/interactive-replies.md`.

**Who it is for.** Every member, and most of all the one who would not think to give an
agent every detail up front.

**The job.** "Ask me what you need in one go, let me fill it in, and get on with it."

**Where it starts.** A reply. When an agent needs two or more facts before it can do the
work (a purchase request with no amount or cost centre, a leave request with no dates), it
says what it needs in a sentence and puts a form under it. The form is a `Form` component
with `TextField`, `SelectField`, `DateField` and `NumberField` inside
(`packages/ui-schema/src/index.ts`), drawn by `apps/web/src/app/forms.tsx` and, on the
phone, `apps/mobile/src/forms.tsx`.

**What they see and can do.**

- A card headed "<agent> asks" and the form's title. Each field has its label; a field
  that may be left empty says "optional". A field the conversation already answered is
  filled in.
- Words: one line, or a box of several. A choice: a list to pick one from (on the phone, a
  row of options to press; pressing the picked one takes it back). A day: the browser's
  date control (on the phone, digits set out as `YYYY-MM-DD`). A number: digits, with its
  unit beside it and what it may be ("0 to 5,000", "1 or more"), which a refusal repeats.
- One button, with the agent's words on it, and beside it: "Your answers are sent to
  <agent> as your next message."
- Pressing it with something missing or wrong sends nothing and marks each such field:
  "This is needed.", "Choose one of the options.", "Give a day, like 2026-12-01.", "Give a
  number.", "This is below what is allowed.", "This is above what is allowed.", "This is
  too long."
- Pressing it with everything in order sends the answers. They appear as the person's
  message, drawn as a card: the form's title, then each label with what was given, and
  "left empty" for a field left empty. The agent's next reply works from them.

**Rules.**

- What is sent is the reply's id, the form's name and what was entered. The server reads
  the form again from the reply as it is stored, checks every value against it, and writes
  the message itself from the form's labels and the values, marking a value the agent gave
  and the person left as "(as suggested)" (`apps/server/src/forms.ts`). A reply cannot
  make the person say something they did not see.
- What is typed stays on the device until the button is pressed. On the web it is kept in
  the browser (`localStorage`, one entry a form) so a reload does not lose it, and removed
  when it is sent, at sign-out, and once twenty newer forms have been typed into. On the
  phone it is kept while the app is open. A half-filled form is
  not on the person's other devices, and an agent never sees it.
- A form is answered once, and only while its reply is the last thing said. Typing a
  message instead closes it.
- One form a reply. A form is never a way to confirm an action; confirmations are the
  gateway's (see [Confirmations](#confirmations-an-agent-asks-before-an-action)).
- An app that does not draw forms gets replies without them: a client says which
  components it draws when it sends a message (`ui`), and an agent is taught the form only
  then. The iOS app and the web app both say 2.

**States.**

| The reply is | Its form shows |
|---|---|
| Still being written | The fields as they arrive, not usable, no button, "You can answer when the reply is finished." |
| The last message, finished | Usable fields and the button |
| Answered | What was sent, not usable, a tick and "Answered <when>" |
| Followed by any other message | The fields as the agent wrote them, not usable, "Not answered. Ask again if you still need this." |
| Failed, stopped, or cut off at the longest a reply can be | Not usable, "This reply was not finished, so its form cannot be answered." |
| Holding a form that asks for a password, a card, bank or identity number | No form and no list: "The agent's form asked for something that must never be typed here… so it is not shown. Do not give these to an agent." |
| Holding a form that is not a working form | Its title and its labels as a list, and "Answer by typing." |

A refusal by the server is said where every other refusal is: "This form can no longer be
answered: it was answered already, or the conversation has moved on." or "These answers do
not fit the form. Check each field and send it again."

**How it is wired.**

| Control | Request | Test |
|---|---|---|
| The form's button | `POST /api/app/conversations/:id/messages` `{action: {messageId, form, values}, ui}` | `apps/server/src/forms.test.ts` "is answered with one message the server writes…"; `apps/web/src/app/reply.test.tsx` "sends the reply's id, the form's name and what was entered…" |
| A field | none: kept on the device | `reply.test.tsx` "keeps what was typed on this device until it is sent" |
| The button with a wrong value | none | `reply.test.tsx` "marks what is missing or does not fit, and sends nothing" |

- Screen: `apps/web/src/app/forms.tsx` (`FormCard`, `AnswerCard`, `formPlace`), registered
  in `apps/web/src/app/reply.tsx`; `Chat.tsx` gives each stored reply its place in the
  conversation (`FormScope`) and the function that sends an answer. Phone:
  `apps/mobile/src/forms.tsx`, `apps/mobile/src/lib/forms.ts`, `screens/Chat.tsx`.
- Data: `messages.action` (`apps/server/src/forms.ts`, migration 25).
- Operated on 2026-11-16 in a browser against a separate instance with the configured
  model: the Assistant asked for a purchase request's details with a form of seven
  fields; the button with the cost empty marked the field and sent nothing; a reload kept
  what was typed; the answer went as one request and was drawn as a card; the next reply
  made the document from the values and left the two empty fields unfilled; after a
  reload the form showed what was sent, with "Answered".
- Not operated: the phone. The iOS app builds from this branch and its checks pass, but
  the one simulator on the build machine has no runtime installed, so the form was never
  touched on a phone.

**Not built.**

- Checkboxes, picking several, people and file fields.
- A form while the agent is still working, with the run waiting for the answer.
- A half-filled form following the person to another device.
- A native date picker on the phone: the day is typed. The design asked for the
  platform's picker; the app has no such component yet and adding one means a native
  dependency.
- A test that draws the form on the phone. The phone's rules are tested
  (`apps/mobile/test/forms.test.ts`); its drawing is not, and it has never been operated.
- Answering a form in a scheduled run's conversation from a notification, or in a reply
  shared with a colleague.

**Design findings.**

- A long question the agent marks as one line is typed in a one-line box (seen: a
  "business justification" of three sentences). Smallest fix: draw a text field with a
  prefilled value longer than 80 characters as several lines.
- The answered form above and the answer card below show the same values twice. Smallest
  fix: fold the answered form to its title and "Answered <when>".
- An agent may still do work before asking (seen: it saved a document, then asked).
  The instruction says to end the reply at the form; nothing enforces it.

---

## Building an agent or a skill by talking

Since 2026-11-15 (CHA-228). The owner: "两大核心的功能：1. 帮助用户在对话中完成 AGENT 的构建……
2. 一样的，帮助用户进行 skill 构建的".

- Who: anyone using the workspace. Job: get an agent for work they repeat, or keep a way
  of working, without leaving the conversation or filling a form.
- What the person does: says what they need ("Every Monday I turn the sales sheet into a
  one-page report. Build me an agent for that", or "make what you just did a skill").
  The agent may first look at the person's files to see how the work is done, or ask up
  to two short questions. It then answers with one sentence and a card.
- The agent card ("New agent"): a face, name, what it does, what it may do as chips that
  switch on and off (your documents, reads your files, makes files, searches and reads
  the web, your Microsoft 365, sends outside), and how it works (the instructions, a few
  lines until "Show all"). Everything can be changed on the card. "Create" makes it as
  the person's own agent. Then the card reads "Created" and "Ready. Type @Name in a
  message to call it.", with "Open in Agents"; the agent is in the "@" list at once.
- The skill card ("New skill"): name, when to use it, the procedure, a template (kept as
  the skill's text). "Create" saves it; then "Ready. Type / in a message and pick
  “Name”."
- A card whose name is one of the person's own agents or skills offers "Update “Name”"
  instead, and changes that one. One that is already there exactly as the card says
  reads "Created" (after a reload, for example).
- Nothing is made by the agent. `AgentDraft` and `SkillDraft` are reply components with
  no effect (`packages/ui-schema/src/index.ts`); the card calls the same routes as the
  builder pages, as the person (`apps/web/src/app/builders.tsx`: `POST` or `PATCH
  /api/app/agents`, `/api/app/skills`). So everything that holds there holds here: an
  agent that can send outside waits for an administrator ("Made. It waits for an
  administrator's approval before it can run."), a held person's agents stay held, a
  skill is scanned and may be held back ("Made, but held back…"), names must be free,
  the agent's reach is checked against what the person may give.
- The agent is told so: "You cannot make an agent or a skill yourself, and must never
  say you did", when to choose which, and to give the whole draft again for a change.
- While the reply is still being written the card follows the writing and nothing on it
  can be pressed ("Still being written."). Instructions longer than five lines must be
  opened with "Show all" before Create ("Open the whole text with “Show all” and read it
  first."), and a draft written after the agent read a page, a file, a mailbox or another
  system says so in amber above its fields and must be opened too: what was read can
  carry instructions of its own.
- Updating a skill from a card keeps the texts it already has; the card's template takes
  the place of the one named "Template" or is added.
- On the phone the draft can be read, not made: "Create it from this conversation in the
  web or desktop app."
- Known gaps: a name the organization's own agents use ("Assistant", "Writer") is refused
  only when Create is pressed; a card cannot attach a knowledge base, a skill or a company connector to
  the agent (that is done on the agent's page); an agent already carrying them keeps
  them on update. An older card is not marked as replaced by a newer one. A refusal
  shows the server's sentence beside the button.

## Confirmations (an agent asks before an action)

> **Since 2026-11-19 (quiet start, Q-3).** Each "Allow" is counted per tool in this browser
> (`muster.allowed`). In a conversation in "Ask first" whose organization allows more, the
> card for writing or editing a file or running a command on the person's computer
> (`local.write`, `local.edit`, `local.exec`) that does not say why it asks whatever the
> mode offers, from the third time, "Allow, and stop asking for this here": it allows the
> action and moves this conversation to "Approve for me". The card in the Inbox does not
> offer it. Tests: `apps/web/src/app/approval.test.tsx`.

**Who it is for.** The member who started the run. Nobody else can decide, including
administrators.

**The job.** "Before anything leaves the organization, or is written on my computer,
show me exactly what and where, and let me say yes or no."

**Where it starts.**
- Inside the conversation, as a card under the running reply, when the agent calls a tool
  that must be confirmed.
- `#/approvals` (the "Approvals" link in the sidebar, with a number when something
  waits).
- A system notification, when Muster is in the background (see
  [Notifications](#notifications)).

**What they see and can do.**
- **The card as it is since 2026-11-18** (the owner, on the one described below it:
  "这种傻逼样式的卡片，你能不能重新设计，丑死了"). In a conversation it is no longer an
  orange box with a shield, a heading and a table of three labels. It is one quiet card
  (`ApprovalCard` in `apps/web/src/app/approval.tsx`):
  - a question about the thing shown: "Run this command?", "Make this change?", "Write
    this file?", "Read this page?", "Remember this?", "Wait for this, then act?"; for
    any other tool "Allow this?", with the tool as a sentence after the place;
  - under it, small: who asks and where — "Muster · in <folder>", a site's host, "Your
    memory". The agent a conversation has when nobody called one is named Muster here
    too;
  - the thing itself in one scrolling box: the whole command, change, content or body;
    for a read, the address, with "Nothing is sent. The address itself is all that
    leaves." under it;
  - why it asks whatever the mode, when there is a reason, in the warning colour with a
    triangle;
  - a bottom row: how long it still waits and the size in bytes on the left; "Don't
    allow" (plain), "Allow any page on <site>…" where it applies, and "Allow" on the
    right.
  What waits in the list (`#/approvals`) is the same card; earlier decisions there and
  the administrators' record keep the table of facts described next (`ApprovalFacts`). What the buttons do is unchanged.
- The card before that, and the facts still shown elsewhere: "Confirm before this
  happens", "<Agent> wants to do the following. Nothing happens until you allow it. It
  gives up in N minutes."
  - Where: the whole address, query included.
  - What: the tool as a sentence, "Read public web pages" or "Send data to an outside
    address, after asking you". The method (`POST`, `GET`) and the content type are no
    longer shown (`apps/web/src/app/approval.tsx:16-19`).
  - Everything that will be sent: the whole body, in a scrolling box, with its size in
    bytes under it. For a read: "Nothing is sent. The address itself is all that
    leaves."
  - "Don't allow" → the action is not done; the agent is told not to try again.
  - "Allow" → the action is done and the run continues.
  - "Allow any page on <site> in this conversation" → shown only when the request is to
    read a page (`web.fetch`), with a line above the buttons: "Allowing the site lets the
    agent open any address on it without asking again, including addresses it writes
    itself." This page is read, and for the rest of this conversation the agent reads
    other pages of the same site without asking. A page on another site asks again. The
    button is offered only for an `https` address (`approval.tsx:67-74`, `:92`,
    `:97-106`).
  - For a write on the person's computer (`local.write`, in the mode "Ask first"):
    "Where" is the path, starting with the attached folder's name; "What" is "Write
    files in those folders"; the box holds the whole content to be written, with its
    size in bytes. The box's label is "Everything that will be
    written". There is no "allow for this conversation" button here: to stop being asked
    the person changes the conversation's mode.
- The Approvals page (`#/approvals`), in two parts:
  - "Waiting for you", with the count on an amber pill. Each request is the same card as
    in the conversation, with "Open conversation" under it; two columns on a wide
    window. With nothing waiting: a card with a green shield, "Nothing is waiting for
    you." and "When an agent needs your go-ahead, to read a site you did not name or to
    send something outside, it appears here and in its conversation."
  - "Earlier decisions", shown once there is one: four filter buttons with counts (All,
    Approved, Rejected, Expired) and a list. A row shows an icon (a paper plane for a
    send, a globe for everything else), the action in words and the site or path, the
    agent and when, and a badge: Approved, Rejected or Expired. Click a row → it opens to
    the same facts as the card and "Open conversation". A filter with nothing in it
    says "None of this kind."
  - The page loads 100 requests in all and reloads them every 15 seconds, so a request
    that was answered elsewhere or gave up moves to "Earlier decisions" by itself
    (`apps/web/src/app/Pages.tsx:69-73`).

**Rules.**
- The gateway decides from the call's action level, not the tool's name
  (`apps/server/src/runtime/runs.ts:649-821`):
  - A0, A1, A2 → allowed.
  - A3 → the person is asked.
  - A4 → denied: "This action is not allowed by the organization's policy." No tool is at
    A4 today.
  - A tool the catalogue does not know is treated as A3 (`tools.ts:712-719`).
- The conversation's mode, never more than the organization allows, changes two of these
  (`runs.ts:656-682`; see [Modes](#modes-how-much-an-agent-may-do-without-asking)):
  - `local.write` is A1, but is treated as A3 in the mode "Ask first": the person is
    asked before a file is written on their computer (policy `confirm-local-write`).
  - reading an address the person did not write is not asked about in the mode "Full
    access".
- `web.send` is A3: it always asks, in every mode.
- `web.fetch` is A0, but, except in "Full access", is treated as A3 when the address is
  not one the person wrote.
  "Wrote" means: an `http(s)` address in this message or an earlier message of the
  person in this conversation, compared whole after normalising. An address the agent
  wrote first does not count, even if the person sends it back (`runs.ts:581-584`,
  `:597-598`; `tools.ts:414-431`).
- A site the person allowed for the conversation is not asked about again. "Allow any
  page on <site>" sends `remember: true` with the approval; the server adds the address's host
  (lower case, with its port if it has one) to `conversations.allowed_hosts`, and the
  gateway then treats a `web.fetch` to that host as the A0 call it is
  (`product.ts:755-764`, `runs.ts:599-616`). The rule is narrow on purpose:
  - It applies to reading a page only. `remember` on a `web.send` approval is ignored,
    so every send still asks.
  - It is the exact host: allowing `docs.example.com` does not allow `example.com` or
    `www.example.com`.
  - Only `https` addresses of the site are read without asking; an `http` address of an
    allowed site still asks (`runs.ts:605-615`).
  - A page read because its site was allowed must stay on that site: if it forwards to
    another site the forward is not followed and the step fails with "The page forwards
    to another site, which was not allowed." A page the person allowed as itself, or
    wrote, may forward as before (`runs.ts:587`, `:613`, `:804`;
    `apps/server/src/runtime/tools.ts:118-123`; `apps/server/src/runtime/net.ts:170-174`).
  - It lasts as long as the conversation and covers only that conversation. There is no
    way to take a site back off the list.
  - A conversation holds at most 50 sites; the 51st is not remembered and asks each
    time.
  - It is recorded: the `approval.approved` event carries `siteAllowedForConversation`
    with the host. Later reads of that site are in the trace with policy
    `default-allow`, like any read of an address the person wrote.
- What is shown is built from the call itself, never from the model's words
  (`tools.ts:657-689`). For a write on the computer that is the path and the content, up
  to 100,000 characters (`tools.ts:659-669`).
- The wait is 15 minutes. After that the request is marked expired and the agent is told
  "The person did not answer in time, so it was not done."
- Pressing Stop while a request waits expires it; nothing is sent.
- A request can be decided once: a second decision is refused with `already_decided`,
  "This was already decided."
- If the agent was suspended or deleted while it waited, "Allow" is refused with
  `agent_unavailable`; "Don't allow" still works (`product.ts:750`).
- The decision is committed before the run continues (`product.ts:776-777`).
- Recorded in the activity log: `approval.approved` or `approval.rejected`, with the
  agent and tool. An expired request is not written to the activity log; it is in the
  trace as an `approval.user` span with its outcome.
- If the server restarts, every pending request becomes expired (`runs.ts:190-192`).
- The network rules still apply after "Allow": public addresses only; ports 80, 443,
  8080, 8443; no credentials in the address; 15 seconds; 1 MB read; at most 3 redirects,
  and a send that is redirected is not re-sent (`apps/server/src/runtime/net.ts:12-15`,
  `:79-99`, `:163-169`). A send is at most 100,000 bytes (`tools.ts:33`).

**States.**
- Nothing waiting: the card "Nothing is waiting for you." with its line of explanation.
- No earlier decisions: that part of the page is not shown.
- Pending: the card, with the minutes left, refreshed every 15 seconds.
- On the Approvals page the list itself is loaded again every 15 seconds; a request that
  gave up is then listed under "Earlier decisions" as Expired.
- Decided: the card leaves the conversation; the step shows done or "not allowed".
- Statuses in the list: Waiting for you, Approved, Rejected, Expired.
- A failed decision shows its reason in red on the card.

**How it is wired.**
- Screen: `apps/web/src/app/approval.tsx:38` (`ApprovalCard`), `:10` (`ApprovalFacts`);
  `apps/web/src/app/Pages.tsx:63` (`MyApprovals`: waiting `:94-138`, earlier decisions
  `:139-228`).
- Requests:
  - `GET /api/app/approvals` → `apps/server/src/product.ts:895`; the person's approvals,
    pending first, 100 at most.
  - `POST /api/app/approvals/:id` `{decision: "approve" | "reject", remember?: boolean}`
    → `product.ts:908`; updates `approvals`; with `remember` on an approved `https`
    `web.fetch`, adds the host to `conversations.allowed_hosts`; writes `admin_events`;
    then `Runs.decided` (`runs.ts:334`).
  - The pending request of a conversation also arrives in
    `GET /api/app/conversations/:id` (`product.ts:655`) and in the live `approval` event.
- Data: `approvals` (`schema.ts:221`: `tool`, `level`, `summary`, `status`,
  `requested_at`, `decided_at`, `decided_by`); `conversations.allowed_hosts`
  (`schema.ts:309`, migration 6: a list of hosts, empty by default). The waiting run is
  in memory.
- Events: activity log `approval.approved` (with `siteAllowedForConversation` when a
  site was allowed), `approval.rejected`; live `approval` (`runs.ts:747`, `:801`); trace
  spans `policy.check` (with `confirm-external-actions`, `confirm-unlisted-address` or
  `confirm-local-write`) and `approval.user`.
- Tests: `product.test.ts` "an action that needs the person's confirmation" (`:801`:
  waits and sends only after approval; sends nothing on no; only the starter may decide;
  abandoned on stop), "reading an address the person did not give" (`:446`), "an address
  the agent wrote first" (`:502`), "an agent taken away while it waits" (`:527`), "asks
  before writing on their computer unless they said it need not" (`:1307`), "asks once
  for a site the person allowed for the conversation, and again for another site"
  (`:1838`), "where agents may connect" (`:1956`). No test covers the card or the
  Approvals page; they are in the web app only.

**Not built.**
- No "always allow this address" across conversations, no allowing a site for sending,
  no allowing a whole domain with its subdomains, and no list of the sites a conversation
  has allowed or way to take one back.
- No editing of what will be sent before allowing it.
- No approval by someone else (a manager, an administrator) and no delegation.
- No way to extend the 15 minutes or to change it per organization.
- No email or mobile push when a request is waiting; only an in-browser or desktop
  notification while Muster is open.
- No reason field when refusing.

**Design findings.**
- Answered on 2026-11-14: a read can be allowed for its whole site for the rest of the
  conversation ("Allow any page on <site> in this conversation"), and the choice is
  recorded on the `approval.approved` event (`approval.tsx:95-104`,
  `product.ts:755-773`). What remains: a research task that crosses many sites still
  stops once for each, each wait still gives up after 15 minutes, and the person cannot
  see or undo what a conversation has allowed.
- Answered on 2026-11-14: the card no longer shows "POST", "GET" or the content type; it
  says where and what in words (`approval.tsx:16-19`). What remains: the size is still
  given in bytes, not KB.
- Answered on 2026-11-14: for a read the "Amount of data: 0 bytes" line is gone
  (`approval.tsx:20-31`). What remains: "Nothing is sent. The address itself is all that
  leaves." still does not say why a read asks at all.
- Answered on 2026-11-14: the Approvals page reloads its list every 15 seconds
  (`Pages.tsx:78-82`), so a request that gave up moves to "Earlier decisions" as Expired.
  What remains: for up to 15 seconds a dead request can still be on screen, and pressing
  Allow on it answers "This was already decided."
- The countdown is in whole minutes and updates every 15 seconds; there is no warning
  before it gives up. Smallest fix: turn the line amber under two minutes.
- After a request expires the reply just continues with a "not allowed" step. The person
  who was away never learns that an action was dropped unless they open the steps.
  Smallest fix: a notice under the reply, "One action was not done because it was not
  confirmed in time", with "Try again".
- The page is called "Approvals" in the sidebar, the card says "Confirm", the buttons say
  "Allow" and "Don't allow", and the history says "Approved" and "Rejected". Smallest fix:
  pick one family of words ("Allow / Allowed / Not allowed").
- For the enterprise owner: only the person who started the run can decide, so a
  compromised or careless member approves their own exfiltration. That is by design, but
  the Approvals page should say that every decision is recorded and visible to
  administrators. Smallest fix: one line in the page lead.
- After "Allow any page on <site> in this conversation" nothing shows which sites the
  conversation may read, and the choice cannot be taken back. The card says what the
  choice means, but only at the moment it is made. Smallest fix: list the allowed sites
  in the conversation's right-hand panel with a "Stop allowing" action.
- Answered on 2026-11-14: the button is offered only for an `https` address, and the
  server stores a site only from an `https` address (`approval.tsx:67-74`,
  `product.ts:950-954`).
- Answered on 2026-11-14: when a conversation already holds 50 allowed sites the next
  one is not stored and the activity log no longer says it was (`product.ts:955-963`).
- Answered on 2026-11-14: the Approvals page is laid out like the rest: what is waiting
  on top with its count, and earlier decisions as a list that can be narrowed to
  Approved, Rejected or Expired (`Pages.tsx:63-232`). What remains is below.
- The empty state names two reasons an agent asks (a site, a send) and leaves out the
  third, writing a file on the person's computer (`en.ts` `app.approval.noneLead`).
  Smallest fix: add it.
- In "Earlier decisions" a write on the computer has a globe for its icon, and its path
  is passed through the code that looks for a site's name (`Pages.tsx:84-90`, `:171`).
  It reads "Write a file on your computer · Reports/a.md" under a globe. Smallest fix:
  a file icon for `local.write`.
- The filter buttons count only what is loaded, 100 requests in all, with no sign that
  older ones exist. Smallest fix: "Showing the latest 100."
- The head of the enterprise will ask where the organization's own decisions are: every
  request here is the person's to allow, and an administrator can only watch. In "Full
  access" there is not even a request to watch. Smallest fix: on the admin Approvals
  list, show reads that went through without asking as their own kind.

---

## Modes: how much an agent may do without asking

> **Since 2026-11-19 (quiet start, Q-3).** The mode chip, on the start page and in a
> conversation, is shown once the mode is not "Ask first" or the person has chosen a mode
> in this browser. Before that, modes are met on the confirmation card (see
> [Confirmations](#confirmations-an-agent-asks-before-an-action)).

**Who it is for.** Every member, for each of their conversations. An administrator
(`settings.manage`) sets the most anyone may choose; see
[admin-console: Policies](admin-console.md#policies).

**The job.** "Stop asking me about every small thing in this piece of work, but only as
far as I say, and never further than my organization lets me."

**Where it starts.** The mode chip in the message box, beside the + and the project: on
the start page for the next conversation, and in a conversation for that conversation.

**What they see and can do.**
- The chip shows the mode's name with an icon: "Ask first" (a hand), "Approve for me" (a
  shield), "Full access" (an open lock, in amber).
- Click → a menu headed "What may agents do here without asking you?" with the three
  modes, a tick on the current one:
  - "Ask first": "Ask before writing a file on your computer and before reading a site
    you did not name."
  - "Approve for me": "Write in the folders you attached without asking. Still ask about
    a new site."
  - "Full access": "Also open any web address without asking. An agent could pass on
    what it has read by putting it in an address."
  - A mode above the organization's ceiling is greyed out and reads "Your organization
    does not allow this."
  - Under the three: "Sending a message or a file outside your organization asks you
    first in every mode."
- Choose a mode on the start page → the next conversation starts in it, and it is
  remembered in this browser for the ones after.
- Choose a mode in a conversation → that conversation changes at once, a reply that is
  being written included (its next step is judged by the new mode), and the choice is
  remembered for new conversations.

**Rules.**
- A mode belongs to a conversation (`conversations.mode`). A new conversation is "Ask
  first" unless the page asks for another (`apps/server/src/schema.ts:360`,
  `apps/server/src/product.ts:614-651`).
> **The administrator's ceiling on modes was removed on 2026-11-21.** The owner: "目的是把
> 授权还给用户，而且不再由管理员决定要不要支持用户选择最高级别的授权，没有意义". Every person
> chooses any of the three modes in each conversation, "Full access" included. Gone: the
> control on the console's Policies page, `GET /api/app/policy`, `PUT /api/settings/policy`,
> `maxMode` in a conversation's and the system's answers, the refusal `mode_not_allowed`,
> and the gateway's reading of `org_settings.max_mode` (the column is left, unread; earlier
> `policy.changed` events stay in the activity log). A conversation stored as "Full access"
> under a lowered ceiling is "Full access" again. What this page says of a ceiling below is
> how it was until then.

- The organization has a ceiling (`org_settings.max_mode`). Until an administrator sets
  one it is "Approve for me" (`apps/server/src/runtime/catalog.ts:59`). So "Full access"
  is closed to everyone until an administrator opens it.
- What a conversation really runs under is the more careful of its own mode and the
  ceiling, worked out again at every tool call (`apps/server/src/runtime/runs.ts:656-662`;
  `catalog.ts:56-57`). So when an administrator lowers the ceiling, every conversation
  follows at once, open ones too. The stored choice is not rewritten: if the ceiling is
  raised again, a conversation that had "Full access" has it again without anyone
  choosing.
- Choosing a mode above the ceiling is refused: `mode_not_allowed`, "Your organization
  does not allow agents that much freedom." (`product.ts:701-712`,
  `apps/server/src/errors.ts:28`). A new conversation asked to start above the ceiling
  starts at the ceiling instead, without a refusal (`product.ts:640-650`).
- Since 2026-11-22 the chip opens a small panel, not a list of paragraphs
  (`apps/web/src/app/ModeChip.tsx`): the word "Permissions", three icons in a row, and
  under them the name and one line of the mode pointed at or chosen ("Ask before writing
  files, running commands or opening new sites." / "Write in the project's folders
  without asking." / "Run any command and open any site without asking."). Choosing
  keeps the panel open. The longer warning under Full access, and the note that sending
  outside the organization always asks, are no longer shown there; what each mode does
  is the table below. The owner, beside another product's picker: "我们的太多文字描述了".
- A project has a page of its own (since 2026-11-22; the owner: "既然是一个项目，是否有
  一个这个项目的概览"; `apps/web/src/app/ProjectPage.tsx`, address `#/p/<id>`). In the
  sidebar a project's name opens it and the arrow beside it folds its conversations.
  The page shows, in this order: what waits for the person in the project (a
  conversation asking for their word, one still working); its steps, with how far it
  has come; its updates, the newest open; "Where it stands", the project's notes; its
  files, the key documents first and then the newest eight made in it ("Show more
  files" for fifty); its conversations (twelve, then all). "New conversation" starts one in the
  project. It is not a board: there are no columns and nobody but the person and their
  agents; since 2026-11-23 a step has a state, a day it is due and the agent it was
  given to (next entry but one).
- A project's notes (`projects.notes`, 6,000 characters; `apps/server/src/projects.ts`)
  carry it from one conversation to the next. Every conversation in the project is
  given them, as where the work stands and not as instructions, and told to bring them
  up to date with `project.note` when something is concluded, decided, left open or
  left open: the whole notes, short lines under "Where it stands", "Decided", "Open".
  (Until 2026-11-23 what was still to do was written there too, as "- [ ] …" lines under
  "Next"; those are steps of their own now, and an agent is told not to list steps in
  the notes. Notes that still hold such lines show them ticked or not as before, and the
  page offers to make them steps.) The tool comes with being in a
  project; nobody ticks it. It asks first once the run has read something from outside,
  as keeping a memory does. The person edits the notes on the page, ticks a step there
  (which saves), and can bring back the notes as they were before the last change, one
  step either way. Tried with the real model: asked what was left and told two
  decisions, it answered from the notes, rewrote them with the decisions, said so, and
  pointed out a line in them that contradicted a ticked step. Not done: a history of the
  notes beyond one step; notes for a conversation passed to another agent (it is told
  the project's name and instructions only); anything in the phone app but the step's
  label; a project shared between people.
- A project's steps (since 2026-11-23; `project_steps`, `apps/server/src/projects.ts`,
  `apps/web/src/app/ProjectSteps.tsx`). The owner, asked what a project's page needs:
  "你进去后 UI 上你需要看到啥呢？需要管理啥呢？比如进度看板吗？一个完整的 PM 需要的东西？".
  Until then a step was a line of the notes that could be ticked and nothing more.
  - **What the person sees.** Under the project's name, "Steps": a thin bar and "2 of 4
    done", then the open steps in the order the person keeps them, a line to add one
    ("Add a step", Enter), and the done ones folded under "2 done". A step's row is a
    tick box, its title, and what is true of it: "Waiting for you" (amber, a hand),
    "Writer is on it" (a spinner while that conversation is writing), the day it is due
    (red once past), and a small button that opens the conversation working on it. What
    came of a step, or what it waits for, is a line under it, with the agent's name when
    an agent wrote it.
  - **What they can do.** Tick a step (done; untick puts it back). Press its title to
    change it (Enter or leaving the box keeps, Escape drops). From the row's menu (shown on hover, and
    with the keyboard): **Hand to** an agent, which starts a conversation in the project
    with "Take up step N of this project: …", marks the step as being done by that agent
    and opens the conversation; **Waiting for me** / **No longer waiting for me**; **Set
    a due date** (a date box in the row, kept on Enter or on leaving it), **No due date**; **Move up** / **Move down**;
    **Delete**. When the notes still hold "- [ ]" lines, a strip says "The notes hold 3
    steps as lines of text" with **Make them steps**: each becomes a step (ticked ones
    done), the lines leave the notes with whatever was indented under them, and a
    heading that stood over nothing else ("Next") goes with them; a sentence above them
    stays. The server does both in one go (`adoptSteps`), or neither: when the notes
    were changed since the page read them it says so and makes nothing.
  - **What an agent does.** Every conversation in the project is shown the steps,
    numbered, the first forty open ones in full ("3. [to do] Book the room (due
    2026-12-01, overdue)", overdue by the person's own calendar) and the last twelve
    done ones in a line, as a record and not as instructions, and is told to keep them true with
    `project.step`: "doing" when it takes one up, "done" with what came of it, "waiting"
    with what it waits for, and to add what the work turns up that is still to do, never
    what the reply itself finishes. One call changes one step, named by its number, and is answered with that step as it
    now reads. A
    step an agent takes up or ends is linked to that conversation. The tool comes with
    being in a project (nobody ticks it), is not given to an agent a step was passed
    to, asks first once the run has read something from outside when the call writes
    words (a new step, a title, a result), as the notes do, with a card that says what
    would change; saying only that a step is being done, is done or waits does not ask,
    since it carries nothing that was read. Its arguments are kept out of traces as
    the notes' are.
  - **Rules.** A step is `todo`, `doing`, `waiting` or `done`; a title of up to 200
    characters on one line; a due day written `2026-11-30`; a result of up to 600. A
    project holds 200 steps (`too_many_steps`). A step's number is its own for good and
    is not used again. Only an agent the person may use (the organization's published
    ones, their own, and what a colleague shared with them) can be given a step
    (`step_agent`),
    and only a conversation of the same project can be named as working on it. Steps
    are the person's alone, like the project; they go when the project is deleted. The name beside what came of a step is whoever
    last wrote its words: a person who only ticks, dates or moves a step an agent
    finished leaves the agent's name there.
  - **Requests.** `GET`/`POST /api/app/projects/:id/steps`, `PATCH`/`DELETE
    …/steps/:step`, `POST …/steps/adopt` (`apps/server/src/product.ts`); the project list carries `steps` and
    `stepsDone`. Tests: `apps/server/src/steps.test.ts`,
    `apps/web/src/app/stepLines.test.ts`.
  - **Tried** on the local server with the real model: three step lines of a project's
    notes made steps; a step added, and handed to the Writer, which opened a
    conversation, marked the step as being done and began the work.
  - **Not built.** Dragging to reorder; a step for more than one person, or seen by
    anyone else; sub-steps; reminders when a due day passes; steps in the phone app (the
    tool's label only); a link from a step to the files it made (the conversation is the
    link); a step's history; a board or timeline view. An agent that ends its reply without
    saying how the step stands leaves it "being done".
- A project's updates (since 2026-11-23; `project_updates`, `apps/server/src/projects.ts`,
  `apps/web/src/app/ProjectUpdates.tsx`): how the project is going, said at a moment and
  kept. The notes say where the work stands and are rewritten; nothing there could be
  sent upward or looked back on.
  - **What the person sees.** Beside the project's name, how it was last said to be
    going: a coloured dot and "On track" (green), "At risk" (amber) or "Off track"
    (red); nothing until there is an update. Under the steps, "Updates": the newest in
    full (its health, "2 hours ago by Writer", its lines), and the earlier ones folded
    under "3 earlier updates".
  - **What they can do.** **Write**: three chips to say how it is going, a box for a few
    lines ("What was finished, what is being done, what is at risk or waited for, what
    comes next."), **Add update**. **Have an agent write one**: starts a conversation in the
    project, with the agent they last used, that writes the update from the steps, the
    notes and what was done, adds it and gives it in its reply; from there it can be
    sent on by mail or Teams as any reply's content can. Delete one (a bin on the row,
    asked once more first). An update is never changed, only added after.
  - **What an agent does.** Every conversation in the project is shown the latest
    update (its day, health and who wrote it) and writes one with `project.update` when
    the person asks how the project is going or for a report: a health and three to six
    short lines. The tool comes with being in a project, is not given to an agent a step
    was passed to, asks first once the run has read something from outside (the card
    shows the update), and its arguments are kept out of traces.
  - **Rules.** Health is `on_track`, `at_risk` or `off_track`; the text is 2,000
    characters at most (`invalid_update`). A project keeps its newest 50, all of them shown. They are the
    person's alone and go with the project. The project list carries `health`, the
    newest update's.
  - **Requests.** `GET`/`POST /api/app/projects/:id/updates`, `DELETE …/updates/:update`.
    Tests: `apps/server/src/updates.test.ts`.
  - **Tried** on the local server: an update written on the page and shown with its
    health. Not tried: a draft by the real model; the approval card; Chinese wording on
    screen.
  - **Not built.** Updates on a schedule (a schedule has no project); sending an update
    from the page itself; anyone but the person seeing them; health across projects in
    one view; health worked out from the steps rather than said.
- A project's key documents (since 2026-11-23; `project_docs`,
  `apps/server/src/projects.ts`, `apps/web/src/app/ProjectFiles.tsx`): the few files
  everything else in the project rests on, each pinned for what it is. On the page,
  "Files" begins with them: a row each with what it is ("Spec", "Decisions",
  "Research", "Release notes", "Key document"), the file, a button to change what it is
  pinned as and one to unpin. When the person has a newer file of the same name the row
  says "Newer copy exists": a file is read by its name and the newest of a name is the
  one read, so the agent is told the same and to say so before relying on it. A file
  made in the project is pinned from its own row: a pin button (on hover, and with the
  keyboard) opens "Pin as" with the five kinds. Every conversation in the project whose agent can read files is told
  the documents' names and kinds ("- The spec: "Launch spec.md""), not what they say,
  and to read the one a piece of work depends on before doing that work. Rules: only
  the person's own files; twelve to a project (`too_many_docs`); a file that is deleted
  stops being one and no longer holds one of the twelve places; a file a run of code
  kept is not replaced by a later run once it is pinned. A document's name is given to an
  agent as a quoted string, whatever is in it. Requests: `GET /api/app/projects/:id/docs`, `PUT`/`DELETE
  …/docs/:file`. Tests: `apps/server/src/docs.test.ts`. Tried in the browser on the
  local server: a file pinned as research. Not built: pinning a file that was not made
  in the project (it has to be among the project's files on the page); an agent pinning
  what it makes; templates for a spec or release notes; a file a colleague shared.
- Steps and the tracker (since 2026-11-24, MUS-14; `apps/server/src/tracker.ts`,
  `apps/web/src/app/ProjectTracker.tsx`): a project can be linked to one project in the
  company's task tracker, so that its steps and the team's tickets are one list. The
  first tracker is Plane; another kind is one more `TrackerApi` in `tracker.ts`.
  - **Who does what.** An administrator connects the tracker once (admin-console.md,
    "Connections", "Task tracker"). The project's owner links the project: on the
    project's page, beside "Steps", "Link to tracker" → a dialog with the tracker's
    projects to choose from and one tick, "Also send the N steps already here" (on) →
    "Link to tracker". Nobody else is offered it, and where the company has no tracker
    nothing is shown at all. There is no setting beyond this. Which of the tracker's
    projects may be linked is the administrator's to say, not the owner's: the company's
    key reaches every project there, so the owner is offered only those ticked on the
    "Task tracker" card, and asking for another is refused (`tracker_not_allowed`).
    Until one is ticked nobody is offered anything.
  - **What they see.** Beside "Steps", one small mark: the tracker project's key and "in
    step", "N waiting", or "not in step" (hover says why). It opens a menu: "Open <name>"
    and, for the owner, "Unlink" (asks first). Each step tied to a work item shows its key
    (`ACM-12`) as a link to it.
  - **What goes out.** A step added here makes a work item; its title, state, due date
    and what came of it (as a comment, once per result) follow every later change. Whoever
    wrote the step, a person, an agent with `project.step`, the notes being adopted: the
    step's own table says its ticket is behind (a trigger fills `tracker_outbox`), so no
    caller needs to know of the tracker and none can forget it.
  - **What comes back.** Title, state and due date changed in the tracker are read about
    every two minutes and taken into the step. No webhook in this version. The mark of
    what was seen (`project_trackers.seen_through`) is the tracker's own clock, and is
    moved only when a reading came to items already seen or to the true last page. A
    reading cut short at its bound (ten pages a pass) leaves the mark where it was and
    keeps where it stopped (`resume_cursor`); the next pass, at once, goes on from there.
    Each reading starts five seconds before the mark: what is read twice changes nothing,
    since an item is compared with what both sides last agreed on. The tracker project's
    key is read with every pass, and every ticket's key follows it when it is renamed.
  - **States.** A tracker's states fall into five groups; a step has four states.

    | A step here | is sent as the group | and agrees with |
    |---|---|---|
    | to do | unstarted (backlog if the project has no such state) | backlog, unstarted |
    | doing | started | started |
    | waiting | started | started |
    | done | completed | completed, cancelled |

    | An item moved there to | makes the step |
    |---|---|
    | backlog, unstarted | to do |
    | started | doing |
    | completed | done |
    | cancelled | done, with "Cancelled in ACM-12." as what came of it when nothing was said |

    Within a group the project's default state is chosen, else the first it shows.

    A state is sent only when the step's no longer agrees with the group the item is in
    ("waiting" agrees with started, so a step set to waiting changes nothing there), and
    a change there moves the step only when the new group does not already agree with it
    (from "In Progress" to "In Review" leaves a waiting step waiting).
  - **When both changed the same thing.** The tracker's word stands. What changed there
    is read before what changed here is sent, in every pass, so a title changed on both
    sides between two passes ends as the tracker's on both. What only one side changed
    (a due date here, a title there) is kept from each.
  - **Deleting.** Never across. A work item deleted there: its step stays, shows no key,
    and its ticket is remembered as gone (`step_tickets.gone_at`), so that the step is
    not made a second time however often it is changed and nothing is tried for ever.
    It is found when the step is next sent, or by the full reading once a day (for a
    tracker project of a thousand items or fewer). A step deleted here: its work item
    stays. Unlinking, or an administrator disconnecting the tracker, leaves both sides as
    they are and forgets what tied them.
  - **Nothing here waits for the tracker.** A pass takes a step or a project for itself
    in a moment (a lease: `next_at` / `next_pull_at` moved five minutes on), asks the
    tracker with no transaction and no lock open, and then writes what came of it. A
    step changed while its ticket was being sent stays to be sent again (`seq` says so).
    Writing a step never waits: `tracker.test.ts` hangs the tracker and changes a step.
  - **Failures.** Anything that goes wrong, a refusal or something nobody foresaw, waits
    longer before the next try: 1, 5, 30 and then every 120 minutes. A step that failed
    eight times is set aside (`parked_at`) until it is changed or the administrator
    saves the connection again; the longest waiting go first, so one that cannot be sent
    never stands in front of the others. A project that cannot be read is asked every
    two hours. The mark beside "Steps" says "not in step" with the reason, and the third
    failure in a row is written to the activity log once (`tracker.failing`). An item is
    made once even when the answer to making it is lost: before one is made the tracker
    is asked for the item that carries the step's id (`external_id`, source `muster`),
    and a refusal that names the item already there is followed too.
  - **Agents.** Nothing of the tracker is said to an agent, in its instructions or its
    tools: `project.step` is as it was (platform.md, "What is said once").
  - **Wired.** Tables `trackers`, `project_trackers`, `step_tickets`, `tracker_outbox`
    (`TRACKER_SCHEMA`, `TRACKER_FIXES_SCHEMA`). Requests: `GET`/`PUT`/`DELETE /api/app/projects/:id/tracker`,
    `GET …/tracker/projects`; `GET …/steps` carries `ticket: {key, url}`. A timer in
    `index.ts` calls `Tracker.tick` once a minute. Tests:
    `apps/server/src/tracker.test.ts` (a Plane that stands in: connecting, which projects
    may be linked, linking, sending, reading back, both changing, deleting each way and
    never making again, retrying, making once, a tracker that hangs, one that answers
    nonsense, a reading cut short, a renamed project, unlinking; the key in no answer,
    row or record).
  - **Not built.** Bringing in work items that were not made from a step; assignees,
    labels, priority, descriptions, comments coming back; a webhook; more than one
    tracker a company or more than one tracker project a project; Linear or Jira.
    A step's conflict with a later change of the same field by another process is
    settled by the next pass, not within one. Not tried: against a real Plane; the page
    in a browser. What is taken from Plane's public API (v1, as its open-source server
    and `~/.claude/skills/plane-tracker` use it) and not proven here: `GET
    …/work-items/?external_id=&external_source=` answers with the one item or 404 (a
    list is handled too, and only an item that names the step is taken from it); `POST`
    with a repeated `external_id` answers 409 with the item's `id` (not relied on);
    `order_by=-updated_at` sorts newest first (where it does not, the whole list is
    read); pages carry `next_cursor` and `next_page_results`; a work item has `name`,
    `state`, `target_date`, `sequence_id`, `updated_at`; a state has `group`, `default`,
    `sequence`; a comment is `comment_html`; a deleted item answers 404 to `PATCH`. A
    page cursor is a place in the list: an item deleted there while a long reading is
    under way can make it step over one, which the next change to that item puts right.
- A project's people (since 2026-11-24, MUS-13; `project_members`,
  `apps/server/src/projects.ts`, `apps/web/src/app/ProjectPeople.tsx`): a project is one
  person's, and they can bring colleagues into it. Until then a project could be shown
  to nobody.
  - **Who may do what.**

    | | Owner | Works in it | Sees it |
    |---|---|---|---|
    | See the page: steps, updates, notes, key documents, who is in it | yes | yes | yes |
    | Open a key document (read only) | yes | yes | yes |
    | Add, change, tick, order and remove steps; write and bring back notes | yes | yes | no |
    | Post an update | yes | yes | no |
    | Delete an update | any | their own | no |
    | Start a conversation in the project; hand a step to an agent | yes | yes | no |
    | Rename it, change its instructions, pin or unpin key documents | yes | no | no |
    | Bring people in, change what they may do, take them out | yes | no | no |
    | Take themself out | no | yes | yes |
    | Delete the project | yes | no | no |

  - **Conversations stay private.** A conversation in a project is its person's alone.
    Nobody else in the project sees it, its title or what was said in it; each person's
    list and the project's page show their own conversations only, and the count of
    conversations on a project is their own. A step that a colleague's conversation is
    working on says "In progress" with no conversation to open.
  - **The click path, for the owner.** On the project's page, beside the health mark, a
    button "Share" (it reads "3 people" once others are in it) opens "People in
    "<project>"". Choose "They may: See it / Work in it" (a line under it says what
    that gives), type a name or an address, click the colleague: they are in the
    project at once and get a notice ("<owner> brought you into the project "<name>",
    to work in it.") that opens the project's page. In the list under "In this
    project" the role is a chip that switches between the two when clicked, and the ×
    takes the person out. The sidebar shows a project with other people in it with a
    people icon in place of the folder.
  - **For someone brought in.** The project is in their sidebar among their own, with
    the people icon; hovering its name says whose it is. On its page a line under the
    name says "<owner>'s project. You work in it." or "<owner>'s project. You can see
    it, not change it." Someone who only sees it has no "New conversation", no pencil
    on the notes, no box to add a step, no step menus, disabled checkboxes, no "Write"
    or "Have an agent write one" on updates, and no pin buttons; the project is not
    among the choices on the start page's project shelf. Anyone but the owner has no
    settings gear and no pencil in the sidebar; the project's chip in a conversation
    opens the project's page instead of its settings. The people button opens the same
    dialog without the search: who is in it, and "Leave this project" (asked once; the
    project goes from their list).
  - **What the page says while others work.** In a project with other people in it the
    steps and the updates are asked for again every 20 seconds while the page is
    looked at, since a colleague may change them at any time. An update says who
    posted it ("2 hours ago by Mo"), or the agent and whose conversation it was
    ("Writer, for Mo").
  - **Agents.** A conversation a member starts in the project is told the project's
    instructions, notes, steps, latest update and key documents as the owner's own
    conversations are, and its `project.note`, `project.step` and `project.update`
    write to the one project everybody sees. Its agent reads a key document by name
    with `files.read` (the person's own file of that name comes first). The words of
    the prompt are the same for everyone: nothing about members is added to it. For
    someone who only sees the project the three tools are absent.
  - **Key documents are how a file reaches the project's people.** Pinning a file is
    what lets them open it, and only read it; the owner's other files stay the
    owner's. The owner is told so under the key documents once others are in the
    project. They also appear among "shared with me" in a member's files.
  - **Taken out, or left.** The person reaches nothing of the project: its page, its
    steps, its key documents. Their conversations there stay theirs, are shown as
    being in no project, and are told nothing of the project from the next message on.
    Nothing is deleted, so being brought back puts those conversations back.
  - **Rules.** Colleagues of the same company only, people not departments; 50 to a
    project (`too_many_members`); a role is `view` or `work`; a project cannot be
    reached at all by anyone not in it (404, as if it were not there), and someone in
    it who may not do a thing is told so (403 `project_view_only`, `project_owner_only`).
  - **Logged.** Bringing someone in, changing what they may do, taking them out and
    leaving are in the admin audit log: `project.member_added`,
    `project.member_changed`, `project.member_removed`, `project.member_left`, with the
    project and the person.
  - **Data.** Schema step 36: `project_members (project_id, org_id, user_id, role,
    added_by, created_at)`, and `project_updates.author_id`. Steps, updates and key
    documents stay kept under the owner (`user_id`); who is asking is found once per
    request (`projectAccess`, and `reach` in `product.ts`).
  - **Requests.** `GET /api/app/projects/:id/members`, `PUT …/members/:user`
    (`{role}`), `DELETE …/members/:user`. `GET /api/app/projects` now lists the
    projects the person was brought into too, each with `role`, `owner` and `people`.
  - **Tests.** `apps/server/src/members.test.ts`.
  - **Not tried.** The page in a browser, by anyone: the people dialog, the reduced
    page of someone who only sees a project, Chinese wording on screen. The phone and
    desktop apps were not changed and not looked at.
  - **Not built, or left as it is.** Sharing with a department or by a link; someone
    outside the company; a member pinning their own file as a key document (they share
    it with the owner, who pins it); seeing a colleague's conversation or the files it
    made; who changed a step (an update says who posted it, a step does not); handing
    the project to another owner. The words an agent is told still say "the person's
    project" in a member's conversation, and in the conversation of someone who was
    since reduced to seeing the project they still describe `project.step` though the
    tool is no longer there: the prompt was left word for word as it was, so that
    nothing about members changes what is sent to the model.
- The sidebar can be put away (since 2026-11-22; the owner: "现在没有支持用户折叠的功能";
  `apps/web/src/app/Workspace.tsx`): a button at its head hides it, a button at the left
  of the top bar brings it back (with "New conversation" beside it), and so does ⌘B or
  Ctrl+B. It stays away between visits (`muster.sidebar` in the browser). A narrow
  window has no sidebar to put away: it has the menu, as before. With it away ⌘K brings
  it back with the cursor in the search box. In the desktop app on a Mac the top bar
  then makes room for the window's own buttons.
- On the start page the project a conversation starts in is chosen on a shelf under the
  message box (`ProjectPicker` in `apps/web/src/app/Projects.tsx`, placed in
  `apps/web/src/app/Chat.tsx`), shown with no project too: a search box, "New project",
  the projects. A new project's dialog is a name, in the desktop app the folders the
  work is in ("Add a folder"), and one button; instructions for agents are in the
  project's settings, not asked for when it is made. No paragraph says what a project
  or a folder is.
- What each mode changes at the gateway (`runs.ts:663-682`, `:715-721`):

  | The agent wants to | Ask first | Approve for me | Full access |
  |---|---|---|---|
  | write a file in an attached folder (`local.write`) | asks (`confirm-local-write`) | does it | does it |
  | read an address the person did not write, on a site they did not allow (`web.fetch`) | asks (`confirm-unlisted-address`) | asks | does it |
  | run a command that reaches outside the folder, sends something, or cannot be undone (`local.exec`, `risk` in `commands.ts`) | asks | asks | does it (since 2026-11-21) |
  | run any other command that does more than look (`local.exec`) | asks | does it | does it |
  | send data to an outside address (`web.send`) | asks (`confirm-external-actions`) | asks | asks |
  | anything else (documents, files, Microsoft 365, looking in a folder) | does it | does it | does it |

- "Full access" does not lift the network rules: public addresses only, the same ports,
  sizes and time limits (`apps/server/src/runtime/net.ts`). It lifts only the question.
- "Full access" lets an agent that has read something private (a document, a file in a
  folder, a mail) put it in an address and open that address, with nobody asked. This is
  why reading an unnamed address asks in the other two modes (`runs.ts:654-655`), and it
  is what the mode's own line and the administrator's confirmation say.
- Recorded: an administrator's change of the ceiling is `policy.changed` in the activity
  log, with the mode before and after. A person's change of a conversation's mode is not
  recorded anywhere. Each tool call's span names the policy that let it through or
  asked, but not the mode.
- In the browser the choice for new conversations is `localStorage` `muster.mode`; "Ask
  first" when nothing is kept (`apps/web/src/app/ModeChip.tsx:15-21`).

**States.**
- The ceiling not yet loaded on the start page: the chip shows "Ask first" and the other
  two are greyed out (`apps/web/src/app/Chat.tsx:427`).
- A conversation whose stored mode is above today's ceiling: the page is told the
  effective mode, so the chip shows the ceiling (`product.ts:673-675`).
- Changing the mode failed: the reason in red above the message box.
- Ceiling "Ask first": both other modes greyed out for everyone.

**How it is wired.**
- Screen: `apps/web/src/app/ModeChip.tsx:31` (`ModeChip`), `:17-24` (the remembered
  mode, `stricter`); on the start page `apps/web/src/app/Chat.tsx:424-428`, `:531-538`;
  in a conversation `Chat.tsx:1002-1018`.
- Requests:
  - `GET /api/app/policy` → `apps/server/src/product.ts:174`; `{maxMode}`. Any member.
  - `POST /api/app/conversations` with `mode` → `product.ts:614`.
  - `GET /api/app/conversations/:id` → `product.ts:655`; `mode` (effective) and `maxMode`.
  - `PUT /api/app/conversations/:id/mode` `{mode}` → `product.ts:701`.
  - `PUT /api/settings/policy` `{maxMode}` → `product.ts:177`; needs `settings.manage`.
- Gateway: `apps/server/src/runtime/runs.ts:656-682` (mode, the two checks, the level),
  `:715-721` (which policy is named).
- Data: `conversations.mode` (`schema.ts:360`, migration 10: `ask`, `auto` or `full`,
  default `ask`), `org_settings` (`:361`: `org_id`, `max_mode`, default `auto`).
- Events: activity log `policy.changed` (administrator only); trace spans `policy.check`.
- Tests: `apps/server/src/product.test.ts` "how much a person lets agents do without
  asking" (`:1306`): "asks before writing on their computer unless they said it need
  not", "reads any public page without asking only in the freest mode, and only where
  the organization allows it" (the freest mode is refused until an administrator allows
  it; a member cannot change the ceiling; lowering the ceiling brings an open
  conversation down; both changes are in the activity log). No test covers the chip.

**Not built.**
- No mode in which sending outside does not ask.
- No mode per agent, per project or per folder: it is the conversation's, for every
  agent step in it.
- No mode that ends by itself (for one reply, for an hour).
- No list of what a mode let through: the steps show what was done, not that it would
  have asked in another mode.
- No ceiling per role, per department or per agent: one for the organization.
- No record of a person's changes of mode.
- No confirmation when a person chooses "Full access".

**Design findings.**
- "Full access" lets an agent that read something private put it in an address it then
  opens. The mode says so in one line, and the administrator is told when opening it,
  but the person is not asked when choosing it, and nothing marks the conversation
  afterwards except an amber chip. Smallest fix: a confirmation on choosing it that
  names what the agent in this conversation can read (documents, folders, Microsoft
  365), and an amber line above the message box while it is on.
- The head of the enterprise cannot have "Full access" for research agents that read
  nothing private without opening it to the Assistant, which reads mail. Smallest fix:
  allow "Full access" only in conversations whose agent holds no tool that reads the
  person's own things.
- A person's change of mode leaves no record, and a trace does not say which mode a run
  was under. After an incident nobody can show when "Full access" was turned on.
  Smallest fix: write `conversation.mode_changed` to the activity log for "Full access",
  and put the mode on the trace.
- Raising the ceiling again silently restores "Full access" in every conversation that
  once had it (`runs.ts:662`, `product.ts:673`). Smallest fix: when the ceiling is
  lowered, lower the stored mode of the conversations above it.
- The names are three kinds of phrase: "Ask first" (what the agent does), "Approve for
  me" (what the person asks for), "Full access" (a state). "Approve for me" is the least
  clear: it writes files without asking but still asks about sites. Smallest fix: name
  them by what stops asking, "Ask first", "Write without asking", "Write and browse
  without asking".
- "Approve for me" matters only to a person with folders attached in the desktop app. To
  everyone in a browser the first two modes are the same, and nothing says so. Smallest
  fix: hide or grey "Approve for me" where no folder can be used.
- The remembered mode applies to every new conversation in this browser, the riskiest
  included (`ModeChip.tsx:21`). Smallest fix: never remember "Full access".

---

## Replies as generated UI

**Who it is for.** Every member.

**The job.** "Give me the answer laid out properly: a table when it is a table, a chart
when it is numbers, a diagram when I ask for one."

**Where it starts.** Every reply in a conversation. The agent writes its reply in a
small language (OpenUI Lang) and the page draws it from a fixed set of components.

**What they see and can do.**
- Text: paragraphs. `**double asterisks**` are bold. Nothing else is formatted. A "muted"
  tone is smaller and grey.
- Heading: a short heading.
- Callout: a boxed note with a title and an icon, in one of three tones (info, warning,
  success).
- List: bullets, or numbers when the order matters.
- Table: a header row and rows of text.
- Facts: label and value pairs in a box.
- Code: a block in a fixed-width face with the language name and a copy button → copies
  the code; a tick shows for 1.5 seconds.
- Diagram: a titled frame with a drawing made from Mermaid source. Two buttons: "Show
  source" switches between the drawing and its source; "Save as image" downloads the
  drawing as an SVG file named after the title.
- Chart: a titled frame with a chart, values on hover, a legend when there is more than
  one series, and "Numbers" to see the same as a table (and "Chart" to switch back).
  Nine kinds: `bar`, `hbar` (lying down: rankings, long names; each bar says its number
  at its end), `stacked` (parts below nothing hang below it), `line`, `area`, `pie` (one
  series; past six slices the smallest are folded into "Other"), `radar`, `combo` and
  `waterfall`. With one series of changes and `up`, each bar is coloured as a rise or a
  fall.
  - `combo` is two measures of different scale over the same labels: the first series as
    bars in `unit`, the others as lines in `unit2`, in **two plots one above the other**,
    never two scales on one plot (a reader cannot tell which line belongs to which
    scale). The lines' scale need not start at nothing.
  - `waterfall` is how an amount became another: the opening amount, each change as a
    bar floating from where the last ended, and a closing "Total" the client adds.
  - `target` draws a dashed line at a value, named by `targetName`.
  - A place without a number (`null`) keeps its place: no bar there, a gap in a line.
  - A unit that is a currency sign leads the number (`$1,200`, `$1.2M`); any other
    follows it. Along an axis large numbers are short (`1.2M`, `3400万`); where a number
    is read (hover, bar ends, the table) it is whole.
  - Of more than a drawing holds, standing bars keep the latest 60, lines and areas the
    latest 240, lying bars the first 30, a radar the first 12. The model is told these.
- Numbers in every other usual way (component set 4, 2026-11-24; `numbers.tsx`,
  `scale.ts`). The agent shows them in the reply itself; it is told not to draw a picture
  with code for what one of these is.
  - Tiles: many named numbers as coloured tiles (a market map). With a weight on every
    item the tiles share one box by weight (a squarified treemap); otherwise a grid.
  - Heatmap: rows by columns, each cell filled by its number, the number written in it.
  - Candles: open, high, low and close for each label; the hovered one is read out above.
  - Scatter: a dot for each thing by two measures; dots are named when there are twelve
    or fewer. `group` colours dots by kind (four kinds, the rest grey, with a legend);
    `size` is a third measure shown as the dot's area. "Numbers" lists them.
  - Metrics: two to six headline figures side by side, each with its change (▲ or ▼
    before it), a note, and a small line of its recent values (`trend`).
  - Flows: amounts going from sources to uses as bands (a Sankey). A box for each name,
    as tall as what passes through it; names with nothing coming in stand at the left,
    names nothing leaves at the right. A flow that would close a circle is left out. The
    layout is one piece of arithmetic for every client
    (`packages/ui-schema/src/flows.ts`). Mermaid's own sankey is not used: it cannot take
    names that are not Latin letters (seen 2026-11-24 with Mermaid 12.3).
  - Progress: value out of a target, as a bar and a percentage.
  - Timeline: dated events, earliest first.
  - Table: `signed` names the columns whose cells are changes; they are coloured.
  - **Rises and falls** are coloured only when the reply gives `up`: `"red"` where a
    rise is red by custom (mainland China, Hong Kong, Taiwan, Japan, Korea; a reader
    writing Chinese), `"green"` otherwise. Without `up`, a fill says how large a number
    is: one hue from faint to full, or blue and orange around grey when some are below
    zero. The midpoint is always grey, the number is always written, and words on a
    fill are ink or white, never the hue.
  - What a reply holds is bounded (60 tiles, 20 by 20 cells, the latest 120 candles, 200
    dots, 40 flows among 24 names), the same on web and phone, and
    anything in the place of a number is left out; nothing is drawn for nothing.
  - An older client (component set 3 and below: a phone not yet updated) is taught the
    Chart and Table it draws, to the letter, and none of the new components
    (`replyFormatPrompt`, `packages/ui-schema/src/index.ts`).
- A table's cells draw **bold** and `code` as a paragraph does (since 2026-11-22; `Runs`
  in `apps/web/src/app/reply.tsx`): until then the marks were shown as written. A
  column's heading has its bold marks taken off.
- A diagram whose source does not parse is tried once more with the slips models most
  often make put right (`repairDiagram` in `apps/web/src/app/diagram.ts`): a line break
  written as backslash-n, fences, an arrow to nowhere after a node. If it still cannot
  be drawn, the reply says so in a line and keeps the source behind the "Show source"
  button, where it used to lay the source out as if it were the answer. The model is
  told both rules in the Diagram's description (`packages/ui-schema/src/index.ts`).
  Nothing asks the agent to draw it again by itself. The phone app is unchanged.
- A Callout whose title is only a tone's name (`Callout("info", "…")`: a model putting
  the tone where the title goes) is drawn with that tone and no title, since 2026-11-21;
  until then the note was headed with the word "info".
- Sources and FollowUps stand under a reply and are no part of it, and since 2026-11-21
  they look it (the owner, on seven source pills and three follow-ups as wide as the
  text: "在下面超级多的东西，用户都不知道是不是正文了"; `SourceList`, `FollowUpButtons` in
  `apps/web/src/app/reply.tsx`):
  - Sources: under a thin rule, one small grey line, "N sources" and up to three of the
    sites they are on ("fta.gov.ae · deloitte.com · andersen.com +4"). A press opens a
    numbered list, each a title that is a link opening in a new tab, with its site after
    it. A page named twice is counted and listed once. Until then: pills, one per page, in rows.
  - FollowUps: a small grey heading, "You could ask next", and under it up to four plain
    lines, each with an arrow, set to the left, grey until the pointer is on them. Shown
    under the latest reply only: under an older one the conversation has gone on. Until
    then: bordered buttons as wide as their text, under every reply. Pressing one sends its
    text as the person's next message; they are disabled while a reply is being written.

**Rules.**
- The components and their properties are defined once, in `packages/ui-schema`; the
  server turns that definition into the model's instructions and the web app binds a
  renderer to the same names. The model cannot choose colours, sizes or markup.
- A reply that is plain prose is shown as one Text. Statements without a `root` are shown
  in order (`packages/ui-schema/src/index.ts:185-197`).
- A link is drawn only if it is `http` or `https` with no user name or password; it is
  checked in the schema and again when drawn (`index.ts:15-24`,
  `apps/web/src/app/reply.tsx:245`).
- A follow-up button shows exactly the text it sends; the agent's `label` is ignored, so
  a reply cannot hide a request behind a friendly label (`reply.tsx:290-294`).
- A chart draws at most four series, in fixed colours. Values that are not numbers are
  dropped.
- A diagram is checked before it is drawn, drawn in Mermaid's strict mode with text
  labels, and shown as a picture, so nothing in it can run, link out or restyle the page.
  Source that does not parse is shown as source (`apps/web/src/app/visuals.tsx:46-99`).
- A diagram is drawn 250 ms after its source stops changing, and is at most 30 rem tall.
- "Copy reply" copies the words of the reply (text, headings, cells, labels) without the
  notation (`index.ts:222-237`).

**States.**
- Streaming: the reply is drawn as far as it has arrived.
- Empty reply: nothing is drawn; while running, "Working…" is shown.
- A chart with no labels or no series draws nothing.
- A diagram that cannot be drawn shows its source, with "Save as image" disabled.

**How it is wired.**
- Screen: `apps/web/src/app/reply.tsx` (`Prose` `:31`, `Text` `:52`, `Heading` `:66`,
  `Callout` `:78`, `List` `:96`, `DataTable` `:119`, `Facts` `:154`, `CodeBlock` `:172`,
  `Diagram` `:206`, `Chart` `:213`, `Sources` `:241`, `FollowUps` `:286`, `Stack` `:300`,
  `Reply` `:331`); `apps/web/src/app/visuals.tsx:46` (`DiagramView`), `:156`
  (`ChartView`).
- Requests: none. The reply text comes from the conversation and its live events.
- Data: `messages.content` holds the reply as the agent wrote it.
- Server side: `replyFormatPrompt()` (`packages/ui-schema/src/index.ts:162`) is added to
  every run's instructions (`apps/server/src/runtime/runs.ts:788`).
- Tests: `packages/ui-schema/src/index.test.ts` "the reply components" (`:22`: parse a
  reply that uses each; are all taught to the model; carry only plain web addresses),
  "toRenderable" (`:69`), "a reply as words" (`:110`). There are no tests of the web
  renderers.

**Not built.**
- No Markdown: no italics, inline code, links inside text, nested lists or headings of
  different sizes.
- No images in a reply.
- No pie chart in a reply, and no chart with two axes.
- No sorting, filtering or copying of a table; no "open as spreadsheet".
- No syntax colouring in code blocks.
- No zoom or full-screen for a diagram or a chart; no PNG export.
- No inputs in a reply other than follow-up buttons, choices and a short form (see
  [A form in a reply](#a-form-in-a-reply)): no checkboxes, no figure that recomputes, no
  table to correct, no live data.
- A link in a Text is plain text; only Sources carries links.

**Design findings.**
- Answered on 2026-11-14: the schema's list of what a reply may hold left out Diagram and
  Chart, and no test parsed them. Both are now in the list
  (`packages/ui-schema/src/index.ts`) and in the test that parses "each of them".
- The copy button of a code block has the hidden label "Copy" in English, not from the
  translations (`reply.tsx:189`); the frames of the Word and page viewers have the same
  kind of fixed titles. Smallest fix: use `t.common.copy`.
- Follow-up buttons show the full text they send, which can be a long sentence in a
  round pill. Smallest fix: keep the rule, but cut the pill to two lines with the full
  text on hover.
- A table has no horizontal scroll (`overflow-hidden`), so a wide table squeezes its
  columns. Smallest fix: `overflow-x-auto` on the wrapper.
- A long reply in the middle of streaming re-lays itself as components arrive; a diagram
  shows raw Mermaid source until it settles. Smallest fix: show "Drawing…" in the frame
  while streaming.
- "Copy reply" on a reply with a chart or a diagram copies the Mermaid source and the
  labels as loose lines. Smallest fix: copy tables as tab-separated rows and skip diagram
  source.
- An enterprise owner will ask whether a reply can be saved as a document in one click.
  It cannot; the person must ask the agent. Smallest fix: a "Save as document" action
  beside Copy that calls `POST /api/app/documents`.

---

## Attaching files to a message, and images a model can see

**Who it is for.** Every member.

**The job.** "Send this file along and have the agent work from it."

**Where it starts.** The + in the message box (start page and conversation) → "Files",
dropping files on the message box, or pasting a file or a screenshot into it. The
paperclip button is gone from both message boxes; the + menu took its place
(`apps/web/src/app/Chat.tsx:142-146`, `apps/web/src/app/PlusMenu.tsx:107-111`).

**What they see and can do.**
- Choose, drop or paste one or more files → each starts uploading at once and appears in
  a tray above the text as "Uploading <name>…".
- When an upload finishes it becomes a chip with the file's icon, name and size. Click
  the name → the file viewer. Click × → the file is taken out of the message (it stays in
  the person's files).
- When an upload is refused the tray shows the reason in red with a × to dismiss it.
- Send → the message goes with the files that finished uploading. The sent message shows
  the same chips. If the message is refused, the files come back to the tray with the
  words (`apps/web/src/app/attach.tsx:49-57`).
- "Try again" on a failed reply sends the same files again.

**Rules.**
- An attached file is an ordinary file of the person: it is stored when it is chosen, not
  when the message is sent, and counts toward their 1 GB.
- A message carries at most 10 files, and every one must be the person's own; otherwise
  the message is refused with `not_found` (`product.ts:582-583`).
- The agent is not given a file's content. It is told each file's name, kind and size and
  that it can read one with `files.read` and the exact name
  (`apps/server/src/runtime/runs.ts:59-79`). An agent without `files.read` cannot read
  them.
- Images, when the configured model can see (`MUSTER_MODEL_VISION=1`): the first 4 images
  of this message that are at most 3.5 MB each are shown to the model with this message.
  In later turns they are named, not shown again. A larger or fifth image is described to
  the model as "an image you cannot see". With a model that cannot see, every image is
  described that way (`runs.ts:934-946`; `service.ts:182-189`).
- Accepted endings: `docx`, `xlsx`, `xlsm`, `pptx`, `doc`, `xls`, `ppt`, `pdf`, `png`,
  `jpg`, `jpeg`, `gif`, `webp`, `html`, `htm`, `md`, `txt`, `csv`, `json`
  (`apps/server/src/files/kind.ts:20-44`). The first bytes must match the ending.
- Refusals: `unsupported_file` (shown as "<name> is not a kind of file Muster accepts."),
  `file_too_large` ("That file is larger than this server accepts."), `protected_file`
  ("This file is protected by a password or a sensitivity label…"), `file_quota` ("You
  have no space left for this file. Delete some files first."), `invalid_file_name`.
- Recorded in the activity log: `file.uploaded` for each upload.

**States.**
- Uploading (pulsing chip), ready (chip), refused (red chip with the reason).
- The send button is disabled while any file is uploading.
- The + is disabled when the message box is.

**How it is wired.**
- Screen: `apps/web/src/app/attach.tsx:20` (`useAttachments`), `:73` (`AttachmentTray`),
  `:108` (`AttachButton`); drop and paste in `apps/web/src/app/Chat.tsx:132-143`,
  `:164-169`; `apps/web/src/lib/files.ts:7` (`uploadFile`).
- Requests:
  - `POST /api/app/files?name=<name>` (the body is the file) →
    `apps/server/src/files.ts:72`; `Files.add` `apps/server/src/files/service.ts:72`.
  - `POST /api/app/conversations/:id/messages` with `files: [ids]` → `product.ts:561`;
    `Files.attachments` `service.ts:168`; stored in `messages.attachments`.
- Data: `files` (`schema.ts:282`), `messages.attachments` (`:298`), the bytes on disk
  under `<files dir>/<org>/<id>`.
- Events: `file.uploaded`.
- Tests: `product.test.ts` "files in a conversation" (`:569`), "images sent with a
  message" (`:677`), "a message that only brings files" (`:1441`);
  `apps/server/src/runtime/models.test.ts` "a message with an image" (`:321`).

**Not built.**
- No picking from files already uploaded: "Files" in the + menu only opens the
  computer's file chooser.
- No upload progress in percent and no cancel of an upload in progress.
- No thumbnail of an attached image, in the tray or in the sent message.
- No check in the browser of size, kind or count before uploading.
- No resizing of an image that is too large for the model.
- No reading of text in images or scanned PDFs (no OCR).
- No audio or video.

**Design findings.**
- The person is never told when an image was not shown to the model (too large, the
  fifth, or the model cannot see). Only the model is told. Smallest fix: a small note on
  the chip, "Not shown to the agent (over 3.5 MB)".
- Attaching an eleventh file fails at send with "The request was not valid." Smallest
  fix: stop accepting at 10 in the tray and say "Up to 10 files per message".
- An agent without `files.read` (a personal agent built without it) accepts attachments
  and then cannot open them. Smallest fix: disable "Files" in the + menu and say why
  when the agent lacks `files.read`, unless the model can see and the file is an image.
- A refused upload for size says "larger than this server accepts" without the limit,
  though `GET /api/app/files/limits` exists and a translated sentence with the limit
  exists (`files.tooLarge`); neither is used. Smallest fix: load the limits once and use
  that sentence.
- Removing a chip leaves the file in the person's files, using their space, without
  saying so. Smallest fix: delete an upload that was removed before it was ever sent.
- A pasted screenshot is named by the browser ("image.png"), so several look the same.
  Smallest fix: name pasted images with the time.

---

## Files: upload, list, view, download, delete

**Who it is for.** Every member, for their own files.

**The job.** "Keep my work files here, open them without leaving, and get them back out."

**Where it starts.**
- `#/documents` ("Documents" in the sidebar): the person's library, files and notes
  together, with "Upload".
- Any file chip: in a message, in the attachment tray, under a reply.
- A file row in the right-hand panel of a conversation.

**What they see and can do.**
- The library (shared with [Documents](#documents-notes-agents-read-and-write)), a page
  of tiles:
  - A top row: "Search your library" (matches names); four buttons with counts, "All",
    "Made by agents", "Uploaded", "Notes"; on a wide window a small bar and "312 MB of 1
    GB", the person's space used, red when over nine tenths; "Upload"; "New document".
  - One tile per file or note, newest first: the mark of its type as people know it from
    their own computer, a sheet in the type's colour with its letter (blue W for Word,
    green X for Excel, green CSV, orange P for PowerPoint, red PDF, a picture for an
    image, violet </> for a web page, grey TXT and MD, amber N for a note, a plain grey
    sheet for a type with no mark). The file's ending decides, then its kind. At the
    size of a line of text a word of several letters is drawn as lines in the same colour. The same mark is on file chips in a conversation, in
    the viewer's title bar, in the work panel and in Knowledge
    (`apps/web/src/app/FileTypeIcon.tsx`; drawn here, no vendor's artwork). Then its name, its
    kind in words and its size, and when it was added; for a file an agent made, "Made
    by an agent 3 hours ago". Click a tile → the viewer (a file) or the editor (a note).
  - With the pointer on a file's tile: a download button.
- "Upload" → the file chooser (several files allowed). Files can also be dropped
  anywhere on the page. Uploads show in a tray above the tiles and join them when they
  finish.
- Click a file → the viewer, a large dialog with the file's name, kind and size, a
  download button and a delete button. What is shown depends on the file:
  - PDF: its pages at the width of the viewer, four at a time, more as the person
    scrolls; the page count at the end. Text can be selected.
  - Word (`.docx`): laid out as pages, drawn in the browser from the file.
  - Workbook (`.xlsx`, `.xlsm`): a grid with column letters and row numbers, merged
    cells, frozen top rows kept in view, the workbook's own fills and bold, and the sheet
    names as tabs along the bottom. A note when not all rows are shown.
  - Presentation (`.pptx`): a rail of slide thumbnails on the left, the current slide as
    large as fits, its speaker notes under it, and "Slide 3 of 12". Arrow keys, Page
    Up/Down, Home and End move between slides. Charts in slides are drawn. What cannot be
    drawn is replaced by a labelled box ("Diagram: download the file to see it", "Video
    or sound: download the file to play it").
  - CSV: a grid with the first row kept in view, up to 2,000 rows.
  - Image: the image, fitted to the viewer.
  - Web page (`.html`, `.htm`): the page in a locked frame, with a "Page / Source"
    switch.
  - Text, Markdown, JSON: the text in a fixed-width face.
  - Older Office files (`.doc`, `.xls`, `.ppt`): a notice and no content; see States.
- Download → the browser downloads the file under its own name.
- Delete → a dialog "Delete “<name>”? This cannot be undone." → on confirm the file is
  removed, the viewer closes and the lists refresh.

**Rules.**
- A file belongs to one person. Nobody else can list, read or delete it; agents reach it
  only through the tools `files.list`, `files.read` and `files.create`, in that person's
  runs.
- One file: 25 MB by default. One person: 1 GB in total. The list an agent and the `+`
  menu read (`GET /api/app/files`) returns the newest 500.
- The library page is made for a thousand files and more (since 2026-11-22, after the
  owner asked what it would look like with a thousand; `apps/web/src/app/Library.tsx`,
  `Files.library` in `apps/server/src/files/service.ts`, `GET /api/app/library`):
  - The server finds, narrows, sorts and counts, and hands over a page of 60 (100 at
    most); the next comes when the foot of the list scrolls into view. Every file can
    be reached: the page no longer stops at the newest 500 without saying so. Rows that
    are loaded stay drawn; with all of 1,022 loaded the page held about 23,000 elements.
  - A word typed is looked for in names and in what files and notes say. What a file
    says is read in the background and kept (`files.search_text`, up to 100,000
    characters; `indexPending`, every five seconds, for up to four of them): a file just
    made is found by its words within seconds, files kept before this in turn, and
    until a file is read only its name finds it. A match in the text shows the words
    around it. It is a plain match of the words as typed, without ranking, word forms or
    typos. An image says nothing.
  - Narrowed by where it came from (all, made by agents, uploaded, notes, each with its
    count under what was typed), by kind and by project; ordered newest first, by name,
    or largest first.
  - Drawn as a list (one line each: name, where it came from, kind, size, when) once
    there are more than 24 things, as cards below that; the person's own choice stands.
  - Each of the person's own files made or sent in a conversation says which, with its
    project, and that opens the conversation. A shared file says who shared it.
  - Several can be picked and deleted at once (`POST /api/app/library/delete`, 200 at
    most a time), each as it would be alone: a file only by its owner and with its
    entry in the record, a note only by whoever wrote it. Only what is loaded can be
    picked; there is no "select all 1,000".
  - Not there: folders, tags, favourites, renaming or moving, undoing a deletion.
- A name is 1 to 200 characters; slashes become underscores; control characters are
  removed (`kind.ts:113-121`).
- A file's kind is judged by its ending and its first bytes together. A mismatch is
  refused. A newer Office file wrapped in a password or an encrypting sensitivity label
  is refused with its own message (`kind.ts:94-110`).
- The server never serves a file in a way that can run: only PDFs and images are sent
  "inline"; everything else is a download; every response carries `nosniff` and a
  content-security policy that allows nothing (`apps/server/src/files.ts:10`, `:40-47`).
- A web page is shown in a frame with no scripts, no network and no access to the app. A
  Word document is drawn into a frame that runs no scripts
  (`apps/web/src/app/FileViewer.tsx:162-206`, `:395-406`).
- A presentation is read in a worker in the browser with a 20-second limit, at most 500
  slides, and size limits on what it unpacks (`apps/web/src/app/slides/SlidesView.tsx:10`,
  `slides/parse.ts:85-91`).
- A workbook's grid is at most 20 sheets, 2,000 rows and 100 columns per sheet. The
  server reads it in a worker limited to 30 seconds and 512 MB, once per content, and
  keeps the result (and a failure) (`apps/server/src/files/extract.ts:12`, `:245-246`;
  `reading.ts:5-6`; `service.ts:200-223`).
- What an agent reads from a file is its text, at most 60,000 characters; a PDF up to 300
  pages; a workbook up to 20 sheets of 500 rows by 60 columns (`extract.ts:6-14`).
- Deleting marks the row deleted and removes the bytes and what was worked out from
  them, unless another file in the organization has the same content
  (`service.ts:302-333`).
- Recorded in the activity log: `file.uploaded`, `file.created` (made by an agent),
  `file.deleted`, each with the name; uploads and creations with kind, size and SHA-256.
- Refusals: `invalid_file_name`, `file_too_large` (413), `unsupported_file` (415),
  `protected_file` (415), `file_quota` (409), `unreadable_file` (422), `not_found`.

**States.**
- Empty library: a dashed box, "Nothing here yet", "Files you upload and everything
  agents make for you are kept here: decks, reports, spreadsheets and notes.", with
  "Upload" and "Ask an agent to make something" (→ the start page). While dragging files
  over the page: "Drop files here to upload them". A search or a filter with nothing in
  it: "No document or file matches."
- The space bar is shown only once the limits have loaded, and only at 1024 px and
  wider.
- Viewer loading: a spinner. Viewer failed: "This file could not be opened here. Download
  it to open it."
- An empty file: "This file has no content to show." (Since 2026-11-15 an empty file is refused when it is uploaded, as "That file is empty"; this state is for a file that reads as empty.)
- Older Office formats: the server's reason, for example "This older Office format
  cannot be read here. Save it as .docx and upload it again." (`.xlsx`, `.pptx` for the
  others), above an empty text area.
- A workbook that cannot be read (too large, too complex, damaged): the request is
  refused with `unreadable_file` and the viewer shows the general failure sentence.

**How it is wired.**
- Screen: `apps/web/src/app/FileViewer.tsx:447` (`FileViewer`), `:57` (`FileChip`), `:97`
  (`PdfView`), `:162` (`DocxView`), `:214` (`Grid`), `:330` (`SheetsView`), `:355`
  (`csvGrid`), `:395` (`HtmlView`), `:408` (`TextBody`), `:428` (`TextFallback`);
  `apps/web/src/app/slides/SlidesView.tsx:375`, `slides/parse.ts`, `slides/chart.ts`,
  `slides/ChartView.tsx`, `slides/worker.ts`; the library in
  `apps/web/src/app/Library.tsx:40` (`MyDocuments`: the top row `:129-195`, the empty
  state `:198-216`, the tiles `:220-277`); the viewer is mounted in
  `apps/web/src/app/Workspace.tsx:481-483`.
- Requests:
  - `GET /api/app/files` → `apps/server/src/files.ts:69`; `Files.list`
    `apps/server/src/files/service.ts:62`.
  - `POST /api/app/files?name=` → `files.ts:72`; `Files.add` `service.ts:72`; inserts
    `files`, writes the bytes, writes `admin_events`.
  - `GET /api/app/files/:id/content` (and `?download`) → `files.ts:90`.
  - `GET /api/app/files/:id/text` → `files.ts:102`; `Files.text` `service.ts:226`.
  - `GET /api/app/files/:id/sheets` → `files.ts:115`; `Files.sheets` `service.ts:234`.
  - `DELETE /api/app/files/:id` → `files.ts:126`; `Files.remove` `service.ts:302`.
  - `GET /api/app/files/limits` → `files.ts:61`. The library calls it for the space bar
    (`Library.tsx:52`).
- Data: `files` (`schema.ts:282`: `name`, `kind`, `mime`, `size`, `sha256`, `source`,
  `conversation_id`, `deleted_at`). On disk: `<files dir>/<org>/<id>` and
  `<files dir>/<org>/derived/<sha256>.text.json` and `.sheets.json`
  (`apps/server/src/files/store.ts`).
- Events: `file.uploaded`, `file.created`, `file.deleted`.
- Tests: `apps/server/src/files.test.ts` "what a file is" (`:22`), "a person's files"
  (`:51`: upload, list, download, delete; never opens a page in place; refuses with a
  reason; belongs to one person; workbook grids; reads once; protected files; deletes
  what was worked out; says what it accepts); `apps/server/src/files/office.test.ts`
  "files that should not be opened" (`:156`); `apps/web/src/app/slides/parse.test.ts`
  "reading XML" (`:77`), "reading a presentation" (`:89`).

**Not built.**
- No folders, tags, or sorting other than newest first. No filter by project or by
  conversation.
- No rename and no moving of a file.
- No sharing a file with a colleague and no public link.
- The person cannot see the size limit of one file or the accepted kinds anywhere in the
  workspace. The space used is shown, on a wide window only.
- No preview of `.doc`, `.xls` or `.ppt`.
- No rendering of Markdown: a `.md` file is shown as raw text.
- No zoom, search, print or page jump in the viewer; no slideshow mode.
- No editing of any file in the viewer.
- No recycle bin: a deleted file is gone.
- No bulk select, bulk delete or bulk download.
- No "which conversation made this" link, though `conversation_id` is stored.
- No versions: a file an agent makes again under the same name replaces the old one.
- No virus scanning.

**Design findings.**
- Answered on 2026-11-14: the library shows the space used beside Upload ("312 MB of 1
  GB", `Library.tsx:108-109`, `:157-171`). What remains: it is hidden below 1024 px, and
  it added up only the newest 500 files the list returned. Since 2026-11-22 the server
  adds up all of the person's own files.
- Answered on 2026-11-14, in part: the library is tiles with a colour per kind and
  filters for "Made by agents", "Uploaded" and "Notes" (`Library.tsx:100-105`,
  `:140-156`). What remains: the page is still called "Documents" in the sidebar, the
  button still says "New document" for a note, and a note's kind still reads "Document".
- A tile is one big button with a second button (download) on top of it that appears
  only under the pointer (`Library.tsx:229-273`). On a touch screen there is no way to
  download without opening the viewer. Smallest fix: show the button always below 768 px.
- The library cannot be sorted or grouped: a deck from last month is found only by
  search. Smallest fix: a "Sort: newest / name / size" control.
- A chip in an old message for a file since deleted opens the viewer and says "This file
  could not be opened here. Download it to open it."; Download then fails too. Smallest
  fix: when the content answers 404, say "This file was deleted" and hide Download.
- For an older Office file the viewer shows a notice and an empty box, and the notice
  suggests "Save it as .docx": the person has to work out that Download is the way.
  Smallest fix: a Download button inside the notice.
- When a workbook cannot be read, the exact reason ("too large or too complex",
  "damaged or protected by a password") is dropped twice: the server answers the general
  `unreadable_file` (`files.ts:121`) and the viewer shows its own general sentence
  (`FileViewer.tsx:334`). Smallest fix: return the reason as the `/text` route does, and
  show it.
- Documents and files are one library under the name "Documents"; the kind line says
  "Document" for a note and "Word document" for a `.docx`, and the upload button says
  "Upload" while the other says "New document". A new user cannot tell what a "document"
  is. The filter is called "Notes" and the thing it filters is called a "Document".
  Smallest fix: name the page "Library" and the plain-text kind "Note" everywhere.
- The delete button is a bare bin next to Download in the header, one slip away.
  Smallest fix: keep the confirmation (it exists) and move the bin behind a "…" menu.
- The list is capped at 500 files with no notice. Smallest fix: say so at the end.
- The viewer cannot be linked to: there is no address for an open file, so the browser's
  Back button leaves the page instead of closing the viewer. Smallest fix: put the file
  id in the hash.
- Enterprise owner: files are stored on the server's disk with no retention rule and no
  administrator view of one person's files beyond totals. Smallest fix: document it;
  later, a retention setting.

---

## Files an agent makes

**Who it is for.** Every member, through an agent that holds the `files.create` tool
(the Assistant, Writer and Researcher do; a personal agent when its builder ticks it).

**The job.** "Make me the deck, the document or the spreadsheet, finished, so I can send
it on."

**Where it starts.** A message that asks for a file, for example "make a deck for my
weekly report". The agent calls `files.create`.

**What they see and can do.**
- A step "Made a file" with the file's name.
- A chip for the file under the reply → opens it in the viewer, where it can be
  downloaded or deleted.
- The file in the right-hand panel marked "saved", and in the library with "Made by an
  agent <when>" on its tile and under the "Made by agents" filter.
- How a file reads is the agent's doing, and since 2026-11-22 it is told how
  (`apps/server/src/files/guide.ts`). Before the first document, presentation or workbook
  of a conversation it reads the guide for that kind with `files.guide` (a step "Read how
  a file is written"; the tool comes with `files.create`, nobody ticks it). A document's
  guide: the conclusion first; headings that tell the story; paragraphs of one point;
  bold only for the few words not to be missed; a table only for figures and cells of a
  few words, five columns at most; no notes on how the work was done and no labels of
  the agent's own working. A presentation's: one message a slide, said in its title;
  the form chosen by what the content is; four bullets of one line at most. A
  workbook's: one table a sheet, the result first, formulas for what is worked out.
- When a document or a deck is made or changed, what the agent wrote is read for what a
  reader would stumble on (`review`, same file), and the agent is told with the file's
  making, to put right with `files.change` before it answers: a table whose cells hold
  sentences, a table of more than six columns, paragraphs over about 120 words, bold at
  the head of more than four paragraphs in ten, four or more working labels (N23, E34);
  slides of more than five bullets, a bullet of several lines, a deck that is bullets
  alone. Nothing is refused for these. They are counted from the text; nothing is
  rendered and looked at. Tried once with the real model, on the nine-page profile that
  prompted it: the agent read the guide, made the file in steps and changed it after
  being told, and the result opened with its conclusion, with short-celled tables and
  no working labels. A workbook is not read this way.
- What can be made, decided by the ending of the name the agent gives:
  - `.pptx`: a designed presentation. Slides can be a cover, a section break, a closing
    slide, bullets (with sub-points), two to four headline numbers, a real chart (bar,
    line, area, pie or doughnut), a table, two to four columns, three to six steps, a
    quote, a takeaway line and speaker notes. A long table is split over several slides.
    One of four colour themes: ink (default), ember, forest, plum. A theme colours the
    cover and closing slide, the charts and the numbers of steps, and nothing else.
    Since 2026-11-22 a slide is flat on a white page (`apps/server/src/files/deck.ts`):
    no cards, tinted panels, bars of colour or drawn shapes. Headline numbers, columns
    and steps stand side by side under a hairline each. A table has no fill: a firm
    line under its header and above a total, hairlines between rows, columns as wide as
    what they hold, and it is not stretched across the slide. The footer is the page
    number alone. Type is one family, a title of 30 points (24 at the smallest), bullets
    of 14 to 22 (chart labels, a table of many columns and the page number are smaller).
    Running text is at most 9.6 inches wide. No text stands on another (the owner, 2026-11-22: "不能出现文字重叠，这是最基本的"):
    every text is measured from the widths of its letters before it is placed
    (`apps/server/src/files/measure.ts`: Helvetica's widths, which Arial matches; a
    Chinese character is a square; the measure errs wide), each thing begins under the
    measured foot of the one above it, type goes down a size where that makes it fit,
    and a slide that holds more than can be set apart is refused with what to do
    (fewer or shorter points, the notes, two slides). A table row is as tall as its
    longest cell needs and a slide takes the rows that fit, so a table splits by height
    and not every eleven rows. A test makes decks of long wrapping text in English and
    Chinese and fails if any two text boxes of a slide intersect or one leaves the slide.
    The measure is of Arial and of a Chinese font's square; a computer that sets the deck
    in another font may wrap a line sooner than measured, and nothing renders the file to
    check.
  - `.docx`: a document from Markdown: a title, sections, paragraphs, bullet and numbered
    lists, tables, quotations, bold and italic; a title block with subtitle and byline;
    page numbers. Since 2026-11-22 (`apps/server/src/files/document.ts`): black
    headings, text of 11 points, an inch of margin, no running header, no rule under the
    title, no tinted or side-barred callout (a `>` line is set in from both sides).
    A table has thin grey lines, a light grey header, a bold total row, and columns as
    wide as what they hold, so a narrow table does not fill the page; when a table is too
    wide, the room is taken from its widest columns first. A document's theme no longer
    changes anything in it.
  - `.xlsx`: a workbook of 1 to 20 sheets, each up to 5,000 rows. The first row is a
    dark header; in a sheet of more than 16 rows it is kept in view and has a filter, in
    a shorter one neither. Rows are not banded (since 2026-11-22). A text longer than its column (held to 60) is wrapped and its row made as tall as its lines. A header stands to
    the right over a column of figures. Numbers of 1,000 and more get separators, and a
    column with decimals shows as many as its most exact figure has, from two to four; a row starting with "Total" or "合计" (and similar) is set
    apart; column widths fit the content. A number the agent gave as text is stored as
    the number it is (not a code with leading zeros); a year keeps its plain form; a
    column whose header says it is a rate or a share and whose values are fractions is
    shown as percentages.
  - A sheet can carry one chart of its own table: bar, line or pie, with a title
    (`sheets[].chart`). It is Excel's own chart, written into the workbook
    (`apps/server/src/files/sheetchart.ts`): it follows the cells and can be restyled
    in Excel. The first column names the points; the number columns are the series, up
    to six, without a total row; a rate beside amounts is left out unless the agent
    names it in `chart.columns`. In the viewer the chart is drawn beside the sheet
    (`SheetsView` in `apps/web/src/app/FileViewer.tsx`). Opened in Microsoft Excel for
    Mac on 2026-11-15: no repair prompt, the chart there with its title, legend and
    colours. Not verified: WPS, Numbers, Excel for Windows.
  - `.html`, `.md`, `.txt`, `.csv`: the text as given. In a CSV, a cell that starts like
    a formula is marked as text.

**Rules.**
- `files.create` is level A1: it writes inside the person's workspace and needs no
  confirmation.
- The file is stored like an upload, counts toward the person's 1 GB and the per-file
  limit, and is tied to the conversation (`files.conversation_id`).
- A file of the same name that an agent made before is replaced. A file the person
  uploaded under that name is not touched; both then exist (`service.ts:96-103`).
- A presentation has 1 to 60 slides (`apps/server/src/files/deck.ts:90`, `:815`). A chart
  needs categories and at least one series of numbers.
- When a file cannot be made the agent is told why in plain words and can try again: a
  name with an ending that cannot be made, missing "text", "sheets" or "slides", too many
  sheets or rows, no space left, too large (`make.ts:115-150`; `service.ts:254-290`).
- Text given for a cell is stored as text and never as a formula.
- Recorded in the activity log: `file.created`, with kind, size and SHA-256, in the name
  of the person whose run it was.

**States.**
- Step running, done, or failed (the agent then says what went wrong in its reply, if it
  chooses to).
- The chip appears once the reply has ended and the file list has refreshed.

**How it is wired.**
- Screen: the chip under a reply, `apps/web/src/app/Chat.tsx:686-690` (`madeBy`) and
  `:795-801`; the panel `:691-702`; the line on the tile
  `apps/web/src/app/Library.tsx:259-261` (the `Chat.tsx` lines here are from before
  `epic/cha-167-local-work`).
- Requests: none from the browser. The tool `files.create`
  (`apps/server/src/runtime/tools.ts:152-285`) calls `Files.make`
  (`apps/server/src/files/service.ts:254`), which calls `makeFile`
  (`apps/server/src/files/make.ts:115`): `makeDeck` (`apps/server/src/files/deck.ts:811`),
  `makeDocument` (`apps/server/src/files/document.ts:59`), `excel` (`make.ts:29`), then
  `Files.add` with `source: "agent"` and `replace: true`.
- Data: `files` (`source = 'agent'`, `conversation_id`), the bytes on disk,
  `messages.steps` (the step that names the file).
- Events: `file.created`; live `step`.
- Tests: `apps/server/src/files/office.test.ts` "making a file and reading it back"
  (`:13`: Word; workbook; designed presentation with a real chart; section breaks and long
  tables; plain formats; CSV formulas; says what is missing); `product.test.ts` "files in
  a conversation" (`:569`), "tells the agent plainly when a file cannot be made" (`:658`).

**Not built.**
- No PDF making. The agent is told the endings it can use: docx, xlsx, pptx, html, md,
  txt, csv.
- No images, logos or pictures in a made deck or document, and no organization template
  or brand colours: the four themes are fixed in the code.
- No formulas, charts, several header rows or cell colours chosen by the agent in a
  workbook.
- No editing of an existing file: the agent can only make a new one, or replace one it
  made under the same name.
- No preview before the file is saved, and no version history after it is replaced.
- No "make this reply into a file" button: the person must ask in words.

**Design findings.**
- The chip under a reply is found by matching the step's file name against the person's
  current files (`Chat.tsx:681-690`). If the agent later replaces the file, both replies
  show the new file; if the person deletes it, the chip silently disappears from the
  reply; if the person uploaded a newer file with the same name, the chip opens that one.
  Smallest fix: store the made file's id on the step and show "deleted" or "replaced"
  when it no longer exists.
- Replacing a file of the same name is silent. A person who asks twice for "report.docx"
  loses the first. Smallest fix: have the tool's answer and the step say "Replaced"; or
  keep both with a number.
- The chip appears only after the reply ends, so during a long run the person sees "Made
  a file" but cannot open it. Smallest fix: refresh the file list on a `files.create`
  step that ends ok.
- Whether the person gets a file or pasted content depends on the model reading the
  agent's instructions. Smallest fix: a starter or a button that makes the request
  explicit ("Make a Word file").
- Enterprise owner: decks carry no company identity. Smallest fix: let an administrator
  choose the default theme; later, a template.
- A person who wants a PDF is told nothing in the UI; the agent may say it cannot.
  Smallest fix: say in the `files.create` summary shown to users "Word, Excel and
  PowerPoint (not PDF)".

---

## Documents (notes agents read and write)

**Who it is for.** Every member, for their own documents.

**The job.** "Keep notes and drafts that my agents can read and update, and that I can
edit myself."

**Where it starts.**
- `#/documents` ("Documents" in the sidebar).
- `#/documents/<title>` opens that document in the editor: from "Recent documents" on the
  start page, or from the right-hand panel of a conversation.
- An agent saving something with the `docs.write` tool.

**What they see and can do.**
- The library: notes and files together as tiles, newest change first (see
  [Files](#files-upload-list-view-download-delete)). A document's tile shows a notebook
  on amber, its title, "Document", its length in characters, and when it was last
  changed. The "Notes" filter shows documents only; "Search your library" narrows by
  title.
- "New document" → the editor, empty.
- Click a document with words in it → it opens to be read: its content rendered as
  Markdown (headings, paragraphs, lists, tables, quotations, rules, code blocks with a
  copy button, **bold**, *italic*, `code`, web and mail links), under "Changed <when> ·
  <n> characters". Nothing is taken as HTML; plain text keeps its lines and indentation,
  and a line of only `=` or `-` is drawn as a rule (`markdown.tsx`). "Close" and "Edit".
  - "Edit" → the editor: a title field (120 characters), a content area (16 rows,
    fixed-width face) under a hint that Markdown works, "Delete", "Cancel", "Save".
    "Cancel" goes back to reading, with what was typed dropped.
- A new or empty document opens straight in the editor, where "Cancel" closes it.
  - Save → the document is created or updated and the dialog closes.
  - Delete → a dialog "Delete “<title>”? This cannot be undone." → on confirm the
    document is removed.
  - When an agent has replaced what the document held, a notice at the top of the
    editor: "An agent replaced what this document held; the earlier version is from
    <when>.", with "Bring back the earlier version". Press it → the earlier content
    becomes the document, what the agent wrote is kept in its place, and the dialog
    closes. Pressing it again on the reopened document swaps them back. The button is
    disabled while the title or the text in the editor differs from what was loaded, so
    bringing back never throws away unsaved typing (`DocumentEditor`,
    `apps/web/src/app/Pages.tsx:242`).
- Agents with the tools: `docs.list` lists titles and sizes; `docs.read` reads one by its
  exact title; `docs.write` creates one, or replaces the whole content of the one with
  that title, keeping what it held before.
  `docs.write` asks for Markdown (headings rather than lines of `=`, code and SQL in
  fences with the language named), since that is how the person reads it.

**Rules.**
- A document belongs to one person. Titles are unique per person: creating or renaming to
  a title in use is refused with `document_exists`, "You already have a document with
  this title."
- A title is 1 to 120 characters; content is at most 200,000 characters
  (`product.ts:391-394`; the same limits in the tool, `tools.ts:94-97`). A request that
  breaks either is refused with `invalid_document`, "A document needs a title of 1 to 120
  characters."
- `docs.list` and `docs.read` are level A0; `docs.write` is A1. None needs confirmation.
- An agent reads at most the first 60,000 characters of a document and is told when there
  is more (`tools.ts:31`, `:78-80`). `docs.list` returns at most 200 titles.
- `docs.write` replaces the whole content. There is no append and no merge.
- When `docs.write` replaces a document, what the document held and when that was last
  changed are kept on the same row (`previous_content`, `previous_at`), and the agent is
  told "The person can bring back what it held before." (`tools.ts:98-107`). One earlier
  version is kept, the latest: a second replacement by an agent keeps the first agent's
  text and drops what the person wrote before that.
- Bringing back is a swap, so it can itself be undone: `content` and `previous_content`
  change places (`product.ts:447-459`). A document no agent has replaced has nothing to
  bring back: `not_found`.
- The person's own Save in the editor drops the earlier version: the document is then
  theirs as saved, there is nothing left to bring back, and the notice is gone
  (`product.ts:439`). So the earlier version can be brought back only until the person
  next saves the document themselves.
- Documents are plain text. Nothing is rendered.
- Not recorded in the activity log: creating, editing, deleting or bringing back a
  document, by the person or by an agent. An agent's call is in the trace, with the title
  as the step detail.
- Deleting is a real delete: the row is removed.

**States.**
- Empty: the library's empty state, "Nothing here yet".
- Loading: a spinner. Load failed: a red notice.
- Save, delete or bringing back failed: a red notice inside the editor; the dialog stays
  open.
- A document an agent has replaced, until the person saves it themselves: the notice
  with "Bring back the earlier version" in the editor; the button is disabled while
  there is unsaved text. The list shows no mark for it.
- An address naming a title that does not exist: the list is shown and nothing opens.

**How it is wired.**
- Screen: `apps/web/src/app/Library.tsx:40` (`MyDocuments`),
  `apps/web/src/app/Pages.tsx:242` (`DocumentEditor`); recent documents on the start page
  `apps/web/src/app/Chat.tsx:564-585`.
- Requests:
  - `GET /api/app/documents` → `apps/server/src/product.ts:507`; titles, sizes, dates.
  - `GET /api/app/documents/:id` → `product.ts:515`; also returns `previousAt`, which is
    null until an agent has replaced the document.
  - `POST /api/app/documents` `{title, content}` → `product.ts:528`.
  - `PUT /api/app/documents/:id` `{title, content}` → `product.ts:538`.
  - `POST /api/app/documents/:id/restore` → `product.ts:559`; swaps `content` with
    `previous_content`.
  - `DELETE /api/app/documents/:id` → `product.ts:572`.
- Tools: `docs.list`, `docs.read`, `docs.write` → `apps/server/src/runtime/tools.ts:121-181`.
- Data: `documents` (`schema.ts:238`: `title`, `content`, `updated_at`, unique
  `(user_id, title)`; `previous_content`, `previous_at` `:306-307`, migration 6).
- Events: none in the activity log; live `step` events and trace spans for tool calls.
- Tests: `product.test.ts` "documents" (`:1928`: "are created, renamed, edited and deleted
  by their owner"), "tools" (`:334`: an agent saves and reads documents; `:431`: one
  person's documents stay out of another's runs), "keeps what a document held before an
  agent replaced it, and gives it back" (`:1814`).

**Not built.**
- No formatting, no Markdown preview, no headings or lists drawn as such.
- No version history beyond the one earlier version kept when an agent replaces a
  document. The person's own saves keep nothing, and the earlier version cannot be read
  or compared before it is brought back.
- No sign of who last changed a document (the person or which agent).
- No autosave and no warning when closing the editor with unsaved changes.
- No sharing, no organization-wide or team documents.
- No folders or tags.
- No export or download of a document as a file, and no "turn into Word".
- No search inside documents.
- No address for the editor of a new document, and the address of an open document is by
  title, not by id.

**Design findings.**
- Answered on 2026-11-14: when an agent replaces a document, what it held before is kept
  (`previous_content`, `previous_at`) and the editor offers "Bring back the earlier
  version" (`tools.ts:98-107`, `product.ts:448`, `Pages.tsx:186-201`). What remains: only
  one earlier version is kept, so two replacements in a row lose the person's own text;
  the person's next Save drops it; the person learns of the replacement only on opening
  the document; and nothing is written to the activity log.
- The activity log records uploads and deletes of files but not of documents, so the
  enterprise's record is uneven. Smallest fix: write `document.saved` and
  `document.deleted` events, naming the agent when a tool did it.
- Content over 200,000 characters is refused with "A document needs a title of 1 to 120
  characters.", which is the wrong reason. Smallest fix: a second code or a message that
  names both limits; a character counter in the editor.
- Closing the editor (Escape, clicking outside, Cancel) discards changes without asking.
  Smallest fix: confirm when the text differs from what was loaded.
- The editor is a 16-row fixed-width text box in a dialog. For "the person's notes" this
  reads as a developer tool. Smallest fix: a proportional face and a taller area; later,
  Markdown preview.
- The title of the dialog for an existing document is the document's title and the field
  under it is also the title. Smallest fix: title the dialog "Edit document".
- Opening by title in the address fails silently when the title has changed. Smallest
  fix: show "That document no longer exists."
- "Document" means a plain-text note here, a Word file in the kind column, and both
  notes and files in the page name. See the finding under Files.

---

## Agents page and building a personal agent

**Who it is for.** Every member. Building an agent needs no permission. An agent that can
act outside the organization needs an administrator's approval (`agents.manage`) before
it runs.

**The job.** "See who I can talk to and what each is for, and set up my own agent for a
job I repeat."

**Where it starts.** `#/agents`: "Agents" in the sidebar, or "All agents" on the start
page.

**What they see and can do.**
- A top row: a "Search agents" box (matches the name and the description); three buttons
  with counts, "All", "Built by you", "From your organization"; and "Build an agent".
- A grid of tiles, one per agent: the organization's published agents and the person's
  own in any state. Every organization starts with four: Assistant, Writer, Researcher,
  Messenger. A tile shows:
  - a face: a coloured tile with the sign of what the agent does, read from its name and
    then its description (a magnifier for a researcher, a pen for a writer, a paper
    plane for a messenger, a calculator for budgets, and so on, in English and Chinese);
    an agent whose words say nothing of the kind gets a robot on a colour worked out
    from its name, so it keeps its colour (`apps/web/src/app/AgentAvatar.tsx`). The same
    face is in the "@" list and the Marketplace, where skills, knowledge bases and
    connectors each have a tile of their own colour;
  - the name and "Built by you" or "From your organization";
  - the description, two lines at most, or "No description.";
  - what it can do, as chips: "Your documents", "Reads your files", "Makes files",
    "Reads the web", "Your Microsoft 365", and in amber "Sends outside, asks first"; or
    "Answers in the conversation only" when it has no tools;
  - no button: the whole tile opens the agent's details (since 2026-11-15; the owner on
    the tile's "Start a conversation" button: "超大开启对话，很傻逼的，不用"). An agent is
    called with "@" where the person is writing;
  - a badge when it is waiting ("Waiting for an administrator's approval.") or suspended
    ("Suspended by an administrator.");
  - "Details", and the top of the tile itself → the agent's sheet.
- After the agents, a dashed tile: "Build your first agent" (or "Build an agent" once
  the person has one) with "For work you repeat: a weekly report, meeting minutes, a
  reply in your team's voice." → the editor. It is not shown under "From your
  organization" or while searching.
- The sheet (slides in from the right): the mark, name and who built it; the
  description; the state badge; "What it can do", one sentence per ability ("Reads the
  files you upload: Word, Excel, PowerPoint, PDF, pages, text"; "Reads your Outlook mail
  and calendar, OneDrive and SharePoint files and Teams chats, once you connect
  Microsoft 365 in Settings"), with "It asks you before anything leaves the
  organization." for an agent that can send; "How it was briefed": the agent's whole
  instructions, for the organization's agents too; "Call in a new conversation" (an
  outline button with an @: the start page opens with that agent called); and on the
  person's own agents "Edit agent" and "Delete" (a dialog "Delete “<name>”? Its
  conversations go with it.").
- "Build an agent" or "Edit agent" → the editor, a dialog:
  - Name (60 characters), "What it is for (shown when choosing an agent)" (200
    characters in the field), Instructions (a 7-row text area with the hint "Tell the
    agent how to do the job, the way you would brief a colleague.").
  - "What it may use": a checkbox per tool, each a sentence ("Read your documents",
    "Search and read your Outlook mail, once you connect Microsoft 365"); the tool's own
    name shows on hover. Twelve tools.
  - A line that changes with the ticks: "You can use it as soon as you save it." or,
    once "send to an outside address" is ticked, "It can send data outside the
    organization, so an administrator must approve it before you can use it."
  - "Create agent" or "Save" → the dialog closes and the list reloads.

**Rules.**
- A person sees the organization's published agents and their own agents in any state.
  They never see another person's own agent (`product.ts:261-275`).
- Risk follows from the furthest-reaching tool: only A0 tools → R1 "Read-only"; any A1 →
  R2 "Writes internally"; any A2 or A3 → R3 "Acts externally"; A4 → R4
  (`apps/server/src/runtime/catalog.ts:99-105`). The page no longer shows the risk or
  the levels to a member; it shows only whether an administrator's approval is needed.
- The tools and their levels (`catalog.ts:11-42`): `docs.list` A0, `docs.read` A0,
  `docs.write` A1, `files.list` A0, `files.read` A0, `files.create` A1, `web.fetch` A0,
  `web.send` A3, and the four that read the person's Microsoft 365, all A0: `m365.mail`,
  `m365.calendar`, `m365.files`, `m365.chats`. An agent with only Microsoft tools is R1
  "Read-only" and is usable as soon as it is saved.
- The four tools that work in folders on the person's computer (`local.*`) are not in
  the list and cannot be ticked. An agent gets them from the tools it already has; see
  [Folders on your computer](#folders-on-your-computer).
- A Microsoft tool does nothing until the person who is talking to the agent has
  connected their own account; until then the agent is told to send them to Settings.
  See [Connections](#connections-microsoft-365).
- What an agent can do is shown as six abilities, each standing for one or more tools
  (`apps/web/src/app/AgentsPage.tsx:44-56`): "Your documents" (`docs.*`), "Reads your
  files" (`files.list`, `files.read`), "Makes files" (`files.create`), "Reads the web"
  (`web.fetch`), "Your Microsoft 365" (any `m365.*`), "Sends outside, asks first"
  (`web.send`). An agent with none of them: "Answers in the conversation only".
- R1 and R2 agents are published as soon as they are saved. R3 and R4 agents are
  "pending" until an administrator approves them (`product.ts:277-315`). Today that means
  any agent with `web.send`.
- Approval is of one exact version (model, instructions, tools). Changing the
  instructions or tools of an approved R3 agent sends it back to pending. Changing only
  the name or description does not (`product.ts:317-363`).
- A suspended agent cannot be changed by its builder, not even its name: Save is refused
  with `agent_suspended`, "This agent is suspended. An administrator must restore it
  before it can be changed." (`product.ts:317-363`, `apps/server/src/errors.ts:23-26`).
  So what an administrator restores is what was suspended. The builder can still delete
  it.
- Name 1 to 60 characters; description up to 300; instructions 1 to 8,000; up to 20
  tools, all known ones. Otherwise `invalid_agent`, "An agent needs a name and
  instructions." (`product.ts:121-126`).
- A person cannot have two agents with the same name (case ignored): `agent_name_taken`,
  "You already have an agent with this name."
- Only the builder can change or delete their agent; platform agents cannot be changed
  from here (`not_found` otherwise).
- Deleting keeps the row (marked deleted and suspended), archives every conversation with
  the agent, and stops anything it is doing, including a waiting confirmation
  (`product.ts:365-392`).
- Every agent runs on the one model the server is configured with.
- Recorded in the activity log: `agent.created`, `agent.changed`, `agent.deleted`, each
  with the risk and tools. Administrators' decisions are `agent.approved`,
  `agent.suspended`, `agent.restored`. A change of the server's model, which gives every
  agent a new version, is recorded once as `agents.model_changed` (`product.ts:87-95`).

**States.**
- Loading: a spinner. Load failed: a red notice.
- The person has built none: the dashed tile reads "Build your first agent".
- A search with no match: "No agent matches. Try other words."
- Agent states: `published`, `pending` ("Waiting for an administrator's approval."),
  `suspended` ("Suspended by an administrator."). The last two disable "Start a
  conversation".
- Save or delete failed: the reason in red, in the editor or above the grid.
- A suspended agent's sheet still has "Edit agent"; the editor opens, and Save answers
  "This agent is suspended. An administrator must restore it before it can be changed."

**How it is wired.**
- Screen: `apps/web/src/app/AgentsPage.tsx:340` (`MyAgents`), `:126` (`AgentTile`),
  `:165` (`AgentSheet`), `:232` (`AgentEditor`), `:84` (`Abilities`, also used by the
  conversation's panel), `:67` (`Mark`).
- Requests:
  - `GET /api/app/agents` → `apps/server/src/product.ts:261`; also creates or refreshes
    the starting agents (`ensurePlatformAgents`, `product.ts:28`).
  - `GET /api/app/tools` → `product.ts:154`; the catalogue with levels.
  - `POST /api/app/agents` → `product.ts:277`.
  - `PATCH /api/app/agents/:id` → `product.ts:317`; refuses a suspended agent with
    `agent_suspended`.
  - `DELETE /api/app/agents/:id` → `product.ts:365`; then `Runs.stopAgent`
    (`apps/server/src/runtime/runs.ts:243`).
  - An administrator's decision: `PATCH /api/agents/:id` → `product.ts:395` (admin
    console).
- Data: `agents` (`schema.ts:113`; `instructions`, `tools` `:194-195`; `deleted_at`
  `:271`; unique platform names `:278`): `source`, `owner_user_id`, `risk`, `state`,
  `version`, `model`. `conversations.archived_at`.
- Events: `agent.created`, `agent.changed`, `agent.deleted`.
- Tests: `product.test.ts` "agents people build" (`:1415`: starting agents; a low-risk
  agent usable at once and unseen by others; held until approved; sent back when a change
  raises its risk; suspended stops for everyone; "does not let a suspended agent be
  changed: what is restored is what was suspended" `:1576`; rejects unknown tools and no
  instructions; only the builder may change or delete), "a deleted agent" (`:1605`). No
  test covers the page.

**Not built.**
- No sharing a personal agent with a team or publishing it to the organization.
- No copying an agent ("start from the Writer").
- No test run before saving, and no example conversation.
- No knowledge attached to an agent (fixed documents or files it always has).
- No choice of model, temperature or reply length per agent.
- No tools beyond the twelve in the catalogue. The only connection to a company system
  is reading the person's Microsoft 365; nothing sends mail, books a meeting or posts a
  message, and there is no connector to Feishu, WeCom, Slack, Google Workspace or a
  company's own systems.
- No choice, per agent, of which connected account or which folders it may use: the
  tools decide, for every person who talks to it.
- No schedule or trigger: an agent runs only when a person sends a message.
- No message to the person when an administrator approves or suspends their agent, and no
  way to ask an administrator or see who they are.
- No icon chosen by the builder: the face is worked out from the agent's name and
  description.
- No sorting, and no "recently used".

**Design findings.**
- Answered on 2026-11-14: the page shows what each agent is for: a tile with a mark, who
  built it and what it can do in plain abilities, a sheet with the whole brief, search
  and three filters (`AgentsPage.tsx:126-230`, `:340-458`). Tool names, level badges and
  risk codes are gone from what a member sees; the editor says only whether an
  administrator must approve.
- "Your Microsoft 365" is on the Assistant's tile whether or not the person has
  connected anything, and the tile does not say which. A person presses "Start a
  conversation", asks about their mail, and is told to go to Settings. Smallest fix:
  load the person's connections here and show "Connect to use" on that chip.
- The six abilities hide a difference a careful person wants: "Your documents" covers
  reading and replacing them, and an agent that can work in folders on the computer
  shows nothing about it, since those tools are not in its list. Smallest fix: "Reads
  and writes your documents", and a seventh chip "Works in your folders (desktop app)"
  for agents whose tools reach there.
- The sheet shows every organization agent's whole instructions to every member
  (`AgentsPage.tsx:202-207`). For the starting agents that is harmless. The head of the
  enterprise will not expect a carefully written brief to be readable by all once the
  organization can publish its own. Smallest fix: show "How it was briefed" only for the
  person's own agents; for the others, the description.
- In the editor the Microsoft tools are four ticks with "once you connect Microsoft 365"
  repeated four times, and the builder is not told that each person who uses the agent
  reads their own account, not the builder's. Smallest fix: group them under one
  heading with that sentence.
- The mark's colour comes from the letters of the name, so "Writer" and a person's
  "Weekly writer" can share a letter and a colour. Smallest fix: let the builder pick
  one of the six.
- After saving an agent that can send outside, the dialog simply closes; the tile then
  shows "Waiting for an administrator's approval." with no next step, no name to contact
  and no time estimate. Smallest fix: on save, say "Sent for approval", and list
  administrators or a contact line.
- Editing an approved agent's instructions sends it back to pending without warning
  before Save; conversations with it then stop working. Smallest fix: when the change
  would need approval again, say so above the Save button.
- Deleting an agent says "Its conversations go with it." There is no count and no undo.
  Smallest fix: "Delete “X” and its 12 conversations?".
- The description field allows 200 characters in the page and 300 on the server; the
  instructions field has no counter though it is refused over 8,000 with "An agent needs
  a name and instructions.", which is the wrong reason. Smallest fix: `maxLength` and a
  counter on both; a clearer message.
- The four provided agents have no "what to ask it" examples, and "Messenger" (send to a
  webhook) is a developer's idea of a starting agent. Smallest fix: one example prompt
  per tile.
- Enterprise owner: a member can build any number of agents that read their files, the
  web and their Microsoft 365 without anyone reviewing the instructions. That is the
  design (R1 and R2), but nothing on this page says administrators can see every
  personal agent. Smallest fix: a line under the top row.
- Translations still hold the old page's words ("Provided by your organization", "You
  have not built any agents.", the risk notes), which nothing shows any more. Smallest
  fix: remove them.

---

## Connections (Microsoft 365)

**Who it is for.** Every member, for their own Microsoft 365 account. No permission. An
operator must first have registered Muster with Microsoft and set a key on the server;
see [clients-and-operations: Server settings](clients-and-operations.md#server-settings).

**The job.** "Let my agents read my mail, calendar, files and chats, so I can ask about
them here, and let me take that back."

**Where it starts.**
- Settings → Connections (the account menu → Settings, or `⌘,` / `Ctrl+,`).
- The + menu in the message box: the Microsoft 365 row, or "Manage connections".
- An agent that was asked about mail by a person who is not connected says: "Microsoft
  365 is not connected for this person. Tell them to connect it in Settings, under
  Connections, and then ask again."

**What they see and can do.**
- Settings → Connections: one line, "Services you let your agents read for you. Each is
  connected by you, on that service's own page, and only your agents working for you can
  use it.", then one card, Microsoft 365:
  - not connected: "Outlook mail and calendar, OneDrive and SharePoint files, Teams
    chats." and "Connect";
  - connected: "Connected as <address>, 3 hours ago." and "Disconnect";
  - not set up on this server: "Not set up on this server yet. An operator has to
    register Muster with the service first.", and "Connect" is disabled;
  - always: the four things agents can then do ("Search and read your Outlook mail",
    "Read your calendar", "Find and read files in OneDrive and SharePoint", "Read your
    Teams chats") and "Reading only: agents cannot send mail, post messages, change your
    calendar or edit files there."
- "Connect" → Microsoft's own page opens in a new tab (in the desktop app, in the
  system's browser), asking which account and then for consent to the reading
  permissions. Muster's page stays where it was.
- After consent the tab shows a page from the Muster server: the Muster mark and the
  Microsoft mark joined by a green tick, "Microsoft 365 is connected", "Connected as
  <address>", "Agents working for you can now" with the same four lines, "Reading only.
  They cannot send mail, post messages, or change your calendar or files. You can
  disconnect at any time in Settings, under Connections.", a "Back to Muster" button and
  "You can close this tab." The page is in Chinese when the browser asks for Chinese
  first, else in English, and follows the system's light or dark look.
- When it did not work the same page has a red cross and one of:
  - "You did not give consent, so nothing was connected."
  - "The answer from Microsoft was not complete. Try connecting again from Muster."
  - "This link is no longer good" — "It was already used or is more than ten minutes
    old. Start again from Muster."
  - "<address> gave consent, but that is not the account Muster knows you by, so nothing
    was connected. Open the link in the browser where you are signed in to Muster, or
    choose your own work account at Microsoft."
  - "Microsoft did not accept the request. An operator may need to check how Muster is
    registered there."
- Back in Muster, Settings → Connections reads the list again when the window gets the
  focus, so the card turns to "Connected as …" by itself.
- "Disconnect" → a dialog "Disconnect <address>? Your agents will no longer be able to
  read it. You can connect it again at any time." → on confirm Muster forgets the
  account's tokens.
- In a conversation, an agent that holds the Microsoft tools (of the starting agents,
  only the Assistant) can then:
  - "Look in Outlook mail": the latest 15 messages, or the 15 that best match some
    words; or one message in full (sender, recipients, date and the body as text, up to
    40,000 characters);
  - "Look at the calendar": what is on between two days (today and the six after when it
    names none), 60 entries at most, each with time, title, place, organizer and up to
    12 of those invited;
  - "Look in OneDrive and SharePoint": the 15 files used lately, or the 15 that match
    some words; or the text of one file (Word, Excel, PowerPoint, PDF and text files, 20
    MB at most);
  - "Look in Teams chats": the 20 most recent chats with the last message of each; or
    the latest 30 messages of one.
  Each is a step in the reply. None asks first.

**Rules.**
- Agents only read. Since 2026-11-15 Muster also asks for `Mail.Send` and `ChatMessage.Send`, used only when a person presses Send on a draft (see `drafts.md`); the wording on this page now says so. Muster asks Microsoft for `offline_access`, `User.Read`, `Mail.Read`,
  `Calendars.Read`, `Files.Read.All`, `Sites.Read.All` and `Chat.Read`, and nothing that
  can send or change (`apps/server/src/connections.ts:20-28`). No tool sends mail, makes
  or changes a calendar entry, uploads or edits a file, or posts a message.
- A connection is one person's. Only runs started by that person use it; another
  person's agent, even the same agent, has none (`connections.ts:239-265`,
  `apps/server/src/runtime/tools.ts:57-60`).
- One Microsoft account per person. Connecting again replaces it
  (`apps/server/src/schema.ts:345`, `connections.ts:211-227`).
- It is offered only when the server is registered with one Microsoft directory (the
  same registration that sign-in with Microsoft uses) and has a key to seal tokens with
  (`MUSTER_SECRET_KEY`); otherwise `POST …/start` answers `connector_unavailable`, "This
  service is not set up on this server. An operator has to register Muster with it
  first." (`connections.ts:67-72`, `apps/server/src/connectors.ts:130-133`).
- Accounts of that one directory only: the consent page is the directory's own
  (`connections.ts:122-136`).
- Starting a connection makes a state that is tied to the person, works once and lives
  ten minutes; only its hash is stored. The exchange uses PKCE (`connections.ts:111-137`,
  `:172-182`).
- The address Microsoft sends the person back to needs no Muster session, because the
  desktop app opens the system's browser, which may hold none
  (`apps/server/src/app.ts:76`, `:281-287`). So the consent counts only when one of these
  is true (`connections.ts:196-209`):
  - the browser it arrives in is signed in to Muster as the person who began; or
  - the Microsoft account's mail address or sign-in name equals that person's email in
    Muster (case ignored).
  Otherwise nothing is connected and the page says so. A link handed to a colleague
  therefore cannot attach the colleague's mailbox to the person who began.
- Tokens are stored sealed (AES-256-GCM with a key made from `MUSTER_SECRET_KEY`), so the
  database alone does not open anyone's mailbox (`connections.ts:77-92`). A row that the
  server's key no longer opens is deleted and the person is "not connected" again
  (`connections.ts:256-260`).
- The access token is renewed when it has less than two minutes left. Two runs that need
  it at once renew once. When Microsoft says the consent is gone (`invalid_grant`,
  `interaction_required`, `consent_required`) the connection is deleted; when Microsoft
  merely did not answer, it is kept and the agent is told "Microsoft 365 could not be
  reached just now. Try again shortly." (`connections.ts:47`, `:239-285`).
- Disconnecting deletes Muster's tokens. It does not tell Microsoft: the consent stays
  listed in the person's Microsoft account until they remove it there
  (`connections.ts:230-236`).
- The four tools are level A0: the gateway lets them through without asking, in every
  mode (`apps/server/src/runtime/catalog.ts:34-41`).
- What comes back from Microsoft is treated as material, like a web page: the agent is
  told it is never an instruction (`tools.ts:633`).
- An id the agent passes back (a message, a file, a chat) must look like an id; "." and
  ".." and anything with a slash are refused: "That is not an id from an earlier
  result." (`tools.ts:49-53`).
- A file is read only if the server can read its kind, and only up to 20 MB: the size
  Microsoft states is checked first, and the download stops at the limit
  (`tools.ts:274-292`, `connections.ts:309-333`).
- When Microsoft refuses: 403 → "Microsoft 365 did not allow that. The organization may
  not have granted Muster that permission."; 404 → "Microsoft 365 has nothing at that
  id."; anything else → "Microsoft 365 answered <status>" with Microsoft's own words
  (`connections.ts:287-303`).
- Recorded in the activity log: `connector.connected` and `connector.disconnected`, by
  the person (their Muster email), with the Microsoft account as the label. Each read is
  not in the activity log. It is in the trace of the run, like any tool call, with the
  first 4,000 characters of what was asked and of what came back (so the beginning of a
  mail an agent read is in the record that administrators and auditors can open).
- What an agent reads goes to the model for that answer. It is not saved to the person's
  files or documents unless an agent, or the person, saves it there.

**States.**
- Loading: a spinner. The list failed to load: a red notice.
- Not set up on this server: the card with "Connect" disabled; in the + menu the row is
  greyed out with "Not set up on this server".
- Connecting failed before Microsoft's page (the server refused): a red notice in
  Settings; in the + menu, "Something went wrong" under the row. The tab that was opened
  for it is closed again (`apps/web/src/app/PlusMenu.tsx:35-55`).
- The browser did not allow a new tab: the consent page opens in the same tab, and
  "Back to Muster" brings the person back (`PlusMenu.tsx:47`).
- Since 2026-11-17 (CHA-253) a mail an agent writes is always a card, also when it does
  not know who it goes to: the recipients are empty and the person fills them in. Before,
  the Assistant wrote such a mail as a code block, which could not be sent
  (`packages/ui-schema/src/index.ts`, the MailDraft description and the rule about mail).
  When the person's connection cannot send yet, the card has a button: "Connect Microsoft
  365" when they are not connected, "Allow sending" when they connected before sending was
  possible. It opens Microsoft's consent page; the card looks again when the person comes
  back to the window, and Send is then live (`apps/web/src/app/drafts.tsx`). When the
  organization has not switched sending on, the card says where an administrator does.
  Seen on this machine: the card with empty recipients and the "Connect Microsoft 365"
  button. Not seen: "Allow sending" followed by a real send.
- Since the same day a reply's parts are never wider than the conversation: a code block
  with a long line scrolls inside itself (`apps/web/src/app/reply.tsx`, `Stack`). Before,
  it widened the whole conversation, which then scrolled sideways.
  A block of plain words (its language is `text`, `plain`, `plaintext`, `txt`,
  `markdown` or `md`) wraps instead, so a letter in a block is all on screen; real code,
  and a block that names no language, scrolls sideways (CHA-255, `prose` in `reply.tsx`).
  The model is asked to name the language and to use `text` for words.
- The page after Microsoft's consent ("Microsoft 365 is connected", or why it was not)
  is written by the server and runs no script. Since 2026-11-17 (CHA-251) it has the
  sign-in page's card, sizes and colours, and it tells a proxy in front not to rewrite
  the address it shows: behind Cloudflare the account used to read "[email protected]"
  in a white pill (`apps/server/src/connectors.ts`, `keepAddresses` and `page`). The
  "Sign in to the Muster app?" page is kept the same way (`apps/server/src/auth/app-routes.ts`).
  Seen rendered on this machine; not yet seen through Cloudflare on the live site.
- Consent taken back at Microsoft, or run out: the next read deletes the connection and
  the agent says it is not connected; the card shows "Connect" again.
- The person is connected but the organization did not allow one of the permissions: the
  agent gets the 403 sentence for that tool; the card still says connected.

**How it is wired.**
- Screen: `apps/web/src/app/Settings.tsx:340` (`Connections`);
  `apps/web/src/app/PlusMenu.tsx:59` (`PlusMenu`), `:35` (`connectMicrosoft`), `:23`
  (`MicrosoftMark`); the page after consent is made by the server,
  `apps/server/src/connectors.ts:70` (`page`), its words `:11-57`.
- Requests:
  - `GET /api/app/connectors` → `apps/server/src/connectors.ts:126`; `Connections.list`
    `apps/server/src/connections.ts:94`; `[{id: "microsoft", available, connected}]`.
  - `POST /api/app/connectors/microsoft/start` → `connectors.ts:130`;
    `Connections.start` `connections.ts:111`; writes `connection_attempts`; answers
    `{url}`.
  - `GET /api/app/connectors/microsoft/callback?state=&code=` → `connectors.ts:136`;
    `Connections.finish` `connections.ts:172`; no session needed; writes `connections`
    and `admin_events`; answers a page (200, or 400 when nothing was connected) that
    loads nothing and runs nothing.
  - `DELETE /api/app/connectors/microsoft` → `connectors.ts:178`; `Connections.remove`
    `connections.ts:230`.
- Tools: `m365.mail`, `m365.calendar`, `m365.files`, `m365.chats`
  (`apps/server/src/runtime/tools.ts:203-345`); they call `Connections.graph`
  (`connections.ts:305`) and `Connections.download` (`:309`), which ask
  `https://graph.microsoft.com/v1.0` as the person.
- Data: `connections` (`schema.ts:334`, migration 9: `user_id`, `provider`, `account`,
  `scopes`, `access_token` and `refresh_token` sealed, `expires_at`; unique
  `(user_id, provider)`), `connection_attempts` (`:348`: `state` as its hash,
  `code_verifier`, `expires_at`). The key is `MUSTER_SECRET_KEY`
  (`apps/server/src/config.ts:275-284`).
- Events: `connector.connected`, `connector.disconnected`; trace spans for each read.
- Tests: `apps/server/src/product.test.ts` "a person's Microsoft 365" (`:1113`): "is
  connected by the person's own consent, read by their agent, and taken back" (nothing
  that can send is asked for; a made-up state is refused; a link handed to someone else
  connects nothing; it works once; the tokens are not stored as they are; the agent's
  search reaches Microsoft with the person's token; another person has no connection;
  after disconnecting the agent is told so; both events are recorded), "renews a token
  that has run out, and is not offered where the server is not registered". Both run
  against a stand-in for Microsoft that answers sign-in and mail only.
- What was run for real: on 2026-11-14 the owner connected a real Microsoft account and
  an agent read real mail through it. Not verified: the calendar, files and Teams chats
  tools have not been run against Microsoft, and no test calls them, against the
  stand-in or otherwise. Not verified: reading a file that lives in a SharePoint site.
  The three file requests all go to the person's own drive (`/me/drive/…`,
  `tools.ts:279-300`), so a file listed under "used lately" that lives elsewhere may
  answer "Microsoft 365 has nothing at that id."

**Not built.**
- No sending, replying, drafting, booking, uploading, editing or posting: the connector
  is read-only.
- No other service: no Feishu, WeCom, DingTalk, Slack, Google Workspace, and no
  connection to a company's own systems.
- No choice of what to share: all four kinds are asked for together, and the person
  cannot connect mail without chats.
- No choice per agent or per conversation: once connected, every agent that holds a
  Microsoft tool may use it in every conversation, without asking.
- No list of what agents read through the connection, for the person.
- No view for an administrator of who has connected what, no way to disconnect someone,
  and no way to turn connections off for the organization short of removing the key.
- No mail attachments, no shared mailboxes, no other people's calendars, no Teams
  channels (chats only), no meeting transcripts.
- No paging: 15 mails, 15 files, 20 chats, 30 messages, 60 calendar entries, and no way
  for the agent to ask for the next ones.
- No revoking at Microsoft when the person disconnects.
- No connecting from iOS.
- Suspending or removing a person does not delete their connection's tokens (the rows go
  only when the user row is deleted). Their runs are ended and cannot start, so the
  tokens are not used; they stay sealed in the database.

**Design findings.**
- The connector is read-only. The first thing a person asks after "what does Lei want?"
  is "reply to her", and the agent cannot. Smallest fix: a draft, not a send:
  `Mail.ReadWrite` to save a draft in Outlook, which the person sends themselves.
- Reading mail never asks, in any mode, and the Assistant holds the tool for everyone
  from the first day. A person who connects for one question has given every later
  conversation with the Assistant their mailbox. Smallest fix: ask once per conversation
  before the first Microsoft read ("Let the Assistant read your mail in this
  conversation?").
- With "Full access" on, an agent that read a mail can put it in an address and open it.
  The two features were built the same week and neither page mentions the other.
  Smallest fix: refuse "Full access" in a conversation whose agent holds a Microsoft
  tool, or ask before the first unnamed address after a Microsoft read.
- An administrator cannot see who connected what, and cannot stop it. The activity log
  has the two events, but there is no list, and the security auditor has to search for
  `connector.connected` and subtract `connector.disconnected`. Smallest fix: a table
  under Sign-in & sessions, "Connected services", with person, account, since, and
  "Disconnect".
- The beginning of every mail, file and chat an agent reads is kept in the trace, which
  administrators and auditors may open (recorded as `trace.viewed`). The Connections
  page says "only your agents working for you can use it" and nothing about who can
  read the record. Smallest fix: one sentence on the card; or keep only the subject and
  sender in the trace for Microsoft reads.
- Disconnecting leaves Muster listed under the person's Microsoft account with its
  permissions. A careful person will find it there later and wonder. Smallest fix: say
  so in the confirmation, with the address of Microsoft's "My Apps" page.
- "Connected as lei@acme.com, 3 hours ago." does not say what was granted. If the
  directory's administrator withheld `Chat.Read`, the card still lists "Read your Teams
  chats". The granted permissions are stored (`connections.scopes`) and not shown.
  Smallest fix: tick only what was granted.
- The page after consent is English or Chinese by the browser's setting, not by the
  language the person chose in Muster, because the browser it opens in may not be the
  one Muster runs in. A person using Muster in Chinese on an English system gets an
  English page. Smallest fix: carry the language in the attempt.
- The times in a calendar answer are as Microsoft returns them, and the days asked for
  are UTC days (`tools.ts:245-252`). "What is on tomorrow?" from Shanghai can miss the
  morning. Smallest fix: ask Microsoft for the person's time zone and use it.
- A person whose Microsoft address differs from their Muster email and who connects from
  the desktop app (whose consent opens in a browser that may not be signed in to Muster)
  is refused with the "not the account Muster knows you by" page. It tells them what to
  do, but it is a second trip. Smallest fix: in the desktop app, say before opening the
  browser that the browser must be signed in to Muster.

---

## Settings and the account menu

**Who it is for.** Every member. The "Desktop app" section appears only in the desktop
app. "Admin console" in the menu needs `console.access`.

**The job.** "See my account and where I am signed in, how much I have used, and set
Muster up the way I like."

**Where it starts.** The account row at the bottom of the sidebar → "Settings" or
"Usage"; `⌘,` / `Ctrl+,` anywhere in the workspace; or "Manage connections" in the +
menu of a message box, which opens it on Connections. Settings is a dialog, not an
address.

**What they see and can do.**
- **Profile** (since 2026-11-17, CHA-258; design in `docs/design/profile.md`) is the first
  section in the list; the account menu's "Settings" still opens on Account. At its top, read-only, who the person is: name, address, organization, role
  and department, which come from sign-in and administrators. Under "How you work", theirs
  to set and the same on every device (`apps/server/src/profile.ts`,
  `apps/web/src/lib/profile.ts`):
  - Time zone: "Follow this device (…)" or one fixed zone.
  - Working hours, with the days; "Clear" takes them away. A follow-up given by day alone
    comes at the start of the day. Since CHA-259 a day may end before it starts (22:00 to
    06:00, a night shift): the agent is told "22:00 to 06:00 (past midnight)". Only a day
    that starts and ends at the same minute is refused. A follow-up given by day alone
    then comes at 22:00 of that day.
  - How you like answers: one or two sentences, 300 characters at most, saved with "Save".
  - Mail signature, 1000 characters at most: put under a mail on its card, where it can
    still be changed or taken off; never given to an agent, which is told only that there
    is one so it writes no closing of its own. "Keep working on it" hands the mail back to
    the agent without the signature, whatever else the person changed, and the card puts
    it under the new draft.
  - Language, appearance, the agent for new conversations and what to be notified of stay
    where they were (General, Notifications) and are now kept by the server too: a choice
    made in one browser is there in another after a reload. The first time a browser signs
    in after this, what it had chosen for itself is sent up and kept only where the person
    had not chosen yet.
  - Every agent that works for the person is told, in place of the one sentence before:
    who they are in the organization, their clock, their working hours, the language they
    read Muster in, and how they like answers, with the words that none of it changes what
    the agent may do. The note itself is written to no span; the run's record names which of
    these the agent was told. What an agent then says aloud ("as you like short answers…")
    is in the record like any reply.
  - Tried on the owner's machine with the real model: hours, answer style and signature
    set in Settings; an agent asked when the day starts answered from them; a mail card
    came with the signature under it. Not looked at: a second browser, the Chinese wording
    in a browser, the phone.
  - The agent for new conversations that the person cannot use right now (deleted,
    suspended, waiting for review, no longer shared with them) reads as not chosen
    (CHA-259, `apps/server/src/profile.ts`). Nothing is written, so the choice is there
    again when the agent is; a device's own copy of it is not cleared by this.
  - The note is put together from one query a run (CHA-259; it was three).
  - On the phone (`apps/mobile/src/session.tsx`, `apps/mobile/src/lib/profile.ts`,
    `apps/mobile/src/screens/Settings.tsx`): language, appearance and the default agent
    follow the profile. Since CHA-259 Settings has "How you work" under the account card:
    time zone ("This device" or one of a short list of zones, with the one already fixed),
    working hours typed as 09:00, how you like answers and the mail signature, all kept
    with one "Save" (so a day half changed is never sent), and the working days. A mail in a reply is shown with
    the signature under it; sending is still done from the web or desktop app. None of it
    is stored on the phone: it is read at sign-in and held while the app is open.
    Tried in the iOS 27 simulator against a development server: hours 22:00 to 6:00 typed
    and kept as 22:00 to 06:00, the days and "Clear" appearing, answer style and signature
    saved with "Saved." shown; the fields scroll clear of the keyboard. Not looked at: the
    Chinese wording, the time zone sheet, a mail card with the signature (no model there).
- Since 2026-11-17 (CHA-249) the dialog is up to 1024 wide and 720 high (it was 768 by 640),
  with roomier rows, and a session started by the desktop app is listed as
  "Muster · macOS · App" rather than "Unknown · App". Sessions the desktop app started
  before this still read "Unknown" until the person signs in again.
- The dialog: a column of sections on the left with a "Search settings" box, the chosen
  section on the right. The search keeps the sections whose name or labels contain the
  words.
- Account:
  - Name, Email, Organization, Role (with one line on what the role may do). All read
    only: "These come from your work account and your organization's administrators."
  - "Where you are signed in": one row per live session: browser and system ("Chrome ·
    macOS"), "Browser" or "App", and "This device" or "Last used 3 hours ago". "Sign
    out" on a row ends that session at once; on this device's row it signs the person
    out.
- Usage:
  - A range switch: 7 days, 30 days (default), 90 days.
  - "Today's allowance": used and limit in tokens with a bar that turns red when the
    limit is reached. Shown only when the organization set an allowance.
  - Six numbers for the range: Replies, Tokens, Cost (US dollars); Tokens in, Tokens out,
    and "Read from cache": the share of what went in that the model's service read from
    its cache, with the two counts under it and one sentence saying what that means
    (since 2026-11-24, MUS-41; `GET /api/app/usage` carries `inputTokens`,
    `outputTokens`, `cachedTokens`; platform.md, "What is said once").
  - "By day": one bar per day with activity; the numbers and the cache share on hover;
    the first and last day under the bars.
  - "By agent": a table of replies, tokens, cache share and cost per agent (20 at most).
  - "Conversations that used the most": the person's ten heaviest conversations in the
    range, by title, each a link to it, with the same columns.
- General:
  - Language: English or 中文.
  - Appearance: System, Light, Dark.
  - "Agent for new conversations": a list of the agents the person may use.
- Connections: the services the person has let their agents read. One card, Microsoft
  365, with "Connect" or "Disconnect", what agents can then do, and "Reading only".
  Described in full under [Connections](#connections-microsoft-365).
- Notifications: two switches, "An agent needs your confirmation" and "A reply is
  ready". See [Notifications](#notifications).
- Your data:
  - "Clear all conversations" → a dialog "Remove all your conversations? This cannot be
    undone." → on confirm every conversation leaves the list, running replies are
    stopped, and a green notice says "Removed N conversations."
  - A sentence on who can read the person's conversations: administrators and security
    auditors.
- Desktop app (desktop only): the server's address and "Use another server", which signs
  the app out and asks for a server again.
- The account menu also has "Sign out", which ends this session and returns to the
  sign-in page.

**Rules.**
- Name, email, organization and role cannot be changed here.
- A person can end only their own sessions. Ending one is recorded as `session.revoked`.
  The list shows at most 50.
- Usage is the person's own runs only. Days are UTC. "Replies" counts runs (traces),
  including failed and stopped ones.
- The daily allowance counts input and output tokens of the person's runs since midnight
  UTC. When it is reached, new messages are refused (`budget_reached`, HTTP 429) and a
  run in progress is stopped after its current model turn. By default there is no
  allowance.
- Language, appearance, the agent, project and mode for new conversations, the
  notification switches and whether the right-hand panel is open are kept in this
  browser only (`localStorage`), not on the server.
- A connection is kept on the server, for the person: it is the same on every device
  they sign in on.
- The sections, in order: Account, Usage, General, Connections, Notifications, Your
  data, and in the desktop app, Desktop app (`apps/web/src/app/Settings.tsx:35-52`).
- Clearing conversations archives them. Documents and files stay. The traces of what
  agents did stay with administrators.
- The usage range accepts only `7d`, `30d`, `90d`; anything else is `invalid_request`.

**States.**
- Sessions and usage each show a spinner while loading and a red notice on failure.
- No usage in the range: the three numbers at zero and "Nothing used in this period."
- No allowance set: the allowance block is not shown.
- Search with no match: "No setting matches."
- Notifications blocked by the browser: a notice and both switches disabled.
- Connections: a spinner, then the card; "Not set up on this server yet…" with
  "Connect" disabled when the operator has not registered Muster with Microsoft or set
  the key.

**How it is wired.**
- Screen: `apps/web/src/app/Settings.tsx:508` (`Settings`), `:110` (`Account`), `:164`
  (`Usage`), `:279` (`General`), `:340` (`Connections`), `:418` (`Notifications`), `:457`
  (`Data`), `:490` (`DesktopApp`); the menu and shortcut in
  `apps/web/src/app/Workspace.tsx:68-80`, `:352-392`; opening on Connections from the +
  menu `Workspace.tsx:151`; sign-out `apps/web/src/App.tsx:169`.
- Requests:
  - `GET /api/app/sessions` → `apps/server/src/product.ts:821`.
  - `DELETE /api/app/sessions/:id` → `product.ts:835`; sets `revoked_at`, writes
    `admin_events`.
  - `GET /api/app/usage?range=` → `product.ts:857`; sums `traces`; `usedToday`
    `apps/server/src/runtime/runs.ts:261`.
  - `GET /api/app/agents` → `product.ts:261` (for the default agent list).
  - `GET /api/app/connectors`, `POST /api/app/connectors/microsoft/start`,
    `DELETE /api/app/connectors/microsoft` → `apps/server/src/connectors.ts:126`, `:130`,
    `:178`.
  - `DELETE /api/app/conversations` → `product.ts:806`; archives all, stops runs.
  - `POST /auth/logout` → `apps/server/src/app.ts:255`.
- Data: `sessions` (`schema.ts:70`, `kind` `:260`), `traces` (`:127`: `prompt_tokens`,
  `completion_tokens`, `cost_micros`, `started_at`), `conversations.archived_at`,
  `connections` (`:334`). In the browser: `muster.locale`, `muster.theme`,
  `muster.agent`, `muster.project`, `muster.mode`, `muster.notify.approvals`,
  `muster.notify.replies`, `muster.panel`.
- Events: `session.revoked`, `auth.logout`, `connector.connected`,
  `connector.disconnected`. Clearing conversations writes no event.
- Tests: `product.test.ts` "the person's own account" (`:1684`: lists sessions and signs a
  device out; adds up their own usage; clears their history without touching the record),
  "what an administrator can see and cap" (`:1743`: stops a person's agents once the
  allowance is used), "the allowance inside a run" (`:1788`), "a person's Microsoft 365"
  (`:1113`).

**Not built.**
- No editing of name or picture; the picture from the sign-in provider is not shown (an
  initial is).
- No "sign out everywhere else" in one action.
- No sign of where a session is (IP address, city) or when it was started, though the
  server has both.
- No export of the person's data, and no deleting of the account.
- No settings kept across devices.
- No instructions that apply to every agent ("always answer in Chinese", "about me"). A
  project's text does that for the conversations in one project only.
- No place in Settings for the mode: it is chosen in the message box, and the choice for
  new conversations is not listed among the preferences.
- No keyboard-shortcut list.
- No time zone choice: usage days and the allowance are always UTC.
- No email notifications.
- No way to ask for a higher allowance.

**Design findings.**
- "Tokens" and a cost in US dollars are shown to members without a word on what a token
  is or whether the cost is charged to them. Smallest fix: a line under the lead, "A
  token is about four characters. Cost is what the model charges your organization."
- The allowance resets at midnight UTC, which is 8 a.m. in China. The refusal says "It
  starts again tomorrow". Smallest fix: say the time in the person's zone: "It starts
  again at 08:00."
- The allowance bar is hidden in Settings › Usage; nothing warns the person as they
  approach it, and a run can be cut off mid-reply. Smallest fix: a notice above the
  message box at 80 percent.
- "Sign out" on another device acts at once with no confirmation, next to "Sign out" for
  this device, which looks the same. Smallest fix: label this device's button "Sign out
  here" and confirm the others.
- Session rows cannot be told apart: two "Chrome · macOS · Browser" rows differ only by
  "Last used". Smallest fix: show the sign-in date and the provider, which the request
  already returns.
- "Clear all conversations" writes nothing to the activity log, while deleting one file
  does. Smallest fix: record `conversations.cleared` with the count.
- Clearing all conversations cannot be undone and there is no export first. Smallest
  fix: keep the confirmation, add the count to it.
- Preferences live in the browser, so a person who signs in on a second computer gets
  English and the light theme again. Smallest fix: store language and theme on the user
  row.
- Settings cannot be linked to and closes on any click outside. Smallest fix: acceptable;
  or an address `#/settings/<section>`.
- The search box in a dialog of six sections is more than is needed and matches on
  labels the person cannot see. Smallest fix: remove it.
- "Your data" says who can read the person's conversations and says nothing of what
  agents read from their Microsoft 365 or their folders, the start of which is kept in
  the same record. Smallest fix: one more sentence there.
- Clearing all conversations leaves the Microsoft connection and the projects as they
  were, and the dialog does not say so. Smallest fix: name what stays.

---

## Language and theme

**Who it is for.** Everyone, before and after signing in.

**The job.** "Use Muster in my language, and in light or dark."

**Where it starts.**
- Signed in: Settings › General.
- Signed out: the two menus under the sign-in card.
- In the admin console: the two menus in the top bar.

**What they see and can do.**
- Language: English or 中文. Choosing one changes every label at once, and the formats of
  dates, numbers, money and "3 hours ago".
- Appearance: System, Light or Dark. System follows the device and changes with it.

**Rules.**
- Two languages are registered: `en` (tag `en-US`) and `zh` (tag `zh-CN`). English is the
  shape every other language must match; the compiler reports a missing key
  (`apps/web/src/i18n/en.ts:1-5`, `apps/web/src/i18n/index.tsx:7-10`).
- The first visit is in English whatever the browser's language (`index.tsx:14-17`).
- The choice is kept in this browser: `muster.locale`, `muster.theme`. Choosing "System"
  removes the saved theme.
- A refusal from the server is shown in the person's language by its code
  (`t.errors[code]`), falling back to the server's English message. A request that could
  not reach the server shows "Cannot reach the server. Check your connection and try
  again."
- The language of the page is set on the document (`lang`), so screen readers and fonts
  follow.
- Diagrams in replies follow the theme (dark or neutral). Charts use theme colours.
  Files in the viewer keep their own colours: a workbook's fills, a web page's white
  background, a Word page's white paper. A workbook that fills any cell is shown whole
  as white paper in either theme, its unfilled cells too (CHA-230): bands chosen
  against white read as broken when every other row took the dark background. A
  chart's title is set smaller, down to 10 px, until all of it is inside the chart
  (`apps/web/src/app/slides/ChartView.tsx`).
- What is not translated: the names and descriptions of the four starting agents; the
  names people give their own agents and documents; anything an agent writes; the plain
  sentences agents are given when a tool fails; the page of the desktop sign-in
  confirmation.

**States.** None beyond the three appearances and two languages.

**How it is wired.**
- Screen: `apps/web/src/app/Settings.tsx:275` (`General`); `apps/web/src/App.tsx:183`
  (`Preferences`).
- Code: `apps/web/src/i18n/index.tsx:39` (`I18nProvider`), `:64` (`errorText`);
  `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/zh.ts`; `apps/web/src/lib/theme.tsx:20`
  (`ThemeProvider`).
- Requests: none.
- Data: `localStorage` only.
- Events: none.
- Tests: none. The type of `zh` against `en` is the only check.

**Not built.**
- No following of the browser's language on first visit.
- No third language, and no right-to-left layout.
- No language choice per organization and no default set by an administrator.
- The agent is not told the person's language: it answers in whatever language the
  message or its instructions lead it to.
- No choice of accent colour, text size or density.
- No high-contrast theme.

**Design findings.**
- A person whose browser is in Chinese lands on an English sign-in page and must find
  the small language menu under the card. Smallest fix: when nothing is saved, use
  `navigator.language` if it starts with `zh`.
- In Chinese the workspace mixes languages: "Assistant", "Writer", "Researcher",
  "Messenger" and their English descriptions sit among Chinese labels, and the default
  agent is found by the English name "Assistant" (`Chat.tsx:390`). Smallest fix:
  translate platform agents by name in the web app; find the default by a stable key.
- Changing the language does not change the language agents answer in, which a user
  will expect. Smallest fix: add "Answer in <language> unless asked otherwise" to the
  system prompt from the person's chosen language.
- The language name in the signed-out menu is the current language's own name; fine. In
  Settings the choice is a plain select with no flag or hint; fine. No change needed.
- Money is always US dollars, also in Chinese. Smallest fix: say "USD" beside the cost,
  or let an administrator set the currency.

---

## Notifications

**Who it is for.** Every member.

**The job.** "Tell me when an agent needs me or has finished, if I am looking at
something else."

**Where it starts.** Settings › Notifications, to turn each kind on or off. The
notifications themselves appear from the browser or the desktop app.

**What they see and can do.**
- Two switches, both on unless turned off:
  - "An agent needs your confirmation" — "So an action waiting for you does not expire
    unnoticed."
  - "A reply is ready" — "When an agent finishes while you are elsewhere."
- Turning a switch on for the first time makes the browser ask for permission.
- A confirmation notification: the title "Confirm before this happens" and "<Agent>
  wants to do the following. Nothing happens until you allow it."
- A reply notification: the conversation's title and "The reply is ready."
- In the desktop app the number of waiting confirmations is also passed to the app
  (`desktop.setWaiting`) for its own badge.

**Rules.**
- A browser notification is shown only when the Muster tab is hidden and the browser has
  granted permission. The desktop app decides for itself whether its window is in front
  (`apps/web/src/lib/notify.ts:18-23`).
- A confirmation in the conversation on screen notifies through that conversation's live
  stream. A confirmation in any other conversation is noticed by the workspace's
  15-second refresh and notifies then (`apps/web/src/app/Workspace.tsx:108-119`).
- A "reply is ready" notification is sent only for the conversation that is open in the
  tab, because only that conversation has a live stream
  (`apps/web/src/app/Chat.tsx:607-608`).
- Nothing is sent when Muster is not open in a tab or the desktop app is not running:
  there is no server push and no email.
- The switches are kept in this browser (`muster.notify.approvals`,
  `muster.notify.replies`).

**States.**
- Permission not asked yet: switches look on; the first change asks.
- Permission denied: "This browser is set to block notifications from Muster. Allow them
  in the browser's site settings." Both switches are off and disabled.
- Not supported: "This browser cannot show notifications." Both switches are off and
  disabled.

**How it is wired.**
- Screen: `apps/web/src/app/Settings.tsx:335` (`Notifications`).
- Code: `apps/web/src/lib/notify.ts`; callers `apps/web/src/app/Chat.tsx:602-609`,
  `apps/web/src/app/Workspace.tsx:108-119`; `apps/web/src/lib/desktop.ts`.
- Requests: none of its own. It depends on `GET /api/app/conversations/:id/events` and
  `GET /api/app/approvals`.
- Data: `localStorage` only.
- Events: none.
- Tests: none.

**Not built.**
- No email, mobile push or chat (Slack, Teams, WeCom, Feishu) notification.
- No notification when Muster is closed.
- No notification for a reply that finishes in a conversation other than the open one.
- No in-app notification list or history.
- No sound.
- Clicking a notification does not open the conversation it is about: no click handler
  is set (`notify.ts:22`).
- No notification when an administrator approves or suspends the person's agent.

**Design findings.**
- "A reply is ready — when an agent finishes while you are elsewhere" promises more than
  is built: it works only when the tab is hidden with that very conversation open. A
  person who starts a long task and moves to another conversation hears nothing.
  Smallest fix: on the workspace's refresh, notify for any conversation whose `running`
  changed from true to false.
- A switch that looks on before the browser was ever asked gives a false picture: the
  person believes they will be told and is not. Smallest fix: show the switch off, with
  "Turn on", until permission is granted.
- Clicking a notification does nothing useful. Smallest fix: `onclick` → focus the
  window and go to `#/c/<id>` or `#/approvals`.
- A confirmation waits only 15 minutes and the only alert needs an open tab. For an
  enterprise this means actions silently expire over lunch. Smallest fix: an email to
  the person when a request has waited 5 minutes; later, a mobile push.
- A confirmation raised in another conversation can take up to 15 seconds to notify.
  Smallest fix: acceptable; or one workspace-wide event stream.
