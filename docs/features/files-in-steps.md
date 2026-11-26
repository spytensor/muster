# Files built in steps, kept in versions, changed in place; tables worked out

Added 2026-11-15 (CHA-223, EPIC 1 of five the owner ordered that day). Written to
`TEMPLATE.md`. It says what the code does today.

## Why

On 2026-11-15 Muster was given three requests a product film shows, with the film's own
files: a board pack (workbook, deck and memo from a PDF and a workbook), an analysis of
10,951 rows of sales, and a PRD with a prototype. It delivered none. A file was the
arguments of one model call: a long one was cut off or timed out and nothing was made. A
change meant making the whole file again. An agent saw the first 500 rows of a sheet and
could not add them up.

## A file an agent makes

**Who it is for.** Every member whose agent may make files (`files.create`) or read them
(`files.read`).

**The job.** "Make me the deck. Now change slide 4. No, put it back." And: "What did the
north region sell in the third quarter?", answered from every row.

**Where it starts.** In a conversation, as before. The versions are in the file viewer.

**What they see and can do.**

- A long file appears in steps: "Made a file", then "Changed a file" once for each part
  added. If a step fails, what was made so far is there.
- Asking for a change to one slide, one sheet or one section changes that part. The step
  reads "Changed a file"; the reply says which version the file is at.
- A file's chip shows "v3" once the file has been changed.
- In the viewer, a file with more than one version has a "Version N" button: every version
  with what changed ("Slide 4 replaced", "Sheet "Detail" added (3 rows)"), when, by whom
  and its size. An earlier one can be downloaded, or brought back, which makes it the
  newest version and loses nothing.
- A question about figures in a spreadsheet or a CSV is answered from every row: the
  steps read "Looked at a table" and "Worked out figures".

**Rules.**

- A file an agent makes keeps its **recipe**: the slides, sheets or text it was made
  from (`file_versions.recipe`). The file is made from the recipe by the same code as
  before (`makeFile`). No model is called to change a file's form.
- **One file through its versions.** Making a file of a name the agent used before, or
  changing it, is the same file's next version, with the same id. Before this, each
  remake was a new file and the old one was gone.
- **A change is one of**: for a presentation, slides added at the end or before a slide,
  a slide replaced by one or more, a slide removed; for a workbook, a sheet added,
  replaced, added to, given a chart, or removed; for a document or text, one section
  (named by its heading) rewritten, or text added at the end; the cover. At most 12
  slides or 2,000 rows in one step. A slide, sheet or section that is not there is
  refused with what is there.
- **Slides are numbered as the person counts them, once.** The cover that is made when an
  agent gives none is part of the kept recipe from the moment the file is made, so slide 3
  is the third page. After that the pages are exactly what is kept: a change adds no cover
  and moves no number other than by what it adds or takes out. A new cover title or
  subtitle is put on the cover slide.
- **One kind of change to a deck per call**: remove, replace or add. The numbers move
  after each, so the agent looks at `files.outline` in between.
- **Two changes at once.** A change is worked out from the version that was read. If the
  file moved on meanwhile (another conversation changed it), the change is refused and the
  agent is told to look again: nobody's change is written over.
- **A section of a document** is a heading and what stands under it up to the next heading
  of its level or above. A line that begins with `#` inside a fenced block of code is not a
  heading. The title's own section is only what stands between it and the first heading
  after it.
- **The tools come with others.** `files.outline` and `files.change` come with
  `files.create`; `data.profile` and `data.query` with `files.read`. Nobody ticks them,
  they are not in an agent's list of tools, and they reach no further: `files.change` is
  A1 like `files.create`, the others A0.
- **Only files made here.** A file the person uploaded, or one made before 2026-11-15,
  has no recipe: the agent is told to make it again (it is then kept from there on). When
  the person uploads a file under a name an agent's file has, the agent's file is still
  the one that is changed.
- A recipe is kept whole with every version, up to 4 MB; a file beyond that is refused
  with the advice to split it. Recipes are not counted in the person's storage.
- **Tables.** `data.profile` says, for a sheet or a CSV, how many rows it has and what
  each column holds (numbers with sum, average, least and most; dates with their range;
  text with its most common values). `data.query` gives sums, averages, least, most,
  counts and distinct counts, by up to four groups (a column, or month, quarter or year
  of a date column), with filters, ordered, up to 200 lines. Both read every row, in the
  worker that reads files (30 seconds, 512 MB). A table of more than 300,000 rows, or of
  more than four million cells, is refused whole: a total over part of it would be wrong.
  Columns beyond the 200th are not read, and the profile says how many there are. A title
  line above the header is passed over, and so are the lines a system's export puts there:
  a title merged across the table and a line of notes ("Exported: …", "Unit: …"). When a
  file is read, the header is the first row with two or more different cells that is not
  a line of notes; a line of notes is one where at least half the cells read "name:
  value". Notes written without a colon cannot be told from a header and are taken for
  one. This rule is for reading only (`fromTable` in `table.ts`): a sheet an agent writes
  still loses only a title and blank lines above its table (`fromHeader`), so a line of
  two or more cells the agent put there, such as a rate its formulas point at, stays. An
  amount with its currency ("¥8,800") and a share ("10%", held as 0.1) are numbers; a
  code ("$007") and an amount whose point may mark thousands ("€1.234") are left as
  written. A day written with its year first ("2026/7/3", "2026年7月3日") is that day. A
  day written with dots ("2026.07.03", which could be a version) or without its year
  ("8月3日") is settled by its column: in a column that is four-fifths days, with at
  least one written beyond doubt or three that could be, dots are days, and a day
  without a year takes the year the others share when its month lies within the months
  they span; otherwise it is left as written. A day with the month or the day first
  ("7/3/2026") is left as written. Not done: subtotal and total rows inside a table are
  still rows, and the same order exported twice is still two rows; the agent has to find
  and leave them out. No
  code from the model runs. A ratio is worked
  out by the agent from the sums.
- **Reading a large spreadsheet gives a sample.** `files.read` of an .xlsx or .csv longer
  than about 6,000 characters returns each sheet's first 25 rows and says to use
  `data.profile` and `data.query`. Before, an agent was handed up to 60,000 characters of
  rows, which it could not add up and which the model service refused (502) on 2026-11-15.
- What a table holds is material from outside, like a file that is read: after
  `data.query`, keeping a memory asks the person first.
- The agent is told to work this way (`runs.ts`): build a long file in steps, change only
  the part asked for, and never report a figure for a whole file that `data.query` did
  not give.
- Up to 50 versions of a file are kept; the oldest go first.
- Recorded in the activity log as `file.changed`, with the version and what changed.

**States.** A file with one version shows no version button. A change that cannot be made
(no such slide, no such sheet) is a failed step with the reason, and the file is as it was.

**How it is wired.**

- Recipe and change: `apps/server/src/files/revise.ts` (`change`, `outline`, `kept`);
  page numbering `deckPages` in `files/deck.ts`.
- Versions: `apps/server/src/files/service.ts` (`make`, `put`, `change`, `outline`,
  `versions`, `versionBytes`, `restore`); migration 21, `file_versions` and
  `files.version`.
- Tables: `apps/server/src/files/table.ts` (`profile`, `query`, `csvRows`), read by
  `tables` in `files/extract.ts`, run through `files/reading.ts`.
- Tools: `files.outline`, `files.change`, `data.profile`, `data.query` in
  `runtime/tools.ts`; `COMES_WITH` in `runtime/catalog.ts`.
- Requests: `GET /api/app/files/:id/versions`, `GET …/versions/:n/content`,
  `POST …/versions/:n/restore` in `apps/server/src/files.ts`.
- Screen: `Versions` in `apps/web/src/app/FileViewer.tsx`; the chip's "v3" in `FileChip`.
- Tests: `apps/server/src/product.test.ts`, "files built in steps, kept in versions,
  changed in place (CHA-223)" (three); `apps/server/src/files/revise.test.ts` (seven);
  `files/office.test.ts`, "takes a sheet that begins with a title line".

**Not built.**

- Several people on one file, comments (EPIC 2, CHA-224). A file is still one person's.
- A card for the result in the reply, with a preview (EPIC 3, CHA-225).
- Formulas in workbooks, chart slides chosen from content, a company template, PDF
  (EPIC 4, CHA-226).
- An earlier version cannot be opened in the viewer, only downloaded or brought back.
- Changing a file the person uploaded.
- A comparison of two versions side by side.
- In a table: joins between sheets, formulas of the agent's own, more than 300,000 rows.
  A workbook the library cannot load is read without formatting, so its dates are numbers
  and cannot be grouped by month.
- If the server stops between writing a file's bytes and recording its version, the bytes
  are the new version and the record the old one until the file is changed again.
- The mobile app shows the steps and the file; it has no version list.

**Design findings.**

- An earlier version is made again from its recipe when asked for, not kept as bytes. If
  the code that makes files changes, an old version made again may look slightly
  different from how it looked then.
- What a version's note says is the form of the change ("Slide 4 replaced"), not its
  meaning. The reply says the meaning.

## Formulas in a workbook (since 2026-11-15, CHA-226)

- A total, a difference, a share or a ratio in a workbook an agent makes is a formula,
  so it recalculates when the person changes a figure in Excel. The agent is told to
  write them so ("=SUM(B2:B9)", "=C5-B5", "=C5/B5", "=SUM('Q3 data'!C2:C40)").
- Only this is a formula: numbers, cells and ranges of a sheet of the same workbook,
  + - * / and brackets, and SUM, AVERAGE, MIN, MAX, COUNT, ROUND(number, places), ABS
  (`apps/server/src/files/formula.ts`). A range stands only as a whole argument of a
  function. A sheet's name in quotes may hold none of `[ ] : * ? / \ | !`, so it
  cannot be a path, another workbook, a span of sheets or a call to another program,
  and it must be a sheet of this workbook. Anything else that begins with "=" stays
  text, as before: opening the file cannot run it. The agent is told which cells those
  were ("These cells begin with "=" but are not formulas that can be written here…")
  so that it can put them right.
- What goes into the file is written again from what was understood, never the text as
  given: function names in capitals, no stray spaces, each sheet under the name it has
  in the file (a name is cut to 31 characters and cleaned), and rows counted from the
  header the file begins at (a title line above the header is left out of the file, and
  the agent counted it).
- Each formula is worked out when the file is made and kept in the cell beside it, so
  the viewer, a chart on the sheet, `data.query` and a program that does not
  recalculate all show the figure at once, dressed like any other figure (separators,
  percentages). Rounding is Excel's (halves away from nothing). What cannot be worked
  out shows what Excel shows: `#DIV/0!`, `#VALUE!` (text in arithmetic), `#REF!` (a
  formula that comes back to itself, or a chain of more than about 2,000 formulas); the
  agent is told of those too. In SUM and its like, text and empty cells are passed
  over.
- Limits: a formula of at most 600 characters; a range of at most 20,000 cells; all the
  formulas of a workbook may read 40,000,000 cells between them, beyond which the
  workbook is refused with advice to work long ranges out with `data.query`.
- Seen on 2026-11-15 on the configured model: the Q3 board pack's variance workbook
  came with 58 formulas over five sheets, and its deck with four chart slides of
  sixteen.
- Known gaps: no IF, no lookups, no text functions, no "5%" inside a formula; a sheet
  whose given name holds "/" cannot be named in a formula; rows added later under a
  total row are not inside its SUM; TRUE counts as nothing and "007" as text, where
  Excel would count them.

## A file several people work on (since 2026-11-16, CHA-224)

The owner: "大家一起可能反反复复的修改 PPT 啊等文件，要能持续性".

- Who: people working on one deck, workbook or document together. Job: each has their
  own agent change it, see who changed what, and say what still needs doing, without
  copies going round.
- Sharing. In the viewer, the file's owner presses the people button: "Share “name”",
  "They may: Read / Change", a colleague by name or a whole department. The list shows
  who has it and with what, and switches between read and change or takes it back
  (`apps/web/src/app/Share.tsx`, `PUT /api/app/items/file/:id/shares` with
  `canChange`). Whoever it is shared with is told in their notices, and sees it in
  Documents with "Shared by Mia Chen".
- What a share gives. To read: open it, download it, see its versions, comment. To
  change: also have one's agent change it with `files.change`, and bring an earlier
  version back. Never: delete it or share it on; only its owner does. It stays the
  owner's file and takes space only from the owner.
- An agent finds a shared file by its name when the person has none of that name
  (`apps/server/src/files/service.ts`, `byName`). `files.outline` says whose it is and
  whether it may be changed. A change is the next version under the name of the person
  whose agent made it. `files.create` never touches a colleague's file: it makes the
  person's own.
- Two people at once: a change is written only onto the version it was worked out
  from. The second is told the file moved on, looks again and makes the change on the
  latest version. Nothing is written over.
- Comments. In the viewer, the speech-bubble button opens "Comments" beside the file:
  which part (free words: "Slide 3", "the Costs sheet"), what should change, who said
  it and when. Anyone who may open the file reads and adds. "Resolve" and "Open again"
  are for whoever may change the file, and for the comment's own author
  (`apps/web/src/app/FileComments.tsx`, `/api/app/files/:id/comments`).
- An agent and comments. `files.outline` lists the open comments ("#1 Mia Chen on Last
  slide: …"), marked as remarks about the file and nothing more. When a change deals
  with one, the agent gives its number in `answers`; the comment is marked resolved by
  that person in that version, and the version's note says "answers #1 (Mia Chen)".
- On record: sharing and taking back are in the activity log with whether the share
  allows changes; every version names who made it.
- Seen on 2026-11-16 on the dev service: Mia shared the board deck with Lei to change
  and left "Add one slide at the end with the three decisions…"; Lei asked their own
  agent to deal with the open comment; it added the slide as version 9 under Lei's
  name, the comment showed resolved in version 9, and Lei's attempt to delete the file
  was refused.
- A file of the person's own, made here or uploaded, always comes before a colleague's
  of the same name: a shared file never takes the place of one the person already has,
  and the agent's list of files says whose each is and what may be done with it.
- An agent is shown at most the 20 newest open comments, each on one line and cut to
  300 characters, so that nobody fills its reading or writes a line that looks like
  something else. Only open comments count toward the 200 a file holds.
- What a reader gets includes the file's whole history: every earlier version can be
  downloaded, also those from before it was shared. A shared file can be attached to a
  message or added to the reader's knowledge base; such a copy stays when the share is
  taken back, as a download would. A file stays shared when its owner leaves the
  organization, like an agent or a skill does.
- The first version, and the newest one the file's owner made, are never pushed out of
  the 50 versions kept, whoever makes the changes after them.
- Known gaps: a comment is on a part named in words, not pinned to a place on a slide;
  nobody is notified of a new comment; a file in a project is not shared with the
  project's members by that alone; a colleague's read-only file cannot be copied in one
  press (the agent offers to make a copy); an uploaded file (not made here) can be
  shared and commented on but not changed in place, as before; at most 200 comments on
  a file.
