# Muster — Code Map

The navigation layer for agents and humans in a codebase too large to read whole
(Standard P9). Tier 1 plans must cite the entries they touch and the canonical
utilities they reuse (plan gate) so reuse is evidenced, not hoped for.

Keep this table truthful — a stale code map is a P9 stop condition, same as a stale
`AGENTS.md`. `Last reviewed:` 2026-11-14.

## Module map

`packages/*` and `apps/*` are the workspace globs from `pnpm-workspace.yaml`.

| Area                | Path                                                                                                  | Purpose                                           | Owner (CODEOWNERS) | Canonical utilities to reuse         |
| ------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------ | ------------------------------------ |
| Workspace toolchain | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.github/workflows/ci.yml` | Scripts, compiler base, lint and format rules, CI | @spytensor         | `pnpm check` runs everything CI runs |
| Protocol            | `packages/protocol`                                                                                   | IDs, agent fingerprint, audit event schema, chain | @spytensor         | `newId`, `digestOf`, `sealEvent`     |
| Shared libraries    | `packages/*`                                                                                          | Code used by more than one app                    | @spytensor         | —                                    |
| Server | `apps/server` | Sign-in, people, admin API, product API (`product.ts`), tracing (`observe.ts`), work on the company's repositories in the sandbox and its code host (`codeHost.ts`), the hosts code may reach, a person's daily allowance for running code and what was used (`sandboxUse.ts`), the Sandbox page's API and the hourly release of idle workspaces (`sandboxAdmin.ts`), single sign-on with SAML and the provisioning tokens (`sso.ts`, `auth/saml.ts`), the SCIM server (`scim.ts`), a project's steps kept in step with the company's task tracker (`tracker.ts`), the activity log's chain, its checking and sending on (`chain.ts`), how long things are kept, the daily purge and erasing a person (`retention.ts`), alert rules and their webhook (`alerts.ts`), the organization's tool policy (`toolPolicy.ts`), serving the web app (`web.ts`) | @spytensor | `recordEvent` for every administrative change; `can`/`canManage` in `roles.ts` for every permission check; `harness` in `test-support.ts` for tests |
| Runtime | `apps/server/src/runtime` | Runs agents: tool catalogue and levels (`catalog.ts`), tools (`tools.ts`), the gateway and run record (`runs.ts`), model transports (`models.ts`), guarded network (`net.ts`), the client for remote MCP servers (`mcp.ts`) | @spytensor | `TOOLS`, `riskOf`, `versionOf`; `publicNet` for any request an agent causes |
| Vendored runtime | `vendor/openclaw` | OpenClaw's agent loop and model types, pinned (`UPSTREAM.md`) | @spytensor | Do not edit except as `UPSTREAM.md` records |
| Reply schema | `packages/ui-schema` | The components a reply may use, the prompt that teaches them, parsing | @spytensor | `replyFormatPrompt`, `toRenderable` |
| Web app | `apps/web` | The workspace (`src/app`) and the admin console (`src/pages`); files are shown in the browser from the file itself (`src/app/FileViewer.tsx`; presentations by the reader in `src/app/slides`) | @spytensor | primitives in `components/ui`; `Kpi`, `Notice`, `useLoad`, `useAction` in `components/shared.tsx`; `Reply` in `app/reply.tsx` |
| Sandbox runner | `apps/sandbox` | Runs agents' code, each run in a container of its own with no network (`runner.ts`); passes what it prints on as it runs and is its one way out, to the hosts a run was given (`wire.ts`, `egress.ts`); says what is running and what each workspace holds, ends a run and releases a workspace when the server asks; the only service with Docker's socket | @spytensor | HTTP on the `sandbox` network, for the server only (see `docs/features/sandbox.md`) |
| Desktop app | `apps/desktop` | Electron window on the server's web app; browser sign-in, keychain session; work on code in attached folders (`bench.ts`, `local.ts`), each conversation's branch, way back and pull request (`task.ts`, `work.ts`) | @spytensor | `window.musterDesktop` (see `apps/web/src/lib/desktop.ts`) |
| iOS app | `apps/mobile` | Expo app; own npm lockfile, outside the pnpm workspace | @spytensor | see its README |
| Deployment | `Dockerfile`, `deploy/` | One image: server plus built web app; compose with PostgreSQL | @spytensor | — |

What each feature is for and how it is wired is in [`features/`](features/README.md).

## Conventions that aren't obvious from the tree

- A package extends `tsconfig.base.json` and defines its own `typecheck` and
  `build` scripts; the root scripts run them across the workspace.
- Biome formats and lints code and JSON. Markdown and YAML are excluded so files
  vendored from the maintainers' coding standard (`gates/`, `automation/`) stay identical to their source.
- CI actions are pinned by commit hash, with the version in a trailing comment.

## Where NOT to put things

- No product code at the repository root; it goes in a package or an app.
- No permission decision in the console alone; the server enforces, the console only hides.
- No administrative change in the server without a `recordEvent` in the same transaction.
- OpenClaw code lives only in `vendor/openclaw`, as `UPSTREAM.md` records (D-2).
- No tool an agent can call outside `runtime/catalog.ts`, and no outbound request for an agent except through `runtime/net.ts`.

## Nested AGENTS.md

None yet.
