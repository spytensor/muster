# Coding on the desktop: working in the person's own repositories

**Built** on 2026-11-18 (CHA-272, first piece CHA-273). Tickets for what follows: CHA-274
(Changes and Run beside the conversation, undoing a reply's changes), CHA-275 (a channel
that does not need the page, checks the harness runs itself, what the owner's coding standard
asks built in).

Where the code is:

- On the computer: `apps/desktop/src/bench.ts` (commands, jobs, exact edits, what a folder
  is), `apps/desktop/src/local.ts` (read, search, find, write, and where an agent may go),
  wired in `apps/desktop/src/main.ts` (`muster:local`, `muster:describe`, `muster:halt`)
  and `preload.ts`.
- On the server: `DEVICE_TOOLS` in `apps/server/src/runtime/catalog.ts`; the tools and the
  confirmation's content in `runtime/tools.ts`; the rules for a command in
  `runtime/commands.ts`; the gateway, the waits and what the agent is told in
  `runtime/runs.ts` (`confirmExec`, `CODING`, `described`); keeping a conversation within
  the model's window in `runtime/compact.ts`.
- On the page: `deviceFor`, `stop`, `StepRow` in `apps/web/src/app/Chat.tsx`; the card in
  `apps/web/src/app/approval.tsx`.
- Tests: `apps/desktop/src/bench.test.ts`, `apps/server/src/runtime/commands.test.ts`,
  `apps/server/src/runtime/compact.test.ts`, and "works on code there" in
  `apps/server/src/product.test.ts`.

**Who it is for.** A member using the Muster desktop app, in a project with folders
attached, with an agent whose own tools write the person's files or documents (the general
agent does). A browser tab cannot do any of this.

**The job.** "I have a product in several repositories on this computer. I say what I
want; it finds the code, changes it, runs it, and tells me what it did. Tomorrow, after I
changed things myself, it goes on from what is on the disk."

## What was taken from OpenClaw and what was not

The owner asked for upstream `v2026.9.8` to be read first (decision D-2: piece by piece).
Read on 2026-11-18, clone at commit `fc23bc8`:

- Upstream's coding tools are two families: the session tools (`src/agents/sessions/tools`,
  read / bash / edit / write / grep / find / ls, 5,869 lines) and its own `exec` / `process`
  tools (11,536 lines on a 15,075-line process layer). **None can be taken unchanged**: each
  carries terminal rendering, and reaches through the gateway, sandbox, approvals or a
  file-safety package Muster does not have. The `exec` family, sub-agents, sessions,
  approvals, sandbox and system prompts are welded to OpenClaw's gateway.
- About 1,550 lines are pure and could be lifted as they are: the edit engine (matching
  with a fuzzy fall-back, line endings and byte-order mark kept, a diff of the change) and
  the output accumulator.
- Upstream has **no** check that a file is as the agent last read it, **no** permission
  logic in its shell tool, and assumes the loop and the files are on one machine.
- **In use for the first time**: the compaction core already vendored in
  `vendor/openclaw/agent-core/src/harness/compaction` (`estimateTokens`,
  `estimateContextTokens`, `generateSummary`), driven by `runtime/compact.ts`.
- **Decision**: the tools on the computer are Muster's own, written against its rules
  (attached folders only, protected names, read-before-change, the gateway decides). The
  next thing to take from upstream is its edit engine, in place of the simpler matching in
  `bench.ts`; the tree-kill already vendored (`harness/env/kill-tree.ts`) can replace the
  process-group kill for Windows.

## What an agent can do there

All paths begin with an attached folder's name. The file tools (list, read, search, find,
edit, write) do nothing outside the attached folders, in `.git` or `node_modules`, or on
names that hold secrets (`.env`, keys), and write nothing where tools run things
(`.vscode`, `.github`, `.husky`): the rules `local.ts` already had. A link that a
repository holds to somewhere else is not followed, by a search or as the repository's
instructions. A command is another matter: see what asks.

| Tool | What it does | Limits |
|---|---|---|
| `local.list` | What is in a folder | 500 entries |
| `local.read` | A text file; with `from` and `lines`, a part of a long one | 256 KB whole; by lines up to 4 MB, 2,000 lines a call |
| `local.search` | Lines that contain words, or match a pattern (`regex`); `glob` for files of one kind | 8,000 files and 60 hits **for each attached folder**; ends by saying how much of each was looked through; a pattern is tried on the first 2,000 characters of a line, and one that repeats something that itself repeats is refused, since it runs where the whole app runs |
| `local.find` | Files by a name pattern, newest first | 200 shown |
| `local.edit` | Replaces one exact piece of a file (`old` → `new`; `all` for every place) | only a file the agent has read (a part is enough), and only if it has not changed since; a piece that is there more than once is refused; spacing that differs is set aside when one place matches line for line, and then `all` is refused; the file's own line endings are kept |
| `local.write` | A new file, or the whole of one | 1 MB; over an existing file only if the agent has read all of it and it has not changed since |
| `local.exec` | A command in the person's shell, in a folder (`in`) | waits 60 s (`wait`, 110 at most), then the command becomes a job; `background: true` starts a job at once; output is cut to its beginning and end (30,000 characters an answer); nothing can be typed into it; 8 running at once |
| `local.job` | Lists jobs; reads what one printed since last read, waits for it, or stops it | a job goes on after the reply; when the app quits each job's process group is ended; a job that ended is kept ten minutes for its last output |

- A repository is searched through what git knows of and does not ignore, so a build's
  output is not gone through; any other folder is walked.
- A command runs as the person: `$SHELL -lc` (`cmd /c` on Windows), with the usual places
  added to `PATH` (an app started from the Dock has fewer), no terminal, no pager, and
  git forbidden to prompt. It can do what the person can do in a terminal. **What bounds
  it is the gateway's decision before it runs, not a sandbox.**
- When a reply ends without finishing (stopped here or elsewhere, or failed), the page
  has the app end the commands that reply was waiting on (`muster:halt`). Jobs go on. What a
  project's conversations have read and the jobs they started are held for the project,
  not for each conversation.
- Git is asked by the app itself (which files a repository holds, its branch and state)
  without its monitor, without a pager and without taking a lock on the person's
  repository.

## What asks, and what does not

Decided at the gateway (`gate` in `runs.ts`) by the conversation's mode, which is the
person's to choose (an administrator's ceiling on it was removed on 2026-11-21, see
[workspace: modes](workspace.md)):

| | "Ask first" | "Auto" and "Full" |
|---|---|---|
| Reading, searching, finding, a job's output | passes | passes |
| A command that plainly only looks | passes | passes |
| Any other command (a test run, a commit, a build) | asks | passes |
| Changing or writing a file | asks | passes |
| A command that reaches outside the folder, sends something, reads where keys are kept, or cannot be undone | **asks** | **asks** |

A command is read as a shell would cut it up (`parse` in `commands.ts`): into the commands
joined by `;`, `&&`, `||`, `|`, a lone `&` and line breaks, each into its words with quotes
taken off. What cannot be read with certainty (an unclosed quote, a backslash) asks in
every mode.

**Plainly only looks** (`onlyLooks`): every command of the line is one of a short list of
programs that only show something (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`,
`diff`, `sort`, `uniq`, `tree`, `jq`, `stat`, `file`, `du`, and of git: `status`, `diff`,
`log`, `show`, `blame`, `rev-parse`, `ls-files`, `ls-tree`, `describe`, `shortlog`, and
listing branches), or any program asked only for its `--version`; called by its plain
name; without an option that writes a file or starts a program (git's `--output`, `-c`,
`-C`, `--no-index`; `rg --pre`; `find -delete`, `-exec`, `-fls`; `sort -o`; a second file
to `uniq`; `tree -o`; `tail -f`); with nothing the shell would put something else in place
of (`$`, backticks, `>`, `<`, a wildcard outside quotes); nothing put in the background;
no word that points outside the folder (a path from `/`, `~`, `..`) and none that names
where secrets are kept. `sed` and `git remote`/`git config` are not on the list.

**Asks in "Ask first" and "Approve for me"** (`risk`), decided by the program each command
calls, not by a word appearing somewhere in it (a commit message that says "push" is not a
push). Until 2026-11-21 these asked in every mode. The owner, on being asked about a loop
that counted files: "用户太燥热了…一直在点击授权". Three things were wrong and were changed
that day:

- "Full access" still asked about them, so no mode stopped the asking. It no longer does:
  full access is the person's word about their own computer, and since the same day no
  administrator decides whether they may give it. A check Muster runs itself still asks,
  once.
- A backslash anywhere made a command unreadable, and what cannot be read is asked about:
  every `printf "…\n"` asked. A backslash is now read as the shell reads it.
- A loop's or a condition's body was judged as a program called `do` or `then`, which is
  none, so `for x in 1; do git push; done` did **not** ask. The shell's own words are now
  passed over, and what stands in `$(…)` or backticks is judged as the commands it is.

The mode chip, hidden by the quiet start until a mode had been chosen
(`docs/design/quiet-start.md`, Q-3), is shown again always: with it hidden nobody found
the modes.

What an independent review tried on the day and what was changed for it (all in
`commands.ts`, each with a case in `commands.test.ts`): looking into nested `$(…)` from
every level took a time that grew without bound, so that one short command could hold the
server (each is now found once, whole; a line over 20,000 characters or nested more than
six deep is asked about); a comment is a comment, quotes and backslashes in it included; a
here-document, `$'…'`, a function, a `case` and a pattern that runs code are not read and
so are asked about; what `find -exec`, `xargs` and programs that run another (`env`,
`timeout`, `nice`, …) run is judged as itself; a program called by a path outside the
folder is outside, also after `then` or `do`; `<(…)`, `>(…)` and `=(…)` are looked into;
an apostrophe inside double quotes begins no single quotes. Left: arithmetic that
evaluates a variable's text again (`x='a[$(cmd)]'; echo $((x))`).

A second review of those changes, the same day, found two more that would have stopped
the merge, and both were changed: trying every word after a program that runs another,
inside one another, again took a time without bound (`xargs` a hundred times held the
server for eighteen seconds), so all that is looked at for one command now has one bound
(`Budget`, 2,000 steps; brackets and quotes nested more than sixty deep, more than two
hundred words after such a program, or anything that throws, are asked about); and what a
comment is was decided in two places that disagreed (after a carriage return, an escaped
space, a joined line), so that `$(git push)` could stand where one place saw a comment. A
comment is now decided in one place (`plain`), a line with a carriage return is not read,
and never "only looks". Also from that review, each with its case in the tests: where
output goes (`> x`, `2>&1`) is no part of what is run, wherever it stands, and the places
it names are judged; a program whose name the shell works out when it runs (`$g push`,
`g?t push`, `{git,push}`) is asked about; variables set for the one command that decide
which program runs (`PATH`, `LD_PRELOAD`, `GIT_SSH_COMMAND`, …); `trap`, `alias`, `git -c`,
`git config` that writes, a shell fed from somewhere; `npx` and `pnpm exec`; `rm -rf ./.git`,
`rm -rf */`, a bare `cd`; anything written into `.git/hooks`. A here-document whose end
word is quoted (`<<'EOF'`) is read as the text it is, so that writing a file that way does
not ask; one whose end word is not quoted still asks. Left, known: `python -c`, `node -e`,
`perl -e` and `awk` with `system()` run without asking, like running a script file does.

A third review, of the second's changes, again found what would have stopped the merge.
Two were new: the reader that takes comments and here-documents out did not follow a
substitution inside double quotes, took a quote in it for the end of the quotes around
it, and cut real commands away as a comment (`echo "$(echo " #" ; git push ; …)"`); and it
took a here-document's end word to be only what stands in the quotes, where the shell
takes what is written against them too (`<<'E'b`). The reader now follows quotes and
brackets into one another as the shell does (`plainCode`, `plainQuoted`), which also ends
a false alarm: a commit message written as `"$(cat <<'EOF' … EOF)"` with an apostrophe in
it no longer asks. Two were old and one character long: an arrow written against a word
(`git>x push`) and a shell's `-c` among other letters (`bash -lc '…'`, the very form the
desktop app uses). Also changed, each with its case in the tests: no program name is
taken from what every object has (`__proto__` made `onlyLooks` throw); what is looked at
is paid for by its size, not by the call; a lone `.` after a program that runs another is
a place, not `source` (`npx eslint .` asked); `git submodule foreach`, `bisect run`,
`difftool -x`, `--config-env`; a variable that decides which program runs, also when set
with `export` or alone on a line; the repository's own record however it is written or
reached (`rm -rf .g*`, `mv .git x`, `: > .git/HEAD`, `.git//hooks`, `.husky`); `pushd`
and `popd` alone.

A fourth review did not reason about the code but wrote about 3.6 million variants of
the risky commands in the tests, ran them through the code as it was before the day's
changes and as it was after, and ran in a real bash and zsh those that had asked before
and no longer did. It found four ways, of two kinds. Reading more had gone wrong: an
arrow inside quotes was taken for an arrow, so that `ls 'x>'&git push` was one command
that only looks; a `#` inside `${x%% #*}` was taken for a comment and the rest of the
line cut away. And reading more had opened what refusing had closed: lines joined between
`$` and its bracket; backslashes inside backticks. The answer to the second kind is not
to read better but to read less: backticks, and a `${…}` that is more than a name, are
**not read, and so asked about** (`plainCode`, `simpleName`). What a word ends with is
now known from how it was written, not from its text (`arrow`, `stream` in `parse`);
joined lines are joined before anything else is read; a bracket that closes a group is
no part of a word, so `(cat .env)` reads `.env`. Three false alarms it found are gone
(`IFS=` before `read`, `{ …; } > out`, `popd`).

The tests now do in small what that review did: ten risky commands, each written in
sixty ways (after a keyword, in a group, in a substitution, with arrows before, after and
inside, with joined lines, after a here-document, fed to a shell), all expected to ask and
none to be taken for looking (`commands.test.ts`, "still asks when a risky command is
written another way").

A fifth review, done the same way over 3.6 million variants, found nothing that this
day's changes had opened and that really runs, no input that throws and none slower than
27 ms, and said to merge. It could put only the first 2,000 of some 355,000 differences
through a real shell before its own harness stopped; those were its own artefacts or the
three small things changed with it: zsh's pattern that runs code after a bracket that
closed (`ls (*)(e:'cmd':)`), what bash takes as the next word after `>&-`
(`git >&-push`), and a command after an array (`x=(a b) git push`). What it counted of
false alarms, of 220 everyday commands: 28 ask now where 13 did, most of them for a
`${…}` that is more than a name (`${VAR:-default}`, `"${arr[@]}"`, `${file%.ts}`) and
for backticks. That is the price of reading less, and the place to look first if the
asking is felt again.

**What this is and is not.** Five reviews, four of which found ways past it; a sixth
would find more: it reads a line of shell with rules, not with a shell. It is a guard against
an agent doing by mistake what the person would not want, and it makes the plain forms of
the dangerous commands ask. It is not a wall against a line written to get past it; that
is what "Ask first" is for, where everything that does not plainly only look asks.

What asks:

- any word that points outside the folder the command runs in: a path from `/` (other
  than `/dev/null`), `~`, a `..`, the home folder by its variable;
- any word that names where keys and passwords are kept, by the same names the file tools
  refuse (`.env`, `.ssh`, `.aws`, `.npmrc`, `.config`, key files, shell histories), also
  after a `:` as in `HEAD:.env`; a variable whose name says it is a token, secret, key or
  password; `printenv`, and `env` by itself;
- administrator's rights; deleting `.git`, by wildcard, or the folder itself; disk tools;
- of git: `push`, `reset --hard`, `clean -f`, discarding with `checkout`/`restore`,
  deleting a branch or tag, `rebase`, rewriting history, `commit --amend`, dropping a
  stash, changing remotes;
- publishing a package; `gh` for anything but viewing; `docker push`/`login`;
- cloud and deploy tools; `ssh`, `scp`, `sftp`, `telnet`, `nc`, `rsync` to another host;
- `curl`/`wget` that send (a method other than GET, data, a form, an upload) or that put a
  variable into what they send;
- a shell fed by a pipe or given `-c`, `eval`, `source`;
- changing permissions widely, `crontab`, `launchctl`, `systemctl`, `defaults`;
- stopping the computer or other programs; `open`, `osascript` and the like.

The confirmation shows the whole command, the folder it runs in by name, and why it asks.
A step shows a command's line breaks as `⏎`.

An option cut short, as the GNU tools take them (`--out` for `--output`), counts as the
option it could be. A program's `--version` passes only for a fixed list of developer
tools.

**What this does not see**, so nobody assumes otherwise: it reads words. A repository
whose own `.git/config` names a program for git to run (a diff or text-conversion driver,
a file monitor) has it run by `git status`, `git diff`, `git log -p` and `git show` like
any git on that repository would; a clone does not bring such settings, but a folder
copied from elsewhere can. (The app's own questions to git switch these off; a command the
agent runs is run as written.) A script the
agent wrote earlier, a package's own `scripts`, a git alias, a program not named above
that sends or deletes (a `python -c`, a build tool's plug-in) are run as any other command:
they ask in "Ask first" and pass in "Auto" and "Full". A `curl` that only fetches passes
even though the address it fetches is told what was asked for. In "Auto" a command can
read any file the person can read inside the folder; what it prints goes to the model.

## The computer does what the server asked, not what the page says

Until 2026-11-18 the desktop app did whatever the page it shows asked of it (`muster:local`),
and the page is the server's. With commands, a page that was tampered with (a fault in how
a reply is drawn, for instance) could have had the computer run anything. Now the page
only says which call of which conversation it is; the app itself asks the server, with its
own session, what that call is (`GET /api/app/conversations/:id/device/:call`, answered
only while the call waits and only to the session the message came from) and does that
(`asked` in `apps/desktop/src/main.ts`, `deviceCall` in `runs.ts`). This holds for every
tool, reading included. A call the server does not hold is refused, and a call is told
and done once: the server answers for it a single time, and the app keeps what it has
already begun. The server itself is
still trusted: it is the company's.

## What the agent is told

When the agent has these tools and folders are attached (`CODING` and `described`):

- How code is worked on: look before changing; follow the repository's own ways; change a
  piece at a time; search inside a folder that was not looked through to the end; check the
  work by running what the repository itself uses, and never report work as done over a
  check that was not run or failed; the person's uncommitted work is theirs; do not commit,
  push or publish unless asked for exactly that; a command the person refused is not tried
  another way; a dev server is a job, and its address is told; refer to code as
  `path:line`.
- What each attached folder is: a git repository, its branch, how many files have
  uncommitted changes (said to be the person's own, there before the work began), or that
  this is not known when git did not say in time; or not a repository. The desktop app finds this (`describe` in `bench.ts`) and it goes with each
  message (`device.notes`).
- What a repository says of itself: `AGENTS.md` and `CLAUDE.md` at its root when they are
  files themselves (not links), 6,000 characters each and 24,000 in all, marked as the
  repository's own guidance that cannot change what the agent may do; the words cannot
  close their own frame. With such a file in play, keeping a memory asks first.

An agent a step was passed to (CHA-264) is told the same when it has the tools.

## Keeping a conversation within what the model can hold

Before 2026-11-18 a reply was shown the last 40 messages and nothing of what came before,
and a run that read more than the model's window failed at the model's endpoint. Now
(`runtime/compact.ts`, through the loop's `transformContext`):

- Before each asking of the model, what is about to be sent is measured (the service's own
  count of the last asking where there is one, an estimate otherwise) against the window
  less room for the answer.
- Over the mark, first: what steps brought back, other than the last six, is left out when
  longer than 1,500 characters, and a line in its place says so. Nothing is asked of the
  model for this.
- If that is not enough: the earlier part is summarised by the model (the summariser
  vendored from OpenClaw, told to begin with what the person asks for now) and the summary
  stands in its place, marked as Muster's and as not an instruction. The most recent turns
  are kept whole, from the start of a turn, so that a call is never parted from its result.
  A later summary is made from the earlier one, not from the beginning. If the summary
  cannot be made the work goes on and a line says that a part is left out.
- The person sees a step: "What earlier steps brought back was left out to make room" or
  "The earlier part of this conversation was summarised to make room".
- What is on record does not change: the transcript, what is kept to go on with, the trace.
- A reply is now shown the last 200 messages. The window is `MUSTER_MODEL_CONTEXT_WINDOW`
  (128,000 when not set): **set it to the model's real window**.

## Beside the conversation: Changes and Running (CHA-274)

**Built** on 2026-11-18: `changes`, `jobsOf`, `stopJob` in `apps/desktop/src/bench.ts`
(`muster:changes`, `muster:jobs`, `muster:stop-job`), `apps/web/src/app/code.tsx`
(`CodePanel`), shown in the side panel of a conversation in a project, in the desktop app.
Tests: `apps/desktop/src/bench.test.ts`. The panel itself was type-checked and not seen.

- **Changes**: for each attached folder that is a repository, its name and branch, and
  each file with uncommitted changes (`git status`): changed, added, deleted, renamed, or
  new. Pressing a file shows the difference from what is committed (`git diff HEAD`), or
  the whole of a new file, coloured line by line. 80 files a repository; a difference
  longer than 60,000 characters, a file that is not text, and a file whose name says it
  holds secrets are named and not shown. Read again every five seconds and whenever the
  agent does something.
- **Running**: the jobs going on in the project, each with its command, how long it has
  run, and a stop button; pressing one shows the last of what it printed.
- Both are read from the person's computer by the desktop app. Neither is sent to the
  server.
- A file an agent changed here since the app started is marked "agent"; the rest is the
  person's own uncommitted work. The mark is the app's memory, gone when it restarts.
- Under a job that printed an address on this computer (`http://localhost:…`), the address
  is a link that opens in the person's browser.

**Undoing a reply's changes, outside a repository** (in a repository, since 2026-11-24, it
is git's, covers commands and outlives a restart: see "A piece of work of its own"
below). (`changed`, `undoable`, `undo` in `bench.ts`;
`muster:undoable`, `muster:undo`; the line under a reply in `Chat.tsx`). The app is told
with each call which reply it belongs to, and puts by what a file held before that reply
first changed it with `local.edit` or `local.write`. Under such a reply, in the desktop
app, "Undo these changes" puts those files back after asking: a changed file to what it
held, a new file removed. A file that no longer holds what the reply left in it (changed
again by the person or by a later reply; what counts is its content, not when it was
saved) is left as it is and said so, and so is one whose folder is no longer attached; what a command changed is not known and not undone. After
undoing, the agent must read a file again before changing it. The last 40 replies' changes
are kept, files up to 4 MB and 96 MB in all, until the app restarts; a file too large to
keep is said to be one that cannot be put back.

## The work pane (CHA-274)

**Built** on 2026-11-18, at the owner's word on seeing the first real run ("右侧的那个面板就应该派上
用上了"; Changes in the colours and layout of Claude Code's): `WorkPane` in
`apps/web/src/app/code.tsx`, `Panel wide` in `Chat.tsx`; `tree`, `view` in
`apps/desktop/src/bench.ts` (`muster:tree`, `muster:view`); `frame-src` for addresses on
this computer in `apps/server/src/web.ts`. Tests: `apps/web/src/app/code.test.ts`. Seen in
the development build of the desktop app: Changes and Files.

Beside a conversation in a project, in the desktop app, the right-hand pane is wide (up to
46% of the window, 760 px) and has five views. It replaces the list and the dialog
described above.

**Each view has a button of its own** in the conversation's bar, at the right (since
2026-11-18, the owner's word on seeing one toggle button and a row of tabs inside the
pane: "你这个按钮的功能真的没有设计好"): this work, the commands, the changes, a page, the
files, in that order. One press opens the pane on that view or goes to it; a press on the
view in front puts the pane away; the button of the view in front is marked. The pane
itself says only which view it is, with its count, and has a button at its right that puts
it away (the owner: every view opened should be closable where it is). A conversation outside a project has
the one button, for what it made and read; a browser keeps the single toggle. Which view
was last in front is kept on the device (`PANE_VIEWS` in `Chat.tsx`, `show` in
`Workspace.tsx`). The buttons for the changes and the commands carry a count while the pane
is open, whatever view is in front; with the pane away nothing is counted, because counting
asks git.

**Its width is the person's** (the owner, the same day: "都需要能够自由拖动"). The edge
towards the conversation is dragged, or moved with the arrow keys; pressed twice, or with Home, it
goes back to the width the pane has by itself. The width is kept on the device, one for the wide
pane and one for the narrow panel of a conversation outside a project, and is never less
than 240 px nor so much that the conversation, in the row the two share, has under 420 px (`Panel` in `Chat.tsx`, `paneWidth` in
`code.tsx`). The narrow panel has the same title row and button to put it away.

**The first view says where the work is and how it stands** (rebuilt 2026-11-22 to the
owner's reference, Claude Code's own panel; the design is
[`../design/context-panel.md`](../design/context-panel.md)). `Overview` in `code.tsx`, from
top to bottom:

- *Environment*: this computer and the conversation's mode; each attached folder with its
  path on this computer (`~/…`, read from the desktop app and never sent to the server),
  its branch and how many files are uncommitted, or that it is not a repository.
- *Context* (`ContextSection` in `apps/web/src/app/context.tsx`), folded or open as the
  person left it: "N% used" and used / window; a bar in parts; then each part with its
  tokens and share of the window: instructions, tools (how many), skills (how many),
  project & repositories, memory (how many), the conversation, this reply's work; then
  what is kept for the answer (above the compaction line) and what is free. Below: how far
  the compaction line is, or that it was passed; where the next reply starts (a reply's
  own reads are not carried over); when the conversation was last compacted.
  - The parts: at each asking of the model the run estimates what it was made of
    (`measureContext` in `runtime/context.ts`, on the llm span as `attributes.context`):
    the instructions' pieces by how each begins, the tools' definitions, and the messages
    shown, the earlier conversation and the person's words apart from this reply's work.
    The conversation's endpoint returns the last such asking's parts, the provider's count
    of it, the compaction line (`compactAt` in `compact.ts`) and about how much the next
    reply's conversation will take (the summary and the messages after it). The page
    scales the parts to the provider's count; without one it shows the estimate and says so.
  - *Compact conversation*: summarises the conversation so far for its agents
    (`Runs.compact`, `POST /api/app/conversations/:id/compact`). The summary is kept on the
    conversation (`summary`, `summary_seq`, `summary_at`, migration 32); every later reply
    sends it and the messages after it, not the ones it covers. The messages are kept and
    shown as they were, with a line where the summary ends and the summary beneath it on a
    press. Not while a reply is written, not under six messages, not with fewer than two
    new since the last time. What it used is a record of its own and counts against the
    day. A summary the run made itself of the earlier conversation only is kept the same
    way, so the next reply does not make it again.
- *Changes*: each repository with the lines added and taken away and the number of files,
  which leads to the changes; the commands that run, which leads to them. Below, as before:
  what waits for the person, what the conversation made, what it read, and what the agent
  can do.

Not there, of what the owner's reference shows: a phone simulator; connectors to sign in
to again (a connection is the organization's or
the person's, under their own page).

- **Changes** (with the number of changed files): every repository attached, its branch,
  and each changed file as a block that folds: the file's name and folder, lines added and
  removed, "agent" when an agent changed it here; under it the difference with the old and
  the new line number, added lines on a green ground and removed lines on a red one with a
  bar at the left, and "Unchanged lines" between two pieces of a difference. A file that
  is not text, or whose mode alone changed, says that there is nothing to show. Read again
  every four seconds while the window is in sight and whenever the agent does something;
  what has not changed is not drawn again.
- **Files**: the attached folders as a tree (what a repository knows and does not ignore;
  never what holds secrets, never a link; 6,000 files a folder), a box that finds a file by
  name, and under the tree the text of the file pressed, with line numbers (the first
  256 KB). Reading a file here does not count as the agent having read it.
- **Preview**: an address on this computer (`localhost` or `127.0.0.1`) shown in a frame
  of its own, with the address to type, load again, and open in the browser. Once the
  person has opened this view, the first address a job prints is shown by itself; before
  that nothing is loaded. Nothing but an address on this computer is taken, and never
  Muster's own page inside itself.

  What is shown there is the person's dev server, which is still somebody's code (the
  agent's, a package's). It is held in four ways, found necessary by the independent review
  of 2026-11-18: the frame has none of the app's own functions (the bridge is not given to
  frames) and cannot open windows or the person's browser; the desktop app puts the
  person's session only on requests from Muster's own page, never on one from a page
  shown inside it (`onBeforeSendHeaders` in `main.ts`); the server refuses any change that
  names another origin, token or no token (`apps/server/src/app.ts`; test in
  `app.test.ts`); and only the window itself is held to Muster's addresses when it is sent
  on, so a dev server that redirects (`/` to `/login`) still shows.
- **Running**: the jobs with their command, folder, time, a stop button and the last of
  what they printed; an address a job serves opens it in Preview.
- **This work**: what the conversation made, sent and read, as the panel showed before.

Not yet: lines of a file are not coloured by language; a file is read, not edited; the
difference is against what is committed, not against the start of the conversation;
Preview cannot show a page that forbids being framed; a reply cannot yet show a command's
result or a difference as a card of its own (the reply format has no such component, and
agents use its table of words).

## A piece of work of its own: a branch, a way back, a pull request (MUS-16, MUS-19, MUS-18)

**Built** on 2026-11-24 as one design, and changed the same day after an independent
review (what it found is said where it applies). On the computer:
`apps/desktop/src/task.ts` (the branch and the copy, the pull request),
`apps/desktop/src/undo.ts` (the way back), `apps/desktop/src/work.ts` (one call done as
part of a conversation's work), `taskStore` and `copiesDir` in `store.ts`,
wired in `main.ts` (`muster:task`, and a conversation named to `muster:describe`,
`muster:changes`, `muster:tree`, `muster:view`). On the server: `local.pr` in
`runtime/catalog.ts` and `runtime/tools.ts`; `confirmPr`, the `title` and `changes` a
device call is handed with (`deviceCall`), and one paragraph of `CODING` in
`runtime/runs.ts`. On the page: `TaskLines` and `Overview` in `apps/web/src/app/code.tsx`.
Tests: `apps/desktop/src/task.test.ts`, `undo.test.ts` and `work.test.ts` (real git repositories, a bare
repository to push to, a `gh` that is a script), "tells the computer what may change
something" in `apps/server/src/product.test.ts`, `apps/web/src/app/task.test.tsx`.

There is nothing for the person to switch on. No mode, no setting.

**A branch of its own (MUS-16).** Before a conversation's first change to a git
repository the app puts the work on a branch,
`muster/<the conversation's title>-<six of its id>`. A change is a file the agent writes
itself (`local.edit`, `local.write`) or a command that does not plainly only look
(`onlyLooks`; the server says which with each call, `changes` in what `deviceCall` hands
over). Two things hold for a command and not for a file:

- **A command never moves the work to a copy.** "Run my tests" is run where the person's
  work is, not in a copy that has neither their changes nor what they installed. So in a
  folder that holds their uncommitted work, a command runs there and nothing is arranged;
  the work moves when the agent first writes a file.
- **A branch made for a command that then changed nothing is taken back** (`unprepare`):
  the folder is put on the branch it was on and the new one, which holds no commit, is
  removed. A test run leaves no branch behind.

**A change that cannot be given its place is refused** (review, 2026-11-24): when the
folder holds the person's uncommitted work, or is on another branch than the work's, and
the copy cannot be made (no room, git refuses), nothing is changed and the agent is told
so in words to pass on. The work is never done in the person's dirty folder or on their
branch as a fall-back. A place for the copy that is taken is passed over for the next
(`…-2`, `…-3`), and what a failed try left is cleared.

| How the folder stands | What happens | The person's folder |
|---|---|---|
| Clean, on a branch | `git checkout -b` in the folder | now on the work's branch |
| The person has uncommitted work | a copy of the repository (a git worktree under the app's own data, `worktrees/<conversation>-<repository>/<name>`), on the new branch cut from the last commit | untouched: same branch, same changes |
| Another conversation's work is checked out there | a copy, cut from the branch that work came from | untouched |
| The person later puts the folder on another branch | the work goes on in a copy, on its branch | untouched |
| On no branch (a commit by itself), or no commit yet | no branch is made; the work is done where it stands | changed in place |
| Not a repository | nothing | changed in place, as before |
| A copy is needed and cannot be made | the change is refused; the agent is told what to tell the person | untouched |

The agent is told once, with the result of the call that caused it, where the work is and
what that means (in a copy: the person's uncommitted changes and whatever is not committed,
installed packages included, are not there; read a file again before changing it). From
then on that conversation's calls, and what the pane shows for it, go to the copy; paths
keep the folder's name. Another conversation, and a new one, see the person's folder. The
record (which conversation, folder, branch, base, copy) is `tasks.json` in the app's data;
the server is told none of it.

What is over is put away (`tidy`, at start and every half hour): work whose branch is
gone, or was merged into where it came from, loses its record; its copy is removed only
if it holds nothing but what is committed, and what git ignores counts as something (a
local settings file, installed packages); its branch is deleted the way git deletes a
merged branch (`branch -d`). **The timer never changes which branch the person's folder is
on**: work whose branch the folder is still on is left as it is until they leave it. A
branch merged only on the service's side by squashing is not seen as merged by git; its
copy is removed once the pull request says merged, its branch is left.

**The app's own git runs nothing of the repository's** (`HARD`, `filtersOff` in
`task.ts`): no hook (`core.hooksPath=/dev/null`; making a branch or a copy would run
`post-checkout`), no file monitor, and every filter the settings name switched off for
that call (a filter with no program is none), with line endings left as they are on the
disk. This holds for what the app does by itself: the branch, the copy, the checkpoints,
undoing. It does not hold for what the person approved: `git push` in `local.pr` is their
git as they set it up, credentials helper included.

**A way back (MUS-19).** In a repository, undo is git's and durable, and it reverses only
what the reply did (`undo.ts`). Around every changing call the whole repository is written
down twice, before the call and after it, each as a commit made with an index of the
app's own (`.git/muster-index`, one for a repository whichever of its folders is attached,
begun as a copy of the person's so that only changed files are hashed): the person's
index, HEAD and stash are never touched. What differs between the two is what that call
changed. For a file tool only the one file it wrote is taken; for a command, every path
that differs. It goes on the reply's list (`.git/muster-undo/<reply>.json`): for each
path, what it held before the reply first changed it and what the reply last left in it.
One ref for the reply, `refs/muster/undo/<reply>`, keeps what the paths held alive.

"Undo these changes" under a reply first says how many files will change and names the
first four, then puts back exactly the listed paths, each to what it held, a file that
was not there removed, a file that could be run still one. Left alone, and named:

- a path that no longer holds what the reply left in it (the person, another
  conversation or a later reply changed it since);
- a path somebody else changed between two of the reply's own changes to it.

What the person changed before the reply's first call, between its calls and after it is
never on the list (review, 2026-11-24: taking one picture before the reply and one after
made everything that moved in between the reply's). The list and the ref are removed only
once everything on it was put back; what was not stays, and the line under the reply
with it, to be tried again. The last 40 replies' are kept. A reply's changes made in a
copy are put back in that copy.

What the repository's way back does not cover is covered as before, by the file tools'
own copy, kept in memory until the app restarts: a file git ignores, a file inside
another repository within this one (a submodule, a nested clone), and any file in a
folder that is not a repository (`covers`). What a command does to such files is not
covered at all. An untracked file over 5 MB is not written down; the agent is told once
which, as "not covered by undo".

`refs/muster/*` are the app's and are local. Their commits say "Muster checkpoint" and
nothing else, never a path of this computer. An ordinary `git push` does not send them;
**`git push --mirror` would**, with every state of the folder they hold. Deleting them
(`git for-each-ref --format='%(refname)' refs/muster/ | xargs -n1 git update-ref -d`) loses
only the way back.

Why commits nothing points at and not a stash or commits on the branch: a stash is the
person's (and shared between copies); a commit on the work's branch would put the agent's
half-done states into the history the pull request shows.

**A pull request (MUS-18).** One tool, `local.pr`, after the other tools of the computer:

- `do: "open"` **always asks the person**, in every mode, full access included
  (`confirmPr`, rule `confirm-pull-request`): the card shows the folder, the title and the
  body. Then the app pushes the work's branch (`git push -u`, to `origin` or the only
  remote) and opens the request with `gh pr create`, as the person, with their own git
  and GitHub CLI credentials. Muster holds none and the server sees none. It refuses with
  words the agent can act on: no branch of this conversation's work; the folder is no
  longer on it; nothing committed; no remote; the push refused (what git said, without
  what could be a credential in an address). Without `gh` the branch is pushed and the
  agent is told to have the person open the request on the service's page.
- `do: "look"` does not ask. It reads the request's state, which checks failed, and what
  reviewers wrote on the commit the request now stands at, each cut to 1,500 characters
  and 12,000 in all. Which commit a review or a comment on a line belongs to is what the
  service recorded for it (`headRefOid`, a review's `commit.oid`, a comment's
  `original_commit_id`), never a date a commit carries, which its author writes. A comment
  on the request as a whole names no commit: it counts when the service made it after the
  first check of that commit began, and counts where no check tells when that was.
  Everything that came from the service stands inside one frame (`framed`): the names of
  the failed checks, what reviewers wrote, and what git or `gh` printed when a push or an
  opening failed. The frame's end cannot be written inside it, in any case or spacing. A
  run that has looked counts as having read from outside: keeping a memory, a follow-up
  or a project note after it asks first.
- The agent is told (in `CODING`, which is the same in every coding conversation) to stay
  on the branch, to commit and call `local.pr` when asked for a pull request, and never to
  push or call `gh` for this itself. A `git push` it runs anyway is still a risky command
  and asks as before, except in full access.

**In the pane** (the first view, under each folder, once the conversation has work there):
the branch, "from main", "in a copy" where it is one; the commits ahead; and
**Open pull request** once something is committed and there is a remote. Pressing it says
"Open a pull request for this work." to the agent as the person's message; the agent
commits what is left, and the confirmation above is where the person agrees. With a
request: its number as a link (opened in the person's browser), "open · checks failed ·
2 review comments", and **Have it fixed** while it is open and its checks failed or
someone wrote: that says so to the agent, which looks, fixes, commits, and calls
`local.pr` `open` again, which pushes the new commits to the same request and asks the
person first, as the first time. One button at most, none while a reply is being
written. The app asks the service how a request stands when the pane asks and no more
than every 45 seconds; the pane asks once a minute while it is in sight. Nothing is
polled with the pane away, and nothing is brought into the conversation by itself: each
round is the person's press.

**What is on record.** Opening a request is a step ("Pull request", its title), an
approval with its summary, and a `policy.check` span with `confirm-pull-request`, like
any confirmed action. The branch, the copy and the checkpoints are on the computer only.

**Not built, and why.**

- The copy starts without what is not committed, installed packages included. The agent
  is told; nothing is installed for it.
- A request merged by squashing leaves its local branch (git cannot tell it is merged).
- A command that goes on as a job after its call ended can change files after it was
  written down: those changes are no reply's, and are not put back.
- While a command runs (up to 110 seconds), what the person changes in the repository is
  taken for the command's: the two cannot be told apart. A file tool has no such window.
- What a command does to files git ignores is not covered by undo.
- A command run in a folder that holds the person's uncommitted work changes that folder,
  on their branch (see why above); the work moves to a copy only when the agent writes a
  file, and the copy does not have what the command changed.
- The confirmation before undoing names four files and counts the rest; the whole list
  is the lines said afterwards. The shared confirmation dialog takes one sentence.
- GitHub only, through `gh`. Other services get the push and are told to open the
  request by hand.
- The request's state is kept on the computer the work was done on; another device, the
  browser and the phone do not show it.
- CI and review comments are not pushed into the conversation unasked, and no reply is
  started by them: with no one pressing, nothing happens.

## In the cloud: work on a repository where nobody's computer is (MUS-20)

**Who it is for.** A person who is not at their computer, or has no desktop app, and wants
work done on one of the company's repositories. An administrator, who decides which
repositories that may be.

**The job.** The same work as on a computer, ending the same way (a branch of its own and
a pull request the person agreed to), done in the server's sandbox.

**Where it starts.** Nowhere new. There is no mode and no switch. In a conversation with
no computer attached, the person says what they want done in a repository; the agent has
five more tools where the company connected its code host and the server can run code
(`server/codeHost.ts`, `runtime/catalog.ts` `CLOUD_TOOLS`).

**What happens, step by step.**

1. `repo.open` with a repository's name. The server asks the code host where the branch
   stands, fetches the repository at that commit as an archive, and has the sandbox
   runner unpack it into one folder of the conversation's workspace (`web/` for
   `acme/web`). The agent is told the folder, how many files, and what was left out
   (links, and files larger than a workspace takes). With no name it says which
   repositories this person may open, or what is open. One repository per conversation.
2. `repo.read`, `repo.edit`, `repo.write` read and change files there. They are worded
   like `local.read`, `local.edit` and `local.write`, and take the same arguments, so an
   agent works the same way in both places. Listing, searching and the project's own
   commands (tests, a build) go through `code.run` in shell, with everything `code.run`
   is held to: no network but the hosts the organization allows, the time and memory
   limits, the person's daily allowance (sandbox.md).
3. `repo.propose` with a title and a body says the work is ready. Nothing is sent. The
   server works out what changed (step 5), keeps the title and body, and puts one notice
   in the person's inbox ("Work on acme/web is ready for you to send").
4. In the conversation, above the message box, one line: `acme/web · from main · 2 files
   changed`. It opens to the changed files, each to its diff. While a proposal waits, the
   pull request is shown as it will read: its title and what it says, both the person's
   to change (the body four lines high, "Show all" for the rest), then **Not now** and
   **Open pull request**. A line above them names any changed file that decides what CI
   runs ("Changes what CI runs: Makefile, build.sh").
5. The press sends it: the server reads the changed files out of the workspace, makes one
   commit on `muster/<title>-<6 of the conversation's id>` through the code host's API,
   and opens the pull request. The line then shows `Pull request #12` as a link. Later
   work proposed again goes to the same branch and request ("Add to the pull request").
   Once that request is merged or closed, the next sending is a new branch (`…-2`) and a
   new request, and says so.

**What changed is worked out without git.** When a repository is unpacked, the runner
says git's own fingerprint of every file (`sha1("blob <length>\0" + bytes)`); that list
is kept with the work (`cloud_work.base`). Later the runner lists the folder as it stands
the same way, and the difference is the work: changed, added, taken out. A new file the
repository's own `.gitignore` files leave out is no part of it, nor is `node_modules/`,
`__pycache__/`, `.venv/` and the like whatever the repository says; a file the repository
already had is its own whatever a rule says, as in git.

**Rules.**

- **The key never reaches the sandbox.** The code host's token is sealed in the database
  (`code_hosts.key_sealed`, with `MUSTER_SECRET_KEY`) and opened only in the server
  process. Fetching and sending are the server's own requests to the code host's API. The
  workspace holds plain files: no `.git`, no remote, no credential helper. The
  repository's code, which runs only in the sandbox, has nothing to find.
- **Nothing leaves without the person's press.** No tool sends. `repo.propose` cannot be
  made to: sending is a request only a signed-in person can make
  (`POST /api/app/conversations/:id/repo/send`), for their own conversation.
- **What was shown is what is sent.** The page sends the mark of the changes it showed
  (`fingerprint`); the server works the changes out again and refuses if they differ
  (409 `repo_changed`: "The work changed after you were shown it"). Each file's bytes
  are then checked against that mark as they are read (git's fingerprint of them), so a
  file changed between the listing and the reading is not sent either. And nothing is
  sent while a reply is still being written in the conversation (409 `run_in_progress`):
  the button is off until it ends.
- **What defines CI is not changed from here.** A branch that changes a workflow runs
  with the repository's secrets the moment it is pushed, before anyone reviews it. So a
  change to `.github/**` (workflows, actions, the rest), `.gitlab-ci.yml`, `.circleci/**`,
  a `Jenkinsfile`, `azure-pipelines*.yml`, `.buildkite/**` and the like is refused, when
  proposed and again when sent, unless an administrator ticked "May change CI workflows"
  for that repository (off by default; the activity log says which repositories have it).
  Files CI commonly runs are sent, but never unnamed: `Makefile`, any `package.json`,
  `Dockerfile*`, `docker-compose*.yml`, a `*.sh` at the top, `scripts/*`, `.husky/**`,
  `pyproject.toml`, `tox.ini` and a few more (`ciKind` in `codeHost.ts`) are listed at
  the top of the card, apart from the file list, and the agent is told to say so too.
- **What the request says is the person's.** The agent's title and body are shown before
  sending and can be changed. In the agent's text a name after an `@` is put in code
  marks (it notifies nobody) and "fixes #12" becomes "fixes issue #12" (it closes
  nothing); what the person writes themself is sent as written.
- **Where work starts from.** The repository's main branch, or one an administrator
  listed for it. An agent that asks for another is told which there are. The card names
  the base.
- **Asked again at every step.** Whether this person may still work on the repository is
  asked on every read, change, proposal, diff and sending, not only when it was opened.
- **The code host's allowance is shared.** A repository already in the workspace at the
  branch's latest commit is not fetched again. One person has a repository fetched at
  most 10 times an hour. A file's earlier content, fetched for a diff, is kept in memory
  by its fingerprint. When the code host says it is asked too often, it is left alone
  until the moment it named, and everyone is told to try again in so many minutes.
- **A sending that stops half-way is taken up.** The commit is made first, then the
  branch is pointed at it, then that is written down. If the answer to the second is
  lost, the next press finds the branch already at that commit and goes on to the
  request: no second commit. A branch with commits Muster did not make is not built
  over: the person is told someone else added to it.
- **Only where it may go.** The branch is made by the server from the title and is
  always `muster/…`; the code host client refuses any other name (`OURS`). An existing
  branch is moved forward only, never forced. A link to the request is shown only if it
  is https.
- **What a repository says is material.** A README, a file of instructions for agents,
  what a command prints: results of `repo.open`, `repo.read` and `code.run` are marked as
  outside content like a web page, and a run that read them counts as having read from
  outside (memory and project notes then ask first).
- **Who may open what.** An administrator names repositories, each for everyone or for
  one department. Others are told "No repository is open to this person here."
- **Its own folder.** The repository goes into a folder named after it. If the
  workspace already has one of that name (the person's files), that one is neither
  written into nor taken away: the repository goes into `<name>-repo` and the agent is
  told.
- **Limits.** A repository's archive: 64 MB. A workspace: 256 MB and 20,000 files. One
  piece of work: 300 changed files, 5 MB a file, 30 MB together.

**Unattended.** A reply is written on the server, not in the page: closing the browser
does not stop it, and the conversation shows it when the person comes back. What bounds
it is what bounds every reply: each `code.run` its own time limit, the person's daily
allowances for tokens and for running code, and the month's budget. A proposal does not
expire: it waits, with its notice in the inbox, until the person sends it or says not
now. If the server restarts while a reply is being written, the reply is marked as not
finished and can be gone on with, as any reply.

**States.** No code host connected, or no sandbox: the tools are not offered and nothing
is said of them. Open (work, nothing proposed). Proposed (waits for the person). Sending.
Sent (branch and pull request exist; more work can be proposed).

**On record.** `code_host.set`, `code_host.changed`, `code_host.removed`,
`code_host.repos_changed` (before and after), and `repo.sent` (repository, branch, pull
request number, how many files, by whom). Never the key, never a file's content.

**How it is wired.**

- Code: `server/codeHost.ts` (the code host client, a conversation's work, the routes),
  `runtime/tools.ts` (`cloudDefinitions`), `runtime/runs.ts` (the `repo` closure and one
  paragraph of instructions), `sandbox/untar.ts` and `runner.ts` (`unpack`, `tree`,
  `drop`), `web/app/CloudWork.tsx`, `web/pages/CodeHostCard.tsx`.
- Data: `code_hosts`, `code_repos`, `cloud_work`, `cloud_opens` (`CODE_HOST_SCHEMA`,
  `CODE_HOST_FIXES_SCHEMA`).
- Requests: `GET`/`PUT`/`DELETE /api/code-host`, `GET /api/code-host/repositories`,
  `PUT /api/code-host/repos`; `GET /api/app/conversations/:id/repo`, `…/repo/diff?path=`,
  `POST …/repo/send`, `POST …/repo/dismiss`.
- Tests: `server/codeHost.test.ts` (what is part of a piece of work; the GitHub client;
  the whole loop with a stand-in code host and sandbox; who may open what),
  `sandbox/untar.test.ts` (archives, links, ways out of the folder, fingerprints),
  `web/app/cloudWork.test.ts`.

**Prompt cache.** The five tools and one paragraph of instructions are there whenever the
company has a code host and the sandbox is ready, the same for every conversation. Which
repositories there are, what is open and what changed are said in tool results only.

**Not built.**

- Checks and review comments of the pull request are not read back into the conversation
  (`local.pr` "look" has no counterpart here yet).
- GitHub only (github.com, and GitHub Enterprise by its API's address).
- Files are not marked as programs in the workspace: a script is run through its
  interpreter. A file the repository marks as a program keeps that mark when sent; a new
  file never has it, even one a run made a program (`chmod +x`): the stream files come
  out of a run in carries names and bytes and nothing else (sandbox `bundle.ts`).
- Links (symlinks), submodules and files whose names are not UTF-8 are left out of the
  workspace, named to the agent as not readable or changeable, and stay as they are in
  the repository.
- After a request is merged, a new one starts from the commit the repository was opened
  at, not from the merged one: the code host shows it against the branch as it now is.
- Nothing here can make a repository require approval before workflows run on a branch;
  that is set on the code host (runbook, 3c).
- A run hands back at most 4,000 changed files, so installing a large tree of packages
  inside the repository's folder (`npm install`) does not carry over to the next run.
- No undo per reply: the work is the difference from the repository, and "Not now" keeps
  it. To start over the conversation is started over.
- The phone shows the notice and names the tools; sending is done on the web.
- One repository per conversation, and a branch other than the main one only by asking
  the agent for it by name.

## The app answers by itself: no page needed (CHA-275)

**Built** on 2026-11-18: `watchDevice` and `tell` in `runs.ts`,
`GET /api/app/device/events` in `product.ts`; `watch`, `carryOut` in
`apps/desktop/src/main.ts`; `desktop.answers` used by `onDevice` in `Chat.tsx`. Test:
"tells the desktop app itself which call waits" in `product.test.ts`.

Until now what an agent asked of the computer went to the conversation's page, which had
the app do it: with the page closed, or another conversation in front, the call waited a
minute and failed. Now the app keeps its own connection to the server, under the same
session as its window. The server tells it which call waits (never what the call is), in whichever
conversation; the app asks what it is, as always once, does it in the folders of that
conversation's project, and answers. It reconnects by itself, more slowly each time up to
half a minute, and begins again when the person signs in or changes server; a connection
that has said nothing for a minute is taken for dead and made again, and the server then
tells again of every call still waiting. The page, when it is open, tells the app of the
call as well: whichever word reaches the app first, the app does the call once and
answers the server itself, saying so again if the first telling did not arrive. The page
no longer does or answers anything; reloading or closing it changes nothing.

Not tried in the desktop app itself, like the rest of this document.

## The project's own checks, run by Muster (CHA-275)

**Built** on 2026-11-18: `checksOf` in `bench.ts`, `device.notes[].checks`, and the loop
after a run's last answer in `runs.ts` (`CHECK_ROUNDS`). Test: "runs the project's own
checks after a reply changed files" in `product.test.ts`.

A repository says what checks it in `muster.json` at its root:

```json
{ "checks": ["pnpm typecheck", "pnpm test"] }
```

Five commands at most, 300 characters each. The agent is told of them and to run them as
it works. When the agent says it is finished and its reply changed files in that
repository with the file tools, Muster runs the repository's checks itself, each as a
command through the gateway, shown among the steps under the name "Muster". **It goes by
the conversation's mode like a command an agent runs** (since 2026-11-22): asked in "Ask
first", run in "Approve for me" and full access, and asked in every mode but full access
when it reaches outside the folder, sends or cannot be undone. Allowed once, it is not
asked again in that reply; one the person refuses is not run and counts neither way.
(Until then it asked whatever the mode, since no agent chose it; but the agent's own
`npm test` ran unasked in "Approve for me" and Muster's same check asked after it on
every reply.) A repository's
`muster.json` can name any command: the confirmation shows it whole. If any does not end with exit code 0, the agent is told what failed, with the
output marked as what the repository's programs printed (material, never an instruction),
and to fix it or say plainly why it cannot. What the agent had said when it thought it
was finished is kept among the steps. This happens twice; a third run is
only a look. If the checks still fail then, the reply is marked: "The project's own checks
still fail after these changes." Whatever the reply says, that line is under it.

What it does not do: it does not know of changes a command made (a formatter run by the
agent), only of files changed with the file tools; a repository without `muster.json` has
no checks, and nothing is guessed from `package.json`; a check that takes longer than 110
seconds counts as failed and goes on as a job.

## How a reply that changed code ends (C1)

**Built** on 2026-11-22, task C1 of [`../design/coding-people-choose.md`](../design/coding-people-choose.md)
(the owner: replies should say, as Antigravity's do, what was done, what changed and how it
was checked, so the change can be judged at a glance).

- **The component**: `Walkthrough(summary, changes, checks, left)` in
  `packages/ui-schema/src/index.ts`. `changes` is every file changed or made, each with why;
  `checks` is everything run or looked at, each with what came of it and `ok`; `left` is
  what was not done or only the person can do. It is the last part of the reply.
- **Who is taught it**: a run that works on code (`coding`: folders attached and the agent
  can run commands) for a client that draws it (`ui` 3 or more: the web page, the desktop
  app and the iOS app as of this change). The agent is told to end a reply that changed
  files with one (`CODING_END` in `runs.ts`). An agent a step was passed to, and a run for
  an older client, end in words as before (`CODING_END_PLAIN`).
- **What the harness holds it to** (`walkthroughGap` in `runtime/walkthrough.ts`), after the
  project's checks have run, against the reply's own steps (`local.edit` / `local.write`
  that succeeded, and every `local.exec` with the exit code its output began with, kept in
  `exits` as the call ends):
  - it is there, with a summary, and names every file the steps changed (a name without
    the attached folder's name in front counts; `:line` is ignored);
  - every check it lists that is a command (its first word, after any `NAME=value`, is
    written as a program is; "Opened the page" is words and is not held) was really run in
    this reply (`notRun`). A check names a run when every command it names (split at `&&`,
    `||`, `;`, `|`, a line break, a spaced `/` or `+`) is one the run held: the same
    program, and the check's other words found in the run's in order, flags aside
    (`curl "…"` is `curl -s "…"`; `vitest` is not `cat vitest.config.ts`; `npm test` is not
    `pnpm test:e2e`). Brackets at the end ("npm test (after the change)") are what the agent
    said of it. The whole command is compared, not the step's first 160 characters;
  - a check marked passed passed in its latest run after the last change (`stale` when it
    ran only before: that checked something else; `wrong` when that run failed, or ended
    with its code unknown). The run's exit code counts only when the check's command is
    the run's last stage: a line break, `;`, `|` and `||` hand the code on to what follows
    (`piped`); `&&` does not; what is in quotes is not split. A command that became a job
    takes the exit code its end reported through `local.job`; one still going is not held;
  - a check marked failed did fail in some run, before the change or after: that the test
    failed before the fix is the record, and claims nothing about the work;
  - a project check Muster ran that failed is listed (`unlisted`); one that passed is not
    asked for, since the agent never saw it;
  - with no check listed, it says under `left` what was not checked (`noChecks`).

  Order in `runs.ts`: the project's checks; then the Walkthrough, not when the checks still
  fail (the reply ends `checks_failed` instead); then, if files changed after the checks
  last ran, the checks once more as a last look.

  When something does not hold, what the agent wrote is kept as a word along the way and it
  is told exactly what (`toldOf`): to run what is needed or correct what it said, and write
  the reply again. It is told at most twice (`WALKTHROUGH_ASKS`). What still does not hold
  after that ends the reply as `walkthrough_unmatched`, with the points as JSON in
  `ending_detail`, and the page says each under the reply in the person's language
  ("The summary at the end does not match what was actually done. By Muster's record: …",
  `Unmatched` in `Chat.tsx`; the phone shows the same notice).
- **The person's language, named** (2026-11-22): where the script of the person's message
  names one language (Chinese, Japanese, Korean) the agent is told it outright
  (`writtenIn`); told only "the person's language", it wrote its sentences along the way in
  English to a person writing Chinese.
- **On the page** (restyled 2026-11-22 after the owner set it beside Antigravity's
  replies): no box. Under a hairline, set like the rest of the reply: the summary; "Changed
  n files", each file as its language's mark and its name (the path on hover) with why after
  a dash; "Verified", each check's command as code with what the agent said of it in
  brackets outside, a thin tick or cross, and what came of it; "Left for you" as a list
  (`WalkthroughCard` in `apps/web/src/app/reply.tsx`, `WalkthroughView` on the phone).
  Paths do not yet open anything (C2).
- **How every reply reads** (same day): a reply is set at 15 px with a line height of 1.75.
  A Text is Markdown (### headings, lists set in two spaces under another, `code`,
  **bold**, ---), rendered by `Markdown`/`inline` in `apps/web/src/app/markdown.tsx` and
  `linesOf` on the phone. Code in running text is the brand's colour on a faint wash
  (`CODE`, `--code-wash`). A file named in backticks or in plain words (`cart.js`,
  `src/App.tsx`, `README.md`, by a language ending only) is shown as its language's mark and
  its name (`FileMention`, `LangMark` in `apps/web/src/app/lang.tsx`); a commit (7 to 40 hex
  characters with both digits and letters) is set as code. A Callout is a thin line in its
  tone, not a filled box. Long words along the way are cut to three lines. The project
  notes an agent asks to keep are shown as Markdown in the approval card.
- Tests: `apps/server/src/runtime/walkthrough.test.ts`, "has a reply that changed code end
  with a Walkthrough" in `apps/server/src/product.test.ts`, the walkthrough cases in
  `packages/ui-schema/src/index.test.ts` and `apps/web/src/app/reply.test.tsx`.
- **Tried for real** on 2026-11-22: the development desktop app against the local server,
  model `deepseek-flash`, "Ask first", a small repository whose `npm test` failed because a
  cart total ignored quantity. The agent ran the test, found the cause, changed
  `cart.js` (the person allowed each command and the change). Its first closing was prose:
  the harness sent it back; it re-ran the test, was sent back once more, ran `git diff` and
  `npm test` together as evidence, and ended with a Walkthrough that named `cart.js`, listed
  both commands with exit 0, and left "not committed" and a note on a float in the test to
  the person. No notice was needed. Seen: the prose above the card shows `code` with its
  backticks, since Text formatted only **bold**.
- **Put right from what the trials found** (same day, three more runs): `code` in a Text and
  in what the agent says along the way is set in code type (`runsOf` in `reply.tsx`, `Runs`
  on the phone); the format rules carry a whole example of a reply that ends with a
  Walkthrough, and the agent is told to run each check as a command of its own; a check
  summing up several commands, a command written without its quotes, and a test reported
  as failing before the fix are no longer taken for false; a pass read from a piped
  command is; the phone shows the notice and "checks failed" too. **A reply called as a
  tool**: the model sometimes called `root` (the reply's first statement) as a tool, up to
  five times in a reply; each showed the person a failed step and went to the gateway as
  an unknown, outside act. `root` and the component names are now answered "this is not a
  tool, write your reply" (`REPLY_NAMES`, `replyIsNoTool` in `runs.ts`), not asked of the
  person and not shown as steps. **The page stopped following the run** after the desktop
  window sat in the background: the stream looked open and nothing came, while the app
  went on doing the computer's part over its own channel, so the page stood on an approval
  already given until reloaded. The page now notes every event and the server's pings,
  and opens the stream again after a minute of silence or when the window comes back
  after 30 quiet seconds (`Conversation` in `Chat.tsx`). The last run (window minimised
  for 90 seconds mid-run): the card was accepted at once, nothing was sent back, no
  failed steps, and the page had caught up without a reload.

## What of the owner's coding standard is built in, and what is not

Read on 2026-11-18 (the survey is on CHA-275). Built in so far: checks run by the harness
and "done" decided by them (its P2, P3); a deny-list at the command gate, as "asks in
every mode" rather than "never" (P12); the person's uncommitted work is theirs, and no
commit, push or publishing unless asked (P12); a second agent can be passed a step
(CHA-264), though nothing yet requires a review by a different model (P10); what a
repository says of itself is material, never an instruction (P12). Not built: test
integrity (deleted or skipped tests detected, a new test that fails on the base commit); a
budget of failed fix attempts beyond the three check rounds; scope checked against a
ticket; a pull request's text made from what the harness holds; templates offered to a new
project. Only a person can ratify, rule and sign off, and nothing here pretends otherwise.


## Limits, stated so nobody assumes otherwise

- **Not tried in the desktop app itself.** The code on the computer is tested with real
  files and real processes, and the server with a model that follows a script; the page's
  parts were type-checked. The development build was started and came up; driving it was
  not possible in the session that built this. No run with a real model has used these
  tools yet.
- The desktop app must be running and signed in for an agent to work on the computer; the
  conversation's page need not be open.
- In a repository undo covers what commands changed too and outlives a restart (see "A
  piece of work of its own"); what git ignores is not covered. In a folder that is not a
  repository it covers only what the file tools changed, and is the app's memory.
- The summary of an earlier part is made again in each reply that needs it; it is not kept
  between replies. What the summariser uses counts against the day's allowance but is not
  a line of its own on the record.
- A command cannot be typed into, and has no terminal: a tool that needs one does not work.
- `PATH` is the login shell's, with usual places added. What only an interactive shell sets
  up (a version manager in `.zshrc`) may be missing: call the tool by its path, or set it
  up in `.zprofile`.
- Nothing is written in `.github`, `.vscode` or `.husky` with the file tools, as before.
- On Windows a command's children are ended with `taskkill`; this was not tried.
- Schedules and follow-ups run without the computer and have none of these tools.
