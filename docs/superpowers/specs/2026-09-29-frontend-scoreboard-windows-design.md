# Frontend scoreboard windows

Restore the existing ESPN-backed DataStore, without reader cutover, new providers,
production operations, or component-specific retrieval. This implements the owner's
September 29 repair requirements; historical evidence is rechecked with Node fetch.

Use compact monthly selectors (`dates=YYYYMM&limit=1000`) for explicit UTC windows.
Read months touched by a one-day guard at both ends, then retain only the exact
inclusive requested UTC dates intersected with the configured season. Keep raw events
until existing match/bracket mappers run: provider IDs, round slugs, notes and penalty
metadata must survive. Clausura's provider year is the previous calendar year.
Apertura/Clausura slug validation must allow their playoff phase names.

Reject wrong league, missing/malformed events, invalid timestamps/status/teams,
conflicting duplicate IDs, ignored month selectors and observable truncation.
Identical events merge independent of object-key order. Valid empty windows succeed;
one failed partition fails the read and cannot populate a success cache.

Bound a read to six sequential months, no retries, a 15-second deadline,
4 MiB per response and 16 MiB aggregate. Preserve no-range bracket behavior.
The public 92-day range and 14-day enrichment limits and limit validation remain.
No full-season fetch on a poll. Existing scoped live/calendar TTLs remain distinct.
Filter and deduplicate before summary enrichment. Preserve telemetry and sanitized
API errors; remove both languages' unsupported promise that the calendar works.

Regression tests and real-browser validation cover current and historical editions,
UTC edges, month navigation, failures, brackets and computed tables. All four local
gates plus snapshot-bound Knights implementation and separate final reviews precede
commit/push/active PR. Production acceptance belongs to a later authorized merge.
