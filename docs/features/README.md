# Feature descriptions

What every feature of Muster is for and how it is wired. Read the section of a feature
before changing it; change the section in the same pull request as the feature
(`AGENTS.md`, "Every feature has a design description").

Each feature is written to one shape, [`TEMPLATE.md`](TEMPLATE.md): who it is for, the
job, where it starts, what the person sees and can do, the rules, the states, how it is
wired (screen, requests, tables, events, tests), what is not built, and the design
findings still open.

| File | What it covers |
|---|---|
| [`workspace.md`](workspace.md) | What every member uses: sign-in, sidebar, start page, conversation, projects, folders on the person's computer, progress and plan, confirmations, modes (how much an agent may do without asking), replies, attachments, files and the viewer (the library), files an agent makes, documents, the Agents page and building agents, connections (Microsoft 365), settings, language and theme, notifications |
| [`coding.md`](coding.md) | Coding on the desktop: commands, jobs, exact edits and search in the person's own repositories, what asks and what does not, and keeping a conversation within the model's window |
| [`files-in-steps.md`](files-in-steps.md) | Files an agent builds in steps and changes in place, their versions, and figures worked out over every row of a table |
| [`sandbox.md`](sandbox.md) | Running code: Python and shell in a container with no network, what a person sees of it, what keeps it apart, its log and its settings |
| [`drafts.md`](drafts.md) | Mail and Teams messages an agent drafts and the person sends from a card; the administrator's switch for sending |
| [`admin-console.md`](admin-console.md) | The console under `#/admin`: roles and permissions, overview, members, departments, invitations, sign-in and sessions, activity log, agent roster, traces, usage, approvals, policies (with the one setting an administrator can change), models, extensions |
| [`platform.md`](platform.md) | What the pages stand on: sign-in and sessions, roles, the agent registry, runs (with the channel to a person's computer), the gateway (with modes), tools, models, budgets, traces, the activity log, file storage, reply format, configuration, schema, the gaps against the locked decisions, and connections to other services |
| [`clients-and-operations.md`](clients-and-operations.md) | The desktop app (with folders on the computer), the iOS app, running it for development, the background service, settings (with the secret key and the Microsoft registration), deployment, backup, quality gates, how work is done here |

## How much a page says

The owner's rule, 2026-11-24, after looking at the admin Connections page ("真的超级多"):
a page is not where things are explained at length.

- A card or a section has a title and **at most one short line** under it: about 60
  characters in English, 30 in Chinese.
- A setting has a label and at most a few words. An empty state is one line.
- What stays on the page in full: **state** (what is set, what is wrong) and the
  **consequences of a destructive choice**, at the moment it is made (in its dialog, and
  still short).
- A longer explanation worth keeping goes behind the small mark beside the name:
  `Hint` in `apps/web/src/components/ui/hint.tsx`. Text not worth a press is deleted.
- The components hold the rule so that a page cannot forget it: `CardDescription`
  (`ui/card.tsx`) and `Lead` (`ui/hint.tsx`) show plain words on one line; when they are
  longer, the first sentence is shown and the whole is behind the mark. Write a lead so
  that its first sentence says it; use `Lead`, not a bare muted paragraph, for anything
  that explains.
- An empty page (`Guide`, `components/guide.tsx`) is an icon, a name, one line and what
  to do first. It had three cards of explanation; they were not read.
- No mode, switch or option is added to make room for an explanation.

## How close a console page sits

The owner's rule, 2026-11-24, after looking at the admin Retention page ("ADMIN 网页非常多的
空白设计，违反我们的规则和要求。信息紧凑的要求"): the console removes air, never information.

- **A setting is one row**, about 36 px: its name (13 px) at the left, what it is beside
  the name in muted words as far as they fit (the whole behind the mark when they do not),
  the control at the right. No second line under the name. Rows are parted by a hairline.
  Use `SettingRow` (`components/shared.tsx`); what is wrong with a setting goes in its
  `below`, shown only then.
- **A card's header is one row**: the title (14 px), its line beside it, actions at the far
  end (`CardHeader`, `CardTitle`, `CardDescription`, `CardAction`). Padding 14 px, 8 px
  between a card's parts, 12 px between cards, 16 px round the page.
- **Tables**: rows 34 px, 13 px text, avatars 24 px, a person on one line (name, then the
  address muted beside it). One line a row unless two are needed.
- **Empty** inside a card is one muted line, not a tall blank (`Empty`).
- **Use the width**: several short cards stand beside each other (two or three columns)
  before the page scrolls; a list of settings has its side cards beside it at its height.
- Buttons are 28 px, fields and selects 28 px. Hit targets stay at 28 px or more; focus
  rings and contrast are as elsewhere.
- **How it is held**: the console's shell carries `data-dense` (`App.tsx`, `Console`), and
  the shared pieces take their tighter measures through the `dense:` variant
  (`index.css`). The person's workspace is not inside it and is unchanged. A dialog opens
  outside the shell and keeps the ordinary measures. A new console page gets all of this
  by using the shared pieces; it does not set paddings of its own.

## How these were written

On 2026-11-14, from the code on branch `epic/cha-166-polish`, by reading each screen and
following every request to its handler and its tables. Nothing here was taken from
memory of how a feature was meant to work. Where something could not be confirmed, the
text says "Not verified:" and what was not confirmed. Line numbers drift; the file and
the function name are what to trust.

The descriptions were not checked against the running app screen by screen. The start
page, the Agent roster and the file viewer were looked at in the browser the same day.

Later on 2026-11-14 five commits changed the product (`82be822`, `5205eb7`, `8ac0214`,
`36cf1d7`, `8921aad`), and the four files were brought back in line with the code as it
stood after the last of them, again by reading the code and its tests and without running
anything. A finding that a change answered was not removed: it now starts with "Answered on
2026-11-14:" and says what was done and what remains. The line numbers cited were moved to
where the lines are now.

Still on 2026-11-14, branch `epic/cha-167-local-work` added projects, folders on the
person's computer, a Microsoft 365 connection, modes with an administrator's ceiling, and
redesigned the Agents page, the library, Approvals, the sign-in page and the invite
dialog. The four files were brought in line with that branch as it stood after its last
commit (`6c96cf8`, the fixes from an independent review), again by reading the code and its
tests and without running anything. The points of the one earlier commit that had not been
worked in (the company's own provider on Sign-in & sessions, "Allow any page" for https
only, "Created an invitation", the roster's Approve text, the restore's start step) are in
the files now. The sections that branch changed cite its line numbers; the others still
cite `epic/cha-166-polish`, and each file says so at its top.

What was run for real that day, by the owner and not by whoever wrote these files: sign-in
with a real Microsoft directory, which worked; and connecting a real Microsoft account,
through which an agent read real mail. Not run: the calendar, files and Teams chats tools
against Microsoft (no test calls them either); folders, in the real desktop app.

## The findings that matter most

Each is described, with its smallest fix, in the section named. This list is the order
they should be worked in; it is the owner's to change.

### A decision is taken without anyone having made it

1. Answered on 2026-11-14: a suspended agent can no longer be changed by its builder (the
   save is refused with `agent_suspended`), so "Restore" publishes what was suspended
   ([admin-console: Agent roster](admin-console.md#agent-roster)).
2. Answered on 2026-11-14: a change of model, which re-stamps every agent's version, is now
   written to the activity log as `agents.model_changed`. What remains: there is still no
   second look at agents that act outside; they stay approved on the new model
   ([platform: The agent registry](platform.md#5-the-agent-registry)).
3. **An agent that can send data outside is available to everyone from the first day**
   (the Messenger agent), and the only control on what it sends is a click by the person
   who asked ([platform: The gateway](platform.md#7-the-gateway)).
4. Answered on 2026-11-14: suspending or removing a person now ends the runs they have in
   progress, and a run cannot start for someone who is no longer active. What remains: the
   confirmations still say nothing about what is kept (conversations, files, agents)
   ([admin-console: Members](admin-console.md#members)).

### A person loses work, or is not told why

5. Answered on 2026-11-14: a refused message is put back in the box with its files, and the
   empty conversation made for a refused first message is removed
   ([workspace: Conversation](workspace.md#conversation)).
6. Answered on 2026-11-14: a reply records why it ended (`messages.ending`: the daily
   allowance, the length limit, or an error with one of five plain causes) and the
   conversation says so. What remains: a reply failed by a restart gives no cause, the
   causes are not translated, and a reply cut off at the length limit has no "Continue"
   button ([workspace: Conversation](workspace.md#conversation)).
7. Answered on 2026-11-14, for documents: when an agent replaces a document, what it held
   before is kept and the editor offers to bring it back. What remains: one earlier version
   only, which the person's next save drops; a file an agent makes again still replaces the
   old one with nothing kept; and neither is written to the activity log
   ([workspace: Documents](workspace.md#documents-notes-agents-read-and-write)).
8. Answered on 2026-11-14, in part: the card is in plain words (no "POST"; the size stays
   in bytes); reading a page can allow its whole site for that conversation; and the
   Approvals page refreshes every 15 seconds. What remains: a request is still gone after
   15 minutes, and the only alert is a notification while Muster is open
   ([workspace: Confirmations](workspace.md#confirmations-an-agent-asks-before-an-action)).

### The console describes more than it controls

9. **Policies and Models cannot change anything**; limits and the model are settings that
   need a restart. Answered on 2026-11-14, in one part: the refusal no longer tells people
   "an administrator can raise it"; the rest stands
   ([admin-console: Policies](admin-console.md#policies)).
   Answered on 2026-11-14: Policies now changes one thing, the most freedom people may
   give agents in a conversation (a ceiling over three modes, set with `settings.manage`,
   confirmed when loosened, recorded as `policy.changed`). What remains: it is the only
   one; the level rules, the limits and the model are still code or settings that need a
   restart, and Models still changes nothing.
10. Answered on 2026-11-14: the activity log searches the whole record on the server (by an
    action's name or by the words on screen), takes a date range and exports CSV, and
    opening someone else's run in Traces is recorded as `trace.viewed`. What remains: no
    detail view of a record, and reading a conversation's runs in the Conversations tab is
    not recorded ([admin-console: Activity log](admin-console.md#activity-log)).
11. Answered on 2026-11-14, in part: invitations now say "Create invitation" and
    "Created"; the role, department and allowance texts no longer promise what does not
    exist; the admin Approvals list says what was asked in words and "Waiting for its
    person". What remains: "awaiting approval" still means an agent on one page and a run
    on another, the activity log still says "Sent invitation", and codes (A3, R2,
    `web.send`) are still shown raw on Overview, Policies, the roster and Traces
    ([admin-console](admin-console.md)).
    Answered on 2026-11-14: the activity log says "Created an invitation", and the invite
    dialog now stays open to say that nothing is mailed and what to send the person. What
    remains: "awaiting approval" still means two things, and the codes are still shown raw
    in the console (the member's Agents page and conversation no longer show them).
12. **Extensions was a preview with sample data.** Answered on 2026-11-15: removed. Its
    place holds Connections, which is real
    ([admin-console: Connections](admin-console.md#connections)).

### What the locked decisions promise and the code does not do

13. **The tamper-evident audit record is written by nothing** (D-5); tool calls live only
    in traces that are rewritten on each save
    ([platform: Gaps](platform.md#21-gaps-against-the-locked-decisions-in-one-place)).
14. **No extension gating and no sandbox** (D-2): tools run inside the server.
15. **What goes to the model passes no gateway** (D-3), and the device half (D-6) does
    not exist on the server.
    Answered on 2026-11-14, for D-6 and in part: from the desktop app an agent can list,
    read, search and write text files in folders the person attached to a project, without
    uploading them, and the server is never told where the folders are. What remains: no
    sync, nothing offline, no run on the device, Office and PDF files in a folder cannot
    be read, nothing on iOS, and it has not been run in the real desktop app; the D-3
    half stands as it was
    ([platform: Gaps](platform.md#21-gaps-against-the-locked-decisions-in-one-place)).

### Running it for a company

16. Answered on 2026-11-14, in part: backups are written whole or not at all and with
    `--clean --if-exists`, so one can be played into the database as it stands, and the
    runbook's restore stops the server first. What remains: the restore and the deployment
    have still never been run on a real deployment, and the runbook restores people's files
    through a container it has just stopped
    ([clients-and-operations: Backup and restore](clients-and-operations.md#backup-and-restore)).
17. Answered on 2026-11-14: the database password is passed on its own (`PGPASSWORD`), not
    inside the address, so it may hold any character. Not yet run on a real deployment
    ([clients-and-operations: Deployment](clients-and-operations.md#deployment)).
18. Answered on 2026-11-17, in part: the iOS app was built for the simulator and walked
    against a development server without a model (sign-in, the conversation, Settings).
    What remains: a reply being written, an approval card and a real device have not
    been seen, and no check covers the app; the desktop app is
    unsigned and signs people out on a network blip
    ([clients-and-operations](clients-and-operations.md)).

### Found on `epic/cha-167-local-work`

19. **A deployment made from the compose file cannot offer Microsoft 365 connections**:
    the server needs `MUSTER_SECRET_KEY`, and the compose file, the example environment
    files and the runbook do not know it. The second redirect URI and the Graph
    permissions are written down only here
    ([clients-and-operations: Server settings](clients-and-operations.md#server-settings)).
20. **What an agent reads from a mailbox or a folder is kept in the trace**: the first
    4,000 characters of each read, in plain text, where administrators and auditors can
    open it; a confirmed write on a person's computer keeps its whole content on the
    approval. The pages tell the person it "is sent to the model for that answer"
    ([platform: Connections](platform.md#22-connections-to-other-services),
    [workspace: Folders](workspace.md#folders-on-your-computer)).
21. **"Full access" lets an agent that read something private put it in an address**, by
    design, once an administrator allows the mode; it is then open to every agent, the
    one that reads mail included, and a person's choice of it is recorded nowhere
    ([workspace: Modes](workspace.md#modes-how-much-an-agent-may-do-without-asking)).
22. **An administrator cannot see who connected what, end a connection, or turn
    connections or folders off**; suspending a person leaves their sealed tokens
    ([admin-console: Sign-in & sessions](admin-console.md#sign-in--sessions)).
23. **The connector only reads, and folders only read text**: an agent can say what a mail
    asks and cannot answer it; it cannot open the spreadsheet in the attached folder
    ([platform: Tools](platform.md#8-tools)).
24. **The desktop app writes what the server's page asks**, inside the attached folders;
    whether to ask first is decided on the server only, and none of it has been run in
    the real app ([clients-and-operations: Desktop app](clients-and-operations.md#desktop-app)).

## Decisions only the owner can take

Taken by the owner on 2026-11-14:

- Microsoft 365 is the first service to connect, before Feishu.
- What an agent reads on a person's device goes to the model for that answer and is not
  copied to the server's file storage unless the person attaches it. The code keeps this
  for file storage. It does keep the start of each read in the run's trace, and the
  content of a write that asked first on its approval (finding 20); whether that is
  within the decision is the owner's to say.
- Modes exist: a person chooses, for each conversation, how much agents may do without
  asking. Until 2026-11-21 an administrator set the most anyone may choose; that ceiling
  was removed at the owner's word, and every mode is the person's own choice.

Still open:

- Whether Office files should be editable in the page, which means embedding an office
  suite under licence (WPS WebOffice, ONLYOFFICE or Microsoft's), or stay view-only.
- Which of the gaps against D-2, D-3, D-5 and D-6 are closed in code now and which are
  recorded as amendments in `docs/proposed-amendments.md`.
- Whether agents that act outside the organization (R3) need an administrator before
  anyone may use them, including the ones Muster ships with.
- Who may read other people's conversations in Traces, and whether each reading is recorded.
  Since 2026-11-14 opening one run is recorded, once an hour for each reader and run;
  opening a conversation's runs is not.
- Whether a person may allow a whole site for a conversation on their own, or whether the
  organization should be able to forbid it or name the sites.
