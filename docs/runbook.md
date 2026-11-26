# Muster — Runbook

How to start, check, deploy and repair Muster. Written so that a person or an AI
agent can follow it without knowing the history. Every command runs from the
repository root.

Keep this file true: when a command here changes, change it in the same pull request.

## 1. Run it on this machine

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` builds the workspace packages on a first run, starts the server (port
7410) and the web app (port 5173), and prints `Muster is ready: http://localhost:5173`.
Open that address and sign in with a development account; `owner@muster.test` is
the owner and can open the admin console. `Ctrl+C` stops both.

- **Agents need a model.** Copy `.env.example` to `.env` and fill in the
  `MUSTER_MODEL_*` values, or set them in the shell. Without them the interface
  works but agents cannot reply, and the start page says so.
- **Data in development is in memory** unless `MUSTER_DATA_DIR` and
  `MUSTER_FILES_DIR` are set in `.env` (see `.env.example`); then accounts,
  conversations and files survive a restart. The server restarts when its own source
  changes; it ignores rebuilt packages, so `pnpm check` does not restart it.
- **To keep it running while you work** (so http://localhost:5173 always shows the
  code in this folder, also after a crash or a closed terminal):

  ```bash
  pnpm service start
  ```

  `pnpm service status | restart | logs | stop`. macOS only. It runs `pnpm dev` under the
  Mac's service manager until you stop it or the Mac restarts; it does not start
  at login. The log is `~/Library/Logs/muster-dev.log`.

The desktop app, against the running server:

```bash
MUSTER_SERVER=http://localhost:5173 pnpm desktop
```

The iOS app is its own project; see `apps/mobile/README.md`.

## 2. Before every change is called done

```bash
pnpm check
```

This is what CI runs: format check, lint, build, typecheck, tests. To run the
server's tests on PostgreSQL as CI also does:

```bash
MUSTER_TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/postgres pnpm exec vitest run apps/server
```

## 3. Deploy

One image is the whole deployment: the server, which also serves the web app.
`deploy/compose.yaml` runs it with PostgreSQL and the sandbox service on one machine.

**First time**

1. On the machine: Docker with the compose plugin, and this repository checked out.
2. `cp deploy/.env.example deploy/.env` and fill it in:
   - `MUSTER_PUBLIC_URL` — the https address people will open.
   - `MUSTER_BOOTSTRAP_OWNER_EMAIL` — the first person allowed in; they become the owner.
   - `POSTGRES_PASSWORD` — a long random value.
   - one sign-in provider (Google, Microsoft, or your own OpenID Connect provider; the
     redirect address to register with the provider is in the comments of the file).
     SAML is set up after the first sign-in, in the admin console (section 3b).
   - the model (`MUSTER_MODEL_*`), or leave it out and set the model after the first
     sign-in, in Admin console → Models (see below).
   - `MUSTER_SECRET_KEY` — a long random value. Without it no model key (and no connector
     credential) can be entered in the console.
3. Start it:

```bash
pnpm deploy:up
```

4. Put a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) in
   front, forwarding to `127.0.0.1:7410`, and keep `MUSTER_TRUST_PROXY=1`. The
   proxy must not buffer responses, or replies will not stream.
5. Check: `curl -s https://YOUR-ADDRESS/auth/providers` lists the provider; open
   the address and sign in as the owner.

**Upgrade**

```bash
pnpm deploy:backup
```

```bash
git pull
```

```bash
pnpm deploy:up
```

The server migrates the database when it starts. Watch it come up:

```bash
pnpm deploy:logs
```

`pnpm deploy:backup` writes two files to `deploy/backups/`: the database and people's
uploaded files. Keep both; a database without its files has documents that cannot be opened.

**Roll back**: check out the previous commit and run `pnpm deploy:up` again. If a
migration ran in between, restore the backup first. Stop the server, so nothing writes
while the database is replaced:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env stop muster
```

```bash
gunzip -c deploy/backups/FILE.sql.gz | docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T db psql -v ON_ERROR_STOP=1 -U muster muster
```

The backup drops each table before it recreates it, so it can be played into the
database as it stands. A backup made before 2026-11-14 does not; restore one of those
into an empty database (`dropdb` and `createdb` first). This restore has not yet been
run against a real deployment: try it once on a copy before relying on it.

Start the server again, then restore people's files from the other backup file (the
files are put back through the running server's container):

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env start muster
```

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T muster tar -xzf - -C /data < deploy/backups/FILES.tar.gz
```

**Stop**: `pnpm deploy:down` (the database volume is kept).

**Moving a deployment to a commit, with a way back**

`scripts/deploy-commit.sh` puts one commit of `main` on the machine it runs on. Run it in
the deployment's checkout (the one that has `deploy/.env`):

```bash
bash scripts/deploy-commit.sh
```

It backs up (keeping the newest 14), moves the checkout to the commit, rebuilds, starts,
and waits up to five minutes for the new server to be healthy, then checks twenty seconds
later that it is the commit it built, still healthy and not restarted. If not, the commit
that was running is started again and the script fails. Only one deployment runs at a
time. Not tried: a commit that fails only after a database migration.

- The checkout ends on a commit, not on a branch (`git status` says "HEAD detached"):
  that is how it is meant to be. Do not edit files there; the script refuses to deploy
  over changes.
- Every deployment restarts the server, so runs in progress end and people send the
  message again.
- To deploy on every merge, call the script from a job of your own, on a runner of your
  own, in a **private** repository. Never attach a self-hosted runner to a public
  repository: a pull request from a fork would run its code on that machine.

**Rules of the deployment**

- Exactly one `muster` container per database. Runs in progress live in its
  memory; a second one refuses to start.
- A restart ends runs in progress: their replies are marked failed and people
  send the message again.
- `MUSTER_DEV` must never be set in a deployment: it turns on the passwordless
  development sign-in. The server refuses to combine it with PostgreSQL or https.

## 3a. A task tracker beside Muster (Plane)

Muster can keep a project's steps in step with a self-hosted
[Plane](https://plane.so) and give agents Plane as a connector. Plane is not part of
Muster's deployment: nothing in `deploy/` starts it. The addresses below are examples.

### A Muster project's steps and Plane's work items as one list

Since MUS-14 (2026-11-24) this is built in; nothing is set up by hand beyond the key.

1. In Plane: profile settings → Personal Access Tokens → make one. Its owner types it
   into Muster; it goes nowhere else.
2. In Muster: Admin console → Connections → "Task tracker". Address
   `https://plane.example.com`, Workspace `<workspace>`, API key the token → "Connect". It
   says how many projects it reached, or what Plane answered. Then tick, under
   "Projects that may be linked", the Plane projects that Muster projects may be tied
   to, and "Save". Until one is ticked nobody is offered "Link to tracker".
3. In a project of your own: beside "Steps", "Link to tracker" → choose the Plane
   project → "Link to tracker". Within a minute each step shows its key (`MUS-12`).

It needs `MUSTER_SECRET_KEY` on the server. Plane allows about
sixty requests a minute for one key: Muster reads a linked project every two minutes and
sends at most twenty steps a minute, and waits longer after a refusal. When the mark
beside "Steps" says "not in step", hover it for the reason; the same reason is in
`project_trackers.last_error` and `tracker_outbox.last_error`, and the third failure in
a row is in the activity log as `tracker.failing`. What it does and does not do:
`docs/features/workspace.md`, "Steps and the tracker". Not tried against the real Plane.

### Letting Muster's agents read and keep work items in Plane

This is a different thing from the above: there the server keeps steps and work items in
step; here an agent is given Plane as a tool, to look things up or file something when
asked. No code is needed: Plane is one of the company's own connectors (Admin console →
Connections → Company connectors → New connector; `docs/features/marketplace.md`, section 6). An
owner sets it up once, since it takes their Plane token, which nobody else types:

| Field | Value |
|---|---|
| Name | `Plane` |
| Address | `https://plane.example.com/api/v1/workspaces/<workspace>` |
| Credential header | `X-API-Key` |
| Credential | a Plane personal access token (Plane → profile settings → Personal Access Tokens) |

| Action | Method | Path | What it is for |
|---|---|---|---|
| `list_projects` | GET | `/projects/` | The projects there are, with their ids |
| `list_states` | GET | `/projects/{project}/states/` | A project's states, with their ids |
| `list_items` | GET | `/projects/{project}/work-items/` | A project's work items |
| `read_item` | GET | `/projects/{project}/work-items/{item}/` | One work item |
| `add_item` | POST | `/projects/{project}/work-items/` | A new work item: body `{"name": "…", "description_html": "<p>…</p>", "state": "<state id>"}` |
| `change_item` | PATCH | `/projects/{project}/work-items/{item}/` | A change: body `{"state": "<state id>"}` and the like |
| `comment_item` | POST | `/projects/{project}/work-items/{item}/comments/` | A comment: body `{"comment_html": "<p>…</p>"}` |

`{project}` and `{item}` are ids, not keys like `MUS-12`. Give the connector to the
departments that should use it and add it to an agent; reading goes through, anything that
writes asks the person first. Not tried: nobody has set it up yet. It needs
`MUSTER_SECRET_KEY` on the server, which seals the credential.

## 3b. Single sign-on (SAML) and provisioning (SCIM)

Both are set up in the admin console, Sign-in & sessions, by an owner (not an
administrator). Nothing goes into the server's settings. SAML needs the site on https.

First name the company's mail domain on the same page: new people are let in, and
provisioned, only at an address in a domain listed there. People who are owners or
administrators are never matched by their address: each presses "Connect my account" on
that page once, signed in.

**Microsoft Entra ID**

1. Entra admin center, Enterprise applications, New application, Create your own
   application ("Muster", non-gallery).
2. Single sign-on, SAML. Basic SAML Configuration: Identifier = Muster's "Entity ID",
   Reply URL = Muster's "Reply URL (ACS)", both copied from the console card.
3. Attributes & Claims: keep `emailaddress`; set Unique User Identifier (Name ID) to
   `user.objectid` with format Persistent, so that a person stays the same account when
   their address changes. Do not change it later: everyone would become a new account.
4. Copy the "App Federation Metadata Url" into Muster, Set up, Metadata address, Save.
5. Assign yourself to the application in Entra, press "Try it" in Muster, sign in. The
   card says "Works". Then "Switch on".
6. Provisioning, Automatic: Tenant URL = the SCIM address from the console, Secret Token =
   a "New token" from the console. Test Connection, then start provisioning. Entra sends
   users and groups assigned to the application; groups become departments.

**Okta**

1. Applications, Create App Integration, SAML 2.0. Single sign-on URL = "Reply URL (ACS)",
   Audience URI = "Entity ID", Name ID format Persistent, Application username a value
   that does not change. Attribute statement: `email` = `user.email`.
2. Sign On tab, copy the Metadata URL into Muster, Save, assign yourself, "Try it",
   "Switch on".
3. General, enable SCIM provisioning. Provisioning tab: SCIM connector base URL = the SCIM
   address, unique identifier field `userName`, authentication HTTP Header with a "New
   token" from the console. Enable Create Users, Update User Attributes, Deactivate Users;
   push groups for departments.

**When the provider breaks.** While single sign-on is on the sign-in page offers only it.
The server's own providers still work at `https://<site>/auth/login/<id>` (`microsoft`,
`google`, `oidc`): an owner signs in there and switches single sign-on off. A new signing
certificate at the provider means setting the metadata again, trying it, and switching it
on again; until then answers signed with the new certificate are refused.

**What to look at.** Activity log: "Sign-in refused" with `reason: saml` and a word
(`signature_bad`, `audience`, `expired`, `confirmation`, `replayed`, …) says why an answer
was not believed; everything the directory did is there with actor `scim`. A 429 from
`/scim/v2` means more than 600 requests a minute on one token.

Not tried against a real Entra ID or Okta: the steps follow their documentation and the
tests' own provider.

## 3c. Work on repositories in the sandbox (GitHub)

For agents to work on a repository when nobody's computer is attached (coding.md, "In the
cloud"). Needs the sandbox running (`MUSTER_SANDBOX_URL`, section 3) and
`MUSTER_SECRET_KEY` set.

1. On GitHub make a fine-grained personal access token (or use a GitHub App's
   installation token) for the organization, limited to the repositories agents may work
   on, with **Contents: read and write** and **Pull requests: read and write**. Nothing
   else. It is the company's token, not a person's own: every pull request is opened by
   it.
2. Admin console → Connections → Code host: paste the token, "Connect". For GitHub
   Enterprise also give its API's address (`https://<host>/api/v3`).
3. "Choose", tick the repositories, each for Everyone or one department, "Save".
4. The repository's package indexes must be on "Hosts code may reach" (Sandbox page, Network) for
   its tests to install anything: `pypi.org`, `registry.npmjs.org` and the like.
5. **Before the first pull request, protect the repository's CI.** A pushed branch runs
   the repository's workflows as they are on that branch. Muster refuses changes to
   workflow files unless you tick "May change CI workflows", but files a workflow runs
   (a Makefile, package.json's scripts, a build script) can still change, and CI will
   run them on the `muster/*` branch. On GitHub: Settings → Actions → General → require
   approval for workflows where you can; keep secrets in **environments** with required
   reviewers, or limit them to protected branches, so a `muster/*` branch gets none; and
   prefer workflows triggered by `pull_request` (no secrets for untrusted changes) over
   `push` on every branch. Tick "May change CI workflows" only for a repository set up
   this way.

When something is wrong:

- "The code host did not take the key": the token expired or was revoked. Paste a new one.
- "The key may not …": the token lacks a permission, or does not cover that repository.
- "The repository is larger than can be worked on here": its archive is over 64 MB or
  holds more than a workspace does (256 MB, 20,000 files).
- A person sees no repository: none is named for their department.
- "The branch … has commits Muster did not make": someone pushed to the pull request's
  branch. Merge or close the request on GitHub; the next sending then opens a new one.
- "These files define what the repository's CI runs": the work changed a workflow and the
  repository is not ticked for it (step 5).
- "The code host is asked too often": GitHub's rate limit for the token. Muster waits
  until the time GitHub named; nothing needs doing. A person is held to 10 fetches of a
  repository an hour.
- "Repositories cannot be worked on here just now" / "putting other repositories in
  place": the sandbox is away, or two archives are being unpacked; try again.
- The token is in no log. `select base_url, key_tail, login from code_hosts` says what is
  connected; `select conversation_id, repository, state, branch, pr_url from cloud_work`
  what was worked on.

## 4. Build the apps

```bash
pnpm desktop:package
```

writes `apps/desktop/out/Muster-<platform>-<arch>/`. That build is unsigned and does not
update itself. A release that installed apps update to is made with
`MUSTER_RELEASE_HOST=<ssh host> pnpm --filter @muster/desktop run release`, on a Mac that
holds the account's Developer ID Application certificate and notarization credentials:
see "Updates" in `apps/desktop/README.md`. Raise `version` in
`apps/desktop/package.json` first: a release is offered only to an earlier version.

iOS: `apps/mobile/README.md` (Expo; its own `npm install`, not part of `pnpm`).

## 5. When something is wrong

| What you see | Why | What to do |
|---|---|---|
| `No projects matched the filters` | The command ran in another folder, or `@` was typed as a full-width `＠` | `cd` to the repository root; retype the `@` |
| `Port 7410/5173 is already in use` | Muster, or something else, is already running | Open http://localhost:5173. If it is the background service: `pnpm service status` / `pnpm service stop`. Otherwise `lsof -ti tcp:PORT \| xargs kill` |
| "Sign-in options could not be loaded" | The web app is up but the server is not | Look at the `[server]` lines of `pnpm dev`; restart it |
| "No model is configured" | No model chosen in the console and `MUSTER_MODEL_*` not set | Admin console → Models: add a service, a model, then "Run agents on this". Or fill in `.env` / `deploy/.env` and restart |
| Models says "the key … cannot be read" and agents do not run | `MUSTER_SECRET_KEY` is not the one the key was sealed with | Put the old key back, or Models → the service → Edit → enter the key again |
| "You have reached your limit for agents this month" | A monthly budget is spent | Admin console → Usage → Budgets: raise or remove the limit. It also starts again on the 1st (UTC) |
| A reply ends with "something went wrong" | The model endpoint failed | Admin console → Traces → the run shows the endpoint's error |
| `another Muster server is already running on this database` | A second server was started | Stop the other one; only one may run |
| Server exits at start with a configuration error | A required variable is missing or malformed; the message names it | Fix `deploy/.env` |
| Admin console → Sandbox → State says "Not ready" | The sandbox service is building its image (a few minutes after a deployment that changed it), or Docker has no gVisor runtime; the reason is on the page | `docker compose -f deploy/compose.yaml logs --tail 20 sandbox`. It tries again every ten minutes; `docker compose … restart sandbox` tries now |
| Admin console → Retention says the activity log cannot be purged | `MUSTER_SECRET_KEY` is not set, or is not the key this database was first run with (the database keeps a hash of the purge's key in `audit_guard`, written once) | Set the key, or put the first one back. To move to a new key on purpose, the owner of the database removes the row of `audit_guard` by hand (its trigger has to be disabled for that) and restarts the server; checkpoints and signatures made with the old key then fail a check |
| Admin console → Activity log says "Does not prove itself" | A record was changed or removed in the database, or (when the reason is the note of what was purged) `MUSTER_SECRET_KEY` is not the key the purge ran with | The notice names the first record. Compare with what was sent on to the SIEM or with an export (`muster-activity-log.jsonl`). If the key was changed, put the old one back. Nothing in Muster repairs a chain |
| Something was purged that should have been kept | A retention period was set (Admin console → Retention); the activity log has `retention.changed` and each `retention.purged` with counts | Nothing in Muster brings it back: restore the database and the files folder from a backup taken before the purge (section 3). To stop further purging at once, place a legal hold on that page |
| Activity log → "Not getting through" | The address the record is sent on to refuses or cannot be reached; the reason is on the page | Fix the other end or the token ("Change"). Nothing is lost meanwhile: it goes on from where it stopped |
| The sandbox's disk fills up, or working folders are kept too long | Each conversation that ran code keeps a working folder until it has been idle for the organization's number of days (7 unless changed) | Admin console → Sandbox: Workspaces shows each with its size; "Release all idle" frees what nobody used for a day; Reclaim sets the days and a cap for all of them. The server looks through them once an hour (`sandbox.reclaimed` in the activity log when something went). The runner itself holds all folders to 20 GB |
| A workspace is not released though it is old | Something is running there, its conversation has a proposal waiting to be sent to the code host, or the organization is under a legal hold | The Workspaces row says which. Stop the run (Running now), have the person send or drop the proposal, or lift the hold |
| A run will not end | Code that loops until its time is up (300 s at most) | Admin console → Sandbox → Running now → Stop. The agent is told an administrator stopped it |
| An agent says it cannot run code | The sandbox is not set up or not ready, so the tool is not offered | As above |
| `pip install` fails in a run with "Tunnel connection failed: 403" | The host is not on the list, or the list is empty | Admin console → Sandbox → Network: add the host the error names (for pip: `pypi.org` and `files.pythonhosted.org`). The opened step lists each refused host with why |
| Every connection from a run fails, allowed hosts too | The sandbox service has no way out: it is not on the `egress` network, or the machine's DNS does not answer inside it | `docker compose -f deploy/compose.yaml exec sandbox node -e "require('dns').lookup('pypi.org',console.log)"`; check `networks:` of the `sandbox` service in `deploy/compose.yaml` |
| An agent says the day's allowance for running code is used | One person ran 200 times or used an hour of processor time today (UTC) | Wait for midnight UTC; or Admin console → Sandbox → Daily limits (for everyone, a department or that person); or raise `MUSTER_SANDBOX_DAILY_RUNS` / `MUSTER_SANDBOX_DAILY_CPU_SECONDS` in `deploy/.env` (0: no limit) and restart the server. Admin console → Usage → Running code shows who ran what |
| Code in a run should reach nothing at all | The list holds the package indexes by default | Admin console → Sandbox → Network: remove every host |
| iOS simulator "runtime is not available" | CoreSimulator holds a stale runtime | Restart the Mac, or the CoreSimulator service |

## 6. Where things are

`docs/code-map.md` lists every part of the code. `docs/architecture.md` holds
the locked decisions. Bugs and requests are GitHub Issues (`CONTRIBUTING.md`).
