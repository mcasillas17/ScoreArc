// Exports the competition/season registry from competitions.ts to a
// language-neutral JSON the Go backend reads. Run: npx tsx scripts/export-competitions.mjs
import { writeFileSync } from 'node:fs';
import { listCompetitionDefinitions, supportsResource } from '../src/server/data/competitions.ts';

const out = listCompetitionDefinitions().map((c) => ({
  id: c.id,
  name: c.name,
  shortName: c.shortName,
  espnSlug: c.espnSlug,
  espnLeagueId: c.espnLeagueId,
  espnRosterName: c.espnRosterName,
  espnScoreboardId: c.espnScoreboardId,
  kind: c.kind,
  category: c.category,
  directoryGroup: c.directoryGroup,
  level: c.level,
  currentSeasonId: c.currentSeasonId,
  seasons: Object.fromEntries(
    Object.entries(c.seasons).map(([sid, s]) => [sid, {
      id: s.id,
      label: s.label,
      monitored: s.monitored ?? false,
      publication: s.publication,
      archiveRosters: s.archiveRosters,
      resources: s.resources?.filter(resource => supportsResource(s, resource)),
      providerYear: s.providerYear,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      phase: s.phase,
      playoffFormat: s.playoffFormat,
      computedTables: s.computedTables ? true : undefined,
      hasBracket: s.format.hasBracket,
      bracketDatesRange: s.bracketDatesRange ?? null,
      knockoutRounds: s.knockoutRounds ?? null,
    }]),
  ),
}));

writeFileSync(
  new URL('../backend/config/competitions.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(`wrote ${out.length} competitions`);
