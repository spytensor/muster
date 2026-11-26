# @muster/server

The Muster control plane, first stage: sign-in, sessions, people management and
the admin API the console uses.

## Run it locally

```bash
pnpm --filter @muster/server dev
```

```bash
pnpm --filter @muster/web dev
```

Then open http://localhost:5173. Development mode (`MUSTER_DEV=1`, set by the `dev`
script) uses an embedded database that starts empty each time and is filled with a
sample organization, and it turns on a **passwordless development sign-in** that
lets anyone sign in as any address. Neither exists outside development mode.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `MUSTER_PUBLIC_URL` | yes | The origin people reach Muster at, e.g. `https://muster.example.com` |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `MUSTER_BOOTSTRAP_OWNER_EMAIL` | yes | The one address allowed to create the organization on a fresh deployment |
| `MUSTER_ORG_NAME` | no | Name given to that organization (default `Muster`) |
| `MUSTER_GOOGLE_CLIENT_ID`, `MUSTER_GOOGLE_CLIENT_SECRET` | one provider | Google sign-in |
| `MUSTER_MICROSOFT_CLIENT_ID`, `MUSTER_MICROSOFT_CLIENT_SECRET`, `MUSTER_MICROSOFT_TENANT` | one provider | Microsoft Entra sign-in for one tenant |
| `MUSTER_SECRET_KEY` | for connections | 32 characters or more; seals the Microsoft 365 tokens kept for each person. Without it nobody is offered a connection. The registration also needs the redirect URI `<public URL>/api/app/connectors/microsoft/callback` |
| `MUSTER_SEARCH1API_KEY`, or `MUSTER_TAVILY_API_KEY`, or `MUSTER_SEARXNG_URL` | for web search | Where agents search the web; one at most. None: agents have no search |
| `MUSTER_SESSION_DAYS` | no | Session lifetime (default 7) |
| `MUSTER_TRUST_PROXY` | no | Set to `1` when a reverse proxy in front sets `X-Forwarded-For`; only then is that header used for recorded IP addresses |
| `PORT` | no | Listening port (default 7410) |

Register `<MUSTER_PUBLIC_URL>/auth/callback/google` (or `/microsoft`) as the
redirect URI with the provider.

## How sign-in decides who gets in

After the provider proves who someone is, `src/auth/admission.ts` lets them in if,
in this order: they are already an active member; an open invitation exists for
their address; their email domain is set to join automatically; or no organization
exists yet and they are the bootstrap owner. Anyone else is refused and no account
is created. An address the provider has not verified is always refused. A
returning person is recognised by the provider's account ID, not by email; an
unknown account is matched to an existing person by email only when the provider
proves the address's domain. Someone removed from the organization comes back
only through a new invitation.

## Agents, traces and the dashboard

`src/observe.ts` serves the agent roster, traces with their steps, notes people
add to them, saved views, CSV export and the dashboard's aggregates. Nothing
writes traces yet: there is no agent runtime. In development the seed
(`src/dev/seed-traces.ts`) fills a month of sample runs so the console has
something to show; in production these pages are empty until a runtime exists.
The tables are the ones a runtime will write to.

## What is not here yet

- No agent runtime, so no real traces. No endpoint accepts traces from outside.
- Invitations are not emailed. The invited person signs in with that address.
- One organization per person, and in practice one organization per deployment.
- Google sign-in has never been run against Google: no credentials existed when
  this was written. The development provider issues real signed ID tokens, so the
  same code path is tested, but the real provider is unverified.
- Microsoft sign-in was run against a real tenant on 2026-11-14 and worked. It requires
  the tenant to emit the optional `xms_edov` claim; without it every Microsoft
  sign-in is refused, by design, because Entra's `email` claim proves nothing.
- The activity log is append-only by convention (the API cannot change it), not
  tamper-evident.
- No rate limiting on sign-in.
- Trace content (inputs and outputs) is readable by owners, administrators and
  auditors. Whether administrators should see it by default is undecided.
