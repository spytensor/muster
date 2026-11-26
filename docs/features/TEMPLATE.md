# Template for one feature

Every feature in `docs/features/` is written to this shape, in this order. Say only what
the code does today; when something is not built, say so under "Not built".

```markdown
## <Feature name>

**Who it is for.** The role (member, builder of agents, administrator, security
auditor, billing, owner, operator), and the permission that gates it if there is one.

**The job.** One or two sentences: what this person is trying to get done, in their words.

**Where it starts.** How the person gets here: the address (`#/…`), the menu item, the
button or the event that opens it.

**What they see and can do.** A list. For each action: what the person does → what
happens for them. Include what a list shows, what a row opens, what each button means.

**Rules.** What the feature always or never does: who may, limits, what needs
confirmation, what is recorded in the activity log, what is refused and with which message.

**States.** Empty, loading, the error cases, and anything that changes how it looks
(suspended, pending, expired, no model configured).

**How it is wired.**
- Screen: `path/to/file.tsx:line` (component name)
- Requests: `METHOD /path` → handler `path/to/file.ts:line`; what it reads or writes
- Data: tables and columns it depends on (`schema.ts`), files on disk, memory-only state
- Events: activity-log actions written, live events sent to the client
- Tests: the tests that hold it in place (`file.test.ts`, test name)

**Not built.** What a person would expect here that does not exist.

**Design findings.** What a picky user and the head of the enterprise buying it would
complain about, each with the smallest change that answers it. Leave empty for the
reviewer if you have none.
```
