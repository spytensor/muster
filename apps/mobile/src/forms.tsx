import Ionicons from "@expo/vector-icons/Ionicons";
import {
  checkAnswer,
  type FieldSpec,
  type FormAction,
  formLabels,
  type Problem,
  readForm,
  startingValues,
} from "@muster/ui-schema";
import { useIsStreaming } from "@openuidev/react-lang";
import { createContext, useContext, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "./i18n";
import { asDay, type FormPlace, formState, rangeOf } from "./lib/forms";
import { useColors } from "./theme";

/**
 * A form an agent put in its reply (CHA-237), as the phone draws it. The same functions
 * read and check it as on the web and on the server (packages/ui-schema), so the three
 * agree on what is a working form and which answers it takes. What is sent is the reply's
 * id, the form's name and what was entered; the server writes the message itself.
 *
 * What is typed stays in this app until the button is pressed: it is kept for as long as
 * the app is open, so leaving the conversation and coming back does not lose it.
 */

export const FormScope = createContext<FormPlace | null>(null);
export { type AnswerForm, formPlace } from "./lib/forms";

/** What was typed into each form and not yet sent, by reply and form. */
const unsent = new Map<string, Record<string, string>>();
const keyOf = (messageId: string, form: string) => `${messageId}.${form}`;

function Field({
  field,
  value,
  onChange,
  editable,
  problem,
  outOfRange,
}: {
  field: FieldSpec;
  value: string;
  onChange(value: string): void;
  editable: boolean;
  problem: string | null;
  outOfRange: boolean;
}) {
  const c = useColors();
  const { t } = useI18n();
  const box = [
    styles.input,
    { color: c.text, backgroundColor: c.card, borderColor: problem ? c.bad : c.border },
  ];
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.text }}>
        {field.label}
        {!field.required && (
          <Text style={{ fontWeight: "400", color: c.muted }}>{`  ${t.app.form.optional}`}</Text>
        )}
      </Text>
      {field.kind === "select" ? (
        <View
          style={styles.options}
          accessibilityRole="radiogroup"
          accessibilityLabel={field.label}
        >
          {field.options.map((option) => {
            const picked = value === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked, disabled: !editable }}
                accessibilityLabel={option}
                disabled={!editable}
                // Pressing the one already picked takes the choice back.
                onPress={() => onChange(picked ? "" : option)}
                style={[
                  styles.option,
                  {
                    borderColor: picked ? c.accent : problem ? c.bad : c.border,
                    backgroundColor: picked ? c.accentSoft : c.card,
                  },
                ]}
              >
                <Text style={{ fontSize: 14, color: picked ? c.accentText : c.text }}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.line}>
          <TextInput
            accessibilityLabel={field.label}
            value={value}
            editable={editable}
            placeholderTextColor={c.muted}
            placeholder={field.kind === "date" ? "YYYY-MM-DD" : undefined}
            keyboardType={
              field.kind === "number"
                ? "numbers-and-punctuation"
                : field.kind === "date"
                  ? "number-pad"
                  : "default"
            }
            multiline={field.kind === "text" && field.long}
            maxLength={field.kind === "date" ? 10 : undefined}
            onChangeText={(text) => onChange(field.kind === "date" ? asDay(text) : text)}
            style={[
              box,
              field.kind === "text" && field.long && { minHeight: 84, textAlignVertical: "top" },
              field.kind === "text" ? { flex: 1 } : { width: 150 },
            ]}
          />
          {field.kind === "number" && field.unit && (
            <Text style={{ fontSize: 13, color: c.muted }}>{field.unit}</Text>
          )}
          {/* What a number may be is said beside it, not only when it is refused. */}
          {field.kind === "number" && rangeOf(field) && (
            <Text style={{ fontSize: 12, color: c.muted, flexShrink: 1 }}>
              {rangeOf(field) === "between"
                ? t.app.form.between(String(field.min), String(field.max))
                : rangeOf(field) === "atLeast"
                  ? t.app.form.atLeast(String(field.min))
                  : t.app.form.atMost(String(field.max))}
            </Text>
          )}
        </View>
      )}
      {problem && (
        <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: c.bad }}>
          {problem}
          {outOfRange && field.kind === "number" && rangeOf(field)
            ? ` ${
                rangeOf(field) === "between"
                  ? t.app.form.between(String(field.min), String(field.max))
                  : rangeOf(field) === "atLeast"
                    ? t.app.form.atLeast(String(field.min))
                    : t.app.form.atMost(String(field.max))
              }.`
            : ""}
        </Text>
      )}
    </View>
  );
}

/** One Form of a reply. `props` is what the reply gave it; nothing in it is trusted to be what the schema says. */
export function FormCard({ props }: { props: unknown }) {
  const c = useColors();
  const { t, ago } = useI18n();
  const f = t.app.form;
  const streaming = useIsStreaming();
  const place = useContext(FormScope);
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
        <View
          style={[styles.card, { borderColor: c.border, backgroundColor: c.card, padding: 14 }]}
        >
          <Text style={{ fontSize: 13, lineHeight: 19, color: c.muted }}>{f.secret}</Text>
        </View>
      );
    return (
      <View style={[styles.card, { borderColor: c.border, backgroundColor: c.card, padding: 14 }]}>
        {title ? (
          <Text style={{ fontSize: 15, fontWeight: "600", color: c.text }}>{title}</Text>
        ) : null}
        {labels.map((label, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels of one form never reorder
          <Text key={index} style={{ fontSize: 14, lineHeight: 20, color: c.text }}>
            {`•  ${label}`}
          </Text>
        ))}
        <Text style={{ fontSize: 12, color: c.muted }}>{f.byTyping}</Text>
      </View>
    );
  }

  const answer = place?.answer;
  const live = state === "live" && Boolean(answer) && Boolean(place);
  const given = state === "answered" ? (place?.answered?.action.answers ?? []) : null;
  const values: Record<string, string> = given
    ? Object.fromEntries(
        given.map((item) => [item.name, item.value === null ? "" : String(item.value)]),
      )
    : {
        ...startingValues(spec),
        ...(typed ??
          (place && state === "live" ? unsent.get(keyOf(place.messageId, spec.name)) : {})),
      };
  const change = (name: string, value: string) => {
    if (!live || !place) return;
    const next = { ...values, [name]: value };
    setTyped(next);
    unsent.set(keyOf(place.messageId, spec.name), next);
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
    if (taken) unsent.delete(keyOf(place.messageId, spec.name));
  };

  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.card }]}>
      <View style={[styles.head, { borderBottomColor: c.border }]}>
        {place && <Text style={{ fontSize: 12, color: c.muted }}>{f.asks(place.agent)}</Text>}
        <Text style={{ fontSize: 15, fontWeight: "600", color: c.text }}>{spec.title}</Text>
      </View>
      <View style={[styles.fields, !live && { opacity: 0.7 }]}>
        {spec.fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            onChange={(value) => change(field.name, value)}
            editable={live && !sending}
            problem={problems[field.name] ? f.problems[problems[field.name] as Problem] : null}
            outOfRange={
              problems[field.name] === "too_small" || problems[field.name] === "too_large"
            }
          />
        ))}
      </View>
      <View style={[styles.foot, { borderTopColor: c.border }]}>
        {live ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={spec.submit}
              disabled={sending}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: c.primary },
                (pressed || sending) && { opacity: 0.7 },
              ]}
            >
              {sending && <ActivityIndicator size="small" color={c.onPrimary} />}
              <Text style={{ fontSize: 15, fontWeight: "600", color: c.onPrimary }}>
                {spec.submit}
              </Text>
            </Pressable>
            <Text style={{ fontSize: 12, lineHeight: 16, color: c.muted }}>
              {f.goesTo(place?.agent ?? "")}
            </Text>
          </>
        ) : (
          <View style={styles.status} accessibilityRole="text">
            {state === "answered" && <Ionicons name="checkmark" size={14} color={c.ok} />}
            <Text style={{ fontSize: 12, lineHeight: 16, color: c.muted, flexShrink: 1 }}>
              {state === "answered"
                ? f.answeredAt(place?.answered ? ago(place.answered.at) : "")
                : state === "arriving"
                  ? f.arriving
                  : state === "unfinished"
                    ? f.unfinished
                    : f.closed}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

/** The person's message that answered a form: each label with what they gave it. */
export function AnswerCard({ action }: { action: FormAction }) {
  const c = useColors();
  const { t } = useI18n();
  return (
    <View style={[styles.answer, { backgroundColor: c.soft }]}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: c.text }}>{action.title}</Text>
      {action.answers.map((item) => (
        <View key={item.name} style={{ gap: 1 }}>
          <Text style={{ fontSize: 12, color: c.muted }}>{item.label}</Text>
          <Text
            selectable
            style={{ fontSize: 15, lineHeight: 21, color: item.value === null ? c.muted : c.text }}
          >
            {item.value === null
              ? t.app.form.empty
              : `${item.value}${item.unit ? ` ${item.unit}` : ""}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: "hidden",
    gap: 4,
  },
  head: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fields: { paddingHorizontal: 14, paddingVertical: 12, gap: 14 },
  foot: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 15,
    minHeight: 40,
  },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: "center",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  answer: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 11, gap: 8 },
});
