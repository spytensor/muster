# A quiet start: show less, and teach at the moment it matters

Status: **built** on branch `spytensor/quiet-start`, web only. Written 2026-11-19. It does
not change a locked decision. Section 4 says where the build differs from the tickets.

The owner's word, 2026-11-19: many choices, skills and agents raise the threshold; show
less, and still let the person find out — "设计小巧思". Then: "全部都做，你来做决定".

Linear refused new issues that day (the workspace's free issue limit). The tickets are
kept here, Q-0 to Q-7, until they can be opened; each commit names its Q number.

## 1. What a new member met (2026-11-19)

Walked in the browser as Mia (member) from sign-in to a first finished piece of work:

| Step | Decisions | New ideas to understand |
|---|---|---|
| Sign in | 1 (the company button) | 0 |
| Say what you need → a Word proposal | **0** | **0** |
| "Mail it to my manager" | — | the card was drawn as `false` (Q-0) |

The main path needs nothing. What raises the threshold is what is **on view**: the first
screen names about eleven things — files, connections, Microsoft 365, projects, three
modes, agents (`@`), skills (`/`), Library, Inbox, Schedules, Marketplace (with Agents,
Skills, Knowledge, Connectors and a Submit area).

## 2. The rule

**A capability appears when the work needs it, and what just happened teaches it.**
Nothing is removed. What is hidden is one step away, and the first time it would help it
is offered in place, once.

Target: the first screen of a new member names three things — the box, adding files, a
new conversation.

## 3. Tickets

### Q-0 A mail draft is drawn as the word "false" — done

DeepSeek wrote its tool-call closing tags (`</｜｜DSML｜｜ parameter>`) after the reply;
the language read `</` as "less than" and the MailDraft became `false`.

- AC-1: the notation (full-width bar), also a tag still arriving, is dropped before a
  reply is drawn, on web and iOS; stored replies draw again.
- AC-2: the server does not store it.
- AC-3: a Stack part that is a bare value is not drawn.
- AC-4: a test holds the reply as it was stored.

### Q-1 The starter suggestions are a short course

- AC-1: the suggestions under the box offer what the person has **not yet used**: a
  file, a document, a schedule, a project, another agent.
- AC-2: once a capability has been used, its suggestion gives way to the next one.
- AC-3: someone who has used them all sees the plain everyday suggestions.
- AC-4: a suggestion still only fills the box; nothing is sent.

### Q-2 `@` and `/` are taught by what happened, not by a line under the box

- AC-1: the line "Type @ to call a specific agent, / to use a skill." is gone.
- AC-2: when a reply has a step another agent did, the reply says once, quietly, that
  the person can call that agent with `@Name` next time.
- AC-3: while the person types, a skill whose name matches what they wrote is offered
  as a faint suggestion in the box; Tab takes it, typing on ignores it.

### Q-3 Modes are learned on the confirmation card

> **AC-1 and AC-3 were withdrawn on 2026-11-21**, at the owner's word after two days of
> use: with the chip hidden nobody found the modes, and people allowed one action after
> another ("这种不能移除…用户体验太差了，一直在点击授权"). The chip is always shown. AC-2
> and AC-4 stand.

- AC-1: the mode chip is not on the start page or in a conversation while the person
  has never changed their mode; their mode is "Ask first".
- AC-2: after the person has allowed the same kind of action three times, the
  confirmation card offers "Don't ask me for this kind again", which moves this
  conversation's mode up one step, within what the organization allows.
- AC-3: once the mode is not "Ask first", the chip is shown, as the state it is in.
- AC-4: "Full access" is never offered on the card; it stays in the chip's menu.

### Q-4 The project chip appears when there is a project

- AC-1: with no project, the start page shows no project chip; "Create a project" in
  the sidebar stays.
- AC-2: with one or more, the chip is shown as today.

Withdrawn by the owner on 2026-11-22, beside another product's start page ("你看看从选择
已经有的项目，到选择新项目之类的"): the project chooser is always there, on a shelf under
the message box, with no project too. It opens a search box, "New project" and the
projects. AC-1 no longer holds.

### Q-5 Connections are asked for by the work

- AC-1: the `+` menu offers files; a connection that is not connected is not listed
  there, and "Manage connections" stays.
- AC-2: a connection already connected is listed, as today.
- AC-3: a card that needs a connection keeps offering it (the mail card's "Connect
  Microsoft 365").

### Q-6 The sidebar grows with the person

- AC-1: Library is shown once the person has a file or a document; Inbox once
  something has ever waited for them; Schedules once they have one.
- AC-2: an entry shown for the first time carries a small dot until it is opened.
- AC-3: the Marketplace stays (it is where agents are found); its "What you offer"
  area is shown only to someone who has made something to offer.
- AC-4: an address typed or linked still opens every page.

### Q-7 A schedule goes to the person's usual agent

- AC-1: a new schedule is answered by the person's usual agent unless they choose
  another; choosing is not a step of making one.

## 4. As built (2026-11-19)

All of Q-0 to Q-7 are built in the web app (and the desktop app, which shows it). Where
the build differs from the tickets above, and what is not yet checked:

- **What the person has met is kept in the browser**, not on the server (`muster.places.seen`,
  `muster.allowed`, `muster.taught.call`, all in `apps/web/src/app/discovery.ts`). Two
  people sharing a browser share it; a new browser starts as new. Moving it to the person's
  profile is the step to take if that matters.
- **Q-1**: agents cannot make a schedule, so the schedule suggestion opens the new-schedule
  form with its words and its timing in it instead of filling the box. There is no
  suggestion for calling another agent: Q-2 teaches it after it happens.
- **Q-2**: the skill is offered in a line under the box rather than in the box itself, so
  what the person typed is never changed by it.
- **Q-3**: the third "Allow" is counted per tool in the browser, across conversations.
  The card is not offered where "Approve for me" would change nothing: sending, reading
  an address nobody gave, and a command that says why it asks whatever the mode.
- **iOS**: none of this was needed there: the iOS app has no suggestions, `+` menu, mode
  chip, project chip or Library, Schedules and Marketplace rows. Q-0 holds there too.
- **Seen in the browser**: Q-1 (as Mia: the schedule suggestion, the form opened with
  "Every week · Monday · 09:00" and "Muster answers it"), Q-2 (the skill line and Tab; the
  "@Researcher" line, once, and not again in the second conversation), Q-4, Q-5, Q-6 (Mia's
  sidebar showed Library and Marketplace only; with the seen list set to what a new
  browser holds, Library and Schedules carried the dot, Inbox showed its count instead,
  and the dot left Library once opened and stayed gone after a reload), the start page
  and a conversation without a mode chip.
- **Q-3, the card's offer, not seen in the app.** It needs the desktop app writing in a
  folder, and driving the desktop app was declined on 2026-11-19. What holds it: the
  component test (`apps/web/src/app/approval.test.tsx`: offered the third time, not for
  sending, a command that says why, or a conversation that cannot move up), and the
  server test that allows a command and then moves the conversation to "auto" while it
  runs, the order the button uses (`apps/server/src/product.test.ts`, the test around
  line 1805: the next ordinary command and an edit no longer ask; `git push` still asks
  and says why). To see it: in the desktop app, in a project with a folder and "Ask
  first", have an agent write a file three times.
