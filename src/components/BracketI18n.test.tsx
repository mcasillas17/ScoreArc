// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { COMPETITIONS } from '@/server/data/competitions';
import type { BracketMatch, BracketRound } from '@/server/data/types';
import BracketInteractive from './BracketInteractive';
import { bracketShapeFor } from './bracketShape';

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
