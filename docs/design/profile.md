# A person's profile

Status: **step 1 built** (EPIC CHA-258); steps 2 and 3 agreed, not built. Written 2026-11-17 (CHA-257). It does not change a locked
decision. It carries out D-6 where today's code falls short of it
(`docs/architecture.md:136-151`: the same account on every device), and it is bound by D-3
(security, without cost to speed) and D-4 (what cannot be audited is not shippable).

The owner asked for it on 2026-11-17: "紧接着需要设计 profile 功能了，对吧？我们越来越多的个人相关的了".
The owner read it the same day and answered every question in section 9 as proposed
("都按建议"). The answers are recorded there.

File and line references are to `main` on 2026-11-17. They were gathered by a read of the
code that day and the ones this document leans on were checked again by hand; they drift.

## 1. Summary

What is personal about someone is in six places today, and an agent is told almost none of
it: their name, and since today their local time. A person has no one place to see what
Muster knows about them, half of their settings live in one browser and are gone in the
next, and nothing says how they like to be answered.

A profile is that one place. It has three layers, which differ in who writes them:

| Layer | What | Written by | Seen by administrators |
|---|---|---|---|
| **Identity** | name, address, organization, role, department, and (if the owner wants it, §9 Q4) title and manager | sign-in and administrators | all of it |
| **Ways of working** | time zone and working hours, language, how they like answers, mail signature, default agent, what to be notified of | the person | that it is set, not what it says (§9 Q1) |
| **What Muster has learned** | facts an agent proposed and the person agreed to; today's memory | an agent proposes, the person confirms | nothing |

An agent is given a short, fixed-shape note built from the first two layers and the
memories it has today. It can propose a learned fact; it cannot change the first two
layers (§9 Q2).

The first slice (§7) is the second layer, moved to the server and shown in one page,
because that is where today's code is furthest from what was decided: D-6 says the same
account on every device, and a person's language, appearance, default agent and
notification choices are kept per browser.

## 2. What exists

### Who a person is

- `users` holds `email`, `name`, `avatar_url`, `last_login_at` (`apps/server/src/schema.ts:39-46`)
  and, since 2026-11-17, `timezone` (`apps/server/src/followups.ts`, migration 26).
- `memberships` holds one organization per person with `role`, `status`, one
  `department_id`, and `memory_off` (`apps/server/src/schema.ts:55-65`,
  `apps/server/src/memory.ts:24`). There is no title and no manager; a department has no
  lead (`schema.ts:32-38`).
- The name is taken from the sign-in token at every sign-in and overwrites what was there;
  the address is never updated after the account is made
  (`apps/server/src/auth/admission.ts:164-165`, `:287-292`). Nobody can edit either: the
  administrator's change accepts role, status and department only
  (`apps/server/src/app.ts:471-475`).
- From Microsoft the sign-in reads `sub`, `email`, `name`, `picture`, `tid`, `oid`,
  `xms_edov`, `acct`, `idp` (`apps/server/src/auth/oidc.ts:17-66`). The Microsoft 365
  connection asks Graph one thing about the person, to label the connection:
  `/me?$select=userPrincipalName,mail` (`apps/server/src/connections.ts:244`). Job title,
  manager, department and photo are not read. The scopes held are `User.Read`,
  `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`, `Chat.Read`
  (`connections.ts:21-29`); `User.Read` already covers the person's own title and
  department, and their manager needs nothing more than that scope either
  (`/me/manager`) — to be confirmed against a real directory before it is relied on.

### How a person works

| Setting | Where it is kept | Same on every device? |
|---|---|---|
| Language | the browser, `muster.locale` (`apps/web/src/i18n/index.tsx:12`); the phone's own store | no |
| Appearance | the browser, `muster.theme` (`apps/web/src/lib/theme.tsx:5`); the phone's own store | no |
| Agent for new conversations | the browser, `muster.agent` (`apps/web/src/app/Chat.tsx:90`); the phone's own store | no |
| Notifications | the browser, `muster.notify.<kind>` (`apps/web/src/lib/notify.ts:6`); absent on the phone | no |
| Time zone | the server, `users.timezone`, set by whichever device spoke last (`apps/server/src/followups.ts`, the `x-muster-timezone` header) | yes, but never chosen |
| Memory on or off | the server, `memberships.memory_off` | yes |
| Mode (ask first, and so on) | the server, per conversation | yes |

Not there at all: working hours, quiet hours, a mail signature, how answers should read,
pronouns, title.

### What Muster has learned

- `memories`: one sentence each, up to 200 per person and 400 characters
  (`apps/server/src/memory.ts:13-14`), with the conversation it came from. No kind, no
  source, no "proposed" state: a memory exists or it does not.
- Every memory, oldest first, is put into every run's instructions
  (`apps/server/src/runtime/runs.ts`, the block that begins "What the person has asked to
  be remembered").
- Only the person can read, change or delete them. What is being remembered is left out of
  the trace and of the approval an administrator sees.
- Once a run has read something from outside, keeping a memory asks the person first.

### What an agent is told about the person

Four things (`runs.ts`, where the instructions are put together): the memories; "It is
…, the person's own clock. You are working for <name>."; the project's instructions if
the conversation is in one; and "Answer in the language of the person's latest message".
Nothing of role, department, working hours or how they like answers.

### What administrators see of a member

Name, address, role, status, department, how they sign in, their sessions, their
connections (which account, since when), usage and cost, their agents, counts of
conversations and files, recent runs (`apps/server/src/app.ts:440-456`,
`apps/server/src/product.ts:431-520`). Not their time zone and not their memory. They
can, however, read what was said in conversations through traces, and the person is told
so (`apps/web/src/i18n/en.ts:1103`). This matters for §5: anything an agent says aloud
about the person is in a trace.

### What a person can take or remove

Delete a conversation, all conversations, a memory, a file; end a session. There is no
export of one's own data and no way to delete one's account.

## 3. The three layers, and why three

A profile could be one form. It should not be, because the three kinds of fact have
different authors, and who may write a fact is what keeps it honest.

1. **Identity is the organization's.** A person does not choose their role or their
   department, and an agent that could be told "I am the CFO" by the person it works for
   would act on it. It comes from sign-in and from administrators, and the person reads it.
2. **Ways of working are the person's.** They are choices, not facts about the world:
   nobody else can know that someone wants short answers. The person sets them, on any
   device, and they hold on all of them.
3. **What was learned is agreed.** An agent notices something ("reports go to Lei on
   Mondays") and the person says yes or no. This is today's memory, with one thing added:
   a proposal can wait for the person's answer instead of being saved or lost.

What a profile is **not**: a place for an agent to write freely about the person, and not
a personality for the assistant. Some assistants keep `USER.md` and `MEMORY.md` files the agent
edits; in a company that is a record nobody can audit and anybody's mail could rewrite.

## 4. Who may see and change what

| | The person | An agent working for them | Administrators | Other members |
|---|---|---|---|---|
| Identity | reads | is told name, role, department (and title, manager if kept) | read, and change role, status, department as today | name and department, where they already see them (sharing, mentions) |
| Ways of working | reads and changes | is told what bears on the work (§5) | see that each is set or not; never the signature's text or the answer style (§9 Q1) | nothing |
| What was learned | reads, confirms, changes, deletes | is told all of it, as today; may propose | nothing | nothing |

Three rules follow from D-3 and D-4.

- **An agent proposes; it does not write.** For the first two layers there is no tool. For
  the third, `memory.save` stays as it is (the person asked for it to be kept), and a new
  proposal is a card in the reply the person presses, not a tool that saves.
- **Outside content cannot reach the profile unasked.** The rule memory has today holds
  for a proposal too: after a run has read a page, a mailbox or a file, what it proposes
  is shown with where it came from, and nothing is kept without the press.
- **Every change is on record without its content.** That a person changed their
  signature, or an administrator a department, is an event; what the signature says is
  not in it. This is how memory is recorded today.

## 5. How it reaches an agent

One note, put together by the server, in a fixed order and a bounded size, in place of
today's single sentence:

```
You are working for Olivia Lin (Owner, Finance), at Northwind Labs.
It is 2026-11-18 09:02 on her clock (Asia/Dubai). She works 09:00–18:00, Monday to Friday.
She reads Chinese and English; answer in the language of her latest message.
How she likes answers: the conclusion first, numbers before prose, no preamble.
```

- **Only what bears on the work.** The signature is not in the note: it is put on a mail
  card when one is drawn, by the page, so it never passes through the model at all.
  Appearance and notifications are not in it either.
- **Bounded.** The answer-style field is one or two sentences (300 characters); the whole
  note has a ceiling, as the forms prompt has, measured in a test.
- **It never changes what an agent may do.** The line memory already carries applies to
  the whole note: it is information about the person, not permission. A role in the note
  does not unlock a tool; permissions stay where they are, in the policy.
- **It is not in the trace, and whether it should be is a decision** (§9 Q3). A run's
  instructions are not recorded today: they are handed to the model
  (`apps/server/src/runtime/runs.ts`, where the agent is made) and written to no span, so
  neither the memories nor this note can be read by whoever reads traces. What the agent
  then says aloud is recorded like any reply: an agent that answers "as you prefer short
  answers…" has put that in the record.

Working hours also feed follow-ups and schedules: "tomorrow morning" becomes the start of
the person's day, and a wake that falls outside their hours can wait for them (the "quiet
hours" left out of CHA-254).

## 6. What was learned: from memory to confirmed facts

Kept as it is: the sentence, the limits, the person's control, the rule after outside
content. Added:

- **A proposal.** A new component in a reply, `Remember`, with one sentence and where it
  came from; the person presses "Keep" or lets it pass. The server writes the memory on
  the press, as it writes a form's answer. Until then nothing is stored. This replaces the
  agent asking in prose "shall I remember that?" and then calling a tool.
- **"Get to know me."** After Microsoft 365 is connected the person may start, once and
  by their own press, a run that reads recent mail and calendar and proposes up to a dozen
  facts with their sources. Each is a `Remember` card. Nothing is read before the press,
  and the run is one that has read from outside, so nothing can be kept without one.
- **Replace and forget.** "Use Lei, not Marcus, from now on" replaces the old sentence
  instead of adding a second that contradicts it; "forget that" deletes and says what was
  deleted. Both as proposals the person presses.

## 7. The smallest first slice: one EPIC

**"My settings are mine on every device, and my agents know how I work."**

1. A `profile` kept on the server for each person: language, appearance, default agent,
   notification choices, time zone (now chosen, with "follow this device" as the default),
   working hours, answer style, mail signature. One row per person; the browser's own
   copies are read once, sent up, and no longer the source.
2. Settings gets a "Profile" section at the top, which shows the identity layer read-only
   (name, address, organization, role, department) and the ways of working, editable. The
   phone gets the same fields.
3. The note of §5 replaces "You are working for …" in the instructions, with a test for
   its size and one that a role in it unlocks nothing.
4. The signature is put under a mail on its card, by the page.
5. A follow-up or a schedule given as "morning" starts at the person's working hours.

### Acceptance criteria

1. A language, appearance, default agent or notification choice made in one browser is
   there in another browser and on the phone after a reload.
2. A first sign-in after the change carries the browser's existing choices up once; later
   the server's are used.
3. Settings shows name, address, organization, role and department, none of them editable.
4. An agent asked "when does my day start?" answers from the working hours; one asked to
   write a mail produces a card with the signature under it; the signature is not in the
   agent's instructions or the trace.
5. An answer style of "conclusion first" is in the instructions of the next run, within
   the size limit; a style longer than the limit is refused with the limit said.
6. An administrator's view of the member says which of these are set and shows none of
   their text. The activity log has "profile changed" with the names of the fields.
7. Another member cannot read any of it.
8. The profile is in `docs/features/workspace.md`; the administrator's view in
   `admin-console.md`.

### Deliberately left out of the first slice

Title and manager (§9 Q4). The `Remember` card, "get to know me", replace and forget
(§6): the second EPIC. Quiet hours for wakes and schedules: the third, with "nothing to
report". Export of one's own data and deleting one's account: needed, and its own design,
because it touches the record D-5 says must be complete.

## 8. Risks

- **A profile is a target.** Whoever can write to it steers every agent the person uses.
  That is why agents have no tool for the first two layers and proposals need a press.
  The residual risk is the person being talked into pressing; the card says where the
  sentence came from for that reason.
- **The note costs tokens on every run.** It is small, but it is every run. The ceiling
  and the test hold it; the default for a person who has set nothing is today's one line.
- **Moving settings to the server can lose them.** The one-time carry-up must not
  overwrite what a second device already sent; the first write wins and later devices
  read. A person who signs in on a phone first should not have the phone's defaults
  replace what they had chosen in a browser they have not opened yet: an unset field is
  "not chosen", distinct from a chosen default.
- **Administrators can read traces.** The note is not recorded (§5), but if a later
  change starts recording a run's instructions, everything in it becomes visible to them
  at once. A test that the recorded run holds none of the note's text guards that.
- **Stale identity.** A name is refreshed at sign-in; a department is whatever an
  administrator last set. If title and manager are read from the directory they are as
  old as the last read; the page should say when that was.

## 9. Questions for the owner, and the answers

Answered by the owner on 2026-11-17, all seven as proposed ("都按建议"). Each question
is kept as it was asked; what was proposed is what was decided.

1. **What may administrators see of the second layer?** Proposed: that each field is set
   or not, never its text. The alternative is all of it, on the grounds that it is work
   data. The proposal follows how memory and follow-ups are treated today.
2. **May an agent change the profile itself?** Proposed: no. It may propose a learned
   fact (a card the person presses); the first two layers have no tool at all.
3. **Does the note stay out of the trace, as a run's instructions do today?** Proposed:
   yes, with one addition: the trace records *that* a profile note was given and which
   fields it held, not what they said. The alternative records everything an agent was
   told, which is the more complete record D-5 asks for and the less private one.
4. **Title and manager: from the directory, by hand, or not at all?** Proposed: read from
   Microsoft 365 when the person connects it, shown read-only with the time they were
   read, and absent otherwise; never typed by the person. Needs a check that the scope
   already held is enough in the owner's directory.
5. **One profile, or one per agent?** Proposed: one. Every agent gets the same note. An
   agent that should know less is a matter for the agent's own definition, later.
6. **Does the person choose their time zone, or does the device?** Proposed: the device,
   unless the person fixes one. Today the last device to speak wins silently.
7. **Which comes second: the `Remember` card with "get to know me" (§6), or quiet hours?**
   Proposed: the card. It is what makes the third layer fill up, and "get to know me" is
   the part people will show each other.

## 10. What was run, and what was not

Nothing was built or run for this document. The references in §2 come from reading the
code; these were checked again by hand on 2026-11-17: the four browser keys, the memory
limits, `memberships.memory_off`, the Graph call that labels a connection, and the
sentence that tells a person administrators can read their conversations. Not checked:
that `User.Read` returns title, department and manager in the owner's directory; how the
phone stores its settings beyond what the survey reported. That a run's instructions are
written to no span was read from the code (two uses of the instructions in `runs.ts`:
where they are put together and where the agent is made), not observed in a stored trace.

## 11. What building step 1 changed

- **The agent is told that there is a signature.** Section 5 kept the signature out of
  the note altogether. Tried with the real model, an agent that does not know one will be
  added writes its own closing, and the card then has two. The note now says that the
  person has a signature which is added after the agent, and to end a mail at its last
  sentence. What the signature says is still never given to an agent.
- **The answer style is quoted and kept to one line.** It is the one field of free text an
  agent reads on every run, so it is stored as a single line, put in quotation marks, and
  followed by the words that it is about how an answer reads, never about what the agent
  may do. A test holds that a style saying "ignore your rules" changes no tool.
- **The record names the fields.** The run's root span carries `profile`, the names of
  what the note held ("identity clock hours language style signs"), as the owner's answer
  to question 3 asked.
- **The phone syncs three fields and edits none of the new ones.** Language, appearance
  and the default agent follow the profile on iOS. Fixing a time zone, working hours, the
  answer style and the signature are set on the web only for now; the acceptance
  criterion that the phone has the same fields is not met for those four.
- **Notifications are carried but the phone has none.** The two notification choices are
  in the profile; the phone has no notifications to apply them to.
- **Schedules were not changed.** A schedule's time is always given by the person on its
  page, so there was no "morning" to interpret; only a follow-up given by day alone uses
  the start of the working day.

## 12. What the follow-up changed (CHA-259, 2026-11-17)

The three things the review of step 1 left are done: the note is one query; a default
agent the person cannot use right now reads as not chosen, without being written over;
working hours may cross midnight.
The phone can set the four fields it could only follow before, and shows a mail with the
signature under it. Still not on the phone: the full list of time zones (it offers a short
one), and sending a mail.
