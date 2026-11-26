/**
 * Reading a form out of a reply, checking what a person answered, and writing their answer
 * as the message the agent receives. The web app, the mobile app and the server all use
 * these same functions, so they cannot disagree about what is a working form, which
 * answers it accepts, or what an answer says.
 *
 * A reply is written by a model, which may have been steered by something it read. So
 * nothing here trusts a prop to be what the schema says: every value is checked for its
 * kind, and anything that is not a plain word, number or yes/no is left out or, where the
 * form would not make sense without it, makes the whole form not a form.
 */

/** How much a form, a field and a reply may hold. */
export const FORM_LIMITS = {
  /**
   * Forms in one reply. A form is answered by the person's next message, so of two forms
   * in a reply only one could ever be answered: a reply has one.
   */
  forms: 1,
  fields: 12,
  options: { min: 2, max: 30 },
  /** Characters of a title, a label, the button's words or an option; longer is cut. */
  label: 120,
  /** Characters of a unit. */
  unit: 20,
  /** Characters of a field's or a form's name. */
  name: 40,
  /** Characters of a value the person types. */
  text: 2000,
  /**
   * Characters of a value the agent gives a field of one line. A longer one would run off
   * the field, and what the person cannot see they must not be made to send.
   */
  line: 200,
} as const;

interface FieldBase {
  name: string;
  label: string;
  required: boolean;
}
export type FieldSpec =
  | (FieldBase & { kind: "text"; value?: string; long: boolean })
  | (FieldBase & { kind: "select"; options: string[]; value?: string })
  | (FieldBase & { kind: "date"; value?: string })
  | (FieldBase & { kind: "number"; value?: number; min?: number; max?: number; unit?: string });

/** A form as every client draws it and as the server answers it. */
export interface FormSpec {
  name: string;
  title: string;
  submit: string;
  fields: FieldSpec[];
}

/** One field of an answer, as it is kept with the person's message. */
export interface Answer {
  name: string;
  label: string;
  /** null: the person left it empty. */
  value: string | number | null;
  unit?: string;
  /** The agent gave this value and the person left it as it was. */
  suggested: boolean;
}

/** What is kept beside a person's message that answers a form (`messages.action`). */
export interface FormAction {
  /** The reply the form is in. */
  messageId: string;
  form: string;
  title: string;
  answers: Answer[];
}

export type Problem =
  | "required"
  | "too_long"
  | "not_an_option"
  | "not_a_date"
  | "not_a_number"
  | "too_small"
  | "too_large"
  | "unknown_field";

const KINDS = {
  TextField: "text",
  SelectField: "select",
  DateField: "date",
  NumberField: "number",
} as const;

/**
 * A key: letters and digits of any language, and `_ . -`. Never a name an object already has.
 * Written as ranges, not as Unicode classes, which not every engine the apps run on knows:
 * of the first 128 characters only letters, digits and `_ . -`; of the rest, none that is a
 * space or a mark that draws nothing.
 */
const NAME = /^[A-Za-z0-9_.\-\u00c0-\u1fff\u2e80-\ud7ff\uf900-\ufdcf\uff10-\uffdc]+$/;
/** Marks that draw nothing or turn the direction of the text: they can hide what words say. */
// Built from words, so that the control characters it names are not themselves in a pattern.
// biome-ignore lint/complexity/useRegexLiterals: a literal would hold the control characters themselves
const UNSEEN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "g",
);
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const name = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length <= FORM_LIMITS.name &&
  NAME.test(value) &&
  !RESERVED.has(value)
    ? value
    : null;

/** Words on one line, cut to what a label may hold. Not words at all: nothing. */
const words = (value: unknown, most: number = FORM_LIMITS.label): string => {
  if (typeof value !== "string") return "";
  const line = value.replace(UNSEEN, "").replace(/\s+/g, " ").trim();
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A day written YYYY-MM-DD that exists in the calendar. */
export const isDay = (value: unknown): value is string => {
  // From the year 1000: an earlier one is a slip, and a date control shows it as nothing.
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
};

/**
 * Whether words carry a web address. An address in a form is the agent's, not the person's,
 * even after the person sends the form: the server tells the two apart by finding the
 * address in the reply as the agent wrote it. So an address may stand only where it can be
 * found there letter for letter: never in a title, a label or a unit (which are cut and set
 * on one line), and in an option or a value only when the reply holds those very words.
 */
const carriesAddress = (value: string) => /:\/\//.test(value);
const written = (value: string, source: string | undefined) =>
  !carriesAddress(value) || source === undefined || source.includes(value);

/** A number as a person would type it, never in the form 1e-7. */
const plain = (value: number) => {
  const text = String(value);
  return /e/i.test(text) ? value.toFixed(20).replace(/\.?0+$/, "") : text;
};

/**
 * A label that asks for something that must not be typed into a conversation: a password or
 * a code, a card or bank number, an identity number. A model is told never to ask for these;
 * a form that does anyway is not drawn as a form.
 */
const SENSITIVE =
  /pass\s*word|passcode|passphrase|\bpin\b|\bcvv\b|\bcvc\b|security code|one[- ]time code|verification code|\botp\b|\b2fa\b|\bsecret\b|api key|private key|\btoken\b|card (number|no\b|details)|credit card|debit card|\biban\b|bank account|account number|routing number|sort code|\bssn\b|social security|passport (number|no\b)|national id|identity number|\bid (number|no\b)|licen[cs]e number|tax (id|number)|密码|口令|验证码|银行卡|信用卡|卡号|银行账号|身份证|护照号|社保号|密钥/i;
export const asksForSecret = (label: string) => SENSITIVE.test(label);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function readField(
  node: unknown,
  misfits?: ReadonlySet<string>,
  source?: string,
): FieldSpec | null {
  const element = record(node);
  const props = record(element?.props);
  const kind = KINDS[element?.typeName as keyof typeof KINDS];
  if (!props || !kind) return null;
  const key = name(props.name);
  const label = words(props.label);
  if (!key || !label || carriesAddress(label) || asksForSecret(label)) return null;
  const base = { name: key, label, required: props.required === true };
  const misfit = typeof element?.statementId === "string" && misfits?.has(element.statementId);
  if (kind === "text") {
    const long = props.long === true;
    const given =
      typeof props.value === "string" &&
      props.value.length <= FORM_LIMITS.text &&
      written(props.value, source)
        ? props.value.replace(UNSEEN, "")
        : undefined;
    // What the agent gives a field is what the person sees in it. A field of one line holds
    // one line, with single spaces, short enough to be read in the field: a value of several
    // lines could write lines of the answer, and one that runs on past the field's edge, or
    // hides words behind a run of spaces, would be sent without having been seen. Such a
    // value is not put into the field at all. In a field of several lines, runs of spaces
    // within a line are closed up.
    const set = long
      ? given?.replace(/[^\S\r\n]+/g, " ").trim()
      : given?.replace(/\s+/g, " ").trim();
    const value = set && (long || set.length <= FORM_LIMITS.line) ? set : undefined;
    return { ...base, kind, long, ...(value ? { value } : {}) };
  }
  if (kind === "select") {
    if (!Array.isArray(props.options)) return null;
    // An option with an address must be the reply's own words, whole and uncut.
    if (
      props.options.some(
        (option) =>
          typeof option === "string" &&
          carriesAddress(option) &&
          (words(option) !== option || !written(option, source)),
      )
    )
      return null;
    const options = [...new Set(props.options.map((option) => words(option)).filter(Boolean))];
    if (options.length < FORM_LIMITS.options.min || options.length > FORM_LIMITS.options.max)
      return null;
    const value = words(props.value);
    return { ...base, kind, options, ...(options.includes(value) ? { value } : {}) };
  }
  if (kind === "date")
    return { ...base, kind, ...(isDay(props.value) ? { value: props.value } : {}) };
  // A model sometimes leaves `required` out of a number field, and what follows moves up one
  // place: the upper bound arrives as the lower one, and the rest is not of its kind. Bounds
  // read that way would refuse every sensible number, so a number field whose arguments
  // did not all fit is taken without bounds.
  const given = misfit ? {} : props;
  let min = finite(given.min);
  let max = finite(given.max);
  if (min !== undefined && max !== undefined && min > max) {
    min = undefined;
    max = undefined;
  }
  const value = finite(props.value);
  const unit = words(given.unit, FORM_LIMITS.unit);
  if (carriesAddress(unit)) return null;
  return {
    ...base,
    kind,
    ...(value !== undefined ? { value } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(unit ? { unit } : {}),
  };
}

/**
 * A Form's props as a working form, or null when it is not one: no name, no title, no
 * fields or too many, a field that is not a field, two fields of one name. `misfits` names
 * the statements of the reply in which an argument was not of its kind; `source` is the
 * reply as the agent wrote it, where any address in an option or a value must be found.
 */
export function readForm(
  props: unknown,
  misfits?: ReadonlySet<string>,
  source?: string,
): FormSpec | null {
  const given = record(props);
  if (!given) return null;
  const key = name(given.name);
  const title = words(given.title);
  if (!key || !title || carriesAddress(title) || asksForSecret(title)) return null;
  if (!Array.isArray(given.fields)) return null;
  const submit = words(given.submit) || "Send";
  if (carriesAddress(submit)) return null;
  if (given.fields.length < 1 || given.fields.length > FORM_LIMITS.fields) return null;
  const fields: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const node of given.fields) {
    const field = readField(node, misfits, source);
    if (!field || seen.has(field.name)) return null;
    seen.add(field.name);
    fields.push(field);
  }
  return { name: key, title, submit, fields };
}

/**
 * What can still be read of a Form that is not a working form: its title and the labels
 * of its fields, so a client can list what was asked and the person can answer by typing.
 */
export function formLabels(props: unknown): {
  title: string;
  labels: string[];
  /** It asks for something that must not be typed here: the person is told so, not asked. */
  secret: boolean;
} {
  const given = record(props);
  const fields = Array.isArray(given?.fields) ? given.fields : [];
  const title = words(given?.title);
  const labels = fields
    .slice(0, 40)
    .map((node) => words(record(record(node)?.props)?.label))
    .filter(Boolean);
  return { title, labels, secret: [title, ...labels].some(asksForSecret) };
}

/**
 * The working forms among the parts of a parsed reply, by name. Only as many as a reply
 * may hold, in order; a form whose name an earlier one has is not one.
 */
export function formsOf(
  root: unknown,
  misfits?: ReadonlySet<string>,
  source?: string,
): Map<string, FormSpec> {
  const forms = new Map<string, FormSpec>();
  const children = record(record(root)?.props)?.children;
  if (!Array.isArray(children)) return forms;
  let met = 0;
  for (const child of children) {
    const element = record(child);
    if (element?.typeName !== "Form") continue;
    met += 1;
    if (met > FORM_LIMITS.forms) break;
    const form = readForm(element.props, misfits, source);
    if (form && !forms.has(form.name)) forms.set(form.name, form);
  }
  return forms;
}

/** What the person entered for one field, as its kind keeps it; null when they left it empty. */
function entered(
  field: FieldSpec,
  raw: unknown,
): { value: string | number | null } | { problem: Problem } {
  if (raw === undefined || raw === null) return { value: null };
  if (field.kind === "number") {
    if (typeof raw === "string" && raw.trim() === "") return { value: null };
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw.trim())
          ? Number(raw.trim())
          : Number.NaN;
    if (!Number.isFinite(value)) return { problem: "not_a_number" };
    if (field.min !== undefined && value < field.min) return { problem: "too_small" };
    if (field.max !== undefined && value > field.max) return { problem: "too_large" };
    return { value };
  }
  if (typeof raw !== "string")
    return { problem: field.kind === "date" ? "not_a_date" : "not_an_option" };
  const value = raw.trim();
  if (!value) return { value: null };
  if (field.kind === "text")
    return value.length > FORM_LIMITS.text ? { problem: "too_long" } : { value };
  if (field.kind === "date") return isDay(value) ? { value } : { problem: "not_a_date" };
  return field.options.includes(value) ? { value } : { problem: "not_an_option" };
}

/**
 * Checks what a person entered against the form. Every value must belong to a field of the
 * form and fit its kind, its options and its bounds; a field marked required must be filled.
 * `values` holds what was entered by field name; a field with no entry is left empty.
 */
export function checkAnswer(
  form: FormSpec,
  values: unknown,
): { ok: true; answers: Answer[] } | { ok: false; problems: Record<string, Problem> } {
  const given = new Map(Object.entries(record(values) ?? {}));
  // No name an entry could carry is already there: "__proto__" is an entry like any other.
  const problems: Record<string, Problem> = Object.create(null);
  const answers: Answer[] = [];
  for (const field of form.fields) {
    const result = entered(field, given.get(field.name));
    given.delete(field.name);
    if ("problem" in result) {
      problems[field.name] = result.problem;
      continue;
    }
    if (result.value === null && field.required) {
      problems[field.name] = "required";
      continue;
    }
    answers.push({
      name: field.name,
      label: field.label,
      value: result.value,
      ...(field.kind === "number" && field.unit ? { unit: field.unit } : {}),
      suggested:
        result.value !== null &&
        field.value !== undefined &&
        (typeof field.value === "string" ? field.value.trim() : field.value) === result.value,
    });
  }
  // An entry for a field the form does not have is never quietly dropped.
  for (const extra of given.keys()) problems[extra] = "unknown_field";
  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, answers };
}

/** How every message that answers a form begins. The model is told what follows it. */
export const ANSWER_OPENS = "My answers to your form";

/** What each field starts with: the value the agent gave it, as the client's input holds it. */
export function startingValues(form: FormSpec): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of form.fields)
    if (field.value !== undefined)
      values[field.name] = typeof field.value === "number" ? plain(field.value) : field.value;
  return values;
}

/**
 * An answer as the words of the person's message: a first line that says what it is, then
 * one line a field. The agent reads exactly this, and so does the person in the
 * conversation. The title and the labels are the agent's words, not the person's, so the
 * first line says they answer the agent's form and sets its title in quotation marks: a
 * title cannot open the person's message as if they had said it. A value of several lines
 * is set in from its second line on, so no line of it reads as a field.
 */
export function answerText(title: string, answers: readonly Answer[]): string {
  return [
    `${ANSWER_OPENS} "${title.replace(/"/g, "'")}":`,
    ...answers.map((answer) =>
      answer.value === null
        ? `${answer.label}: (left empty)`
        : `${answer.label}: ${String(answer.value).replace(/\r?\n/g, "\n    ")}${answer.unit ? ` ${answer.unit}` : ""}${
            answer.suggested ? " (as suggested)" : ""
          }`,
    ),
  ].join("\n");
}

/** A stored `messages.action`, if it is one: what a client or the server reads back. */
export function readAction(value: unknown): FormAction | null {
  const given = record(value);
  if (
    !given ||
    typeof given.messageId !== "string" ||
    typeof given.form !== "string" ||
    typeof given.title !== "string" ||
    !Array.isArray(given.answers)
  )
    return null;
  const answers: Answer[] = [];
  for (const item of given.answers) {
    const answer = record(item);
    if (
      !answer ||
      typeof answer.name !== "string" ||
      typeof answer.label !== "string" ||
      !(
        answer.value === null ||
        typeof answer.value === "string" ||
        typeof answer.value === "number"
      )
    )
      return null;
    answers.push({
      name: answer.name,
      label: answer.label,
      value: answer.value,
      ...(typeof answer.unit === "string" ? { unit: answer.unit } : {}),
      suggested: answer.suggested === true,
    });
  }
  return { messageId: given.messageId, form: given.form, title: given.title, answers };
}
