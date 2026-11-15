import { describe, it, expect, vi } from 'vitest';
import { currentScopes } from '../../../scripts/match-freshness-watchdog.mjs';
import {
  COMPETITIONS,
  listCompetitionDefinitions,
  getCompetition,
  listCompetitions,
  ongoingCompetitions,
  resolveSeason,
  OFFICIAL_R32_ORDER,
} from './competitions';

describe('competition registry', () => {
  it('keeps candidate definitions hidden', () => {
    const allDefinitions = listCompetitionDefinitions();
    expect([allDefinitions.length, new Set(allDefinitions.map(c => c.espnSlug)).size]).toEqual([57, 57]);
    expect(ongoingCompetitions().map(c => c.id)).toEqual(['leagues-cup', 'nations-league', 'uefa-nations-league', 'premier-league', 'laliga', 'serie-a', 'bundesliga', 'ligue-1', 'super-league-greece', 'mls', 'liga-mx', 'wsl', 'nwsl', 'liga-mx-femenil']);
    expect(listCompetitions().map(c => c.id)).toEqual(['world-cup', 'leagues-cup', 'nations-league', 'uefa-nations-league', 'premier-league', 'laliga', 'serie-a', 'bundesliga', 'ligue-1', 'super-league-greece', 'mls', 'liga-mx', 'wsl', 'nwsl', 'liga-mx-femenil']);
  });
  it('preserves the public season, landing link and monitored-scope baseline', () => {
    const baseline: [string, string, string[]][] = [
      ['world-cup', '2026', ['1998', '2002', '2006', '2010', '2014', '2018', '2022', '2026']],
      ['leagues-cup', '2026', ['2026']], ['nations-league', '2026-27', ['2026-27']],
      ['uefa-nations-league', '2026-27', ['2026-27']], ['premier-league', '2026-27', ['2026-27']],
      ['laliga', '2026-27', ['2026-27']], ['serie-a', '2026-27', ['2026-27']],
      ['bundesliga', '2026-27', ['2026-27']], ['ligue-1', '2026-27', ['2026-27']],
      ['super-league-greece', '2026-27', ['2026-27']], ['mls', '2026', ['2026']],
      ['liga-mx', '2026-apertura', ['2026-apertura']], ['wsl', '2026-27', ['2026-27']],
      ['nwsl', '2026', ['2026']], ['liga-mx-femenil', '2026-apertura', ['2026-apertura']],
    ];
    expect(listCompetitions().map(c => [c.id, c.currentSeasonId, Object.keys(c.seasons)])).toEqual(baseline);
    for (const [id, season, seasons] of baseline) {
      expect(resolveSeason(id)?.season.id).toBe(season);
      for (const sid of seasons) expect(resolveSeason(id, sid)?.season.id).toBe(sid);
    }
    // The current monitor reads the current season of every public competition, including concluded editions.
    expect(currentScopes(listCompetitions())).toEqual(baseline.map(([competition, season]) => ({ competition, season })));
  });

  it('keeps a staging-only definition off public routes', () => {
    const candidate = listCompetitionDefinitions().find(c => c.espnSlug === 'fifa.wwc')!;
    candidate.seasons['2023'] = { ...COMPETITIONS['world-cup'].seasons['2026'], id: '2023', publication: 'staging' };
    try {
      expect(getCompetition(candidate.id)).toBeUndefined();
      expect(resolveSeason(candidate.id, '2023')).toBeUndefined();
      expect(listCompetitions().some(c => c.id === candidate.id)).toBe(false);
    } finally { delete candidate.seasons['2023']; }
  });

  it('publishes a candidate only after its landing edition and presentation are ready', () => {
    const candidate = listCompetitionDefinitions().find(c => c.id === 'womens-world-cup')!;
    const before = { ...candidate };
    candidate.seasons = { '2023': { ...COMPETITIONS['world-cup'].seasons['2026'], id: '2023', publication: 'archive' } };
    candidate.currentSeasonId = '2023';
    try {
      expect(getCompetition(candidate.id)).toBeUndefined();
      Object.assign(candidate, { teamStyle: 'flag', emblem: '🌍', accent: COMPETITIONS['world-cup'].accent });
      expect(resolveSeason(candidate.id)?.season.id).toBe('2023');
      expect(listCompetitions().some(c => c.id === candidate.id)).toBe(true);
    } finally {
      delete candidate.currentSeasonId; delete candidate.teamStyle; delete candidate.emblem; delete candidate.accent;
      Object.assign(candidate, before);
    }
  });

  it('keeps staged editions hidden without displacing the landing season', () => {
    const comp = COMPETITIONS['world-cup'];
    comp.seasons['future'] = { ...comp.seasons['2026'], id: 'future', publication: 'staging' };
    try {
      expect(resolveSeason('world-cup')?.season.id).toBe('2026');
      expect(resolveSeason('world-cup', 'future')).toBeUndefined();
      expect(getCompetition('world-cup')?.seasons.future).toBeUndefined();
    } finally { delete comp.seasons['future']; }
  });

  it('admits an allowlisted staging edition only in a staging website build', async () => {
    const comp = COMPETITIONS['world-cup'];
    comp.seasons.next = { ...comp.seasons['2026'], id: 'next', publication: 'staging', monitored: false };
    try {
      vi.stubEnv('SCOREARC_ENV', 'staging');
      vi.stubEnv('SCOREARC_STAGING_EDITIONS', 'world-cup/next');
      for (const environment of ['preview', 'production']) {
        vi.stubEnv('VERCEL_ENV', environment);
        vi.resetModules();
        const { default: build } = await import('../../../next.config.mjs');
        vi.stubEnv('SCOREARC_WEBSITE_STAGING_EDITIONS', build.env?.SCOREARC_WEBSITE_STAGING_EDITIONS ?? '');
        expect(Boolean(resolveSeason('world-cup','next'))).toBe(environment === 'preview');
        expect(resolveSeason('world-cup')?.season.id).toBe('2026');
      }
    } finally { delete comp.seasons.next; vi.unstubAllEnvs(); }
  });

  it('has world-cup and leagues-cup with correct ESPN slugs', () => {
    expect(COMPETITIONS['world-cup'].espnSlug).toBe('fifa.world');
    expect(COMPETITIONS['leagues-cup'].espnSlug).toBe('concacaf.leagues.cup');
  });

  it('world cup uses flags; leagues cup uses crests', () => {
    expect(COMPETITIONS['world-cup'].teamStyle).toBe('flag');
    expect(COMPETITIONS['leagues-cup'].teamStyle).toBe('crest');
  });

  it.each([
    ['nations-league', 'CONCACAF Nations League', 'concacaf.nations.league'],
    ['uefa-nations-league', 'UEFA Nations League', 'uefa.nations'],
  ])('keeps %s distinct in routes, feeds and compact labels', (id, name, espnSlug) => {
    const rc = resolveSeason(id);
    expect(rc?.competition).toMatchObject({ id, name, shortName: name, espnSlug, kind: 'national', teamStyle: 'flag' });
    expect(rc?.season).toMatchObject({
      id: '2026-27',
      format: { hasBracket: true, hasGroups: true, hasThirdPlaceRace: false },
      knockoutRounds: ['quarterfinals', 'semifinals', 'final'],
    });
  });

  it('each competition declares a current season that exists', () => {
    for (const comp of listCompetitions()) {
      expect(comp.seasons[comp.currentSeasonId]).toBeDefined();
    }
  });

  it('the WC 2026 season carries the bracket order; leagues cup does not', () => {
    expect(COMPETITIONS['world-cup'].seasons['2026'].bracketOrder).toHaveLength(16);
    expect(COMPETITIONS['leagues-cup'].seasons['2026'].bracketOrder).toBeUndefined();
  });

  it('ids match their registry keys', () => {
    for (const [key, comp] of Object.entries(COMPETITIONS)) expect(comp.id).toBe(key);
  });

  it('getCompetition / listCompetitions work', () => {
    expect(getCompetition('leagues-cup')?.name).toBe('Leagues Cup');
    expect(getCompetition('nope')).toBeUndefined();
    expect(listCompetitions().length).toBe(Object.keys(COMPETITIONS).length);
  });

  it('ongoingCompetitions excludes a competition whose current season concluded, keeps the rest', () => {
    const ongoing = ongoingCompetitions();
    const ids = ongoing.map((c) => c.id);
    expect(ids).not.toContain('world-cup');
    expect(ids).toContain('liga-mx');
    expect(ids).toContain('premier-league');
    // Every competition, minus exactly the concluded ones.
    const concludedCount = listCompetitions().filter(
      (c) => c.seasons[c.currentSeasonId]?.concluded,
    ).length;
    expect(ongoing.length).toBe(listCompetitions().length - concludedCount);
  });

  it('resolveSeason defaults to the current season and validates inputs', () => {
    const cur = resolveSeason('world-cup');
    expect(cur?.competition.id).toBe('world-cup');
    expect(cur?.season.id).toBe('2026');
    expect(resolveSeason('world-cup', '2026')?.season.id).toBe('2026');
    expect(resolveSeason('nope')).toBeUndefined();
    expect(resolveSeason('world-cup', '1999')).toBeUndefined();
    expect(resolveSeason('constructor', '2026')).toBeUndefined();
    expect(resolveSeason('__proto__', '2026')).toBeUndefined();
    expect(resolveSeason('world-cup', 'constructor')).toBeUndefined();
    expect(resolveSeason('world-cup', '__proto__')).toBeUndefined();
  });

  it('OFFICIAL_R32_ORDER lists 16 team pairs', () => {
    expect(OFFICIAL_R32_ORDER).toHaveLength(16);
    expect(OFFICIAL_R32_ORDER[0]).toEqual(['RSA', 'CAN']);
  });

  it('registers the domestic leagues with their ESPN slugs, as no-bracket club competitions', () => {
    const leagues: Record<string, string> = {
      'premier-league': 'eng.1',
      laliga: 'esp.1',
      'serie-a': 'ita.1',
      bundesliga: 'ger.1',
      'ligue-1': 'fra.1',
      mls: 'usa.1',
      'liga-mx': 'mex.1',
      'super-league-greece': 'gre.1',
    };
    for (const [id, slug] of Object.entries(leagues)) {
      const comp = COMPETITIONS[id];
      expect(comp, id).toBeDefined();
      expect(comp.espnSlug).toBe(slug);
      expect(comp.kind).toBe('club');
      expect(comp.teamStyle).toBe('crest');
      const season = comp.seasons[comp.currentSeasonId];
      expect(season, `${id} current season`).toBeDefined();
      expect(season.format.hasBracket).toBe(false);
      expect(season.bracketOrder).toBeUndefined();
    }
  });

  it('Liga MX exercises the split-season model (Apertura)', () => {
    expect(COMPETITIONS['liga-mx'].currentSeasonId).toBe('2026-apertura');
    expect(COMPETITIONS['liga-mx'].seasons['2026-apertura'].label).toBe('Apertura 2026');
  });

  it('Liga MX Apertura carries the Liguilla qualification cut; other leagues do not', () => {
    const ligaMx = COMPETITIONS['liga-mx'];
    const season = ligaMx.seasons[ligaMx.currentSeasonId];
    expect(season.qualification).toEqual({ cut: 8, labelKey: 'standings.liguilla' });

    const pl = COMPETITIONS['premier-league'];
    expect(pl.seasons[pl.currentSeasonId].qualification).toBeUndefined();
  });

  it('stores qualification zones as semantic label keys', () => {
    expect(COMPETITIONS['premier-league'].seasons['2026-27'].zones?.[0].labelKey)
      .toBe('zone.champion');
  });

  it('stores configured round windows as structured dates', () => {
    expect(COMPETITIONS['leagues-cup'].seasons['2026'].computedTables?.nextRound)
      .toEqual({ round: 'quarterfinals', startDate: '2026-08-25', endDate: '2026-08-27' });
  });

  it('every competition defines a valid accent (base/bright/soft), world-cup = gold', () => {
    for (const comp of listCompetitions()) {
      expect(comp.accent, comp.id).toBeDefined();
      expect(typeof comp.accent.base).toBe('string');
      expect(typeof comp.accent.bright).toBe('string');
      expect(typeof comp.accent.soft).toBe('string');
      expect(comp.accent.base).toMatch(/^#|rgba?\(/);
    }
    // The World Cup keeps gold — it is the one competition that belongs to no
    // country. Every club league takes a colour from its own flag, so the
    // domestic title band and the competition chrome read as national.
    expect(COMPETITIONS['world-cup'].accent.base.toLowerCase()).toBe('#e8b84b');
    // Blanco, not verde. The flag has both, and the brand green now sits 5
    // degrees of hue from Mexico's verde -- close enough that Liga MX pages
    // would have looked like they had no accent at all. White is the only
    // achromatic accent in the set, so it cannot collide with anything.
    expect(COMPETITIONS['liga-mx'].accent.base).toBe('#e9edeb');      // blanco
    expect(COMPETITIONS['premier-league'].accent.base).toBe('#d4344a'); // St George red
    expect(COMPETITIONS['serie-a'].accent.base).toBe('#0a9b52');       // tricolore green
    expect(COMPETITIONS['bundesliga'].accent.base).toBe('#d20515');    // rot
    expect(COMPETITIONS['bundesliga'].accent.bright).toBe('#f5c518');  // gold
    expect(COMPETITIONS['ligue-1'].accent.base).toBe('#3b7fd4');       // bleu
  });

  // The flag palette must not leak into the UEFA zones. A Champions League
  // place is the same outcome in every country, so it keeps one colour across
  // all of them; only the domestic title follows the flag.
  it('keeps European qualification colours shared across leagues', () => {
    const leagues = ['premier-league', 'laliga', 'serie-a', 'bundesliga', 'ligue-1'];
    for (const id of leagues) {
      const comp = COMPETITIONS[id];
      const season = comp.seasons[comp.currentSeasonId];
      const ucl = season.zones?.filter((z) => z.kind === 'ucl') ?? [];
      expect(ucl.length, `${id} should define a Champions League zone`).toBeGreaterThan(0);
      // `kind` is the whole contract: the colour comes from --zone-ucl, which
      // is defined once globally and never per competition.
      for (const z of ucl) expect(z.kind).toBe('ucl');
    }
  });
});

describe('world-cup seasons', () => {
  it('resolves 2022 as a 4-round knockout without a hardcoded bracketOrder', () => {
    const rc = resolveSeason('world-cup', '2022');
    expect(rc).toBeTruthy();
    expect(rc!.season.knockoutRounds).toEqual([
      'round-of-16', 'quarterfinals', 'semifinals', 'final',
    ]);
    expect(rc!.season.bracketOrder).toBeUndefined();
    expect(rc!.season.bracketDatesRange).toBeTruthy();
    expect(rc!.season.sections).toEqual(['bracket', 'scores']);
  });

  it('keeps 2026 as a 5-round knockout with its hardcoded order', () => {
    const rc = resolveSeason('world-cup', '2026')!;
    expect(rc.season.knockoutRounds).toEqual([
      'round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', 'final',
    ]);
    expect(rc.season.bracketOrder?.length).toBe(16);
  });

  it('exposes all eight editions (seven past + 2026)', () => {
    const ids = Object.keys(COMPETITIONS['world-cup'].seasons).sort();
    expect(ids).toEqual(['1998','2002','2006','2010','2014','2018','2022','2026']);
  });
});

describe('computed-table membership (T10.10)', () => {
  const computed = Object.values(COMPETITIONS).flatMap(c =>
    Object.values(c.seasons).flatMap(s => (s.computedTables ? [{ c, s, t: s.computedTables }] : [])));

  it('scopes each side to a configured league season', () => {
    expect(computed.length).toBeGreaterThan(0);
    for (const { t } of computed) {
      for (const scope of [t.membership.primary, t.membership.split]) {
        expect(resolveSeason(scope.competitionId, scope.seasonId)?.season.id).toBe(scope.seasonId);
      }
      expect(t.membership.primary.competitionId).not.toBe(t.membership.split.competitionId);
    }
  });

  // The phase window is the only knockout exclusion the inputs allow (no round
  // is served on a match), so it must close before the first knockout day.
  it('closes the phase window before the next round starts', () => {
    for (const { t } of computed) {
      const end = t.datesRange.slice(9);
      expect(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)}` < t.nextRound!.startDate).toBe(true);
    }
  });
});
