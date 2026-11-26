# @muster/web

The Muster admin console. Its look is that of an operations console: a quiet
grouped sidebar, a white content panel, and colour used only for state and data.

```bash
pnpm --filter @muster/web dev
```

It expects the server on port 7410 and proxies `/api`, `/auth` and `/dev-idp` to it.

## Pages

Built and backed by the server:

- Sign-in, with the language and appearance switches.
- Overview: a dashboard of agent activity and people, for the chosen period.
- Members, departments, invitations, sign-in and sessions, activity log.
- Agent roster.
- Traces: three lists (traces, spans, conversations) with search, filters, time
  range, column choice, saved views and CSV export; one trace as a tree of steps
  with a timeline; one step with its input, output, attributes, events and notes.
- Usage: cost by period, department and model.

Previews with sample data, each marked on the page: approvals, policies,
extensions, models. They show an intended design; nothing behind them exists.
Their data is in `src/pages/Previews.tsx`. See "What is designed is wired end to
end" in the root `AGENTS.md` for the rule they are an exception to.

## Languages

English is the default; Chinese is available from the switch in the header. The
choice is kept in the browser.

- Every string is in `src/i18n/en.ts`, which also defines the shape. `zh.ts` is
  typed against it, so a missing or misspelled key does not compile.
- To add a language: copy `en.ts`, translate, and register it in
  `src/i18n/index.tsx`.
- Dates, numbers, money and durations go through the formatters from `useI18n()`,
  never through hand-built strings.
- The server returns error codes; the console translates them
  (`errors` in the message files).

## Appearance

Light, dark, or following the system (the default), from the switch in the header.
Colours come only from the CSS variables in `src/index.css`. To rebrand, change
`--brand` and `--brand-text`. Chart series colours are `--series-1` to `--series-4`
and were checked as a set for colour-blind separation against both surfaces; if
they change, check them again.

## Conventions

- `src/components/ui` holds the primitives, `src/components/shared.tsx` the pieces
  pages share, `src/components/charts.tsx` the chart building blocks.
- What a role may do is decided by the server. The console hides controls a person
  cannot use, as a convenience, not as the control.
- List filters live in the address, so a filtered view can be linked and reloaded.
