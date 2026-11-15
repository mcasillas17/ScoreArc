# T12.4 — competition player directory

The user authorized a fresh implementation after recovery found no earlier T12.4
work. This scope follows the user's detailed acceptance criteria; implementation
choices below are the implementer's, without a new design approval round.

## Approach

Extend `competitionPlayerIndex` with lightweight directory rows and roster
coverage. It already reads standings and one roster per distinct team inside
`runDataOperation`; deriving both links and displayed team context there avoids
another fetch pass or a mixed reader/ESPN result. A separate roster implementation
would duplicate identity and fallback rules. A global player search would require
unrequested all-competition fan-out, so it is excluded.

## Behavior

- `/[locale]/c/[comp]/[season]/players` serves EN/ES local search over the selected
  competition's currently available rosters. No requests occur while typing.
- Only the competition's configured current season offers roster search. Historical
  routes explain the limitation and link to the current directory without reading
  rosters. Metadata makes that same distinction.
- The page always explains that these are current rosters for teams listed in this
  season, not a historical or complete record of every participant. Coverage counts
  teams with nonempty rosters, not a proof of completeness.
- Zero listed teams, some missing/empty rosters, no roster data, and thrown load
  failures receive distinct truthful copy. A reader/fallback failure propagates
  from the data layer and renders the explicit unavailable page state.
- Rows show name and roster team. Search folds accents and existing non-decomposing
  letters through the existing `playerSlug` normalization. Name/team/abbreviation
  search is local. Native search input, live result count and ordinary links support
  keyboard use; no custom combobox or arrow-key model is needed.
- Slugs come exclusively from `buildSlugMap`. Same-athlete duplicates keep the
  existing first-roster rule. Unresolved collisions remain unlinked; no change to
  the public identity contract or guessed link. Profile URLs stay singular.
- Reuse `PlayerName` with prefetch disabled in the directory. No profile, headshot,
  team-profile or all-leagues fan-out is introduced.
- Add Players to competition rail/drawer/bottom navigation and highlight singular
  profile routes too. Up to six phone targets share the existing flexible bar;
  verify widths 320/440/560 and 600/730/860 plus desktop. Remove the obsolete
  site-wide Players-soon label. Keep the existing menu and standings form.

## Boundaries

No source-selection, transport, backend, production configuration, monitoring or
activation changes. Reader concurrency, budgets, cancellation, strict errors and
grouped fallback stay owned by T16.3. No new dependencies. Route locale and scope
are validated by existing resolvers; provider names are rendered as React text.

## Evidence

Tests cover coverage, duplicates/collisions, grouped fallback and exhaustion,
cancellation, historical no-read behavior, metadata, EN/ES search and navigation.
Browser checks cover both default ESPN and the existing local synthetic reader,
keyboard focus, responsive bounds, player profiles and standings-form popups.
Cold/warm server request counts/bytes and browser payloads are recorded separately;
synthetic data is never represented as live parity. Knights reviews the integrated
implementation and then the documented final snapshot before normal push/PR.
