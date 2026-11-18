import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { dataStore } from '@/server/data/store';
import type { Match, TeamProfile } from '@/server/data/types';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import * as registry from '@/server/data/competitions';
import TeamPage, { generateMetadata } from './page';

vi.mock('@/server/data/playerIndex', () => ({
  competitionPlayerIndex: vi.fn(async () => ({ byProvider: new Map(), bySlug: new Map() })),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/es/c/liga-mx/2026-apertura/team/mex-america',
  useRouter: () => ({ push: vi.fn() }),
}));

const america = { id: '227', name: 'América', abbr: 'AME', crestUrl: null };
const atlas = { id: '213', name: 'Atlas', abbr: 'ATL', crestUrl: null };

const nextMatch: Match = {
  id: 'next-match',
  kickoff: '2026-08-22T02:00:00.000Z',
  state: 'scheduled',
  minute: null,
  statusDetail: '',
  statusName: 'STATUS_SCHEDULED',
  home: america,
  away: atlas,
  homeScore: null,
  awayScore: null,
  winnerId: null,
  note: null,
  scorers: [],
  cards: [],
  shootout: null,
  shootoutDetail: null,
  stats: null,
  winProbability: null,
};

const profile: TeamProfile = {
  team: america,
  location: 'América',
  color: '#ffff91',
  altColor: null,
  record: null,
  standing: null,
  standingSummary: null,
  squad: [],
  schedule: [nextMatch],
};

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each(['en', 'es'])('gives the two América teams their own edition share and canonical in %s', async locale => {
  vi.spyOn(dataStore, 'getTeam').mockImplementation(async (_rc, id) => ({ ...profile, team: { ...america, id } }));
  for (const [comp, teamId] of [['liga-mx', 'mex-america'], ['liga-mx-femenil', 'mex-w-america']]) {
    const meta = await generateMetadata({ params: { locale, comp, season: '2026-apertura', teamId } });
    expect(meta.alternates?.canonical).toBe(`/${locale}/c/${comp}/2026-apertura/team/${teamId}`);
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringContaining(`compId=${comp}&`) })]);
    expect(meta.title).toContain(comp === 'liga-mx' ? 'Liga MX Apertura 2026' : 'Liga MX Femenil Apertura 2026');
  }
});

it('renders a supported team without requesting an unsupported player directory or squad', async () => {
  const scope = registry.resolveSeason('liga-mx', '2026-apertura')!;
  vi.spyOn(registry, 'resolveSeason').mockReturnValue({ ...scope, season: { ...scope.season, resources: ['teams', 'scores'] } });
  vi.spyOn(dataStore, 'getTeam').mockResolvedValue(profile);
  vi.mocked(competitionPlayerIndex).mockRejectedValueOnce(new Error('unsupported'));
  const node = await TeamPage({ params: { locale: 'es', comp: 'liga-mx', season: '2026-apertura', teamId: 'mex-america' } });
  const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
  expect(competitionPlayerIndex).not.toHaveBeenCalled();
  expect(html).not.toContain('Plantel');
  expect(html).toContain('América');
});

describe('Spanish team page', () => {
  it('uses the translated short-versus label for the next match', async () => {
    vi.spyOn(dataStore, 'getTeam').mockResolvedValue(profile);

    const node = await TeamPage({
      params: {
        locale: 'es',
        comp: 'liga-mx',
        season: '2026-apertura',
        teamId: 'mex-america',
      },
    });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);

    expect(html).toContain('AME vs ATL');
    expect(html).not.toContain('AME v ATL');
  });
});
