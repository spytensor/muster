import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  MailIcon,
  MessagesSquareIcon,
  PencilLineIcon,
  SendIcon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useConfirm } from "@/components/confirm";
import { MoreMenu } from "@/components/more";
import { useAction } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ReplyActions } from "./reply";
import { connectMicrosoft } from "./PlusMenu";
import { signed, unsigned, useProfile } from "@/lib/profile";

/**
 * A mail or a Teams message an agent drafted, as the card the person sends it from
 * (CHA-220). The agent cannot send: the draft is words in its reply. Everything here is
 * the person's: they read it, change it, and Send posts what the card then holds.
 */

interface Sent {
  messageId: string;
  key: string;
  kind: "mail" | "teams";
  /** "unknown": Microsoft did not say whether it went. "sending": in flight. */
  status: "sent" | "discarded" | "unknown" | "sending";
  at: string;
  content: { to?: string[]; cc?: string[]; subject?: string; body?: string; chat?: string };
}
interface State {
  /** Why a card can or cannot send. */
  sending: {
    allowed: boolean;
    connected: boolean;
    mail: boolean;
    teams: boolean;
    account: string | null;
  };
  drafts: Sent[];
}

/** A card as the side panel lists it: what it is, who it is for, and what became of it. */
export interface DraftCard {
  id: string;
  kind: "mail" | "teams";
  title: string;
  /** "unknown": it was submitted and nobody knows whether it went. The person has to look. */
  status: "unsent" | "sent" | "discarded" | "superseded" | "unknown";
}
const Drafts = createContext<{
  state: State | null;
  reload(): void;
  cards: DraftCard[];
  show(card: DraftCard | { id: string; gone: true }): void;
}>({
  state: null,
  reload: () => undefined,
  cards: [],
  show: () => undefined,
});
/** The drafts of this conversation, in the order their cards are on the page. */
export const useDraftCards = () => useContext(Drafts).cards;
/** The reply a card is part of. No message yet while the reply is still being written. */
export const DraftScope = createContext<{
  messageId: string | null;
  /** The run read something that did not come from the person before writing this. */
  outside: boolean;
  /** A later reply holds a newer draft. */
  superseded: boolean;
}>({ messageId: null, outside: false, superseded: false });

/** What the cards of one conversation share: whether sending is possible and what was sent. */
export function DraftsProvider({
  conversation,
  beat,
  children,
}: {
  conversation: string;
  /** Changes when the conversation gains a message. */
  beat: number;
  children: ReactNode;
}) {
  const [state, setState] = useState<State | null>(null);
  const reload = useCallback(() => {
    api<State>(`/api/app/conversations/${conversation}/drafts`)
      .then(setState)
      .catch(() => setState(null));
  }, [conversation]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when a message arrives
  useEffect(reload, [reload, beat]);
  // And when the person comes back to this window: they may have given consent in another tab.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  // Each card says what it is, so the side panel can list them without reading replies itself.
  const [cards, setCards] = useState<DraftCard[]>([]);
  const show = useCallback((card: DraftCard | { id: string; gone: true }) => {
    setCards((now) => {
      const rest = now.filter((one) => one.id !== card.id);
      if ("gone" in card) return rest.length === now.length ? now : rest;
      const before = now.find((one) => one.id === card.id);
      if (before && before.status === card.status && before.title === card.title) return now;
      return before ? now.map((one) => (one.id === card.id ? card : one)) : [...now, card];
    });
  }, []);
  const value = useMemo(() => ({ state, reload, cards, show }), [state, reload, cards, show]);
  return <Drafts.Provider value={value}>{children}</Drafts.Provider>;
}

/** A short name for a draft from what it first said, so the same draft is found again after a reload. */
function keyOf(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u0001")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `d${hash.toString(36)}${parts.join("").length.toString(36)}`;
}
const addresses = (text: string) =>
  text
    .split(/[\s,;，；]+/)
    .map((address) => address.trim())
    .filter(Boolean);
// Plain letters only: an address with letters of another alphabet, or ones that cannot be
// seen, can read as a colleague's and be a stranger's. The server refuses the same.
const ADDRESS =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b px-3 py-1.5 text-[13px]">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
const line =
  "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:opacity-70";

function Card({
  kind,
  original,
}: {
  kind: "mail" | "teams";
  original: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    chatId: string;
    chat: string;
  };
}) {
  const { t } = useI18n();
  const d = t.app.draft;
  const { state, reload, show } = useContext(Drafts);
  const { messageId, outside, superseded } = useContext(DraftScope);
  const { send: say, disabled: busyElsewhere } = useContext(ReplyActions);
  const { confirm, dialog } = useConfirm();
  const action = useAction();
  const key = useMemo(
    () =>
      keyOf(
        kind === "mail"
          ? ["mail", ...original.to, "|", ...original.cc, original.subject, original.body]
          : ["teams", original.chatId, original.body],
      ),
    [kind, original],
  );
  const [to, setTo] = useState(original.to.join(", "));
  const [cc, setCc] = useState(original.cc.join(", "));
  const [subject, setSubject] = useState(original.subject);
  const [body, setBody] = useState(original.body);
  // The person's signature goes under a mail on its card, put there by the page: it is in
  // their profile, never in what an agent is told, so no agent wrote it. It is added once,
  // to a body the person has not touched and that does not end with it already, and from
  // then on it is text on the card like any other, theirs to change or take off.
  const signature = useProfile()?.ways.signature ?? "";
  const [revising, setRevising] = useState(false);
  const [change, setChange] = useState("");

  const record = state?.drafts.find((draft) => draft.messageId === messageId && draft.key === key);
  const sent = record?.status === "sent";
  const discarded = record?.status === "discarded";
  // Microsoft did not say whether it went: not sent again by a press.
  const unknown = record?.status === "unknown";
  const inFlight = record?.status === "sending";
  // Added to a draft that has not been sent or put aside, whose body the person has not
  // touched and that does not end with it already. Adding it twice changes nothing.
  const untouched = state !== null && !record;
  // What was submitted is what is shown, for a draft that went, may have gone or is
  // going: the person changed it before sending, and it is that they have to check
  // (CHA-269). The page read anew knows only what the agent first wrote.
  const held = record && (sent || unknown || inFlight) ? record.content : null;
  const heldAt = held ? record?.at : undefined;
  // If it turns out not to have gone, the card goes on from what was submitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once for each submission
  useEffect(() => {
    if (!held || sent) return;
    if (held.to) setTo(held.to.join(", "));
    if (held.cc) setCc(held.cc.join(", "));
    if (held.subject !== undefined) setSubject(held.subject);
    if (held.body !== undefined) setBody(held.body);
  }, [heldAt]);
  useEffect(() => {
    if (kind !== "mail" || !signature || !untouched) return;
    setBody((now) => (now !== original.body ? now : signed(now, signature)));
  }, [kind, signature, untouched, original.body]);
  // A Teams draft names a chat by its id. Who that is comes from Microsoft, asked as the
  // person, never from what the agent called it.
  const [chat, setChat] = useState<{ name: string; members: string[]; outside: boolean } | null>(
    null,
  );
  const [chatError, setChatError] = useState<string | null>(null);
  const { errorText } = useI18n();
  const canAsk = kind === "teams" && Boolean(messageId) && Boolean(state?.sending.connected);
  // Asked again after a send that did not go: who is in the chat may have changed.
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is what asks again
  useEffect(() => {
    if (!canAsk) return;
    let live = true;
    api<{ name: string; members: string[]; outside: boolean }>(
      `/api/app/drafts/chat/${encodeURIComponent(original.chatId)}`,
    ).then(
      (found) => live && setChat(found),
      (failure) => live && setChatError(errorText(failure)),
    );
    return () => {
      live = false;
    };
  }, [canAsk, original.chatId, errorText, asked]);
  const sending = state?.sending;
  // What the person's own consent would put right: not connected yet, or connected before
  // sending was possible. The agent cannot give it; the person can, from here.
  const consent =
    messageId &&
    !discarded &&
    !superseded &&
    sending?.allowed &&
    (!sending.connected || !sending[kind])
      ? sending.connected
        ? d.allow
        : d.connectNow
      : null;
  // Said in order: what stands in the way of sending, if anything.
  const blocked = !messageId
    ? d.writing
    : !sending
      ? d.checking
      : !sending.allowed
        ? d.off
        : !sending.connected
          ? d.connect
          : !sending[kind]
            ? d.reconnect
            : kind === "teams" && !chat
              ? (chatError ?? d.checking)
              : null;

  const toList = addresses(to);
  const ccList = addresses(cc);
  const wrong = kind === "mail" ? [...toList, ...ccList].filter((a) => !ADDRESS.test(a)) : [];
  const home = sending?.account ? domainOf(sending.account) : "";
  const outsiders =
    kind === "mail" && home
      ? [...toList, ...ccList].filter((a) => ADDRESS.test(a) && domainOf(a) !== home)
      : [];
  const ready =
    body.trim() !== "" &&
    (kind === "teams" || (toList.length > 0 && wrong.length === 0 && subject.trim() !== ""));
  // Why Send is not live although nothing stands in its way: what the mail still lacks.
  const missing =
    kind === "mail" && !sent && !discarded && !superseded
      ? toList.length === 0
        ? d.noRecipient
        : subject.trim() === ""
          ? d.noSubject
          : null
      : null;
  // With their signature under it and nothing else changed, it is still the draft as written.
  const asWritten = body === original.body || unsigned(body, signature) === original.body.trimEnd();
  const edited =
    !asWritten ||
    (kind === "mail" &&
      (subject !== original.subject ||
        to !== original.to.join(", ") ||
        cc !== original.cc.join(", ")));

  const leaves = kind === "mail" ? outsiders.length > 0 : Boolean(chat?.outside);
  const send = async () => {
    if (!messageId || !ready) return;
    // Out of the organization is the one press that is asked about twice. The server holds
    // to it too: it refuses what leaves without this yes.
    if (
      leaves &&
      !(await confirm(
        d.send,
        kind === "mail"
          ? d.confirmOutside(outsiders.join(", "))
          : d.confirmOutsideChat(chat?.name ?? ""),
      ))
    )
      return;
    await action.run(async () => {
      await api("/api/app/drafts/send", {
        method: "POST",
        body:
          kind === "mail"
            ? {
                messageId,
                key,
                kind,
                to: toList,
                cc: ccList,
                subject: subject.trim(),
                body,
                outside: leaves,
              }
            : { messageId, key, kind, chatId: original.chatId, body, outside: leaves },
      });
    });
    // Whatever the answer, the card shows what the server now holds: sent, or not known.
    reload();
    setAsked((n) => n + 1);
  };
  const discard = (release = false) =>
    action.run(async () => {
      await api("/api/app/drafts/discard", {
        method: "POST",
        body: { messageId, key, kind, ...(release ? { release: true } : {}) },
      }).finally(reload);
    });
  const revise = () => {
    const wanted = change.trim();
    if (!wanted) return;
    // The agent starts from what the card holds now, so the person's own changes are kept.
    say(
      // Fenced: it is a draft to work on, not something the person is telling the agent to do.
      // Without their signature: that is theirs, never given to an agent, and the card puts
      // it back under the new draft.
      `${d.reviseRequest(wanted)}${
        edited
          ? `\n\n${d.reviseFrom}\n\`\`\`\n${kind === "mail" ? `${d.to}: ${to}\n${cc ? `${d.cc}: ${cc}\n` : ""}${d.subject}: ${subject}\n\n` : ""}${unsigned(body, signature).replaceAll("```", "'''")}\n\`\`\``
          : ""
      }`,
    );
    setRevising(false);
    setChange("");
  };

  // Listed in the side panel under what it is for.
  const cardId = messageId ? `draft-${messageId}-${key}` : "";
  const title =
    kind === "mail"
      ? `${(held ? (held.subject ?? "") : subject) || d.mail} · ${(held ? (held.to ?? []) : toList).join(", ")}`
      : (chat?.name ?? d.unnamedChat);
  const status = sent
    ? "sent"
    : unknown
      ? "unknown"
      : discarded
        ? "discarded"
        : superseded
          ? "superseded"
          : "unsent";
  useEffect(() => {
    if (!cardId) return;
    show({ id: cardId, kind, title, status });
  }, [cardId, kind, title, status, show]);
  useEffect(() => {
    if (!cardId) return;
    return () => show({ id: cardId, gone: true });
  }, [cardId, show]);

  const shown = held;
  const locked = sent || unknown || inFlight || !messageId || action.busy;
  const Icon = kind === "mail" ? MailIcon : MessagesSquareIcon;

  return (
    <div
      id={cardId || undefined}
      className={cn(
        "glass scroll-mt-4 overflow-hidden rounded-xl border text-sm",
        (discarded || (superseded && !sent)) && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{kind === "mail" ? d.mail : d.teams}</span>
        {sending?.account && !sent && (
          <span className="truncate text-xs text-muted-foreground">{d.from(sending.account)}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          {sent ? (
            <span className="flex items-center gap-1 text-ok">
              <CheckCircle2Icon className="size-3.5" />
              {d.sentAt(new Date(record.at).toLocaleString())}
            </span>
          ) : unknown ? (
            <span className="text-warn">{d.unknown}</span>
          ) : inFlight ? (
            <span className="text-muted-foreground">{d.sendingNow}</span>
          ) : discarded ? (
            <span className="text-muted-foreground">{d.discarded}</span>
          ) : superseded ? (
            <span className="text-muted-foreground">{d.superseded}</span>
          ) : (
            <span className="text-muted-foreground">{d.notSent}</span>
          )}
        </span>
      </div>

      {kind === "mail" ? (
        <>
          <Field label={d.to}>
            <input
              className={line}
              value={shown ? (shown.to ?? []).join(", ") : to}
              onChange={(event) => setTo(event.target.value)}
              disabled={locked}
              placeholder={d.toHint}
              aria-label={d.to}
              aria-invalid={wrong.length > 0}
            />
          </Field>
          {(shown ? (shown.cc ?? []).length > 0 : true) && (
            <Field label={d.cc}>
              <input
                className={line}
                value={shown ? (shown.cc ?? []).join(", ") : cc}
                onChange={(event) => setCc(event.target.value)}
                disabled={locked}
                aria-label={d.cc}
              />
            </Field>
          )}
          <Field label={d.subject}>
            <input
              className={cn(line, "font-medium")}
              value={shown ? (shown.subject ?? "") : subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={locked}
              maxLength={300}
              aria-label={d.subject}
            />
          </Field>
        </>
      ) : (
        <Field label={d.chat}>
          <span className="min-w-0 flex-1">
            {shown ? (
              shown.chat || chat?.name || d.unnamedChat
            ) : chat ? (
              <>
                <span className="font-medium">{chat.name}</span>
                {chat.members.length > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {d.members(chat.members.join(", "))}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{chatError ?? d.checking}</span>
            )}
          </span>
        </Field>
      )}
      <textarea
        className="block max-h-[28rem] min-h-28 w-full resize-y bg-transparent px-3 py-2.5 leading-relaxed outline-none disabled:opacity-80 [field-sizing:content]"
        value={shown ? (shown.body ?? "") : body}
        onChange={(event) => setBody(event.target.value)}
        disabled={locked}
        aria-label={d.body}
      />

      {!sent && (
        <div className="grid gap-2 border-t px-3 py-2">
          {unknown && (
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              {d.unknownLead}
            </p>
          )}
          {(wrong.length > 0 || leaves || outside) && (
            <div className="grid gap-1 text-xs">
              {wrong.length > 0 && (
                <p className="flex items-start gap-1.5 text-destructive">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  {d.wrongAddress(wrong.join(", "))}
                </p>
              )}
              {leaves && (
                <p className="flex items-start gap-1.5 text-warn">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  {kind === "mail" ? d.outsideOrg(outsiders.join(", ")) : d.outsideChat}
                </p>
              )}
              {outside && (
                <p className="flex items-start gap-1.5 text-muted-foreground">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  {d.readOutside}
                </p>
              )}
            </div>
          )}
          {revising ? (
            <div className="flex items-center gap-2">
              <input
                // biome-ignore lint/a11y/noAutofocus: opened by the person to type in at once
                autoFocus
                className="h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                value={change}
                onChange={(event) => setChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) revise();
                  if (event.key === "Escape") setRevising(false);
                }}
                placeholder={d.reviseHint}
              />
              <Button size="sm" onClick={revise} disabled={!change.trim() || busyElsewhere}>
                {d.reviseGo}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevising(false)}>
                {t.common.cancel}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {unknown ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => discard(true)}
                  disabled={action.busy}
                >
                  {d.notSentAfterAll}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={send}
                  disabled={!ready || Boolean(blocked) || action.busy || inFlight}
                >
                  <SendIcon />
                  {action.busy || inFlight ? d.sendingNow : d.send}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRevising(true)}
                disabled={!messageId || busyElsewhere}
              >
                <PencilLineIcon />
                {d.revise}
              </Button>
              <span className="flex-1" />
              {messageId && !discarded && !unknown && !inFlight && (
                <MoreMenu
                  label={d.more}
                  items={[{ label: d.discard, onSelect: () => void discard(), destructive: true }]}
                />
              )}
            </div>
          )}
          {action.error ? (
            <p className="text-xs text-destructive">{action.error}</p>
          ) : (
            !revising &&
            !unknown && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {blocked ?? missing ?? d.yours}
                </p>
                {consent && (
                  // Microsoft's own page opens; this card looks again when the person is back.
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => void action.run(connectMicrosoft)}
                  >
                    {consent}
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
      {dialog}
    </div>
  );
}

const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function MailDraftCard({ props }: { props: Record<string, unknown> }) {
  const original = useMemo(
    () => ({
      to: list(props.to),
      cc: list(props.cc),
      subject: text(props.subject),
      body: text(props.body),
      chatId: "",
      chat: "",
    }),
    [props.to, props.cc, props.subject, props.body],
  );
  return <Card kind="mail" original={original} />;
}
export function TeamsDraftCard({ props }: { props: Record<string, unknown> }) {
  const original = useMemo(
    () => ({
      to: [],
      cc: [],
      subject: "",
      body: text(props.body),
      chatId: text(props.chatId),
      chat: text(props.chat),
    }),
    [props.body, props.chatId, props.chat],
  );
  return <Card kind="teams" original={original} />;
}
