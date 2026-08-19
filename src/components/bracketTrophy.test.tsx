import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RadialBracket from './RadialBracket';
import { COMPETITIONS, listCompetitions } from '@/server/data/competitions';
import type { BracketRound } from '@/server/data/types';

// `/trophy.png` is a photograph of the FIFA World Cup trophy. It sat hardcoded
// at the centre of the radial bracket from when the World Cup was the only
// competition, so the Leagues Cup bracket showed the World Cup trophy in
// production. Nothing caught it because nothing asserted the hub belonged to
// the competition around it.

const rounds: BracketRound[] = [
  {
    slug: 'quarterfinals',
    name: 'Quarterfinals',
    matches: [
      {
        id: 'm1',
        home: { id: 'h', name: 'Home', abbr: 'HOM', crestUrl: null },
        away: { id: 'a', name: 'Away', abbr: 'AWY', crestUrl: null },
        homeScore: null,
        awayScore: null,
        winnerId: null,
        kickoff: '2026-08-20T00:00:00Z',
        state: 'scheduled',
      },
    ],
  } as unknown as BracketRound,
];

function render(emblem: string, trophyImage?: string) {
  return renderToStaticMarkup(
    <RadialBracket
      rounds={rounds}
      teamStyle="crest"
      apiBase="/api/x/y"
      emblem={emblem}
      trophyImage={trophyImage}
    />,
  );
}

describe('bracket hub emblem', () => {
  it('shows the real trophy for the competition that owns it', () => {
    expect(render('🌍', '/trophy.png')).toContain('/trophy.png');
  });

  it("shows a competition's own emblem when it has no trophy of its own", () => {
    const html = render('🏆');
    expect(html).not.toContain('/trophy.png');
    expect(html).toContain('🏆');
  });

  // The guard that matters: exactly one competition may claim that image.
  it('gives the trophy photograph to the World Cup alone', () => {
    const withTrophy = listCompetitions().filter((c) => c.trophyImage);
    expect(withTrophy.map((c) => c.id)).toEqual(['world-cup']);
  });

  it('gives every competition something to render at the hub', () => {
    for (const comp of listCompetitions()) {
      expect(comp.trophyImage ?? comp.emblem).toBeTruthy();
    }
  });

  it('does not put the World Cup trophy on the Leagues Cup', () => {
    const leaguesCup = COMPETITIONS['leagues-cup'];
    expect(leaguesCup.trophyImage).toBeUndefined();
    expect(render(leaguesCup.emblem, leaguesCup.trophyImage)).not.toContain('/trophy.png');
  });
});
