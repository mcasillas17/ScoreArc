import { describe, it, expect } from 'vitest';
import { activeCompetition, competitionSections } from './SiteNav';
import { resolveSeason } from '@/server/data/competitions';

describe('activeCompetition', () => {
  it('finds the competition a workspace path is inside', () => {
    expect(activeCompetition('/c/liga-mx/2026-apertura/standings')?.competition.id).toBe('liga-mx');
  });

  it('falls back to the current season when the path names none', () => {
    const rc = activeCompetition('/c/liga-mx');
    expect(rc?.season.id).toBe(resolveSeason('liga-mx')!.season.id);
  });

  // The nav is global, so it renders on routes that have no competition at all.
  it('is undefined off the workspace routes', () => {
    expect(activeCompetition('/')).toBeUndefined();
    expect(activeCompetition('/teams')).toBeUndefined();
  });

  it('is undefined for a competition that does not exist', () => {
    expect(activeCompetition('/c/not-a-competition/2026')).toBeUndefined();
  });
});

describe('competitionSections', () => {
  // A league's base URL redirects to /standings, so a root item would be a
  // second link to the page below it.
  it('gives a league no root item', () => {
    const rc = resolveSeason('liga-mx')!;
    expect(competitionSections(rc, false).map((s) => s.label)).toEqual([
      'Standings', 'Matches', 'Teams', 'News',
    ]);
  });

  // A cross-league cup's root shows its phase tables until the draw completes
  // and the bracket after, so "Bracket" is wrong for most of the competition.
  it('calls a phased cup\'s root Knockout', () => {
    const rc = resolveSeason('leagues-cup')!;
    expect(competitionSections(rc, false)[0].label).toBe('Knockout');
  });

  it('calls a straight knockout root Bracket', () => {
    const rc = resolveSeason('world-cup')!;
    expect(competitionSections(rc, false)[0].label).toBe('Bracket');
  });

  it('translates every label', () => {
    const rc = resolveSeason('world-cup')!;
    const en = competitionSections(rc, false).map((s) => s.label);
    const es = competitionSections(rc, true).map((s) => s.label);
    expect(es).toHaveLength(en.length);
    expect(es.every((label, i) => label !== en[i])).toBe(true);
  });

  it('points every section at a real route under the season', () => {
    const rc = resolveSeason('world-cup')!;
    const base = `/c/${rc.competition.id}/${rc.season.id}`;
    for (const s of competitionSections(rc, false)) expect(s.href.startsWith(base)).toBe(true);
  });
});
