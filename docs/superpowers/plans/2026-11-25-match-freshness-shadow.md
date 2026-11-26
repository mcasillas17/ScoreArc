# Match freshness shadow Worker

Implement the side-by-side trial described in the [design](../specs/2026-11-25-match-freshness-shadow.md). Use one feature branch and exercise the GitHub producer's existing regression suite at each step.

- [ ] Extract the portable reader contract and keep the Node entry points compatible. Run `npx vitest run scripts/match-freshness-watchdog.test.ts scripts/match-freshness-monitor.test.ts`. Expect the same reader and alert behavior as the baseline.
- [ ] Add an isolated scheduled Worker, SQLite migration and ordered shadow snapshots in D1. Exercise real SQLite with the five-minute slot as the unique key. Cover a repeated tick, concurrent ticks, state damage, error recovery, conditional open and resolution. Run `npx vitest run infra/match-freshness-shadow`. Expect one committed observation per slot and a single GET per monitored edition on a normal tick.
- [ ] Compare a pending Actions checkpoint to a shadow row for the same observation window. Report missing or unpaired evidence separately from divergent decisions. Add a local Wrangler procedure and a live-window measurement worksheet in the runbook.
- [ ] Verify the Worker bundle, local D1 migration and scheduled event in workerd, then run the repository tests, typecheck, lint, build and hosted PR checks. Cloud deployment and alert handoff are separate operations.
