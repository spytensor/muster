import { ALERTS_FIXES_SCHEMA, ALERTS_SCHEMA } from "./alerts.js";
import { BUDGETS_SCHEMA } from "./budgets.js";
import { AUDIT_CHAIN_SCHEMA, AUDIT_FIXES_SCHEMA } from "./chain.js";
import { CODE_HOST_FIXES_SCHEMA, CODE_HOST_SCHEMA } from "./codeHost.js";
import { COMPANY_SCHEMA, MCP_SCHEMA } from "./company.js";
import { DRAFTS_SCHEMA, DRAFTS_UNKNOWN_SCHEMA } from "./drafts.js";
import { FILE_VERSIONS_SCHEMA } from "./files/service.js";
import { FOLLOWUPS_SCHEMA } from "./followups.js";
import { FORMS_SCHEMA } from "./forms.js";
import { KNOWLEDGE_SCHEMA } from "./knowledge.js";
import { MARKET_SCHEMA } from "./market.js";
import { MEMORY_SCHEMA } from "./memory.js";
import { MODEL_SETTINGS_SCHEMA } from "./modelSettings.js";
import { NOTICES_SCHEMA } from "./notices.js";
import { PROFILE_SCHEMA } from "./profile.js";
import { PROJECT_ITEMS_NUMBERS_SCHEMA, PROJECT_ITEMS_SCHEMA } from "./projectItems.js";
import { RETENTION_SCHEMA } from "./retention.js";
import { SANDBOX_ADMIN_SCHEMA } from "./sandboxAdmin.js";
import { SANDBOX_USE_SCHEMA } from "./sandboxUse.js";
import { SCHEDULES_SCHEMA } from "./schedules.js";
import { SHARING_SCHEMA } from "./sharing.js";
import { SKILLS_SCHEMA } from "./skills.js";
import { DIRECTORY_SCHEMA, DIRECTORY_TRIED_SCHEMA } from "./directory.js";
import { SSO_FIXES_SCHEMA, SSO_SCHEMA } from "./sso.js";
import { TOOL_POLICY_SCHEMA } from "./toolPolicy.js";
import { TRACKER_FIXES_SCHEMA, TRACKER_SCHEMA } from "./tracker.js";
/**
 * Migrations, in order. Each entry is one migration: a list of statements run in a
 * transaction. Never edit a migration that has shipped; append a new one.
 */
export const MIGRATIONS: string[][] = [
  [
    `create table organizations (
      id uuid primary key,
      name text not null,
      created_at timestamptz not null default now()
    )`,
    // A domain belongs to at most one organization.
    `create table org_domains (
      org_id uuid not null references organizations(id) on delete cascade,
      domain text not null unique,
      auto_join boolean not null default false,
      created_at timestamptz not null default now(),
      primary key (org_id, domain)
    )`,
    `create table departments (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      name text not null,
      created_at timestamptz not null default now(),
      unique (org_id, name)
    )`,
    `create table users (
      id uuid primary key,
      email text not null unique,
      name text not null default '',
      avatar_url text,
      created_at timestamptz not null default now(),
      last_login_at timestamptz
    )`,
    `create table identities (
      provider text not null,
      subject text not null,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (provider, subject)
    )`,
    // One organization per person for now: user_id is unique.
    `create table memberships (
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null unique references users(id) on delete cascade,
      role text not null check (role in ('owner', 'admin', 'auditor', 'billing', 'member')),
      -- 'removed' keeps the row so a removed person is not let back in by a domain rule.
      status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
      department_id uuid references departments(id) on delete set null,
      joined_at timestamptz not null default now(),
      joined_via text not null,
      primary key (org_id, user_id)
    )`,
    `create table invitations (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      email text not null,
      role text not null check (role in ('owner', 'admin', 'auditor', 'billing', 'member')),
      department_id uuid references departments(id) on delete set null,
      invited_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      accepted_at timestamptz,
      revoked_at timestamptz
    )`,
    // At most one open invitation per email, across all organizations.
    `create unique index invitations_open on invitations (email)
      where accepted_at is null and revoked_at is null`,
    // id is the SHA-256 of the session token; the token itself is never stored.
    `create table sessions (
      id text primary key,
      public_id uuid not null unique,
      user_id uuid not null references users(id) on delete cascade,
      org_id uuid not null references organizations(id) on delete cascade,
      provider text not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz,
      ip text,
      user_agent text
    )`,
    `create index sessions_user on sessions (user_id)`,
    `create table login_attempts (
      state text primary key,
      provider text not null,
      nonce text not null,
      code_verifier text not null,
      -- SHA-256 of a value held only in the starting browser's cookie.
      binding text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )`,
    // seq gives a strict order: ids made in the same millisecond do not sort reliably.
    `create table admin_events (
      id uuid primary key,
      seq bigint generated always as identity,
      org_id uuid not null references organizations(id) on delete cascade,
      time timestamptz not null default now(),
      actor_user_id uuid,
      actor_email text not null,
      action text not null,
      target_type text,
      target_id text,
      target_label text,
      detail jsonb not null default '{}'::jsonb,
      ip text
    )`,
    `create index admin_events_org_seq on admin_events (org_id, seq desc)`,
  ],
  // 2: agents, traces and what people record about them.
  [
    `create table agents (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      name text not null,
      description text not null default '',
      source text not null check (source in ('platform', 'org', 'user')),
      owner_user_id uuid references users(id) on delete set null,
      risk text not null check (risk in ('R1', 'R2', 'R3', 'R4')),
      state text not null check (state in ('draft', 'pending', 'published', 'suspended')),
      version text not null,
      model text not null,
      created_at timestamptz not null default now()
    )`,
    // One trace is one run of an agent, start to finish.
    `create table traces (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      agent_id uuid not null references agents(id) on delete cascade,
      agent_version text not null,
      user_id uuid references users(id) on delete set null,
      conversation_id uuid not null,
      venue text not null check (venue in ('cloud', 'device')),
      status text not null check (status in ('ok', 'error', 'blocked', 'awaiting_approval')),
      started_at timestamptz not null,
      duration_ms integer not null,
      input text not null default '',
      output text not null default '',
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      cost_micros bigint not null default 0,
      span_count integer not null default 0,
      max_action text not null check (max_action in ('A0', 'A1', 'A2', 'A3', 'A4'))
    )`,
    `create index traces_org_started on traces (org_id, started_at desc)`,
    `create index traces_org_agent on traces (org_id, agent_id, started_at desc)`,
    `create index traces_conversation on traces (conversation_id)`,
    // One span is one step inside a run: a model call, a tool call, a policy decision.
    `create table spans (
      id uuid primary key,
      trace_id uuid not null references traces(id) on delete cascade,
      org_id uuid not null references organizations(id) on delete cascade,
      parent_id uuid,
      seq integer not null,
      kind text not null check (kind in ('agent', 'llm', 'tool', 'retriever', 'policy', 'approval')),
      name text not null,
      status text not null check (status in ('ok', 'error', 'blocked')),
      start_offset_ms integer not null,
      duration_ms integer not null,
      input text not null default '',
      output text not null default '',
      attributes jsonb not null default '{}'::jsonb,
      events jsonb not null default '[]'::jsonb,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      cost_micros bigint not null default 0
    )`,
    `create unique index spans_trace on spans (trace_id, seq)`,
    `create table annotations (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      trace_id uuid not null references traces(id) on delete cascade,
      span_id uuid references spans(id) on delete cascade,
      author_user_id uuid not null references users(id) on delete cascade,
      label text not null,
      score numeric check (score is null or (score >= 0 and score <= 1)),
      note text not null default '',
      created_at timestamptz not null default now()
    )`,
    `create index annotations_trace on annotations (trace_id)`,
    `create table saved_views (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      filters jsonb not null,
      created_at timestamptz not null default now(),
      unique (user_id, name)
    )`,
  ],
  // 3: what people use: agents they define, conversations, approvals, documents, and sign-in from native apps.
  [
    `alter table agents add column instructions text not null default ''`,
    `alter table agents add column tools text[] not null default '{}'`,
    `create table conversations (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      agent_id uuid not null references agents(id) on delete cascade,
      title text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      archived_at timestamptz
    )`,
    `create index conversations_user on conversations (user_id, updated_at desc)`,
    // status: 'running' while the agent is working, then one of the final three.
    `create table messages (
      id uuid primary key,
      conversation_id uuid not null references conversations(id) on delete cascade,
      org_id uuid not null references organizations(id) on delete cascade,
      seq integer not null,
      role text not null check (role in ('user', 'assistant')),
      content text not null default '',
      status text not null default 'complete' check (status in ('running', 'complete', 'failed', 'stopped')),
      trace_id uuid,
      created_at timestamptz not null default now(),
      unique (conversation_id, seq)
    )`,
    // A request for the person who started a run to confirm one action.
    `create table approvals (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      agent_id uuid not null references agents(id) on delete cascade,
      conversation_id uuid not null references conversations(id) on delete cascade,
      trace_id uuid not null,
      tool text not null,
      level text not null check (level in ('A3', 'A4')),
      summary jsonb not null,
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
      requested_at timestamptz not null default now(),
      decided_at timestamptz,
      decided_by uuid references users(id) on delete set null
    )`,
    `create index approvals_user on approvals (user_id, status, requested_at desc)`,
    `create index approvals_org on approvals (org_id, requested_at desc)`,
    `create table documents (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      title text not null,
      content text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, title)
    )`,
    // Sign-in from a native app happens in the system browser; these carry it back to the app.
    `create table app_logins (
      id text primary key,
      challenge text not null,
      redirect text not null,
      user_id uuid references users(id) on delete cascade,
      org_id uuid references organizations(id) on delete cascade,
      provider text,
      code text unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )`,
    `alter table sessions add column kind text not null default 'browser' check (kind in ('browser', 'app'))`,
  ],
  // What the person saw while a reply was written: the steps it took and its plan.
  [
    `alter table messages add column steps jsonb not null default '[]'`,
    `alter table messages add column plan jsonb not null default '[]'`,
    // A run is on record while it is still going.
    `alter table traces drop constraint traces_status_check`,
    `alter table traces add constraint traces_status_check
       check (status in ('ok', 'error', 'blocked', 'awaiting_approval', 'running'))`,
    // An agent its builder deleted keeps its row, so the record of what it did stays whole.
    `alter table agents add column deleted_at timestamptz`,
    // Two first visits at once could each create the starting agents. The later copies are
    // kept, because runs may point at them, but renamed and suspended so the names are unique.
    `update agents a set name = a.name || ' (' || left(a.id::text, 8) || ')', state = 'suspended'
      where a.source = 'platform' and exists (
        select 1 from agents b
         where b.org_id = a.org_id and b.source = 'platform' and b.name = a.name and b.id < a.id)`,
    `create unique index agents_platform_name on agents (org_id, name) where source = 'platform'`,
  ],
  // People's files. The bytes live in the file store under <org>/<id>; this is what each is and whose.
  [
    `create table files (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      kind text not null,
      mime text not null,
      size bigint not null,
      sha256 text not null,
      source text not null check (source in ('upload', 'agent')),
      conversation_id uuid references conversations(id) on delete set null,
      created_at timestamptz not null default now(),
      deleted_at timestamptz
    )`,
    `create index files_user on files (user_id, created_at desc) where deleted_at is null`,
    // The files a person sent along with a message: [{id, name, kind, size}].
    `alter table messages add column attachments jsonb not null default '[]'`,
  ],
  // 6: what a person is owed when something ends or is overwritten.
  [
    // Why a reply ended when it did not simply finish: 'allowance', 'length' or 'error', and for an error, what went wrong.
    `alter table messages add column ending text`,
    `alter table messages add column ending_detail text`,
    // What a document held before an agent replaced it, so the person can have it back.
    `alter table documents add column previous_content text`,
    `alter table documents add column previous_at timestamptz`,
    // Sites the person said an agent may read for the rest of a conversation.
    `alter table conversations add column allowed_hosts text[] not null default '{}'`,
  ],
  // 7: finding whether a reader already opened a run this hour, without reading the whole record.
  [
    `create index admin_events_views on admin_events (org_id, actor_user_id, target_id, time) where action = 'trace.viewed'`,
  ],
  // 8: projects. A project is a person's place for one piece of ongoing work: its
  // conversations, and what every agent working in it is told.
  [
    `create table projects (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      name text not null,
      instructions text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
    `create unique index projects_name on projects (user_id, lower(name))`,
    // A conversation may belong to one project. Deleting the project keeps the conversation.
    `alter table conversations add column project_id uuid references projects(id) on delete set null`,
    `create index conversations_project on conversations (project_id) where project_id is not null`,
  ],
  // 9: a person's connections to services outside Muster. Tokens are stored sealed.
  [
    `create table connections (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      provider text not null,
      account text not null,
      scopes text not null default '',
      access_token text not null,
      refresh_token text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      unique (user_id, provider)
    )`,
    // A connection being made: the state sent to the service, kept as its hash, for the person who began.
    `create table connection_attempts (
      state text primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      provider text not null,
      code_verifier text not null,
      expires_at timestamptz not null
    )`,
  ],
  // 10: how much a person lets agents do in a conversation without asking, and the most an
  // organization lets anyone choose.
  [
    `alter table conversations add column mode text not null default 'ask' check (mode in ('ask', 'auto', 'full'))`,
    `create table org_settings (
      org_id uuid primary key references organizations(id) on delete cascade,
      max_mode text not null default 'auto' check (max_mode in ('ask', 'auto', 'full'))
    )`,
  ],
  // 11: who sees what. A thing a person made is shared with named people and departments.
  SHARING_SCHEMA,
  // 12: skills, and what an agent carries beside its instructions and tools.
  SKILLS_SCHEMA,
  // 13: knowledge bases an agent can look things up in.
  KNOWLEDGE_SCHEMA,
  // 14: the company's own connectors, and services switched off for everyone.
  COMPANY_SCHEMA,
  // 15: who gave each reply, and whom each message was addressed to. A conversation has
  // an agent of its own; a message may be for another one the person invited.
  [
    `alter table messages add column agent_id uuid references agents(id) on delete set null`,
    `update messages m set agent_id = v.agent_id from conversations v where v.id = m.conversation_id`,
  ],
  // 16: the marketplace and its rules, and notices.
  [...MARKET_SCHEMA, ...NOTICES_SCHEMA],
  // 17: what a person asked their agents to remember.
  MEMORY_SCHEMA,
  // 18: work a person scheduled.
  SCHEDULES_SCHEMA,
  // 19: what an agent drafted and a person sent, and where sending is switched on.
  DRAFTS_SCHEMA,
  // 20: a draft whose sending ended where the server could not see.
  DRAFTS_UNKNOWN_SCHEMA,
  // 21: a file an agent makes keeps what it was made from, version by version.
  FILE_VERSIONS_SCHEMA,
  // 22: what a reply that did not finish had done, kept so that it can be gone on with.
  [`alter table messages add column resume jsonb`],
  // 23: a file shared with colleagues, to read or to change, and what they say about it.
  [
    `alter table shares add column can_change boolean not null default false`,
    `create table file_comments (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      file_id uuid not null references files(id) on delete cascade,
      n integer not null,
      user_id uuid references users(id) on delete set null,
      part text not null default '',
      body text not null,
      status text not null default 'open' check (status in ('open', 'resolved')),
      resolved_by uuid references users(id) on delete set null,
      resolved_version integer,
      created_at timestamptz not null default now(),
      resolved_at timestamptz,
      unique (file_id, n)
    )`,
  ],
  // 24: the record holds (CHA-236). A run that ended without finishing has a status of its
  // own, and the activity log cannot be rewritten: the database refuses it, not a habit.
  [
    `alter table traces drop constraint traces_status_check`,
    `alter table traces add constraint traces_status_check
       check (status in ('ok', 'error', 'blocked', 'stopped', 'awaiting_approval', 'running'))`,
    // Runs recorded before this, that their own reply says did not finish, are given the
    // status they should have had: a count of finished runs must not fall on the day of
    // the change because the past was never corrected. A message of a stopped run, or of
    // one cut off at the longest a reply can be, says so; the trace is found through it.
    `update traces t set status = 'stopped'
       from messages m
      where m.trace_id = t.id and t.status = 'ok'
        and (m.status = 'stopped' or m.ending = 'length')`,
    `alter table spans drop constraint spans_status_check`,
    `alter table spans add constraint spans_status_check
       check (status in ('ok', 'error', 'blocked', 'stopped'))`,
    // A row of the log is never changed. It goes only with its whole organization: by the
    // time that removal reaches the log, the organization's own row is already gone.
    `create function admin_events_append_only() returns trigger language plpgsql as $$
     begin
       if tg_op = 'DELETE' and not exists (select 1 from organizations where id = old.org_id) then
         return old;
       end if;
       raise exception 'The activity log is append-only: a row cannot be changed or removed.'
         using errcode = 'restrict_violation';
     end $$`,
    `create trigger admin_events_append_only before update or delete on admin_events
       for each row execute function admin_events_append_only()`,
    `create function admin_events_no_truncate() returns trigger language plpgsql as $$
     begin
       raise exception 'The activity log is append-only: it cannot be emptied.'
         using errcode = 'restrict_violation';
     end $$`,
    `create trigger admin_events_no_truncate before truncate on admin_events
       for each statement execute function admin_events_no_truncate()`,
  ],
  // 25: what a person's message answers, when it answers a form in a reply.
  FORMS_SCHEMA,
  // 26: what an agent is waiting for, to be brought back to; and the person's time zone.
  FOLLOWUPS_SCHEMA,
  // 27: where a message came from, when it is not the person's own words or an agent's
  // reply: 'followup' for the message with which Muster brought an agent back (CHA-256).
  // Those written before the column are found through the follow-up that wrote them.
  [
    `alter table messages add column if not exists origin text`,
    `update messages m set origin = 'followup' from followups f where f.message_id = m.id`,
  ],
  // 28: how a person works, kept here so it is the same on every device (CHA-258).
  PROFILE_SCHEMA,
  // 29: what a file says, kept so that a person with a thousand files can find one by a
  // word in it. Null until it has been read; empty when there is nothing to read.
  [
    `alter table files add column if not exists search_text text`,
    // The files not yet read are found without looking through every file.
    `create index if not exists files_unread on files (created_at desc) where search_text is null and deleted_at is null`,
  ],
  // 30: a project's notes: where its work stands, kept from one conversation to the next
  // by the agents working in it and by the person. The notes before the last change are
  // kept once, so that a change by an agent can be taken back.
  [
    `alter table projects add column if not exists notes text not null default ''`,
    `alter table projects add column if not exists notes_before text`,
    `alter table projects add column if not exists notes_at timestamptz`,
    `alter table projects add column if not exists notes_by text`,
  ],
  // 31: a count of the changes to a project's notes: how a page says which notes it
  // started from, so that a change made meanwhile is not written over unseen.
  [`alter table projects add column if not exists notes_rev integer not null default 0`],
  // 32: a conversation's summary for its agents: what stands in for its messages up to and
  // including summary_seq in every later reply (docs/design/context-panel.md). The messages
  // themselves stay as they were.
  [
    `alter table conversations add column if not exists summary text`,
    `alter table conversations add column if not exists summary_seq integer`,
    `alter table conversations add column if not exists summary_at timestamptz`,
  ],
  // 33: a project's steps: what is still to do in it, each with a state, a due day, the
  // agent it was given to, the conversation working on it and what came of it
  // (docs/features/workspace.md, "A project's steps"). `n` is its number in the project,
  // never used again; `position` is where the person put it.
  [
    `create table project_steps (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      n integer not null,
      title text not null,
      state text not null default 'todo' check (state in ('todo', 'doing', 'waiting', 'done')),
      due text,
      agent_id uuid references agents(id) on delete set null,
      conversation_id uuid references conversations(id) on delete set null,
      result text not null default '',
      position double precision not null,
      by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      done_at timestamptz,
      unique (project_id, n)
    )`,
    `create index project_steps_project on project_steps (project_id, position)`,
  ],
  // 34: a project's updates: how it is going, said at a moment and kept. Only added to.
  [
    `create table project_updates (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      health text not null check (health in ('on_track', 'at_risk', 'off_track')),
      text text not null,
      by text,
      created_at timestamptz not null default now()
    )`,
    `create index project_updates_project on project_updates (project_id, created_at desc)`,
  ],
  // 35: a project's key documents: files pinned for what they are (the spec, the
  // decisions, the research, the release notes), which every conversation in it is told of.
  [
    `create table project_docs (
      id uuid primary key,
      org_id uuid not null references organizations(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      file_id uuid not null references files(id) on delete cascade,
      kind text not null check (kind in ('spec', 'decisions', 'research', 'release', 'other')),
      created_at timestamptz not null default now(),
      unique (project_id, file_id)
    )`,
  ],
  // 36: what of a prompt the model's service read from its cache, and wrote to it. Parts
  // of prompt_tokens, not beside it; nothing was counted before, so what is there says 0.
  [
    `alter table traces add column cached_tokens integer not null default 0,
                        add column cache_write_tokens integer not null default 0`,
    `alter table spans add column cached_tokens integer not null default 0,
                       add column cache_write_tokens integer not null default 0`,
  ],
  // 37: a project's people: the colleagues its owner brought into it, to see it or to
  // work in it (docs/features/workspace.md, "A project's people"). And who posted an
  // update, now that it may be someone other than the owner; null on those from before.
  [
    `create table project_members (
      project_id uuid not null references projects(id) on delete cascade,
      org_id uuid not null references organizations(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role text not null check (role in ('view', 'work')),
      added_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      primary key (project_id, user_id)
    )`,
    `create index project_members_user on project_members (user_id)`,
    `alter table project_updates add column if not exists author_id uuid references users(id) on delete set null`,
  ],
  // 38: plan first (MUS-17). Withdrawn before release (the owner, 2026-11-24): the
  // feature and everything that read or wrote these three columns was removed. The step
  // stays exactly as it was written, because databases have already run it and the steps
  // after it are numbered from it. `conversations.plan`, `approvals.note` and
  // `messages.note` are unused: nothing reads or writes them.
  [
    `alter table conversations add column plan text not null default 'off' check (plan in ('off', 'planning', 'approved'))`,
    `alter table approvals add column note text`,
    // What Muster told the agent with a message: that the conversation was planning, or
    // the plan the person had approved. Kept with the message so that it is sent again
    // exactly as it was, turn after turn.
    `alter table messages add column note text`,
  ],
  // 39: the model agents run on, chosen in the console (its services, their sealed keys,
  // the models and their prices), and the month's budgets for the company, a department
  // and a person.
  [...MODEL_SETTINGS_SCHEMA, ...BUDGETS_SCHEMA],
  // 40: MCP servers as connectors, the company's and a person's own (MUS-22).
  MCP_SCHEMA,
  // 41: alerts for those who run the organization: the rules as changed, what is or was
  // so, where it is also sent, and what was sent (docs/features/admin-console.md, "Alerts").
  ALERTS_SCHEMA,
  // 42: the activity log proves itself: every row carries the hash of the one before it;
  // and where the record is sent on to.
  // The same step: how long things are kept, and the hold that stops their purging.
  [...AUDIT_CHAIN_SCHEMA, ...RETENTION_SCHEMA],
  // 43: what was true as a message arrived, as it was said to the agent then: sent again
  // word for word with the conversation, so that a model's service reads it from its cache.
  [`alter table messages add column turn jsonb`],
  // 44: alerts that do not flap, a mark several processes agree on, and the indexes the
  // rules read from.
  ALERTS_FIXES_SCHEMA,
  // 45: what review of the activity log's chain asked for: the purge is let through by a
  // key only the server can make, the head and the checkpoints are not written by hand,
  // a check signs for what it found; and sending on says since when it has been failing.
  AUDIT_FIXES_SCHEMA,
  // 46: the organization's tool policy: a rule on a tool for everyone or a department,
  // what an agent may reach, and what a conversation was not offered when it began (MUS-26).
  TOOL_POLICY_SCHEMA,
  // 47: the company's tracker, a project's link to it, each step's ticket, and the steps
  // whose ticket is behind (docs/features/workspace.md, "Steps and the tracker").
  TRACKER_SCHEMA,
  // 48: the organization's own way in: its SAML identity provider, sign-ins on their way
  // through it, and what its directory provisions people with (SCIM).
  SSO_SCHEMA,
  // 49: running code: the hosts an organization's code may reach, and a line for every
  // run with what it used, which a person's daily allowance is counted from (sandboxUse.ts).
  SANDBOX_USE_SCHEMA,
  // 50: what review of single sign-on asked for: who switched it on, and a sign-in begun
  // in the console by someone already signed in.
  SSO_FIXES_SCHEMA,
  // 51: what review of the tracker asked for: a ticket remembered as gone, a step set
  // aside after enough tries, a reading gone on with, and which projects may be linked.
  TRACKER_FIXES_SCHEMA,
  // 52: work on the company's repositories without anyone's computer: its code host, the
  // repositories agents may work on, and each conversation's work (codeHost.ts).
  CODE_HOST_SCHEMA,
  // 53: what review of work on repositories asked for: the branches work may start from,
  // whether it may change a repository's CI, a sending taken up where it stopped, and an
  // hour's allowance of fetches.
  CODE_HOST_FIXES_SCHEMA,
  // 54: the sandbox as an administrator runs it: who asked for each run and what it
  // reached by host, an organization's rules for releasing workspaces, a day's allowance
  // by department and by person, and what a released workspace's agent is yet to be told
  // (sandboxAdmin.ts, MUS-54).
  SANDBOX_ADMIN_SCHEMA,
  // 55: what lives in a project: its repositories, guides, environments, links, people to
  // reach and facts, each put there by a person or an agent (projectItems.ts, MUS-59).
  PROJECT_ITEMS_SCHEMA,
  // 56: a project counts the things ever kept in it, so a removed thing's number is not
  // given to another (projectItems.ts).
  PROJECT_ITEMS_NUMBERS_SCHEMA,
  // 57: the company's directory at Feishu, WeCom or DingTalk: the application it
  // registered there, sign-ins on their way through it, and which department is which
  // (directory.ts).
  DIRECTORY_SCHEMA,
  // 58: why the last try of a directory from the console did not work.
  DIRECTORY_TRIED_SCHEMA,
];
