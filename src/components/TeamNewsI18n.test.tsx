import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useTranslations } from '@/i18n/I18nProvider';
import type { IndexedTeam } from '@/server/data/teamIndex';
import type { NewsArticle, SquadPlayer, TeamProfile } from '@/server/data/types';
import NewsList from './NewsList';
import SquadTable from './SquadTable';
import TeamHeader from './TeamHeader';
import TeamSearch from './TeamSearch';

vi.mock('next/navigation', () => ({
  usePathname: () => '/es/teams',
  useRouter: () => ({ push: vi.fn() }),
}));

const profile = {
  team: { id: '227', name: 'América', abbr: 'AME', crestUrl: null },
  location: 'América',
  color: '#ffff91',
  altColor: null,
  record: { summary: '3-1-0', gamesPlayed: 4, points: 10, goalDifference: 5 },
  standing: { rank: 1, competition: 'Mexican Liga BBVA MX' },
  standingSummary: '1st in Mexican Liga BBVA MX',
  squad: [],
  schedule: [],
} as unknown as TeamProfile;

const squad: SquadPlayer[] = [{
  id: 'player-1',
  name: 'Álvaro Fidalgo',
  jersey: 8,
  position: 'M',
  age: 29,
  nationality: 'Spain',
  headshotUrl: null,
  stats: null,
}];

const teams = [
  {
    id: 'mex-america',
    name: 'América',
    abbr: 'AME',
    crestUrl: null,
    memberships: [{
      competitionId: 'liga-mx',
      competitionName: 'Liga MX',
      seasonId: '2026-apertura',
      seasonLabel: 'Apertura 2026',
      pathname: '/c/liga-mx/2026-apertura/team/mex-america',
    }],
  },
  {
    id: 'mex-atlas',
    name: 'Atlas',
    abbr: 'ATL',
    crestUrl: null,
    memberships: [{
      competitionId: 'liga-mx',
      competitionName: 'Liga MX',
      seasonId: '2026-apertura',
      seasonLabel: 'Apertura 2026',
      pathname: '/c/liga-mx/2026-apertura/team/mex-atlas',
    }],
  },
] as unknown as IndexedTeam[];

const articles: NewsArticle[] = [{
  id: 'story-1',
  headline: 'América signs a new midfielder',
  description: 'Provider-authored description stays verbatim.',
  byline: 'ESPN Deportes',
  published: '2026-08-21T12:00:00.000Z',
  image: null,
  url: 'https://example.com/story',
}];

function renderSpanish(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
}

function TeamNewsHeadings() {
  const t = useTranslations();
  return <><h2>{t('team.squad')}</h2><h2>{t('news.title')}</h2></>;
}

describe('Spanish team and news surfaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:20.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('localizes framing while preserving provider-authored names and copy', () => {
    const html = renderSpanish(
      <>
        <TeamHeader profile={profile} teamStyle="crest" locale="es" />
        <TeamNewsHeadings />
        <SquadTable squad={squad} />
        <TeamSearch teams={teams} />
        <NewsList articles={articles} />
      </>,
    );

    for (const expected of [
      '1.º en Mexican Liga BBVA MX',
      'Plantel',
      'Sin aparición',
      'Buscar equipos',
      '2 equipos',
      'Noticias',
      'ahora mismo',
      'América signs a new midfielder',
      'Provider-authored description stays verbatim.',
      'ESPN Deportes',
    ]) {
      expect(html).toContain(expected);
    }

    for (const english of [
      '1st in',
      '>Squad<',
      'Has not appeared',
      'Search teams',
      '>2 teams<',
      '>News<',
      'just now',
    ]) {
      expect(html).not.toContain(english);
    }

    expect(html).toContain('href="/es/c/liga-mx/2026-apertura/team/mex-america"');
    expect(html).not.toContain('href="/c/liga-mx/2026-apertura/team/mex-america"');
  });

  it('preserves unrecognized provider standing prose as escaped text', () => {
    const rawSummary = 'Leaders <script>bad()</script> of Liga MX';
    const fallbackProfile = {
      ...profile,
      standing: null,
      standingSummary: rawSummary,
    } as unknown as TeamProfile;

    const html = renderSpanish(
      <TeamHeader profile={fallbackProfile} teamStyle="crest" locale="es" />,
    );
    expect(html).toContain('Leaders &lt;script&gt;bad()&lt;/script&gt; of Liga MX');
    expect(html).not.toContain('<script>');
  });

  it('renders a localized header from a narrow view model without client context', () => {
    const headerProfile = {
      team: profile.team,
      location: profile.location,
      color: profile.color,
      altColor: profile.altColor,
      record: profile.record,
      standing: profile.standing,
      standingSummary: profile.standingSummary,
    };

    const html = renderToStaticMarkup(
      <TeamHeader profile={headerProfile} teamStyle="crest" locale="es" />,
    );

    expect(html).toContain('América');
    expect(html).toContain('Récord');
    expect(html).toContain('1.º en Mexican Liga BBVA MX');
    expect(headerProfile).not.toHaveProperty('squad');
    expect(headerProfile).not.toHaveProperty('schedule');
  });

  it('omits an invalid published timestamp without throwing', () => {
    const html = renderSpanish(
      <NewsList articles={[{ ...articles[0], published: 'not-a-date' }]} />,
    );
    expect(html).toContain('América signs a new midfielder');
    expect(html).not.toContain('ahora mismo');
    expect(html).not.toContain('Invalid Date');
  });
});
