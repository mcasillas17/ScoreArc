// Exports the provider->canonical team crosswalk from the curated seed into a
// file the frontend can import. Run: npm run export:teams
//
// The direction is the opposite of export-competitions.mjs, which generates
// backend config from frontend source. Team identity is curated in
// backend/config/teams.seed.json (hand-authored and reviewed, per AGENTS.md),
// so the seed is the source and this copy is generated.
//
// This copy exists because .vercelignore excludes `backend`, so the seed is not
// present at build time on Vercel. Importing it directly would pass locally and
// fail the deploy.
import { readFileSync, writeFileSync } from 'node:fs';

const seed = JSON.parse(
  readFileSync(new URL('../backend/config/teams.seed.json', import.meta.url), 'utf8'),
);

// Only what the frontend needs to turn a URL into a provider request, and a
// provider id back into a URL. Names and countries stay in the seed: they are
// curation metadata, and duplicating them here would create a second place to
// correct a club's name.
const byProvider = {};
for (const team of seed) {
  const espn = team?.refs?.espn;
  if (!espn || !team.id) continue;
  if (byProvider[espn] && byProvider[espn] !== team.id) {
    throw new Error(
      `ESPN id ${espn} maps to both ${byProvider[espn]} and ${team.id} in the seed`,
    );
  }
  byProvider[espn] = team.id;
}

const sorted = Object.fromEntries(
  Object.entries(byProvider).sort(([a], [b]) => a.localeCompare(b)),
);

writeFileSync(
  new URL('../src/server/data/teamCrosswalk.json', import.meta.url),
  JSON.stringify(sorted, null, 2) + '\n',
);

console.log(`wrote ${Object.keys(sorted).length} team mappings`);
