import {
  type Answer,
  checkAnswer,
  type FieldSpec,
  type FormAction,
  type FormSpec,
  formLabels,
  formsIn,
  type Problem,
  readAction,
  readForm,
  startingValues,
} from "@muster/ui-schema";
import { useIsStreaming } from "@openuidev/react-lang";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Message } from "./api";

/**
 * A form an agent put in its reply (CHA-237): the person fills it in and presses its one
 * button. What is sent is the reply's id, the form's name and what they entered; the
 * server reads the form again from the stored reply and writes their message itself.
 *
 * What is typed stays on this device until the button is pressed.
 */

/** What a form needs to know about the reply it is in. Absent: the reply is shown somewhere it cannot be answered. */
export interface FormPlace {
  messageId: string;
  status: Message["status"];
  /** The reply was cut off at the longest a reply can be: stored as complete, but not finished. */
  cut: boolean;
  /** Nothing has been said after this reply. */
  last: boolean;
  /** The agent that wrote the reply. */
  agent: string;
  /** The working forms of the reply as it is stored: what the server would answer. */
  forms: Map<string, FormSpec>;
  /** The message that answered a form of this reply, when one did. */
  answered: { action: FormAction; at: string } | null;
  /** Sends an answer, and says whether it was taken. Absent where a form cannot be answered. */
  answer?: AnswerForm;
}
export type AnswerForm = (answer: {
  messageId: string;
  form: string;
  values: Record<string, string>;
}) => Promise<boolean>;
export const FormScope = createContext<FormPlace | null>(null);

/** Where a reply stands in its conversation, for the forms and choices in it. */
export function formPlace(
  message: Message,
  messages: Message[],
  agent: string,
  answer?: AnswerForm,
): FormPlace {
  let answered: FormPlace["answered"] = null;
  for (const other of messages) {
    if (other.role !== "user" || other.seq <= message.seq) continue;
    const action = readAction(other.action);
    if (action?.messageId === message.id) answered = { action, at: other.createdAt };
  }
  return {
    messageId: message.id,
    status: message.status,
    cut: message.ending === "length",
    last: messages.at(-1)?.id === message.id,
    agent: message.agentName ? message.agentName : agent,
    forms:
      message.status === "complete" && message.ending !== "length"
        ? formsIn(message.content)
        : new Map(),
    answered,
    ...(answer ? { answer } : {}),
  };
}

const KEPT = "muster.form.";
const KEY = (messageId: string, form: string) => `${KEPT}${messageId}.${form}`;
/** What the person had typed into a form on this device and not yet sent. */
function kept(messageId: string, form: string): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY(messageId, form)) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
/** Forgets everything typed into forms and not sent: at sign-out, so the next person finds none of it. */
export function forgetForms(but = 0) {
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(KEPT));
    // The oldest first: a key holds its reply's id, which begins with when it was made.
    for (const key of keys.sort().slice(0, Math.max(0, keys.length - but)))
      localStorage.removeItem(key);
  } catch {
    // No storage, nothing kept.
  }
}
function keep(messageId: string, form: string, values: Record<string, string> | null) {
  try {
    if (values) {
      localStorage.setItem(KEY(messageId, form), JSON.stringify(values));
      // A form left half filled in is never met again once its conversation moves on: only
      // the latest few are kept.
      forgetForms(20);
    } else localStorage.removeItem(KEY(messageId, form));
  } catch {
    // Storage is full or switched off: what is typed lives as long as the page does.
  }
}

/** A form's state in the conversation, which decides whether its fields can be used. */
export type FormState = "arriving" | "live" | "answered" | "closed" | "unfinished";
export function formState(
  streaming: boolean,
  place: FormPlace | null,
  form: string | undefined,
): FormState {
  if (streaming) return "arriving";
  if (!place) return "closed";
  if (place.status === "running") return "arriving";
  if (place.status !== "complete" || place.cut) return "unfinished";
  if (form && place.answered?.action.form === form) return "answered";
  return place.last ? "live" : "closed";
}

function Field({
  field,
  value,
  onChange,
  disabled,
  problem,
  outOfRange,
}: {
  field: FieldSpec;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  problem: string | null;
  outOfRange: boolean;
}) {
  const { t, number } = useI18n();
  const id = useId();
  // What a number may be is said beside it, not only when it is refused.
  const range =
    field.kind !== "number"
      ? null
      : field.min !== undefined && field.max !== undefined
        ? t.app.form.between(number(field.min), number(field.max))
        : field.min !== undefined
          ? t.app.form.atLeast(number(field.min))
          : field.max !== undefined
            ? t.app.form.atMost(number(field.max))
            : null;
  const shared = {
    id,
    name: field.name,
    value,
    disabled,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem ? `${id}-problem` : undefined,
    "aria-required": field.required || undefined,
  } as const;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-[13px] font-medium">
        {field.label}
        {!field.required && (
          <span className="ml-1.5 font-normal text-muted-foreground">{t.app.form.optional}</span>
        )}
      </label>
      {field.kind === "text" && field.long ? (
        <Textarea {...shared} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : field.kind === "text" ? (
        <Input {...shared} type="text" onChange={(event) => onChange(event.target.value)} />
      ) : field.kind === "select" ? (
        <NativeSelect {...shared} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t.app.form.pick}</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      ) : field.kind === "date" ? (
        <Input
          {...shared}
          type="date"
          className="w-44"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Input
            {...shared}
            type="text"
            inputMode="decimal"
            className="w-36 tabular-nums"
            onChange={(event) => onChange(event.target.value)}
          />
          {field.unit && <span className="text-[13px] text-muted-foreground">{field.unit}</span>}
          {range && <span className="text-xs text-muted-foreground">{range}</span>}
        </div>
      )}
      {problem && (
        <p id={`${id}-problem`} className="text-xs text-destructive">
          {problem}
          {/* A number outside what is allowed is told what is allowed. */}
          {outOfRange && range ? ` ${range}.` : ""}
        </p>
      )}
    </div>
  );
}

/** One Form of a reply. `props` is what the reply gave it; nothing in it is trusted to be what the schema says. */
export function FormCard({ props }: { props: unknown }) {
  const { t, dateTime } = useI18n();
  const f = t.app.form;
  const streaming = useIsStreaming();
  const place = useContext(FormScope);
  const answer = place?.answer;
  const read = readForm(props);
  // Once the reply is stored, the form is the one the server would answer, or it is not a form.
  // A reply cut off at its longest is stored but not finished: its form is shown as it got, unusable.
  const stored = !streaming && place?.status === "complete" && !place.cut;
  const spec = stored ? (read && place.forms.get(read.name)) || null : read;
  const state = formState(streaming, place, spec?.name);
  const [typed, setTyped] = useState<Record<string, string> | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [sending, setSending] = useState(false);

  if (!spec) {
    // Still arriving: its fields may not be here yet. Stored: it is not a working form.
    if (!stored) return null;
    const { title, labels, secret } = formLabels(props);
    if (!title && labels.length === 0) return null;
    // A form that asks for a password, a card or an identity number is not shown, and the
    // person is not invited to type the answer either.
    if (secret)
      return (
        <p className="max-w-2xl rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          {f.secret}
        </p>
      );
    return (
      <div className="grid max-w-2xl gap-1.5 rounded-xl border px-4 py-3 text-sm">
        {title && <p className="font-medium">{title}</p>}
        {labels.length > 0 && (
          <ul className="grid list-disc gap-0.5 pl-5">
            {labels.map((label, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the labels of one form never reorder
              <li key={index}>{label}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{f.byTyping}</p>
      </div>
    );
  }

  const live = state === "live" && Boolean(answer) && Boolean(place);
  const given = state === "answered" ? (place?.answered?.action.answers ?? []) : null;
  const values: Record<string, string> = given
    ? Object.fromEntries(
        given.map((item: Answer) => [item.name, item.value === null ? "" : String(item.value)]),
      )
    : {
        ...startingValues(spec),
        ...(typed ?? (place && state === "live" ? kept(place.messageId, spec.name) : {})),
      };
  const change = (name: string, value: string) => {
    if (!live || !place) return;
    const next = { ...values, [name]: value };
    setTyped(next);
    keep(place.messageId, spec.name, next);
    if (problems[name]) setProblems(({ [name]: _, ...rest }) => rest);
  };
  const submit = async () => {
    // Asked again here: the library does not stop a press while a reply is arriving.
    if (!live || !place || !answer || sending) return;
    const checked = checkAnswer(spec, values);
    if (!checked.ok) return setProblems(checked.problems);
    setSending(true);
    const taken = await answer({ messageId: place.messageId, form: spec.name, values });
    setSending(false);
    if (taken) keep(place.messageId, spec.name, null);
  };

  return (
    <form
      className="glass-thick my-1 grid max-w-2xl overflow-hidden rounded-xl"
      data-form-state={state}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="border-b px-4 py-2.5">
        {place && <p className="text-xs text-muted-foreground">{f.asks(place.agent)}</p>}
        <p className="text-sm font-medium">{spec.title}</p>
      </div>
      <fieldset className={cn("grid gap-3 px-4 py-3", !live && "opacity-70")} disabled={!live}>
        {spec.fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            onChange={(value) => change(field.name, value)}
            disabled={!live || sending}
            problem={problems[field.name] ? f.problems[problems[field.name] as Problem] : null}
            outOfRange={
              problems[field.name] === "too_small" || problems[field.name] === "too_large"
            }
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5">
        {live ? (
          <>
            <Button type="submit" size="sm" disabled={sending}>
              {sending && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {spec.submit}
            </Button>
            <p className="text-xs text-muted-foreground">{f.goesTo(place?.agent ?? "")}</p>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            {state === "answered" && <CheckIcon className="size-3.5 text-ok" />}
            {state === "answered"
              ? f.answeredAt(place?.answered ? dateTime(place.answered.at) : "")
              : state === "arriving"
                ? f.arriving
                : state === "unfinished"
                  ? f.unfinished
                  : f.closed}
          </p>
        )}
      </div>
    </form>
  );
}

/** The person's message that answered a form: each label with what they gave it. */
export function AnswerCard({ action }: { action: FormAction }) {
  const { t } = useI18n();
  return (
    <div className="grid min-w-56 gap-2 rounded-2xl bg-secondary px-3.5 py-2.5 text-sm">
      <p className="font-medium">{action.title}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {action.answers.map((item) => (
          <div key={item.name} className="contents">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="break-words whitespace-pre-wrap">
              {item.value === null ? (
                <span className="text-muted-foreground">{t.app.form.empty}</span>
              ) : (
                `${item.value}${item.unit ? ` ${item.unit}` : ""}`
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
