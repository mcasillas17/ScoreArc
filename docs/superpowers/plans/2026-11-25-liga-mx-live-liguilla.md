# Liga MX live Liguilla implementation

Use the approved two-leg arc and scorecard design for men's Apertura 2026.

- [x] Enable the edition's real knockout window and preserve individual legs on each bracket matchup on both DataStore paths. Reuse the league table for seeds, preserve partial draws and use a projection before publication. Verify that both home/away orientations attach to the same pair and a single finished leg cannot decide the series. Regenerate the competition registry and verify the Go ingestion contract.
- [x] Build pure tie scoring and prediction functions. Test scheduled zeroes, reversed venues, incomplete or withdrawn matches, live leads, seed ties, extra time and shootouts. Keep a stable round/club key for each scoreline, including after reseeding. Verify with focused Vitest tests.
- [x] Add the bilingual scorecard to the existing radial bracket. Keep the published matches in the poll loop, show provisional vs final outcomes, preserve and share fan scores independently, and display the re-seeded semifinals and final. Exercise both tabs and keyboard controls in a browser.
- [x] Verify the complete edition locally, test at low/mid/high phone widths and desktop, run the Vitest suite, strict typecheck and build. Review the diff, deliver a feature PR and leave the dev server running.
