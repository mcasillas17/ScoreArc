// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { BracketMatch, MatchStats, MatchSummaryData, TeamStats } from '@/server/data/types';
import MatchDetailPopup from './MatchDetailPopup';
import { MatchStatsBlock, WinProbBar } from './MatchStats';

vi.mock('next/navigation', () => ({
  usePathname: () => '/es',
  useRouter: () => ({ push: vi.fn() }),
}));

const teamStats = (shots: number): TeamStats => ({
  possession: 50,
  shots,
  shotsOnTarget: 4,
  shotAccuracy: 50,
  corners: 3,
  offsides: 1,
  passes: 400,
  passesAccurate: 350,
  passAccuracy: 88,
  crosses: 10,
  crossesAccurate: 4,
  crossAccuracy: 40,
  longBalls: 30,
  tackles: 12,
  tacklesEffective: 8,
  tackleAccuracy: 67,
  interceptions: 7,
  clearances: 15,
  blockedShots: 2,
  saves: 3,
  fouls: 9,
  yellowCards: 1,
  redCards: 0,
});

const stats: MatchStats = { home: teamStats(8), away: teamStats(11) };

const scheduledMatch: BracketMatch = {
  id: 'scheduled-localization',
  round: 'group',
  kickoff: 'not-a-date',
  home: { id: 'home', name: 'Home FC', abbr: 'HOM', crestUrl: null, placeholder: false },
  away: { id: 'away', name: 'Away FC', abbr: 'AWY', crestUrl: null, placeholder: false },
  homeScore: null,
  awayScore: null,
  state: 'scheduled',
  statusDetail: 'Scheduled',
  statusName: 'STATUS_SCHEDULED',
  minute: null,
  winnerId: null,
  note: null,
};

const emptySummary: MatchSummaryData = {
  scorers: [], cards: [], stats: null, winProbability: null, lineups: null,
  videos: [], shootoutDetail: null, info: null, form: null, commentary: [], h2h: [],
};

function renderPopup(match: BracketMatch, summary: MatchSummaryData | null = emptySummary, onClose = vi.fn()) {
  return render(
    <I18nProvider locale="es">
      <MatchDetailPopup match={match} summary={summary} loading={false} onClose={onClose} />
    </I18nProvider>,
  );
}

describe('match details localization', () => {
  afterEach(cleanup);

  it('renders Spanish match-detail framing without English leakage', async () => {
    render(
      <I18nProvider locale="es">
        <MatchStatsBlock stats={stats} />
        <WinProbBar prob={{ home: 45, draw: 25, away: 30 }} homeAbbr="HOM" awayAbbr="AWY" />
        <MatchDetailPopup match={scheduledMatch} summary={emptySummary} loading={false} onClose={vi.fn()} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    const text = document.body.textContent ?? '';
    for (const label of ['Estadísticas del partido', 'Tiros', 'A puerta', 'Pases', 'Defensa', 'Disciplina', 'Empate', 'Próximo', 'No disponible']) {
      expect(text).toContain(label);
    }
    for (const label of ['Match stats', 'Shots', 'On Target', 'Passing', 'Defending', 'Discipline', 'Draw', 'Upcoming']) {
      expect(text).not.toContain(label);
    }
  });

  it('uses semantic Spanish status labels and keeps only unknown provider states verbatim', async () => {
    const cases: Array<{ match: BracketMatch; expected: string; absent?: string }> = [
      { match: { ...scheduledMatch, state: 'finished', statusName: 'STATUS_FINAL', statusDetail: 'FT', homeScore: 2, awayScore: 1 }, expected: 'Final', absent: 'FT' },
      { match: { ...scheduledMatch, state: 'finished', statusName: 'STATUS_FINAL_PEN', statusDetail: 'FT-Pens', homeScore: 4, awayScore: 3 }, expected: 'Penaltis', absent: 'FT-Pens' },
      { match: { ...scheduledMatch, state: 'live', statusName: 'STATUS_IN_PROGRESS', statusDetail: '1st half', minute: null, homeScore: 0, awayScore: 0 }, expected: 'En vivo' },
      { match: { ...scheduledMatch, state: 'live', statusName: 'STATUS_HALFTIME', statusDetail: 'HT', minute: null, homeScore: 0, awayScore: 0 }, expected: 'Descanso', absent: 'HT' },
      { match: { ...scheduledMatch, state: 'live', statusName: 'STATUS_EXTRA_TIME', statusDetail: "ET 105'", minute: "105'", homeScore: 1, awayScore: 1 }, expected: "Tiempo extra 105'", absent: "ET 105'" },
      { match: { ...scheduledMatch, state: 'live', statusName: 'STATUS_WEATHER_DELAY', statusDetail: 'Source weather delay', minute: null, homeScore: 0, awayScore: 0 }, expected: 'Source weather delay' },
    ];

    for (const { match, expected, absent } of cases) {
      const { unmount } = renderPopup(match);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      const text = screen.getByRole('dialog').textContent ?? '';
      expect(text).toContain(expected);
      if (absent) expect(text).not.toContain(absent);
      unmount();
    }
  });

  it('localizes rich detail framing while preserving provider-authored fields', async () => {
    const richSummary: MatchSummaryData = {
      ...emptySummary,
      shootoutDetail: { home: [{ order: 1, player: 'Provider shooter', scored: true }], away: [] },
      cards: [{ teamId: 'home', player: 'Provider booked player', minute: "40'", type: 'yellow' }],
      info: { venue: 'Provider Stadium', city: 'Provider City', referee: 'Provider Referee', attendance: 12345 },
      form: {
        home: [{ result: 'W', opponent: 'SRC', score: '2-1' }, { result: 'D', opponent: 'RAW', score: '1-1' }, { result: 'L', opponent: 'TST', score: '0-1' }],
        away: [],
      },
      h2h: [{ label: 'SRC 2-1 TST', date: '2026-06-15T12:00:00.000Z' }],
      commentary: [{ minute: "12'", text: 'Provider commentary text' }],
      videos: [{ id: 'provider-video', headline: 'Provider video headline', duration: 62, thumbnail: null, mp4Url: null, isGoal: true }],
    };
    const match = { ...scheduledMatch, state: 'finished' as const, statusName: 'STATUS_FINAL', statusDetail: 'FT', note: 'Provider match note', homeScore: 2, awayScore: 1 };
    const { unmount } = renderPopup(match, richSummary);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent ?? '';
    for (const label of ['Penaltis', 'Tanda de penaltis', 'Resumen', 'Forma y enfrentamientos directos', 'Forma reciente', 'Enfrentamientos directos', 'Comentarios · 1']) {
      expect(text).toContain(label);
    }
    for (const providerText of ['Provider match note', 'Provider Stadium', 'Provider City', 'Provider Referee', 'Provider commentary text', 'Provider video headline', 'SRC 2-1 TST']) {
      expect(text).toContain(providerText);
    }
    expect(dialog.innerHTML).toContain('Provider shooter');
    expect(dialog.innerHTML).toContain('aria-label="1. Provider shooter — anotó"');
    expect(dialog.innerHTML).toContain('aria-label="Provider booked player — Tarjeta amarilla, 40\'"');
    expect(text).toMatch(/12[,.]345/);
    expect(dialog.innerHTML).toContain('aria-label="Ganado contra SRC 2-1"');
    expect(dialog.innerHTML).toContain('aria-label="Empate contra RAW 1-1"');
    expect(dialog.innerHTML).toContain('aria-label="Perdido contra TST 0-1"');
    expect(dialog.innerHTML).toContain('title="Ganado contra SRC 2-1"');
    expect(text).toContain('jun 2026');
    expect(dialog.innerHTML).toContain('>G</span>');
    expect(dialog.innerHTML).toContain('>E</span>');
    expect(dialog.innerHTML).toContain('>P</span>');
    unmount();
  });

  it('keeps the dialog focus and Escape-close behavior', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { unmount } = renderPopup(scheduledMatch, emptySummary, onClose);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const close = screen.getByRole('button', { name: 'Cerrar detalles del partido' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('closes from its button and restores the prior focus', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { unmount } = renderPopup(scheduledMatch, emptySummary, onClose);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar detalles del partido' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
