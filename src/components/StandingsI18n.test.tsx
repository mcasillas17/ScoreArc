import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Group, Standing, StatLeader } from '@/server/data/types';
import StandingsLive from './StandingsLive';
import GroupTable from './GroupTable';
import LeaderTable from './LeaderTable';
import LeagueDial from './LeagueDial';
import ThirdPlaceTable from './ThirdPlaceTable';
import LeagueZoneTable from './LeagueZoneTable';
import PhaseQualifiers from './PhaseQualifiers';
import ZoneRing from './ZoneRing';
import type { Zone } from '@/server/data/competitions';

vi.mock('next/navigation', () => ({
  usePathname: () => '/es/c/world-cup/2026/standings',
  useRouter: () => ({ push: vi.fn() }),
}));

function standing(rank: number, played = 3): Standing {
  return {
    team: {
      id: `team-${rank}`,
      name: rank === 1 ? 'Club América' : `Equipo ${rank}`,
      abbr: `E${rank}`,
      crestUrl: null,
    },
    rank,
    played,
    wins: 2,
    draws: 1,
    losses: 0,
    goalsFor: 5,
    goalsAgainst: 2,
    goalDifference: 3,
    points: 7,
    advanced: rank < 3,
  };
}

function group(id: string, name = `Provider Group ${id}`, played = 3): Group {
  return { id, name, standings: Array.from({ length: 4 }, (_, index) => standing(index + 1, played)) };
}

function renderSpanish(node: ReactNode): string {
  return renderLocalized('es', node);
}

function renderLocalized(locale: 'en' | 'es', node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

function leader(): StatLeader {
  return {
    rank: 1,
    player: 'Alex Morgan',
    teamId: 'team-1',
    teamAbbr: 'USA',
    teamName: 'United States',
    teamCrestUrl: null,
    value: 3,
    matches: 2,
  };
}

describe('Spanish standings surfaces', () => {
  it('localizes representative tables and radial labels without translating proper names', () => {
    const groups = ['A', 'B', 'C', 'D'].map((id) => group(id));
    const html = renderSpanish(
      <>
        <StandingsLive
          initialGroups={[groups[0]]}
          initialScorers={[]}
          initialAssists={[]}
          apiBase="/api/world-cup/2026"
          showThirdPlace={false}
        />
        <StandingsLive
          initialGroups={groups}
          initialScorers={[]}
          initialAssists={[]}
          apiBase="/api/world-cup/2026"
          showThirdPlace
        />
        <LeagueDial standings={groups[0].standings} cut={2} teamStyle="crest" />
        <LeagueDial standings={group('P', 'Preseason', 0).standings} cut={2} teamStyle="crest" />
        <ThirdPlaceTable groups={groups} />
      </>,
    );

    for (const expected of ['Clasificación', 'LÍDER', 'clubes', 'jugados', 'Mejores terceros', 'Club América']) {
      expect(html).toContain(expected);
    }
    for (const english of ['>Standings<', '>LEADER<', ' clubs<', ' played<', 'Best Third-Placed Teams']) {
      expect(html).not.toContain(english);
    }
  });

  it('localizes only recognized group ids and React-escapes preserved provider names', () => {
    const html = renderSpanish(
      <StandingsLive
        initialGroups={[
          group('A', 'Provider Group A'),
          group('conference-east', 'East <script>alert(1)</script>'),
        ]}
        initialScorers={[]}
        initialAssists={[]}
        apiBase="/api/world-cup/2026"
        showThirdPlace
      />,
    );

    expect(html).toContain('Grupo A');
    expect(html).not.toContain('Provider Group A');
    expect(html).toContain('East &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('translates configured zones and structured round dates', () => {
    const zones: Zone[] = [
      { from: 1, to: 1, kind: 'champion', labelKey: 'zone.champion' },
      { from: 4, to: 4, kind: 'relegation', labelKey: 'zone.relegation' },
    ];
    const phaseGroups = [
      group('mls', 'MLS'),
      group('liga-mx', 'Liga MX'),
    ];
    const html = renderSpanish(
      <>
        <LeagueZoneTable standings={group('league').standings} zones={zones} teamStyle="crest" />
        <PhaseQualifiers
          groups={phaseGroups}
          cut={4}
          round={{ round: 'quarterfinals', startDate: '2026-08-25', endDate: '2026-08-27' }}
        />
      </>,
    );

    for (const expected of ['Campeón', 'Descenso', 'Cuartos de final', '25–27 de agosto de 2026', 'Cruces por siembra']) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('Relegation');
    expect(html).not.toContain('Seeded pairings');
  });

  it('renders a localized unavailable value for an invalid configured date range', () => {
    const html = renderSpanish(
      <PhaseQualifiers
        groups={[group('mls', 'MLS'), group('liga-mx', 'Liga MX')]}
        cut={4}
        round={{ round: 'quarterfinals', startDate: 'invalid' as never, endDate: '2026-08-27' }}
      />,
    );
    expect(html).toContain('No disponible');
  });

  it.each([
    { locale: 'en' as const, abbreviation: 'Pos', tooltip: 'Position' },
    { locale: 'es' as const, abbreviation: 'Pos', tooltip: 'Posición' },
  ])('localizes the position header in every table variant for $locale', ({ locale, abbreviation, tooltip }) => {
    const groups = ['A', 'B', 'C', 'D'].map((id) => group(id));
    const html = renderLocalized(
      locale,
      <>
        <GroupTable group={groups[0]} />
        <ThirdPlaceTable groups={groups} />
        <LeaderTable leaders={[leader()]} metric="goals" />
      </>,
    );

    expect(Array.from(html.matchAll(new RegExp(`<th title="${tooltip}">${abbreviation}</th>`, 'g'))))
      .toHaveLength(3);
    expect(html).not.toContain('<th>#</th>');
  });

  it.each([
    { locale: 'en' as const, singular: '1 played', range: '1–2 played' },
    { locale: 'es' as const, singular: '1 jugado', range: '1–2 jugados' },
  ])('renders singular and range played grammar for $locale', ({ locale, singular, range }) => {
    const singularStandings = [standing(1, 1), standing(2, 1)];
    const rangeStandings = [standing(1, 1), standing(2, 2)];
    const html = renderLocalized(
      locale,
      <>
        <ZoneRing standings={singularStandings} zones={[]} teamStyle="crest" />
        <ZoneRing standings={rangeStandings} zones={[]} teamStyle="crest" />
      </>,
    );

    expect(html).toContain(`>${singular}</text>`);
    expect(html).toContain(`>${range}</text>`);
  });
});
