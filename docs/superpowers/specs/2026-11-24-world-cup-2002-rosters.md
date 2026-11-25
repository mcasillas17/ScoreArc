# 2002 World Cup squads and player lookup

The first production archive read in the reader readiness trial looked up Davor Vugrinec by slug. That page checks each entrant's roster. ScoreArc had no stored 2002 squad memberships. ESPN's year-specific Croatia response identified Vugrinec (athlete 19278) on a roster of 22.

## Scope

Use the eight groups in the season-specific ESPN standings to establish the competition's 32 entrants. Fetch each team's roster for 2002 and check the returned edition, team, collection and player identities. During the investigation 30 teams returned usable rosters. China and Senegal returned HTTP 404. Both are entrants and their squad coverage is unknown.

Provide a manual, dry-run-by-default Go command for this edition. An explicit apply writes the validated archive using the ingester login and the existing schema. Retrying the same input must preserve identities and other editions. An unavailable roster must preserve any previously accepted facts. Live polling and the production comparison percentage are independent of this command.

## Acceptance

- The reader's existing edition-team route lists all 32 participating nations.
- An accepted archive roster remains usable as historical evidence and contains season-scoped player totals when supplied.
- A player page can resolve a known player from a verified roster even with gaps elsewhere. A missing roster cannot prove that an unknown player was absent.
- Vugrinec's replay resolves Croatia, goals, assists and starts/substitutions from the archived tournament. ScoreArc retains honest coverage for the missing teams.
- A release can ship and be validated before an operator authorizes any write to production.
