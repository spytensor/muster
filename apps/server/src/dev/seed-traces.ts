import { newId } from "@muster/protocol";
import type { Queryable } from "../db.js";
import { ensurePlatformAgents } from "../product.js";
import {
  type Level,
  PLATFORM_AGENTS,
  riskOf,
  TOOLS,
  type ToolName,
  versionOf,
} from "../runtime/catalog.js";

/** A small deterministic generator, so the sample data is the same on every start. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a call to each tool looks like in the record: [arguments, result, slowest and fastest in ms]. */
// The sample record uses the tools that need nothing connected.
const CALLS: Partial<Record<ToolName, { input: string; output: string; ms: [number, number] }>> = {
  "docs.list": {
    input: "{}",
    output:
      "Launch notes (2,314 characters)\nPricing notes (1,102 characters)\nQ3 plan (4,870 characters)",
    ms: [20, 90],
  },
  "docs.read": {
    input: '{"title":"Launch notes"}',
    output: "Launch notes\n\nThe launch moves to the 21st. Three items were re-scoped…",
    ms: [20, 120],
  },
  "docs.write": {
    input: '{"title":"Weekly report","content":"Shipped: …"}',
    output: 'Created the document "Weekly report" (1,840 characters).',
    ms: [30, 160],
  },
  "files.list": {
    input: "{}",
    output:
      "- Q3 results.xlsx (spreadsheet, 18240 bytes)\n- Supplier agreement.docx (document, 41200 bytes)",
    ms: [20, 90],
  },
  "files.read": {
    input: '{"name":"Q3 results.xlsx"}',
    output: '--- Sheet "Summary" (12 rows) ---\n1: Region,Revenue\n2: North,1204000…',
    ms: [80, 900],
  },
  "files.create": {
    input: '{"name":"Weekly report.docx","text":"# Weekly report…"}',
    output:
      'Made the file "Weekly report.docx" (15360 bytes). The person can open it from this conversation.',
    ms: [150, 1200],
  },
  "web.fetch": {
    input: '{"url":"https://example.com/research/retrieval-evaluation"}',
    output:
      "Content of https://example.com/research/retrieval-evaluation:\n\nRetrieval evaluation in 2026…",
    ms: [300, 2400],
  },
  "web.send": {
    input:
      '{"url":"https://hooks.example.com/team","body":"{\\"text\\":\\"Release 2.4 is out\\"}"}',
    output: "Sent. The address answered with status 200.",
    ms: [180, 900],
  },
};
/** What each sample call is about, as the person sees it in the list of steps. */
const DETAILS: Partial<Record<ToolName, string>> = {
  "docs.list": "",
  "docs.read": "Launch notes",
  "docs.write": "Weekly report",
  "files.list": "",
  "files.read": "Q3 results.xlsx",
  "files.create": "Weekly report.docx",
  "web.fetch": "example.com/research/retrieval-evaluation",
  "web.send": "hooks.example.com/team",
};
const SENT = {
  destination: "https://hooks.example.com/team",
  method: "POST",
  contentType: "application/json",
  bytes: 29,
  preview: '{"text":"Release 2.4 is out"}',
};

interface AgentSpec {
  name: string;
  /** Local part of the builder's address; empty for an agent the platform provides. */
  owner: string;
  description: string;
  instructions: string;
  tools: ToolName[];
  state: "pending" | "published" | "suspended";
  weight: number;
  users: string[];
  asks: [string, string][];
}

const EVERYONE = ["member", "wang.lei", "li.na", "sun.yu", "wu.tong", "zhao.min", "admin", "owner"];
const ASKS: Record<string, { weight: number; users: string[]; asks: [string, string][] }> = {
  Assistant: {
    weight: 30,
    users: EVERYONE,
    asks: [
      [
        "Summarize my launch notes into five points.",
        "Five points from Launch notes, with the date change first.",
      ],
      [
        "What did we decide about pricing? Check my documents.",
        "Pricing notes say: annual plans first, monthly plans in the second quarter.",
      ],
      [
        "Read this page and tell me what matters for us.",
        "Three things matter: the new limits, the price change, and the migration date.",
      ],
      [
        "Turn last week's meeting notes into action items with owners.",
        "Seven action items, each with an owner and a date; two have no owner yet.",
      ],
      [
        "Compare the two vendor quotes in my documents.",
        "A table of both quotes: the second is cheaper over three years, not over one.",
      ],
      [
        "Draft a reply to the customer asking about the delay.",
        "A draft is ready for you to read: it gives the new date and says why.",
      ],
      [
        "What is on my plate this week? Check my notes.",
        "Four things are due this week; the budget review is the one at risk.",
      ],
      [
        "Explain the new expense policy in plain words.",
        "In short: receipts within 30 days, and travel above the limit needs approval first.",
      ],
      [
        "Make a checklist for onboarding a new engineer.",
        "A checklist of twelve steps, grouped by first day, first week and first month.",
      ],
      [
        "Summarize the quarterly numbers for the board update.",
        "Revenue is up, churn is flat, and hiring is two people behind plan.",
      ],
      [
        "List the open questions from the security review.",
        "Five questions are open; three wait on Engineering and two on Legal.",
      ],
      [
        "Which contracts renew in the next 90 days?",
        "Three renew in the next 90 days; one needs notice by the end of the month.",
      ],
    ],
  },
  Writer: {
    weight: 22,
    users: ["member", "wang.lei", "li.na", "sun.yu", "zhao.min", "auditor"],
    asks: [
      [
        "Draft this week's report for the growth team.",
        'Saved as "Weekly report": three shipped items, two risks and next week\'s plan.',
      ],
      [
        "Rewrite the supplier agreement summary in plain language.",
        'Saved as "Supplier agreement, plain": two clauses still need a lawyer\'s eye.',
      ],
    ],
  },
  Researcher: {
    weight: 16,
    users: ["wang.lei", "zhao.min", "member", "wu.tong"],
    asks: [
      [
        "Find recent work on retrieval evaluation and summarize it.",
        "Five pieces summarized, the two most relevant first, each with its address.",
      ],
      [
        "What changed in the pricing of our three main competitors?",
        "Two raised prices this quarter; the third added a free tier. Sources are listed.",
      ],
    ],
  },
  Messenger: {
    weight: 8,
    users: ["li.na", "wu.tong", "admin"],
    asks: [
      [
        "Tell the release channel that 2.4 is out.",
        "Sent to hooks.example.com/team: Release 2.4 is out.",
      ],
      [
        "Send this week's numbers to the team webhook.",
        "Sent the three headline numbers to the team webhook.",
      ],
    ],
  },
};

const AGENTS: AgentSpec[] = [
  ...PLATFORM_AGENTS.map((agent) => ({
    ...agent,
    owner: "",
    state: "published" as const,
    ...(ASKS[agent.name] as (typeof ASKS)[string]),
  })),
  {
    name: "Meeting minutes",
    owner: "wang.lei",
    description: "Turns my meeting notes into decisions and action items.",
    instructions:
      "Read the notes document the person names and write minutes: decisions first, then action items with owners. Save the minutes as a document.",
    tools: ["docs.read", "docs.write"],
    state: "published",
    weight: 8,
    users: ["wang.lei"],
    asks: [
      [
        "Write up the minutes from today's planning notes.",
        'Saved as "Planning minutes": 5 decisions and 9 action items.',
      ],
    ],
  },
  {
    name: "Reading list",
    owner: "wu.tong",
    description: "Reads the pages I give it and keeps a running summary.",
    instructions:
      "Read each page the person gives you and add a three-line summary to the Reading list document.",
    tools: ["docs.read", "docs.write", "web.fetch"],
    state: "published",
    weight: 4,
    users: ["wu.tong"],
    asks: [["Add this article to my reading list.", "Added, with a three-line summary."]],
  },
  {
    name: "Release announcer",
    owner: "li.na",
    description: "Posts release notes from my documents to the team chat.",
    instructions:
      "Read the release notes document the person names, write a short announcement, and send it to the webhook address the person gives.",
    tools: ["docs.read", "web.send"],
    state: "published",
    weight: 5,
    users: ["li.na"],
    asks: [
      [
        "Announce the 2.4 release notes to the team chat.",
        "Announced: the note is in the team chat.",
      ],
    ],
  },
  {
    name: "Social posting",
    owner: "zhou.jie",
    description: "Publishes posts to the company's channels.",
    instructions: "Write the post the person asks for and send it to the address they give.",
    tools: ["web.send"],
    state: "suspended",
    weight: 2,
    users: ["zhou.jie"],
    asks: [
      [
        "Post the launch announcement to the marketing channel.",
        "Posted to the marketing channel.",
      ],
    ],
  },
  {
    name: "Competitor watch",
    owner: "zhao.min",
    description: "Reads competitor sites and posts a digest to the team chat.",
    instructions:
      "Read the competitor pages the person lists, write a digest of what changed, and send it to the team webhook.",
    tools: ["web.fetch", "web.send"],
    state: "pending",
    weight: 0,
    users: [],
    asks: [],
  },
];

const DAY = 86_400_000;
const say = (text: string) => `root = Stack([a])\na = Text(${JSON.stringify(text)})`;

export interface SeedModel {
  id: string;
  /** US dollars per million tokens. */
  inputPrice: number;
  outputPrice: number;
}
export interface SeedPerson {
  id: string;
  email: string;
}

/**
 * Fills a development database with a month of work: the platform's agents and a few that people
 * built, and for every run its conversation, messages, trace and any confirmation it asked for.
 * Everything here uses the real agents and the real tools, so what the console shows about the
 * sample is what it would show about real use.
 */
export async function seedTraces(
  db: Queryable,
  orgId: string,
  people: SeedPerson[],
  now: number,
  model: SeedModel,
): Promise<void> {
  if (people.length === 0) throw new Error("sample runs need at least one person");
  const rand = rng(20261114);
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
  const pick = <V>(items: V[]): V => items[Math.floor(rand() * items.length)] as V;
  const byLocal = new Map(people.map((person) => [person.email.split("@")[0] as string, person]));
  /** The named people who exist here; when none does, anyone. */
  const among = (names: string[]) => {
    const found = names.flatMap((name) => byLocal.get(name) ?? []);
    return found.length > 0 ? found : people;
  };

  await ensurePlatformAgents(db, orgId, model.id);
  const agents = new Map<string, { id: string; version: string; risk: string }>();
  for (const row of await db.query<{ id: string; name: string; version: string; risk: string }>(
    "select id, name, version, risk from agents where org_id = $1 and source = 'platform'",
    [orgId],
  )) {
    agents.set(row.name, row);
  }
  await db.query("update agents set created_at = $2 where org_id = $1 and source = 'platform'", [
    orgId,
    new Date(now - 80 * DAY),
  ]);
  for (const [index, agent] of AGENTS.entries()) {
    if (!agent.owner) continue;
    const created = now - (60 - index * 6) * DAY;
    const id = newId(created);
    const version = await versionOf({
      model: model.id,
      instructions: agent.instructions,
      tools: agent.tools,
    });
    const risk = riskOf(agent.tools);
    agents.set(agent.name, { id, version, risk });
    await db.query(
      `insert into agents (id, org_id, name, description, source, owner_user_id, risk, state, version, model, instructions, tools, created_at)
       values ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        orgId,
        agent.name,
        agent.description,
        (among([agent.owner])[0] as SeedPerson).id,
        risk,
        agent.state,
        version,
        model.id,
        agent.instructions,
        agent.tools,
        new Date(created),
      ],
    );
  }

  const runnable = AGENTS.filter((a) => a.weight > 0);
  const totalWeight = runnable.reduce((sum, a) => sum + a.weight, 0);
  const chooseAgent = () => {
    let roll = rand() * totalWeight;
    for (const agent of runnable) {
      roll -= agent.weight;
      if (roll <= 0) return agent;
    }
    return runnable[0] as AgentSpec;
  };

  for (let day = 29; day >= 0; day--) {
    const date = new Date(now - day * DAY);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const runs = weekend ? between(2, 6) : between(12, 20) + Math.round((29 - day) / 5);
    for (let i = 0; i < runs; i++) {
      const agent = chooseAgent();
      // Working hours, with a lunchtime dip.
      const hour = pick([8, 9, 9, 10, 10, 10, 11, 11, 13, 14, 14, 14, 15, 15, 16, 16, 17, 19]);
      const startedAt = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        hour,
        between(0, 59),
        between(0, 59),
      );
      if (startedAt > now) continue;
      const turns = rand() < 0.22 ? between(2, 3) : 1;
      const person = pick(among(agent.users));
      const conversationId = newId(startedAt);
      let at = startedAt;
      let seq = 0;
      let title = "";
      for (let turn = 0; turn < turns && at <= now; turn++) {
        const [ask, answer] = pick(agent.asks);
        title ||= ask.slice(0, 60);
        if (turn === 0) {
          await db.query(
            "insert into conversations (id, org_id, user_id, agent_id, title, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$6)",
            [
              conversationId,
              orgId,
              person.id,
              (agents.get(agent.name) as { id: string }).id,
              title,
              new Date(at),
            ],
          );
        }
        const done = await insertRun(agent, person, conversationId, new Date(at), ask, answer, seq);
        seq += 2;
        at += done + between(60_000, 240_000);
        await db.query("update conversations set updated_at = $2 where id = $1", [
          conversationId,
          new Date(Math.min(at, now)),
        ]);
      }
    }
  }

  /** One turn: the person's message, the agent's reply, and the record of how it got there. */
  async function insertRun(
    agent: AgentSpec,
    person: SeedPerson,
    conversationId: string,
    startedAt: Date,
    ask: string,
    answer: string,
    messageSeq: number,
  ): Promise<number> {
    const t0 = startedAt.getTime();
    const traceId = newId(t0);
    const registered = agents.get(agent.name) as { id: string; version: string; risk: string };
    const rootId = newId(t0);
    const spans: unknown[][] = [];
    let clock = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cost = 0;
    let status: "ok" | "error" | "blocked" = "ok";
    let maxAction: Level = "A0";
    let lastInput = ask;
    const shown: { id: string; tool: string; status: string; detail: string; ms: number }[] = [];
    const push = (row: {
      id?: string;
      parent: string | null;
      kind: string;
      name: string;
      status: string;
      start: number;
      ms: number;
      input?: string;
      output?: string;
      attributes?: object;
      events?: object[];
      pt?: number;
      ct?: number;
      cost?: number;
    }) => {
      spans.push([
        row.id ?? newId(t0),
        traceId,
        orgId,
        row.parent,
        0,
        row.kind,
        row.name,
        row.status,
        row.start,
        row.ms,
        row.input ?? "",
        row.output ?? "",
        JSON.stringify(row.attributes ?? {}),
        JSON.stringify(row.events ?? []),
        row.pt ?? 0,
        row.ct ?? 0,
        row.cost ?? 0,
      ]);
    };
    const llm = (name: "decide" | "answer", output: string, failure?: string) => {
      const pt = failure ? 0 : between(900, 5200);
      const ct = failure ? 0 : between(80, 900);
      const ms = between(700, 5200);
      const c = Math.round(pt * model.inputPrice + ct * model.outputPrice);
      push({
        parent: rootId,
        kind: "llm",
        name,
        status: failure ? "error" : "ok",
        start: clock,
        ms,
        input: lastInput,
        output,
        attributes: {
          model: model.id,
          stopReason: failure ? "error" : name === "decide" ? "toolUse" : "stop",
        },
        events: failure ? [{ name: "error", atMs: ms, message: failure }] : [],
        pt,
        ct,
        cost: c,
      });
      promptTokens += pt;
      completionTokens += ct;
      cost += c;
      clock += ms + between(5, 40);
    };

    const steps = [...agent.tools]
      .sort(() => rand() - 0.5)
      .slice(0, between(1, agent.tools.length));
    // The action that leaves the organization comes last, after the reading.
    steps.sort((a, b) =>
      TOOLS[a].level > TOOLS[b].level ? 1 : TOOLS[a].level < TOOLS[b].level ? -1 : 0,
    );
    for (const tool of steps) {
      const { level, summary } = TOOLS[tool];
      // Sample agents use only the tools the sample record describes.
      const call = CALLS[tool] ?? { input: "{}", output: "", ms: [100, 400] as [number, number] };
      llm("decide", `${tool}(${call.input})`);
      if (level > maxAction) maxAction = level;
      const toolId = newId(t0);
      const toolStart = clock;
      const asks = level === "A3";
      push({
        parent: toolId,
        kind: "policy",
        name: "policy.check",
        status: "ok",
        start: clock,
        ms: 0,
        input: `${tool} · ${level}`,
        output: asks ? "ask" : "allow",
        attributes: {
          actionLevel: level,
          effect: asks ? "ask" : "allow",
          policyId: asks ? "confirm-external-actions" : "default-allow",
        },
      });
      let rejected = false;
      if (asks) {
        rejected = rand() < 0.2;
        const waited = between(4000, 90_000);
        const approvalId = newId(t0 + clock);
        const outcome = rejected ? "rejected" : "approved";
        await db.query(
          `insert into approvals (id, org_id, user_id, agent_id, conversation_id, trace_id, tool, level, summary, status, requested_at, decided_at, decided_by)
           values ($1,$2,$3,$4,$5,$6,$7,'A3',$8::jsonb,$9,$10,$11,$3)`,
          [
            approvalId,
            orgId,
            person.id,
            registered.id,
            conversationId,
            traceId,
            tool,
            JSON.stringify(SENT),
            outcome,
            new Date(t0 + clock),
            new Date(t0 + clock + waited),
          ],
        );
        push({
          parent: toolId,
          kind: "approval",
          name: "approval.user",
          status: rejected ? "blocked" : "ok",
          start: clock,
          ms: waited,
          input: `Confirm ${tool} ${SENT.method} ${SENT.destination}`,
          output: outcome,
          attributes: { actionLevel: level, approvalId, outcome, approver: person.email },
        });
        clock += waited;
      }
      const failed =
        !rejected && rand() < (tool === "web.fetch" ? 0.1 : tool === "web.send" ? 0.06 : 0.01);
      const output = rejected
        ? "The person chose not to allow this action."
        : failed
          ? tool === "web.fetch"
            ? "The page answered with status 503."
            : tool === "web.send"
              ? "The address answered with status 500."
              : 'There is no document titled "Launch notes".'
          : call.output;
      if (!rejected) clock += between(call.ms[0], call.ms[1]);
      push({
        id: toolId,
        parent: rootId,
        kind: tool === "web.fetch" ? "retriever" : "tool",
        name: tool,
        status: rejected ? "blocked" : failed ? "error" : "ok",
        start: toolStart,
        ms: clock - toolStart,
        input: call.input,
        output,
        attributes: { actionLevel: level, summary },
        events: failed ? [{ name: "exception", atMs: clock - toolStart, message: output }] : [],
      });
      shown.push({
        id: toolId,
        tool,
        status: rejected ? "blocked" : failed ? "error" : "ok",
        detail: DETAILS[tool] ?? "",
        ms: clock - toolStart,
      });
      clock += between(5, 30);
      lastInput = `Result of ${tool}: ${output}`;
      if (rejected) {
        status = "blocked";
        answer = "I did not send it, because you chose not to allow it.";
        break;
      }
    }
    // Now and then the model endpoint itself fails, and the run with it.
    const modelFailed = status === "ok" && rand() < 0.04;
    if (modelFailed) {
      status = "error";
      llm("answer", "", "The model endpoint answered with status 529.");
    } else {
      llm("answer", say(answer));
    }
    const content = modelFailed ? "" : say(answer);

    push({
      id: rootId,
      parent: null,
      kind: "agent",
      name: agent.name,
      status,
      start: 0,
      ms: clock,
      input: ask,
      output: content || "The model endpoint answered with status 529.",
      attributes: { venue: "cloud", user: person.email, risk: registered.risk, model: model.id },
    });

    await db.query(
      `insert into messages (id, conversation_id, org_id, seq, role, content, status, trace_id, created_at, steps) values
         ($1,$3,$4,$5,'user',$7,'complete',null,$10,'[]'), ($2,$3,$4,$6,'assistant',$8,$9,$11,$10,$12::jsonb)`,
      [
        newId(t0),
        newId(t0),
        conversationId,
        orgId,
        messageSeq,
        messageSeq + 1,
        ask,
        content,
        modelFailed ? "failed" : "complete",
        startedAt,
        traceId,
        JSON.stringify(shown),
      ],
    );
    await db.query(
      `insert into traces (id, org_id, agent_id, agent_version, user_id, conversation_id, venue, status, started_at, duration_ms,
                           input, output, prompt_tokens, completion_tokens, cost_micros, span_count, max_action)
       values ($1,$2,$3,$4,$5,$6,'cloud',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        traceId,
        orgId,
        registered.id,
        registered.version,
        person.id,
        conversationId,
        status,
        startedAt,
        clock,
        ask,
        content || "The model endpoint answered with status 529.",
        promptTokens,
        completionTokens,
        cost,
        spans.length,
        maxAction,
      ],
    );
    // The root span is pushed last but belongs first.
    const ordered = [spans[spans.length - 1] as unknown[], ...spans.slice(0, -1)];
    for (const [index, row] of ordered.entries()) {
      row[4] = index;
      await db.query(
        `insert into spans (id, trace_id, org_id, parent_id, seq, kind, name, status, start_offset_ms, duration_ms, input, output,
                            attributes, events, prompt_tokens, completion_tokens, cost_micros)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17)`,
        row,
      );
    }
    return clock;
  }
}
