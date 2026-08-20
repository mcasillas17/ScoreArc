import { describe, it, expect } from 'vitest';
import { canonicalTeamId, providerTeamId } from './teamIdentity';

describe('team identity crosswalk', () => {
  it('maps a provider id to our canonical id', () => {
    expect(canonicalTeamId('227')).toBe('mex-america');
    expect(canonicalTeamId('10125')).toBe('mex-tijuana');
  });

  it('maps back, so a URL becomes an upstream request', () => {
    expect(providerTeamId('mex-america')).toBe('227');
    expect(providerTeamId(canonicalTeamId('216'))).toBe('216');
  });

  // A club ESPN knows and the seed does not has no canonical id yet. That is a
  // real answer: it gets no URL and its crest stays unlinked, rather than
  // linking to a page that cannot resolve.
  it('returns null for an uncurated club rather than inventing an id', () => {
    expect(canonicalTeamId('999999')).toBeNull();
    expect(canonicalTeamId('')).toBeNull();
    expect(canonicalTeamId(null)).toBeNull();
    expect(providerTeamId('mex-not-a-club')).toBeNull();
    expect(providerTeamId(null)).toBeNull();
  });

  it('uses country-prefixed slugs, never bare provider numbers', () => {
    expect(canonicalTeamId('227')).toMatch(/^[a-z]{3}-[a-z0-9-]+$/);
    expect(canonicalTeamId('227')).not.toMatch(/^\d+$/);
  });
});

// teamCrosswalk.json is generated from backend/config/teams.seed.json, which is
// curated by hand. The two drift the moment someone edits the seed and forgets
// `npm run export:teams` -- and nothing else catches it, because the generated
// copy stays internally valid while pointing at the wrong clubs.
//
// The seed is read here rather than imported: .vercelignore excludes `backend`,
// so it exists in the repo and in CI but not in a Vercel build. This test runs
// in the first two.
describe('crosswalk stays in step with the curated seed', () => {
  it('has an entry for every seeded club, with the same canonical id', async () => {
    const { readFileSync } = await import('node:fs');
    const seed = JSON.parse(
      readFileSync(new URL('../../../backend/config/teams.seed.json', import.meta.url), 'utf8'),
    ) as Array<{ id: string; refs: { espn?: string } }>;

    const missing: string[] = [];
    const wrong: string[] = [];
    for (const team of seed) {
      const espn = team.refs?.espn;
      if (!espn) continue;
      const mapped = canonicalTeamId(espn);
      if (mapped === null) missing.push(`${team.id} (espn ${espn})`);
      else if (mapped !== team.id) wrong.push(`espn ${espn}: crosswalk ${mapped} vs seed ${team.id}`);
    }
    expect({ missing, wrong }).toEqual({ missing: [], wrong: [] });
  });
});
