# Drafts a person sends: mail and Teams messages

Added 2026-11-15 (CHA-220), after the feature freeze, on the owner's word. Written to
`TEMPLATE.md`. It says what the code does today.

## Mail and Teams drafts

**Who it is for.** Every member who has connected their Microsoft 365. An administrator
(`settings.manage`) decides whether anyone in the organization may send.

**The job.** "Write the mail for me, let me read it and fix it, and send it when I say so."
The person never has to wonder whether an agent sent something on its own: it cannot.

**Where it starts.** In a conversation, when the person asks an agent to write, answer or
send a mail, or to post in a Teams chat. The agent's reply holds a card.

**What they see and can do.**

- A card headed "Mail draft" or "Teams message draft", with the account it would go from
  and "Not sent". A mail shows To, Cc, Subject and the body. A Teams message shows the
  chat and the body: the chat's name and who is in it are asked of Microsoft as the person
  (`GET /api/app/drafts/chat/:id`), never taken from what the agent called it, and Send is
  off until Microsoft has answered. Every field of a mail and the body of a Teams message
  can be changed on the card. The chat of a Teams message cannot.
- **Send** → sends what the card holds at that moment, from the person's own account. The
  card then reads "Sent <when>", shows what was sent, and can no longer be changed.
  When any address is outside the domain of the person's connected account, or anyone in
  the Teams chat belongs to another directory than the person's (or to none that Microsoft
  states), a dialog says so and asks once more. The
  server refuses such a send that does not carry that yes (`confirm_outside`).
- **Keep working on it** → a line to say what should change ("shorter", "add the date").
  It goes to the agent as the person's next message; if they changed the card first, the
  card's text goes with it so their changes are kept. The agent answers with a new card,
  and the old one is dimmed and reads "A newer draft is below".
- **"…" → Put this draft aside** → the card is dimmed and reads "Put aside". It can still
  be sent.
- "May have been sent": Microsoft took the request and did not say what became of it (no
  answer, or a failure on its side), or the server stopped mid-send. The card says to look
  in Sent Items or the chat first, and offers one button, "I looked: it was not sent",
  which puts the draft aside so that it can be sent again (`release` on the discard route:
  plain "Put this draft aside" does not free such a draft, so a card open in another tab
  that has not heard cannot). A press never sends it twice.
  Since 2026-11-18 (CHA-269, found by an outside review): the card shows what was
  submitted, as the server holds it, not what the agent first wrote. A page read anew
  used to show the agent's recipients and words, so the person was told to look for the
  wrong mail. The side panel lists it under "Waiting for you" as "may have been sent",
  not as "not sent". When the person says it was not sent, the card goes on from what
  was submitted. Test: `apps/web/src/app/drafts.test.tsx`.
- Under the fields, when they apply: "Not an address: …" (Send is off until fixed), "Goes
  outside your organization: …" or "Someone in this chat is outside your organization.",
  and "Written after the agent read a page, a mailbox or a chat. Check who it goes to and
  what it says." That last one shows from the first reply in the conversation in which an
  agent read anything that is not the person's own words (the web, Microsoft 365, a company
  system, a file, a knowledge base, a folder), and on every draft after it.
- On Connections in the admin console, the Microsoft 365 card has a row "Sending drafts":
  "Nobody can send" or "People can send", and "Let people send drafts" / "Stop sending for
  everyone" in its "…" menu. Both ask before they act.

**Rules.**

- No tool sends mail or posts in Teams. `MailDraft` and `TeamsDraft` are components of a
  reply (`packages/ui-schema/src/index.ts`): words on a page. The agent's instructions say
  it cannot send and must not say it did. (An agent that has `web.send`, or a company
  connector with an action that changes something, can still post to an address or a
  system; each such call asks the person first, as before. See `platform.md`, the gateway.)
- Sending is the person's own request, from their own session, through their own
  connection. The server sends what they submitted, not what the agent wrote.
- A press sends once. The draft is taken (`sent_drafts`, unique on reply and key) before
  Microsoft is asked, so of two presses one sends. If Microsoft refuses (a 4xx answer),
  nothing went: the draft is released and the card says what Microsoft said. If Microsoft
  does not answer, or fails on its side, the draft is marked as not known and is not sent
  again by a press. This guards against a slip of the hand, not against the person: the
  key is made in the browser, and whoever holds the person's session can send as them, as
  they could from the mailbox. What the server holds to whatever the page sent: sending is
  on, the connection may send, a chat is one of the person's own, leaving the organization
  was confirmed, and at most 30 sends an hour for one person (`send_limit`).
- Off until an administrator switches it on (`org_settings.sending`). Switching Microsoft
  365 off for everyone stops sending as well.
- `Mail.Send` and `ChatMessage.Send` are asked of Microsoft only where an administrator has
  switched sending on. An organization that never does is asked for reading only, and
  Muster holds no token there that could send. A connection made before sending was
  switched on does not include it: the card and Settings say to disconnect and connect again.
- An address is plain letters, digits and `._%+-` before the `@` and a plain host after:
  letters of other alphabets and characters that cannot be seen are refused, since such an
  address can read as a colleague's and be a stranger's.
- A mail has 1 to 20 addresses in To, up to 20 in Cc, a subject of one line (no line
  breaks or hidden characters, up to 300), a body up to 100,000 characters, sent as plain
  text and kept in the person's Sent Items. A Teams message has up to 20,000 characters.
- Recorded as `draft.sent` in the activity log: who sent, to whom (or which chat, by
  Microsoft's name for it and its id), how many bytes, whether it left the organization,
  and `outcome: unknown` when Microsoft did not say. Never the subject or the body. The administrator's switch is recorded as
  `connector.sending_on` / `connector.sending_off`.
- The agent is told afterwards that the person sent its draft, so it does not offer it again.
- Refusals: `invalid_draft` (400), `sending_off` (403), `sending_not_connected` (409),
  `confirm_outside` (409), `draft_sent` (409), `draft_busy` (409), `draft_unknown` (409), `chat_unknown` (404),
  `send_limit` (429), `send_failed` (502, with what Microsoft said), `not_found` for a reply
  that is not the person's or holds no draft of that kind.

**States.** While the reply is being written: fields locked, "Still being written."
Sending switched off: Send is off, "Your organization has not switched on sending through
Muster. You can copy the text." Not connected: "Connect Microsoft 365 in Settings…".
Connected without sending: "…Disconnect and connect again in Settings." Sent. Put aside.
Superseded.

**How it is wired.**

- Components: `MailDraft(to, cc, subject, body)`, `TeamsDraft(chatId, chat, body)` in
  `packages/ui-schema/src/index.ts`; the rule in `replyFormatPrompt`.
- Screen: `apps/web/src/app/drafts.tsx` (`Card`, `DraftsProvider`, `DraftScope`), bound in
  `apps/web/src/app/reply.tsx`, provided in `apps/web/src/app/Chat.tsx`. The switch:
  `apps/web/src/pages/Connections.tsx`. The note: `apps/web/src/app/Settings.tsx`.
- Requests, all in `apps/server/src/drafts.ts`: `GET /api/app/conversations/:id/drafts`
  (whether sending is possible, and what was sent or put aside), `POST /api/app/drafts/send`,
  `POST /api/app/drafts/discard`. The switch: `PUT /api/company-connectors/services/microsoft`
  with `{sending}` in `apps/server/src/company.ts`.
- Microsoft: `Connections.post` in `apps/server/src/connections.ts` → `POST /me/sendMail`,
  `POST /chats/{id}/messages`. Only `drafts.ts` calls it.
- Data: migration 19, `sent_drafts` and `org_settings.sending`; migration 20, the state
  `unknown` (`drafts.ts`).
- The agent's history: `runs.ts` adds a line to a reply whose draft was sent.
- Tests: `apps/server/src/product.test.ts`, "drafts a person sends (CHA-220)" (six);
  `packages/ui-schema/src/index.test.ts`, "drafts".

**Not built.**

- Sending from the mobile app: a draft is shown there as text.
- Attachments, HTML mail, replying inside an existing mail thread, a new Teams chat or a
  channel post, calendar invitations, drafts for a company connector.
- Send later. A sent-items view in Muster.
- "Outside your organization" goes by the domain of the connected account only, not by the
  organization's list of domains: a colleague at a subdomain is marked as outside.
- A rule for who may be written to (only these domains, never those).
- The warning "written after the agent read…" is worked out in the page from the steps of
  the conversation, not by the server.

**Design findings.**

- A key of a draft is made in the browser from what the agent first wrote. Two identical
  drafts in one reply share it, and are one draft.
- Posting in Teams was not seen against a real tenant: the owner's tenant refused reading chats (403). It is held by the test with a stand-in for Microsoft.
