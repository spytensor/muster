# Running code: the sandbox

Until 2026-11-23 an agent on the server could not run anything. Files were made from
recipes and figures came from two fixed table tools; only the desktop app ran commands,
on the person's own computer. The owner, on seeing it: "现在 muster 没有任何的 sandbox
啊，那么多的各种脚本怎么执行呢?在线的那种". This is the answer: a place on the server
where an agent's Python or shell runs, kept apart from everything else.

## Running code in a conversation

**Who it is for.** Every member, through any agent that may make files (`files.create`).
Nobody turns it on per agent; it comes with making files, where the server has a sandbox.

**The job.** "Work this out from my spreadsheet", "chart it", "convert this", "is the deck
you made laid out properly": work where a program does better than reading.

**Where it starts.** In a conversation, on the web, the desktop app or the phone. The
person asks in their own words. There is no button for it and nothing to switch on: the
agent decides a step needs code, as it decides a step needs a search.

**What they see and can do.**

- They ask → the reply's list of steps gains a row **Ran code**, with a few words the agent
  gave for it ("Monthly totals by region") and how long it took. While it runs the row
  reads "Running code" with a spinner, and what the code prints appears under the row as
  it is printed: the last six lines, a few times a second (since 2026-11-24, MUS-5). When
  it ends the lines go; what it came to is in the opened step. Nothing asks for
  confirmation: the run reaches nothing but the hosts the organization allows.
- They press Stop while code runs → the reply stops and so does the run: its container
  is removed. What it had used by then counts against their day.
- They press the row → it opens to show the level and how it was judged
  ("A1 · allowed without asking"), **The code (Python)** or **(Shell)** exactly as it was
  written, the files that were put in, the files the agent asked to keep, the line "Ran in
  a sandbox, which saw only these files", and **What came back**: how the run ended, what
  it printed, what it wrote, and any connection that was refused, by host, with why.
- The code needs a package the sandbox lacks → the agent installs it with `pip` in the
  same run and uses it there (since 2026-11-24, MUS-4). What is installed lasts for that
  run. A host that is not allowed is refused, and the agent is told to say so, not to look
  for another way.
- Settings → Usage shows one line, "Code run today: 12 of 200 runs · 3 min" (MUS-6). Past
  the day's allowance the agent is told the run was not made and why, and says so.
- The agent keeps a file for them (a chart, a cleaned table, a converted document) → the
  file appears as a card under the reply, like any file an agent makes, and in their
  Library. A picture shows as itself on the card. Several files from one run are several
  cards.
- They ask for a change to a Word, Excel or PowerPoint file they uploaded ("make the
  payment term 45 days, leave everything else") → the agent opens the file in the sandbox
  (python-docx, openpyxl, python-pptx), changes only what was asked, and keeps the result
  under a new name ("Contract (revised).docx"); the upload stays as it was. Until
  2026-11-23 an uploaded file could only be read and made again from scratch, which lost
  its styles and layout. Tried with the real model: one sentence of a contract changed,
  and the revised file compared with the original paragraph by paragraph: the same
  styles, the same 12-point coloured run, the same table style, that sentence alone
  different. What the libraries do not reach (a chart, a tracked change) the agent is
  told to say, not to remake the file unasked.
- They ask for a change → the agent runs again. The conversation's working folder is still
  there, so the second run finds what the first one wrote.
- The agent made a presentation or a long document and wants to be sure of it → it puts
  the file in the sandbox and runs `look` on it, which lays the file out as an office
  program would and reports, page by page, text that stands on other text, text that runs
  off the page and empty pages. The agent fixes what it names and looks again.

**Rules.**

- A run sees the files the agent names in `files` and what earlier runs in the same
  conversation wrote. It sees none of the person's other files, no other conversation, no
  other person, nothing of the server.
- A run has no network of its own. What it reaches, it reaches through the sandbox
  service, which lets through https to the hosts on the organization's list and nothing
  else (see "The way out" below). Unless an administrator changed it, the list is the
  package indexes: `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`.
- One person's agents may run code 200 times and use an hour of processor time in a day
  (UTC, like the day's tokens). `MUSTER_SANDBOX_DAILY_RUNS` and
  `MUSTER_SANDBOX_DAILY_CPU_SECONDS` change that; 0 takes a limit away. An administrator
  sets other numbers for everyone, a department or one person on the Sandbox page (see
  "The Sandbox page"); the person's own comes first, then their department's.
  - **Processor time is counted from outside the run**: the seconds the container was
    there, by the sandbox service's clock, times the two processors a run is allowed. That
    is the most it can have used, so an hour of processor time is half an hour of running.
    What the code inside says it used is not asked: it could say anything (review,
    2026-11-24).
  - **A run's place is taken before it starts** (`SandboxUse.reserve`): a line is written
    at the most the run can come to (the time it may take, on both processors), while the
    person's row is held, and brought down to what it took when it ends (`settle`). Four
    conversations asking at once cannot each see room for the last run.
  - Every run that started counts, however it ended: well, failed, past its time, ended
    for memory, stopped by the person (by the server's clock then, since no answer came).
    One the sandbox never started (busy, not ready, a file that is not theirs) does not.
    A line left "running" by a server that stopped is closed as "lost" once the time the
    run asked for is ten minutes past (`sweepSandboxRuns`, at start and every five
    minutes; one statement, so several servers agree): counted at that time on both
    processors, since nothing better is known and the code may have run all of it
    (MUS-53).
- What code prints is passed on while it runs up to 220 KB a run; past that the row stops
  growing and the answer still holds the beginning and the end.
- What the agent is told about the sandbox is the same whatever the list holds: the tool's
  description and the instructions name no host. The list can change between two messages
  of a conversation without changing what the model's service has already read
  (`platform.md`, "What is said once"; `server/sandboxUse.test.ts`).
- Only what the agent names in `keep` leaves the sandbox, and only after a run that ended
  well. It is saved as the person's file, through the same door as every other file: the
  same kinds, the same size limit, the same quota, the same line in the activity log
  (`file.created`). A kind that is not kept here (a program, say) is refused, and the agent
  is told which file and why.
- A kept file takes the place of one thing only: a file of the same name that an earlier
  run in the same conversation kept, and that nobody was given a share of. A file made
  from a recipe (`files.create`), an uploaded file and any file of another conversation
  stay, beside the new one, whatever their names. Two files kept in one run may not have
  the same name. (Found in review before this shipped: it replaced every agent-made file
  of that name the person had, and deleted its content.)
- Putting a file in needs the agent to have `files.read`. An agent that may make files but
  not read them can run code on nothing but what it writes itself.
- Limits of one run: 60 seconds unless the agent asks for more, 300 at most; 2 processors;
  2 GB of memory; 256 processes; 10 files in and 10 kept. A working folder holds 256 MB;
  one file put in may be 64 MB; a run hands back 4,000 changed files at most, and is told
  which it could not. Three runs go at once on the whole server; a fourth waits up to 30
  seconds and is then told the sandbox is busy.
- What a run printed comes back as its first and last 100,000 bytes, and the agent is
  given 16,000 characters of them (8,000 of the errors).
- A working folder nobody has used for seven days is released (the number is the
  organization's, 1 to 90; see "The Sandbox page"). The next run in that conversation
  starts an empty one, and the agent is told so once. All working folders of the whole
  server together may hold 20 GB; past that, the ones used longest ago go first.
- What a run printed is treated as material from outside, like a web page: it may hold
  text from a file, so it is never an instruction, and a reply that has read it is one that
  "read something from outside" for the rules about sending (`OUTSIDE`,
  `apps/server/src/runtime/runs.ts`).
- The tool's level is A1, the same as making a file. It adds nothing to an agent's risk
  level.

**States.**

- *No sandbox set up, or the sandbox not ready* (still building its image, Docker without
  gVisor): the tool is not offered and the agent is not told about it. Nothing in a
  conversation looks different; the agent works as it did before.
- *The run failed*: the row is marked as failed ("Running code failed", red), and
  opened it says "It failed (exit 1)" with the error; the agent is given the same words
  and usually corrects its code and runs again. (For its first day a failed run was a
  ticked step, to be opened to know.)
- *Past its time*: "It ran past its time and was ended." What it had written is still in
  the working folder; nothing from it is kept for the person.
- *Out of memory*: "It was ended for using more memory than a sandbox has."
- *The sandbox did not answer, or is busy*: the row shows the step as failed, with those
  words.
- *The person stops the reply*: the request to the sandbox is dropped. The run itself ends
  when its time is up.
- *An administrator stops the run* (Sandbox page): the step fails with "An administrator
  stopped this run", and the agent says so.

**How it is wired.**

- Screen: `apps/web/src/app/Chat.tsx:764` (`StepOpened`, the opened row),
  `apps/web/src/app/ranCode.ts:18` (`ranCode`, the code out of a request that may have
  been cut short), `apps/web/src/app/Chat.tsx:1981` (`madeBy`, the cards of kept files).
  The phone app names the step (`apps/mobile/src/i18n`); it shows what came back as text.
- Tool: `code.run`, `apps/server/src/runtime/tools.ts:881`. Arguments: `why`, `code`,
  `language` (`python`, the default, or `shell`), `files`, `keep`, `seconds`. Catalog
  entry `apps/server/src/runtime/catalog.ts:96`; it comes with `files.create`
  (`catalog.ts:122`) and is offered only with a sandbox (`tools.ts:1252`) that says it is
  ready (`apps/server/src/runtime/runs.ts:1871`). What the agent is told:
  `runs.ts:1996`. The step's few words: `tools.ts:1458` (`stepDetail`).
- The server's side of the sandbox: `apps/server/src/sandbox.ts:58` (`createSandbox`), a
  client for the runner; the conversation's id is the working folder's name. Files go in
  by `Files.bytesByName` (`apps/server/src/files/service.ts:575`) and come out through
  `Files.add` with `replaceRun` (`service.ts:390`).
- A step names every file it kept: `step.file` and, for more than one, `step.files`
  (`runs.ts:2207`).
- Tests: `apps/server/src/sandbox.test.ts` (the tool against a stand-in sandbox),
  `apps/web/src/app/ranCode.test.ts`.

**Not built.**

- What `pip` installs lasts for one run: there is no shared package cache, so a package
  is fetched again each time it is needed.
- Only https by name, port 443. No plain http, no other port, no address, no git over
  ssh.
- The agent cannot see pictures a run made (a chart, a page of a deck) unless the model
  can see images and the person sends the file back; `look` answers in words.
- Nothing typed into a run; no notebook that keeps variables between runs. The working
  folder is what lasts.
- Deleting a conversation does not always delete its working folder at once; the hourly
  pass releases a folder with no conversation once it is a day old.
- Coding on the desktop does not use the sandbox: it runs on the person's computer
  (`coding.md`). Not verified: whether a scheduled run or a follow-up is offered the tool;
  they go through the same code, and neither was tried.
- The phone app does not show the code as code.

## A repository in a workspace (MUS-20)

Work on one of the company's repositories can be done in a conversation's workspace when
nobody's computer is attached (coding.md, "In the cloud"). For that the runner does three
more things, and still nothing a request can steer: no image, no flag, no path outside
the workspace.

- `PUT /spaces/<id>/unpack/<folder>` takes a repository's archive (gzipped tar, 64 MB at
  most) and puts its files into one folder of the workspace, in place of what was there.
  Only files are made: a link, a device or a name that climbs out of the folder is passed
  over and named in the answer (`untar.ts`). An archive that holds more than the
  workspace has room for is refused whole, before anything is taken away. The answer
  lists every file with git's fingerprint of it.
- `GET /spaces/<id>/tree/<folder>` lists that folder as it stands, the same way.
- `DELETE /spaces/<id>/files/<name>` takes one file out.

Two archives are unpacked at a time over all workspaces; a third waits its turn, and is
told to try again if none comes within half a minute. While one is unpacked the runner
holds it packed and unpacked at once: up to about 330 MB for the largest (64 MB packed,
256 MB of files, headers), so about 660 MB at the most, inside the runner's 3 GB. The
server hands the archive on without making a copy of it.

A file whose name is not UTF-8 is passed over like a link: its name could not be written
back as it was.

The code host's key is never part of any of this: the server fetches the archive and
sends the work, and the runner sees bytes.

## The Sandbox page (MUS-54)

**Who it is for.** `settings.read` (Owner, Administrator, Auditor) to see it;
`settings.manage` (Owner, Administrator) to change anything on it.

**The job.** "What is running right now and can I stop it; what was run and by whom; how
much room do the working folders take and when does it come back; how much may a person
run; what did code reach."

**Where it starts.** `#/admin/sandbox`, "Sandbox" under Platform. Nothing about the
sandbox is on Models any more; Usage keeps one line that links here.

**What they see and can do.** One page, top to bottom. A table with nothing in it is one
muted line.

- **State.** Ready or not, with the reason in words when not; how code is kept apart
  ("gVisor", or "plain container" in amber); the image's tag and when it was built;
  running now, of how many places, and how many wait for one; this organization's
  workspaces and what they hold, against its cap when it has one; the free room on the
  sandbox's disk.
- **Reclaim.** "Release after N days idle" (7 unless changed; 1 to 90) and "Cap for all
  workspaces" in GB (empty: none), both typed in place and saved with one button; what
  one workspace may hold (256 MB, fixed in the runner); when workspaces were last looked
  through, how many that released and how much; and when they are looked through next.
- **Daily limits.** Runs a day and processor minutes a day for everyone, and a row for
  each department or person with a limit of their own. "Add a limit", "Set", "Change"
  open a small dialog with the two numbers; "Remove" in it takes the limit away. Below:
  the time a run may take (60 s, 300 at most) and how many run at once (3), fixed in the
  runner and shown as that.
- **Running now.** Every run in flight in the organization: person, agent, conversation
  (a link to the reply's trace), language, when it started ("waiting" before it has a
  place), how long it has run, its time limit, bytes printed so far, connections asked
  for. Asked again every four seconds while the page is in sight. **Stop** on a row asks
  once, then ends the container.
- **Workspaces.** One row per conversation that has a working folder: person,
  conversation, the repository opened there if any, files, size, last used, and
  "Released in N days" ("next pass" when due; "running" or "kept: proposal waiting" when
  it is kept whatever its age; "on hold" under a legal hold). Sorted by last used or by
  size, by pressing the column's name. **Release** on a row, and **Release all idle** in
  the header (everything not used for a day or more), each asking once; the question for
  all names how many and how much.
- A line and a period switch (24 hours, 7 days, 30 days, 90 days) for the two tables below.
- **Runs.** Every line of `sandbox_runs` in the period, newest first, 50 to a page:
  person, when, conversation (a link to the trace), took, processor time, peak memory
  (the column is there only when a row has it; nothing records it yet), printed, network
  up and down, connections refused, ending. Filters: a person, an ending (OK, Failed,
  Timed out, Stopped, Lost, Refused).
- **Network.** The hosts code may reach, as chips (moved here from Models, unchanged:
  type to add, cross to remove, "Back to the package indexes"); and per host over the
  period: connections allowed, refused, bytes sent and received, from what each run
  recorded.

**Rules.**

- **A workspace's room comes back in three ways, none asked of the person.**
  1. *Idle.* Not used for the organization's number of days: released. "Used" is the
     runner's own mark on the folder: a run ended there, or a file was put in.
  2. *Over the cap.* Where the organization set a cap for all its workspaces and they
     hold more: after the idle ones are gone, the ones used longest ago are released,
     one by one, until what is left is under the cap.
  3. *An administrator* releases one, or all not used for a day.
- **What is never released**, by the pass or by an administrator:
  - a workspace something is running in. The sandbox service is asked to release and
    refuses while anything is being done there (`in_use`); a conversation whose reply is
    still being written counts as running too;
  - a workspace whose conversation has work on a repository that is **proposed or being
    sent** (`cloud_work.state`). What was proposed is the folder's contents until it is
    on the code host: releasing it would lose work the person was shown and has not
    decided on. It is kept until they send it or drop it, and the row says so. An
    administrator who tries is told why (`sandbox_proposal_waiting`);
  - anything in an organization under a **legal hold** (Retention): the pass releases
    nothing there and the page says "A legal hold is on"; an administrator's Release and
    "Release all idle" are refused too (`sandbox_held`).
  - a workspace used since the list it was chosen from was read: the release carries
    that time (`?idle=1&since=<ms>`) and the sandbox service refuses if the folder is newer.
- **Work on a repository that was only open**, or already sent, goes with the folder:
  its record is removed, so the agent opens the repository again rather than comparing
  with an empty folder. Changes that were made and never proposed are lost with it,
  like any other file in a working folder nobody used for that long.
- **The pass** is made once an hour by the server (`SandboxReclaim`, asked every ten
  minutes; the first a minute after start). With several server processes one of them
  makes it: whoever writes the hour's line in `sandbox_reclaim`. It reads every folder
  from the runner once, releases as above, and writes for each organization what it
  came to. A pass that released something writes one line in the activity log,
  `sandbox.reclaimed`, by "muster", with the counts (released, bytes, how many for being
  idle and how many for the cap, how many were kept because running or proposed). A pass
  that found nothing to do writes no line: it is on the page ("Last run"), not in a log
  it would fill at 24 lines a day. A folder with no conversation (deleted while the
  sandbox could not be reached) is released once it is a day old.
- **Coming back.** Nothing is asked of the person and nothing is restored: the next
  `code.run` or `repo.open` in that conversation makes a fresh, empty folder. The agent
  is told once, in that tool's result: "Note: this conversation's working folder was
  released after 9 days without use, and starts empty. What earlier runs wrote there is
  gone; files that were kept are still in the person's files … A repository that was
  open must be opened again." (or "by an administrator", or "to make room"). Never in
  the agent's instructions or its tools, which stay the same from turn to turn
  (`SandboxUse.releasedNote`; `sandbox_released.told`).
- **The runner's own sweep is a backstop.** It still ends containers past their time
  and holds all folders of all organizations to 20 GB, longest idle first. Its own idle
  period is now 90 days, the longest an organization may choose, so that it never
  releases sooner than the organization said.
- **Stopping a run.** The server asks the runner to end what runs in that conversation's
  workspace; the container is removed. The run's line ends as `stopped`, counted for as
  long as it ran. The step fails with "An administrator stopped this run. Tell the
  person so in a sentence, and do not run it again unless they ask.", so the reply goes
  on and says so; the reply itself is not cut off. Recorded: `sandbox.run_stopped`, with
  the conversation and whose it is.
- **A day's allowance** is the person's own where one is set, else their department's,
  else everyone's, else the server's settings (`MUSTER_SANDBOX_DAILY_RUNS`,
  `MUSTER_SANDBOX_DAILY_CPU_SECONDS`), shown as "from the server's settings". A limit is
  both numbers; 0 is no limit. It is what `SandboxUse.reserve` holds a run to and what
  the person sees in Settings → Usage.
- **One organization sees only its own.** Runs, workspaces and what is running are
  matched to the organization's conversations on the server; a workspace or a run of
  another organization is "not found". The State card's disk figures are the sandbox
  service's as a whole.
- Every change is in the activity log: `sandbox.run_stopped`,
  `sandbox.workspace_released` (one, or how many and how much), `sandbox.reclaimed`,
  `sandbox.settings_changed` (before and after), `sandbox.limit_set`,
  `sandbox.limit_removed`, and `sandbox.hosts_changed` as before.

**States.**

- *No sandbox set up*: one notice, "This server has no sandbox, so agents cannot run code."
- *The sandbox cannot be reached*: State says "Not ready" with why; Workspaces says it
  cannot list them; Running now falls back to the runs not yet settled, without what
  they printed; nothing is released until it answers again.
- *Stop on a run that just ended*: "Nothing is running there any more."

**How it is wired.**

- Screen: `apps/web/src/pages/Sandbox.tsx` (`SandboxPage`); what it works out itself in
  `apps/web/src/pages/sandboxLogic.ts`.
- Server: `apps/server/src/sandboxAdmin.ts` (`registerSandboxAdmin`, `SandboxReclaim`,
  `SANDBOX_ADMIN_SCHEMA`); limits and the note in `apps/server/src/sandboxUse.ts`
  (`limitsFor`, `releasedNote`); the runner's client in `apps/server/src/sandbox.ts`.
- Requests: `GET /api/sandbox/overview`, `GET /api/sandbox/running`,
  `POST /api/sandbox/running/:conversation/stop`, `GET /api/sandbox/runs`,
  `GET /api/sandbox/workspaces`, `DELETE /api/sandbox/workspaces/:conversation`,
  `POST /api/sandbox/workspaces/release-idle`, `PUT /api/sandbox/settings`,
  `PUT /api/sandbox/limits`, `DELETE /api/sandbox/limits/:kind/:id?`,
  `GET /api/sandbox/network`, and `GET`/`PUT /api/sandbox/hosts` as before.
- Runner: `GET /status`, `GET /running`, `GET /spaces`, `POST /spaces/<id>/stop`,
  `DELETE /spaces/<id>?idle=1` (`apps/sandbox/src/index.ts`).
- Tables: `sandbox_settings`, `sandbox_limits`, `sandbox_released`, `sandbox_reclaim`,
  and five more columns on `sandbox_runs` (agent, language, trace, printed, net by host).
- Tests: `apps/server/src/sandboxAdmin.test.ts`, `apps/sandbox/src/runner.test.ts`
  ("what an administrator is shown, and may do"), `apps/web/src/pages/sandboxLogic.test.ts`.

**Not built.**

- The time a run may take, how many run at once and what one workspace holds are the
  runner's and are shown, not changed, on the page.
- Peak memory of a run is not recorded.
- Stopping a run does not end the reply it belongs to: the agent goes on and says so.
- A run that waits for a place is stopped only once it gets one (up to 30 seconds).
- Runs made before this page have no agent, language, trace or per-host record.
- Not verified: the page in a browser, and any of it against a real sandbox service
  with gVisor; the tests use a stand-in for Docker and for the runner.

## The sandbox, for whoever runs the server

**Who it is for.** The operator, and the administrator who is asked "where does that code
run?".

**The job.** Know that it is on, know what keeps it apart, and find out what happened
when something goes wrong.

**Where it starts.** `#/admin/sandbox` → **State**. On the machine:
`docker compose logs sandbox`.

**What they see and can do.**

- `#/admin/sandbox` shows one of: **Ready · gVisor** (green); **Ready · plain container**
  (amber: allowed by name for development, not for production); **Not ready** with the
  reason in words ("building the image; this takes a few minutes the first time", "Docker
  has no gVisor runtime…"); or, with no sandbox set up, one notice saying so.
- Traces (`#/admin/traces`) show each `code.run` call as a span like any tool call: the
  code that was asked for and what came back, cut at the usual length.
- The runner writes one line of JSON for each thing it does, to its own log:

  ```
  {"at":"…","event":"ready","isolation":"gvisor","runtime":"runsc","image":"muster-sandbox:fb981f08c3d8"}
  {"at":"…","event":"run","space":"<conversation id>","language":"python","exit":0,"timedOut":false,"ms":753,"in":1,"changed":1,"bytes":96420}
  {"at":"…","event":"run.broke","space":"…","code":137,"ms":2400,"why":"…","said":"…"}
  {"at":"…","event":"sweep","forgotten":3,"bytes":1200000}
  {"at":"…","event":"cleared","containers":1}
  {"at":"…","event":"ended_late","container":"muster-sandbox-…"}
  {"at":"…","event":"not_ready","reason":"…"}
  ```

  `in` is how many files the run was handed, `changed` how many it wrote, `bytes` what the
  working folder holds afterwards. The code itself is never in this log: it is in the
  trace, where reading it is a permission.

**Rules: what keeps the code apart.**

- **A container for each run, thrown away after it.** Started with gVisor (`runsc`), which
  puts its own kernel between the code and the machine's. The runner looks for a Docker
  runtime whose name holds "runsc" or "gvisor" and runs nothing without one, unless
  `SANDBOX_ALLOW_CONTAINER=1` allows an ordinary container; that is for a developer's
  machine.
- **No network** (`--network none`), **a read-only system** (`--read-only`), **no
  privileges** (`--cap-drop ALL`, `no-new-privileges`, not root), **limits** on processor,
  memory, processes and time. Flags: `apps/sandbox/src/runner.ts` (`run`).
- **The way out is this service, and only for what is on the list** (since 2026-11-24,
  MUS-4; `apps/sandbox/src/egress.ts`). The container still has no network interface but
  its own loopback. Inside it a small program listens on that loopback
  (`127.0.0.1:8118`, set as `HTTPS_PROXY`) and passes every connection made to it out
  through the run's standard output, as pieces (`apps/sandbox/src/wire.ts`); the answer
  comes back on its standard input. So there is no Docker network between a run and
  anything, nothing a run can scan, and no difference between runtimes: it works the same
  under gVisor on a rootless Docker as in an ordinary container. The runner reads each
  connection as a proxy request and lets it through only when all of these hold:
  - it is `CONNECT name:443`, the name is a host name (never an address) and is on the
    list that came with this run (a name, or `*.example.com` for every host under one);
  - every address the name has is a public one. Loopback, the private ranges, link-local
    and metadata addresses (`169.254.0.0/16`), carrier-grade NAT, IPv6 local and
    IPv4-in-IPv6 forms are refused, and one such address among several refuses the name;
  - the connection is made to the address that was looked at, not to the name again, so
    a name that answers differently a moment later gains nothing;
  - the first bytes sent through it are a TLS greeting naming the same host. A connection
    opened to an allowed host and then used for another site at the same address is ended
    before anything of it goes out.
  Anything else is answered `403` and put on the run's record with the host and the
  reason; a refused connection is over, and nothing more sent on it is read. A run may
  send 32 MB out and take 1 GB in, over at most 16 connections at once. An address is
  public only if it is ordinary IPv4 outside every reserved range, or IPv6 from the part
  handed out to the world (`2000::/3`) less Teredo, 6to4, the documentation and
  benchmarking ranges; an IPv4 address written as an IPv6 one (`::ffff:…`, `::a.b.c.d`,
  `64:ff9b::…`) is never one, nor is any address this machine itself has.
- **One run cannot fill this service's memory** (review, 2026-11-24). What waits to be
  handed to a run that is not reading is counted; past 8 MB, or past 2,000 connections
  asked for in one run, the container is killed and the run ends "it opened connections
  faster than it read their answers". Inside the container each connection has its own
  sender, so one the code does not read holds up no other.
- **A connection's bytes go no faster than they are taken** (MUS-53). Each side may send
  512 KB of a connection (`WINDOW`, `wire.ts`) and then waits for a `W` piece saying how
  many more: the container says it as the code reads what came for it, the runner as the
  host takes what the code sent. The host's socket rests while the code is behind
  (`egress.ts`), and the code's own writes wait while the host is. So code that reads a
  large download slowly gets all of it; before, a connection with 16 MB waiting was cut.
  Whatever a run says, it is never sent more than a window ahead; the caps above (8 MB
  waiting, 2,000 connections, 32 MB out, 1 GB in) hold as before.
- **The code cannot write the answer's pieces itself.** It runs as the same user as the
  program that packs the answer (`entry.py`), and could otherwise open that program's
  open files through `/proc`. The program marks itself not to be looked into
  (`PR_SET_DUMPABLE` 0), which makes its `/proc` entries root's; tried on Linux in an
  ordinary container with the run's own flags: the code saw none of its files and could
  write to none. Not tried under gVisor. If it did not hold there, the code could forge
  what it printed and what it wrote (which is its own to say anyway) and end its own run
  early; it could not change what is counted, which is this service's clock.
  **What this does not stop:** nothing is decrypted, so what code says to an allowed host
  is between the two. An allowed host that accepts uploads is a place data can be sent
  to; that is why the list is the administrator's and starts with package indexes only.
  The check of the greeting stops the plain case of one address serving many sites; a
  host that itself passes requests on is not seen through. A package that is installed is
  code from the internet, run inside the sandbox like the agent's own.
- **The runner has a way out of its own** since then (`deploy/compose.yaml`, network
  `egress`): it is the one that connects. It connects to nothing but what it resolved and
  found public for a host on the list.
- **Nothing of the machine is mounted into it.** The working folder is memory inside the
  container. The files go in on standard input as one stream and come out on standard
  output as one. The stream is this service's own and has room for nothing but names and
  content (`apps/sandbox/src/bundle.ts`): no link, device, owner or permission can be
  written in it.
- **What comes out is not trusted.** The code runs as the same user as the script that
  packs the answer, so the answer could be forged. The runner checks it whole (`unpack`,
  `apps/sandbox/src/bundle.ts`) and refuses all of it when anything in it is not as it
  should be: a name that climbs out (`safePath`), the same name twice, a file where
  another's folder is, a length that runs past the end, anything after the end. Then
  nothing is written and the step fails with "the run gave no answer that could be
  read". What it says was printed is cut to what a run may hand back, whatever came. A
  forged answer can still claim the run ended well; that gains nothing, since the code
  could have written the same files honestly.
- **The runner takes nothing from a request into the command it starts**: no image, no
  flag, no path. A request names a working folder (an id), a file name (checked), a
  language (one of two), the code (handed in as a file, never as an argument) and a time.
- **Nothing outlives its watcher.** Each container carries the time by which it must
  have ended. The runner ends one that is past it (every five minutes), ends its own when
  it is told to stop, and ends any it finds when it starts.
- **The runner is itself limited** to 3 GB of memory and 512 processes
  (`deploy/compose.yaml`): a working folder passes through its memory on the way in and
  out, and past the limit it is the runner that is restarted, not the machine.
- **The runner holds Docker's socket**: that of the Docker it runs on, which the
  deployment script finds (`scripts/deploy-commit.sh`; `SANDBOX_DOCKER_SOCK`). Under an
  ordinary Docker that is as much as being root on the machine. Under a rootless Docker
  it is as much as being the user Docker runs as: not root, but
  the owner of every other container there, the database's among them. It
  is the only service that does; the server does not. It listens on a network that has no
  way out and that only the server is on (`deploy/compose.yaml:97`). There is no
  password between the two: being on that network is what is trusted.
- **The image holds everything a run may use**, since nothing can be fetched: Python 3.12
  with pandas, numpy, scipy, matplotlib, seaborn, scikit-learn, statsmodels, openpyxl,
  xlsxwriter, python-docx, python-pptx, pypdf, PyMuPDF, Pillow and more; LibreOffice,
  poppler, Chinese fonts (`apps/sandbox/image/Dockerfile`). The runner builds it when it
  starts, under a name made from the content of that folder, and removes the images of
  earlier versions.

**What an administrator sees and can do (since 2026-11-24).**

- `#/admin/sandbox` → **Network**, **Hosts code may reach**: the hosts as
  chips. Type a name and press Enter (or +) to add one; press a chip's cross to take it
  away. It is saved as it is changed, and the next run goes by it. "Back to the package
  indexes" appears once the list differs from the one it began with. With no host, the
  line reads "None: code reaches nothing." A name that is an address, or has a port or a
  path, is refused with why. Whoever may read settings sees the list; whoever may change
  them changes it; each change is in the activity log (`sandbox.hosts_changed`, before
  and after).
- The same page: everything in "The Sandbox page" above (daily limits, every run,
  workspaces, what code reached by host).
- A person: Settings → Usage, one line.

**States.**

- *First start, or the image changed*: "Not ready: building the image", for a few minutes.
  The runner answers `/health` meanwhile, so a deployment does not wait for it.
- *The build failed, or Docker has no gVisor*: "Not ready" with the reason; the runner
  tries again every ten minutes. Agents are not offered the tool until it is ready.
- *The runner is down*: the server takes it as not ready within 20 seconds.

**How it is wired.**

- Service: `apps/sandbox` (`@muster/sandbox`), Node with no dependencies.
  `src/index.ts:38` (`serve`): `GET /health`, `PUT` and `GET /spaces/<id>/files/<name>`,
  `POST /spaces/<id>/run`, `DELETE /spaces/<id>`. `src/runner.ts:219` (`prepare`: the
  runtime and the image), `:488` (`run`), `:419` (`sweep`). Inside the container:
  `image/entry.py` (takes the files in, runs the code, hands back what changed) and
  `image/look.py` (the `look` command).
- Settings. The server: `MUSTER_SANDBOX_URL` (`apps/server/src/config.ts:146`); the
  compose file sets it to the service beside it, and setting it to nothing turns code off.
  The runner: `SANDBOX_RUNTIME` (use this Docker runtime, not the one found),
  `SANDBOX_ALLOW_CONTAINER=1` (run without gVisor), `SANDBOX_SPACES` (where working
  folders are kept; the `spaces` volume), `PORT` (7420).
- Requests: `GET /api/system` gains `sandbox` (`apps/server/src/product.ts:594`), asked of
  the runner at that moment. Screen: `apps/web/src/pages/System.tsx:128`.
- Data: no table. Working folders are folders on the `spaces` volume, named by
  conversation id.
- Tests: `apps/sandbox/src/bundle.test.ts`, `apps/sandbox/src/runner.test.ts` (Docker is
  stood in for; what is checked is what the runner asks of it and what it does with the
  answer).

**How it was tried (2026-11-23).** On a Mac with Docker Desktop, in an ordinary container
(no gVisor there): Python reading a CSV and drawing a chart with Chinese labels; no
network; the system not writable; a run past its time; one past its memory; `look`
finding text on text in a slide made for the purpose; a file name of 43 Chinese
characters; 6,000 files written by one run (4,000 handed back, the rest named as not
kept); a file name that is not text; a folder replaced by a file; three million
characters printed (200,000 came back). The same container flags were
started under gVisor on a Linux server with a plain Python image: the kernel answered as
gVisor's, the working folder was writable, the system was not, and there was no network.
With the real model (DeepSeek) in the web app: a 3,600-row CSV totalled by region and
month, the figures checked against a separate calculation and equal to the cent; a chart
kept as a PNG and shown on the reply's card; a three-slide deck made and checked with
`look`.

**How the way out, live output and stopping were tried (2026-11-24).** Without Docker: the
program that runs inside the container (`image/entry.py`) was started by the runner's
tests as it is in a container, over the same standard input and output
(`apps/sandbox/src/inside.test.ts`): files in and out, lines arriving while the code
still ran, a run ended at its time and when stopped, a connection passed out and
answered. Once, by hand, against the real package index from that program: `curl
https://pypi.org/simple/six/` answered 200 through the runner (590 bytes out, 21 KB in);
`https://example.com` was refused as not on the list; `http://pypi.org` was refused as
not https; and a connection opened to `pypi.org` and greeted as `example.com` was ended.
Then (review fixes, same day): a run that never reads its answers was ended with no
more than the cap waiting; a connection flooded with 4 MB the code never read did not
stop a second one from being answered; and `entry.py` was run once in a Linux container
(runc, `--network none --cap-drop ALL --user 1000`) to see that the code cannot open its
files. **Not tried:** the whole of it under gVisor on the rootless
Docker production runs (what is assumed there: a container started with `--network none`
still has its own loopback to listen on; if it has not, the run goes on with no way out
and says so nowhere but in failing connections); `pip install` itself (the image is not
on this machine); the pages in a browser.

**Not built.**

- No password between server and runner (see above).
- The hosts are one list for the organization; there is none per agent or per person.
- No alert when the sandbox is not ready; the console says so when someone looks.
- No way for an administrator to turn code off for some people or some agents: it is on
  for everyone who may make files, or off for the server.
- A machine without gVisor can only run code by allowing an ordinary container.
- The library versions in the image are whatever was newest when it was built; they are
  listed in `/opt/versions.txt` inside it, not pinned in the repository.

**Design findings.**

- A person cannot tell from the reply alone that code ran in a sandbox rather than "in
  Muster"; the opened step says so. Enough for now; a word on the row would crowd it.
