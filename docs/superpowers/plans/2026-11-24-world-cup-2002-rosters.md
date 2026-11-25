# Implementation plan for 2002 World Cup squads

1. Add the four missing national teams to the curated seed and run `npm run export:teams`. Check both directions of each crosswalk using `npx vitest run src/server/data/teamIdentity.test.ts`.
2. Build an edition-specific importer with a read-only preview. Test wrong-edition responses, missing entrants, duplicate identities, partial responses, and the provider's missing-roster result. Run the command against the year-specific ESPN endpoints.
3. Persist the complete directory and accepted squads in one transaction under the ingester role. Test rollback, replay, and preservation of existing observations using a disposable Postgres database.
4. Exercise the edition directory, squads, player identity and profile through the Go HTTP reader. Replay the slug lookup with both known players and missing team coverage.
5. Apply the command twice against a seeded local database. Inspect the archive player page through the local reader and compare the results with the recorded provider response. Run the repository's TypeScript, frontend and Go checks before opening a PR.
