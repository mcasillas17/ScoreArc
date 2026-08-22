import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The identity contract (docs/backend/PLAYER_IDENTITY.md): provider ids never
 * appear in a public URL. A numeric /player/ or /team/ segment in source is
 * the regression this guards against -- someone linking from a context where
 * the provider's number was the handy value.
 *
 * Static source scan rather than a render: the number would come from data at
 * runtime, but the *pattern* that produces it is visible in source as a
 * template interpolating an id-typed value into /player/ or /team/. Those
 * templates are required to go through teamHref/playerSlugs, so any literal
 * numeric segment IS a bug.
 */
const ROOTS = ['src/app', 'src/components'];

// An array, not a generator: this repo's TS target has no downlevelIteration,
// as teamIndex.ts already notes.
function tsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsxFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('player and team links carry slugs, never provider numbers', () => {
  it('no source builds a /player/ or /team/ href from a raw id', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of tsxFiles(root)) {
        const source = readFileSync(file, 'utf8');
        // `/player/${...id}` or `/team/${...id}` interpolations that are not
        // one of the sanctioned shapes (slug variables, teamHref output).
        const pattern = /\/(?:player|team)\/\$\{(?!encodeURIComponent\()([^}]*\b(?:athleteId|providerId|espnId)\b[^}]*)\}/g;
        let match;
        while ((match = pattern.exec(source)) !== null) {
          offenders.push(`${file}: ${match[0]}`);
        }
        // Literal numeric ids hardcoded into player/team paths.
        const literal = /\/(?:player|team)\/\d+/g;
        while ((match = literal.exec(source)) !== null) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
