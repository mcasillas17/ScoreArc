import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { dataStore } from '@/server/data/store';
import type { Match, TeamProfile } from '@/server/data/types';
import TeamPage from './page';

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

afterEach(() => vi.restoreAllMocks());

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
