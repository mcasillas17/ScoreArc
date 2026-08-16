import { describe, it, expect } from 'vitest';
import {
  COMPETITIONS,
  getCompetition,
  listCompetitions,
  resolveSeason,
  OFFICIAL_R32_ORDER,
} from './competitions';

describe('competition registry', () => {
  it('has world-cup and leagues-cup with correct ESPN slugs', () => {
    expect(COMPETITIONS['world-cup'].espnSlug).toBe('fifa.world');
    expect(COMPETITIONS['leagues-cup'].espnSlug).toBe('concacaf.leagues.cup');
  });

  it('world cup uses flags; leagues cup uses crests', () => {
    expect(COMPETITIONS['world-cup'].teamStyle).toBe('flag');
    expect(COMPETITIONS['leagues-cup'].teamStyle).toBe('crest');
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

  it('resolveSeason defaults to the current season and validates inputs', () => {
    const cur = resolveSeason('world-cup');
    expect(cur?.competition.id).toBe('world-cup');
    expect(cur?.season.id).toBe('2026');
    expect(resolveSeason('world-cup', '2026')?.season.id).toBe('2026');
    expect(resolveSeason('nope')).toBeUndefined();
    expect(resolveSeason('world-cup', '1999')).toBeUndefined();
    expect(resolveSeason('constructor', '2026')).toBeUndefined();
    expect(resolveSeason('__proto__', '2026')).toBeUndefined();
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
    expect(season.qualification).toEqual({ cut: 8, label: 'Liguilla' });

    const pl = COMPETITIONS['premier-league'];
    expect(pl.seasons[pl.currentSeasonId].qualification).toBeUndefined();
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
    expect(COMPETITIONS['liga-mx'].accent.base).toBe('#22a95e');      // verde
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
