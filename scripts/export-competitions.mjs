// Exports the competition/season registry from competitions.ts to a
// language-neutral JSON the Go backend reads. Run: npx tsx scripts/export-competitions.mjs
import { writeFileSync } from 'node:fs';
import { listCompetitionDefinitions } from '../src/server/data/competitions.ts';

const out = listCompetitionDefinitions().map((c) => ({
  id: c.id,
  name: c.name,
  shortName: c.shortName,
  espnSlug: c.espnSlug,
  kind: c.kind,
  category: c.category,
  directoryGroup: c.directoryGroup,
  level: c.level,
  currentSeasonId: c.currentSeasonId,
  seasons: Object.fromEntries(
    Object.entries(c.seasons).map(([sid, s]) => [sid, {
      id: s.id,
      label: s.label,
      publication: s.publication,
      resources: s.resources,
      providerYear: s.providerYear,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      phase: s.phase,
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
