import { isId } from "@muster/protocol";
import { answerText, checkAnswer, FORM_LIMITS, type FormAction, formsIn } from "@muster/ui-schema";
import { z } from "zod";
import type { Queryable } from "./db.js";

/**
 * A person's answer to a form an agent put in its reply (CHA-237).
 *
 * A reply may hold a `Form` (packages/ui-schema). It is words on a page: it can call
 * nothing. The person fills it in and presses its button, and what arrives here is the
 * reply's id, the form's name and what they entered. Nothing else is taken from the page:
 * the form itself is read again from the reply as it is stored, the values are checked
 * against that form, and the message the agent then receives is written here, from the
 * form's own labels and the values. So a reply cannot make the person say something they
 * did not see, and a page cannot answer a form that is not there.
 *
 * A form can be answered only while its reply is the last thing said in the conversation.
 * The answer is the person's next message, so a second answer finds the reply no longer
 * last: that is checked again where the message is stored, under the conversation's lock
 * (`Runs.start`).
 */
export const FORMS_SCHEMA = [
  // What a person's message answers, when it answers a form: the reply, the form, each
  // label with its value. Null for a message they typed.
  // "if not exists": a database that ran this change while it was still numbered 24 has
  // the column already.
  `alter table messages add column if not exists action jsonb`,
];

/** What a client sends with a message that answers a form. */
export const AnswerBody = z.strictObject({
  messageId: z.string().refine(isId),
  form: z.string().min(1).max(FORM_LIMITS.name),
  values: z.record(
    z.string().max(FORM_LIMITS.name),
    z.union([z.string().max(FORM_LIMITS.text + 100), z.number()]),
  ),
});

export interface FormAnswer {
  /** The person's message, as the agent and the conversation read it. */
  content: string;
  /** What is kept beside it. */
  record: FormAction;
  /** Where the reply stands in the conversation: it must still be the last message when the answer is stored. */
  replySeq: number;
  /** The agent that wrote the reply, and so the one the answer is for. Null: the conversation's own. */
  agentId: string | null;
}

/**
 * Checks an answer against the form in the stored reply and writes the person's message.
 * `form_closed`: the reply is not this conversation's last reply, or it did not finish. `invalid_form`:
 * the reply has no such working form, or a value does not fit it.
 */
export async function formAnswer(
  db: Queryable,
  conversation: { id: string; orgId: string },
  answer: z.infer<typeof AnswerBody>,
): Promise<FormAnswer | "form_closed" | "invalid_form"> {
  const reply = (
    await db.query<{
      seq: number;
      role: string;
      status: string;
      content: string;
      last: number;
      agent_id: string | null;
      ending: string | null;
    }>(
      `select m.seq, m.role, m.status, m.content, m.agent_id, m.ending,
              (select max(seq) from messages where conversation_id = m.conversation_id) as last
         from messages m where m.id = $1 and m.conversation_id = $2 and m.org_id = $3`,
      [answer.messageId, conversation.id, conversation.orgId],
    )
  )[0];
  if (!reply) return "invalid_form";
  if (reply.role !== "assistant" || reply.status !== "complete" || reply.seq !== Number(reply.last))
    return "form_closed";
  // A reply cut off at the longest a reply can be is stored as complete, and what was cut
  // may be its form: fields missing, a label ending mid-word. It is not answered.
  if (reply.ending === "length") return "form_closed";
  const form = formsIn(reply.content).get(answer.form);
  if (!form) return "invalid_form";
  const checked = checkAnswer(form, answer.values);
  if (!checked.ok) return "invalid_form";
  return {
    content: answerText(form.title, checked.answers),
    record: {
      messageId: answer.messageId,
      form: form.name,
      title: form.title,
      answers: checked.answers,
    },
    replySeq: reply.seq,
    agentId: reply.agent_id,
  };
}
