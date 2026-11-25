// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { COMPETITIONS } from '@/server/data/competitions';
import type { BracketMatch, BracketRound } from '@/server/data/types';
import BracketInteractive, { mergeRounds } from './BracketInteractive';
import { bracketShapeFor } from './bracketShape';
import ChampionCelebration from './ChampionCelebration';

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

const team = (id: string, name = `Team ${id}`, abbr = id.toUpperCase()) => ({
  id,
  name,
  abbr,
  crestUrl: null,
  placeholder: false,
});

const match = (index: number): BracketMatch => ({
  id: `quarterfinal-${index}`,
  round: 'quarterfinals',
  kickoff: '2026-08-20T00:00:00Z',
  home: team(`h${index}`),
  away: team(`a${index}`),
  homeScore: null,
  awayScore: null,
  state: 'scheduled',
  statusDetail: '',
  statusName: 'STATUS_SCHEDULED',
  minute: null,
  winnerId: null,
  note: null,
});

const rounds: BracketRound[] = [{
  slug: 'quarterfinals',
  matches: Array.from({ length: 4 }, (_, index) => match(index)),
}];

const championTeams = {
  mexico: team('mex', 'México', 'MEX'),
  canada: team('can', 'Canadá', 'CAN'),
  brazil: team('bra', 'Brasil', 'BRA'),
  japan: team('jpn', 'Japón', 'JPN'),
  germany: team('ger', 'Alemania', 'GER'),
  paraguay: team('par', 'Paraguay', 'PAR'),
  netherlands: team('ned', 'Países Bajos', 'NED'),
  morocco: team('mar', 'Marruecos', 'MAR'),
};

const championRounds: BracketRound[] = [{
  slug: 'quarterfinals',
  matches: [
    { ...match(0), home: championTeams.mexico, away: championTeams.canada },
    { ...match(1), home: championTeams.brazil, away: championTeams.japan },
    { ...match(2), home: championTeams.germany, away: championTeams.paraguay },
    { ...match(3), home: championTeams.netherlands, away: championTeams.morocco },
  ],
}];

const leaguesCup = COMPETITIONS['leagues-cup'];
const season = leaguesCup.seasons['2026'];

function bracket(
  predictionEnabled: boolean,
  readOnly: boolean,
  bracketRounds: BracketRound[] = rounds,
) {
  return (
    <I18nProvider locale="es">
      <BracketInteractive
        rounds={bracketRounds}
        apiBase="/api/leagues-cup/2026"
        teamStyle="crest"
        compId="leagues-cup"
        emblem={leaguesCup.emblem}
        championTitleKey={leaguesCup.championTitleKey}
        seasonId="2026"
        compShortName={leaguesCup.shortName}
        seasonLabel={season.label}
        shape={bracketShapeFor(season)}
        predictionEnabled={predictionEnabled}
        readOnly={readOnly}
      />
    </I18nProvider>
  );
}

async function completeChampionPrediction() {
  window.history.replaceState(null, '', '/es/c/leagues-cup/2026');
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(bracket(true, false, championRounds));

  fireEvent.click(screen.getByRole('tab', { name: 'Arma tu cuadro' }));
  for (const name of ['México', 'Brasil', 'Alemania', 'Países Bajos']) {
    fireEvent.click(screen.getByRole('button', { name }));
  }

  await waitFor(() => expect(screen.getAllByRole('button', { name: 'México' })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'México' })[1]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Alemania' })[1]);

  await waitFor(() => expect(screen.getAllByRole('button', { name: 'México' })).toHaveLength(3));
  fireEvent.click(screen.getAllByRole('button', { name: 'México' })[2]);

  return {
    celebration: await screen.findByRole('dialog', { name: 'México — CAMPEONES' }),
    open,
  };
}

describe('bracket localization', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['en', 'WORLD CHAMPIONS', 'Your predicted winner'],
    ['es', 'CAMPEONAS DEL MUNDO', 'Tus ganadoras previstas'],
  ] as const)('uses the women’s champion terms in %s', (locale, title, subtitle) => {
    window.history.replaceState(null, '', `/${locale}/c/liga-mx-femenil/2026-apertura`);
    render(<I18nProvider locale={locale}><ChampionCelebration
      team={team('mex-w-america', 'América', 'AME')} emblem="🏆" championTitleKey="champion.world" onClose={() => {}}
    /></I18nProvider>);
    expect(screen.getByRole('dialog', { name: `América — ${title}` })).toBeTruthy();
    expect(screen.getByText(subtitle)).toBeTruthy();
  });

  it('labels the Femenil projection and explains two legs in Spanish', () => {
    const edition = COMPETITIONS['liga-mx-femenil'].seasons['2026-apertura'];
    const projected = [{ ...rounds[0], matches: rounds[0].matches.map(m => ({ ...m, id: 'proj-' + m.id })) }];
    render(<I18nProvider locale="es"><BracketInteractive rounds={projected} apiBase="/api/x/y" compId="liga-mx-femenil"
      seasonId={edition.id} compShortName="Liga MX Femenil" seasonLabel={edition.label} emblem="🇲🇽"
      shape={bracketShapeFor(edition)} predictionEnabled /></I18nProvider>);
    expect(screen.getByRole('tab', { name: 'Proyección' })).toBeDefined();
    expect(screen.getByText(/ida y vuelta/)).toBeDefined();
  });

  it('accepts newly available seeds after a poll while preserving the decided match', () => {
    const decided = { ...match(0), state: 'finished' as const, homeScore: 2, awayScore: 1, winnerId: 'h0' };
    const polled = { ...match(0), home: { ...decided.home, overallSeed: 2 }, away: { ...decided.away, overallSeed: 4 } };
    const round = (m: BracketMatch): BracketRound[] => [{ slug: 'quarterfinals', matches: [m] }];
    expect(mergeRounds(round(decided), round(polled))[0].matches[0]).toMatchObject({
      winnerId: 'h0', homeScore: 2, state: 'finished', home: { overallSeed: 2 }, away: { overallSeed: 4 },
    });
  });

  it('shares two-leg scorelines and restores the edition pick independently of live results', async () => {
    const edition = COMPETITIONS['liga-mx'].seasons['2026-apertura'];
    const uri = '/en/c/liga-mx/2026-apertura';
    window.history.replaceState(null, '', uri);
    window.localStorage.clear();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const seeded = { ...match(0), home: { ...team('ame', 'América'), overallSeed: 3 }, away: { ...team('mty', 'Monterrey'), overallSeed: 6 } };
    const renderEdition = () => render(<I18nProvider locale="en"><BracketInteractive
      rounds={[{ slug: 'quarterfinals', matches: [seeded] }]} apiBase="/api/liga-mx/2026-apertura"
      compId="liga-mx" seasonId={edition.id} compShortName="Liga MX" seasonLabel={edition.label}
      shape={bracketShapeFor(edition)} emblem="🏆" predictionEnabled poll={false} /></I18nProvider>);
    const first = renderEdition();
    fireEvent.click(screen.getByRole('tab', { name: 'Build your bracket' }));
    for (const [name, value] of [['América', '1'], ['Monterrey', '0']]) {
      for (const leg of ['Ida', 'Vuelta']) {
        fireEvent.change(screen.getByRole('textbox', { name: new RegExp(name + '.*' + leg, 'i') }), { target: { value } });
      }
    }
    expect(screen.getByText('América advances')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Share your bracket on X' }));
    const sharedText = new URL(String(open.mock.calls[0][0])).searchParams.get('text')!;
    const shared = new URL(sharedText.slice(sharedText.indexOf('http')));
    first.unmount();
    const restored = renderEdition();
    expect(screen.queryByText('América advances')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Build your bracket' }));
    expect(screen.getByText('América advances')).toBeDefined();
    restored.unmount();
    window.localStorage.clear();
    window.history.replaceState(null, '', uri + shared.search);
    renderEdition();
    expect(await screen.findByText('América advances')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Build your bracket' }).getAttribute('aria-selected')).toBe('true');
    window.history.replaceState(null, '', '/');
  });

  it('renders read-only bracket and accessibility text from the Spanish catalog', () => {
    const { container } = render(bracket(false, true));
    const html = container.innerHTML;

    expect(html).toContain('Cuadro de eliminatorias');
    expect(html).toContain('Cuartos de final');
    expect(html).toContain('aria-label="Zoom del cuadro"');
    expect(html).toContain('aria-label="Emblema de la competición"');
    expect(html).not.toContain('Knockout bracket');
    expect(html).not.toContain('Quarterfinals');
    expect(html).not.toContain('Competition emblem');
  });

  it('localizes prediction controls and shares a locale-preserving complete message', () => {
    window.history.replaceState(null, '', '/es/c/leagues-cup/2026');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(bracket(true, false));

    expect(screen.getByRole('tablist', { name: 'Modo del cuadro' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Arma tu cuadro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compartir tu cuadro en X' }));

    expect(screen.getByText('Compartir')).toBeTruthy();
    expect(screen.getByText('Restablecer')).toBeTruthy();
    expect(screen.queryByText('Share')).toBeNull();

    const intent = new URL(String(open.mock.calls[0][0]));
    expect(intent.searchParams.get('text')).toBe(
      'Estoy armando mi cuadro de Leagues Cup 2026 en ScoreArc ⚽ — arma el tuyo: ' +
      'http://localhost:3000/es/c/leagues-cup/2026?b=e30',
    );
  });

  it.each([
    ["Men's World Cup", '2026', 'MensWorldCup2026'],
    ['Liga MX Femenil', 'Apertura 2026', 'LigaMXFemenilApertura2026'],
  ])('shares one valid hashtag for %s %s', (compShortName, seasonLabel, hashtag) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<I18nProvider locale="es"><BracketInteractive
      rounds={rounds} apiBase="/api/leagues-cup/2026" compId="leagues-cup" seasonId="2026"
      compShortName={compShortName} seasonLabel={seasonLabel} emblem="🏆" shape={bracketShapeFor(season)} predictionEnabled
    /></I18nProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Arma tu cuadro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compartir tu cuadro en X' }));
    const intent = new URL(String(open.mock.calls[0][0]));
    expect(intent.searchParams.get('hashtags')).toBe(hashtag);
    expect(intent.searchParams.get('text')).toContain(`${compShortName} ${seasonLabel}`);
  });

  it('localizes champion celebration and canvas accessibility text', async () => {
    const { celebration } = await completeChampionPrediction();
    expect(celebration.textContent).toContain('Tu ganador previsto');
    expect(screen.getByRole('img', { name: 'Bandera del campeón' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cerrar celebración' })).toBeTruthy();
    expect(celebration.textContent).not.toContain('Your predicted winner');
    expect(document.body.innerHTML).not.toContain('Champion flag');
  });

  it('shares a complete localized champion-bearing message', async () => {
    const { open } = await completeChampionPrediction();
    fireEvent.click(screen.getByRole('button', { name: 'Compartir en X' }));
    const intent = new URL(String(open.mock.calls.at(-1)?.[0]));
    const text = intent.searchParams.get('text') ?? '';
    const messagePrefix =
      'Mi elección para ganar Leagues Cup 2026: México 🏆⚽ — arma tu cuadro en ScoreArc: ';
    expect(text.startsWith(messagePrefix)).toBe(true);
    expect(text).not.toContain('My pick to win');

    const sharedUrl = new URL(text.slice(messagePrefix.length));
    expect(sharedUrl.pathname).toBe('/es/c/leagues-cup/2026');
    expect(sharedUrl.searchParams.get('c')).toBe('MEX');
    expect(sharedUrl.searchParams.get('name')).toBe('México');
  });
});
