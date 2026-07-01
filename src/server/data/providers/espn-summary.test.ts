import { describe, it, expect } from 'vitest';
import {
  mapSummaryScorers,
  mapSummaryCards,
  mapSummaryStats,
  mapWinProbability,
  mapSummaryLineups,
  mapSummaryVideos,
} from './espn-summary';
import raw from '../__fixtures__/espn-summary.json';

describe('mapWinProbability', () => {
  it('derives normalized win/draw/win % from moneylines (home=4789, away=464)', () => {
    const wp = mapWinProbability(raw, '4789', '464');
    expect(wp).not.toBeNull();
    expect(wp!.home).toBeCloseTo(26.6, 0);
    expect(wp!.draw).toBeCloseTo(29.0, 0);
    expect(wp!.away).toBeCloseTo(44.5, 0);
    expect(wp!.home + wp!.draw + wp!.away).toBeCloseTo(100, 0);
  });

  it('swaps legs when our home is the odds away team', () => {
    const wp = mapWinProbability(raw, '464', '4789');
    expect(wp!.home).toBeCloseTo(44.5, 0);
    expect(wp!.away).toBeCloseTo(26.6, 0);
  });

  it('returns null when odds are absent', () => {
    expect(mapWinProbability({}, 'a', 'b')).toBeNull();
    expect(mapWinProbability(null, 'a', 'b')).toBeNull();
  });
});

describe('mapSummaryCards', () => {
  const cards = mapSummaryCards(raw);

  it('extracts cards with player, minute, team and yellow/red type', () => {
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.teamId).toBeTruthy();
      expect(typeof c.player).toBe('string');
      expect(typeof c.minute).toBe('string');
      expect(['yellow', 'red']).toContain(c.type);
    }
  });

  it('is resilient to empty/garbage input', () => {
    expect(mapSummaryCards({})).toEqual([]);
    expect(mapSummaryCards(null)).toEqual([]);
  });
});

describe('mapSummaryScorers', () => {
  const scorers = mapSummaryScorers(raw);

  it('returns at least one scorer from the fixture', () => {
    expect(scorers.length).toBeGreaterThan(0);
  });

  it('all scorers have non-empty player names', () => {
    expect(scorers.every((s) => s.player.length > 0)).toBe(true);
  });

  it('all scorers have non-empty minute values', () => {
    expect(scorers.every((s) => s.minute.length > 0)).toBe(true);
  });

  it('all scorers have a non-empty teamId', () => {
    expect(scorers.every((s) => s.teamId.length > 0)).toBe(true);
  });

  it('penalty and shootout fields are booleans', () => {
    for (const s of scorers) {
      expect(typeof s.penalty).toBe('boolean');
      expect(typeof s.shootout).toBe('boolean');
    }
  });

  it('includes known scorers from the fixture (Antonio Nusa, Erling Haaland)', () => {
    const names = scorers.map((s) => s.player);
    expect(names).toContain('Antonio Nusa');
    expect(names).toContain('Erling Haaland');
  });
});

describe('mapSummaryScorers resilience', () => {
  it('returns [] for empty object input', () => {
    expect(mapSummaryScorers({})).toEqual([]);
  });

  it('returns [] for null input', () => {
    expect(mapSummaryScorers(null)).toEqual([]);
  });

  it('skips entries with no team', () => {
    const input = {
      keyEvents: [
        { scoringPlay: true, clock: { displayValue: "10'" } }, // no team
        {
          scoringPlay: true,
          team: { id: '1' },
          clock: { displayValue: "20'" },
          participants: [{ athlete: { displayName: 'Player A' } }],
          penaltyKick: false,
          shootout: false,
        },
      ],
    };
    const result = mapSummaryScorers(input);
    expect(result).toHaveLength(1);
    expect(result[0].player).toBe('Player A');
  });

  it('skips entries where scoringPlay is false', () => {
    const input = {
      keyEvents: [
        {
          scoringPlay: false,
          team: { id: '1' },
          clock: { displayValue: "10'" },
          participants: [{ athlete: { displayName: 'Player A' } }],
          penaltyKick: false,
          shootout: false,
        },
      ],
    };
    expect(mapSummaryScorers(input)).toEqual([]);
  });

  it('handles missing participants gracefully (player = empty string)', () => {
    const input = {
      keyEvents: [
        {
          scoringPlay: true,
          team: { id: '1' },
          clock: { displayValue: "5'" },
          shootout: false,
        },
      ],
    };
    const [s] = mapSummaryScorers(input);
    expect(s.player).toBe('');
  });
});

describe('mapSummaryStats', () => {
  // Fixture: Ivory Coast (4789) is teams[0], Norway (464) is teams[1]
  // Pass Ivory Coast as home, Norway as away
  const result = mapSummaryStats(raw, '4789', '464');

  it('returns non-null for valid fixture input', () => {
    expect(result).not.toBeNull();
  });

  it('maps home team possession to a number', () => {
    expect(result!.home.possession).toBe(47.1);
  });

  it('maps home team shots to a number', () => {
    expect(result!.home.shots).toBe(14);
  });

  it('maps home team shotsOnTarget to a number', () => {
    expect(result!.home.shotsOnTarget).toBe(5);
  });

  it('maps home team passes to a number', () => {
    expect(result!.home.passes).toBe(401);
  });

  it('maps home team corners to a number', () => {
    expect(result!.home.corners).toBe(14);
  });

  it('maps home team fouls to a number', () => {
    expect(result!.home.fouls).toBe(6);
  });

  it('maps away team possession correctly', () => {
    expect(result!.away.possession).toBe(52.9);
  });

  it('maps away team stats correctly', () => {
    expect(result!.away.shots).toBe(9);
    expect(result!.away.shotsOnTarget).toBe(4);
    expect(result!.away.passes).toBe(473);
    expect(result!.away.corners).toBe(3);
    expect(result!.away.fouls).toBe(7);
  });

  it('swaps home/away when ids are reversed', () => {
    const reversed = mapSummaryStats(raw, '464', '4789');
    expect(reversed!.home.possession).toBe(52.9); // Norway as home
    expect(reversed!.away.possession).toBe(47.1); // Ivory Coast as away
  });

  it('returns null for empty object input', () => {
    expect(mapSummaryStats({}, 'a', 'b')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(mapSummaryStats(null, 'a', 'b')).toBeNull();
  });

  it('returns null when boxscore.teams is missing', () => {
    expect(mapSummaryStats({ boxscore: {} }, 'a', 'b')).toBeNull();
  });

  it('returns null when team ids do not match', () => {
    expect(mapSummaryStats(raw, 'x', 'y')).toBeNull();
  });
});

describe('mapSummaryLineups', () => {
  it('returns non-null for valid fixture (home=4789, away=464)', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    expect(result).not.toBeNull();
  });

  it('home formation is a non-empty string', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    expect(result!.home.formation.length).toBeGreaterThan(0);
  });

  it('home lineup has exactly 11 starters', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    expect(result!.home.players).toHaveLength(11);
  });

  it('all home starters have a non-empty name', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    expect(result!.home.players.every((p) => p.name.length > 0)).toBe(true);
  });

  it('away lineup also has 11 starters', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    expect(result!.away.players).toHaveLength(11);
  });

  it('starters carry a jersey image url when available', () => {
    const result = mapSummaryLineups(raw, '4789', '464');
    const withJersey = result!.home.players.filter((p) => p.jersey != null);
    // Fixture players have jerseyImages; expect at least one mapped, and any
    // mapped value is an ESPN https url.
    expect(withJersey.length).toBeGreaterThan(0);
    expect(withJersey.every((p) => p.jersey!.startsWith('https://'))).toBe(true);
  });

  it('returns null for empty object (resilience)', () => {
    expect(mapSummaryLineups({}, '4789', '464')).toBeNull();
  });

  it('returns null when team ids do not match', () => {
    expect(mapSummaryLineups(raw, 'x', 'y')).toBeNull();
  });
});

describe('mapSummaryVideos', () => {
  const videos = mapSummaryVideos(raw);

  it('returns clips with a playable mp4 url', () => {
    expect(videos.length).toBeGreaterThan(0);
    expect(videos.every((v) => v.mp4Url && /\.mp4/.test(v.mp4Url))).toBe(true);
  });

  it('flags goal clips and sorts them first', () => {
    const goal = videos.find((v) => v.isGoal);
    expect(goal).toBeTruthy();
    // once a non-goal appears, no goal clip may follow (goals are front-loaded)
    let seenNonGoal = false;
    for (const v of videos) {
      if (!v.isGoal) seenNonGoal = true;
      else expect(seenNonGoal).toBe(false);
    }
  });

  it('carries a headline and thumbnail', () => {
    expect(videos[0].headline.length).toBeGreaterThan(0);
  });

  it('returns [] for a malformed payload', () => {
    expect(mapSummaryVideos({})).toEqual([]);
    expect(mapSummaryVideos(null)).toEqual([]);
  });
});
