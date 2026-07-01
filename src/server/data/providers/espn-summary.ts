import type { Scorer, Card, MatchStats, TeamStats, WinProbability, LineupPlayer, TeamLineup, MatchLineups, MatchVideo, PenaltyKick, ShootoutDetail, MatchInfo, FormResult, MatchForm, CommentaryItem, H2HMeeting } from '../types';

// Venue, city, referee and attendance from summary.gameInfo.
export function mapSummaryInfo(raw: unknown): MatchInfo | null {
  try {
    const gi = (raw as any)?.gameInfo;
    if (!gi) return null;
    const v = gi.venue ?? {};
    const addr = v.address ?? {};
    const ref = (gi.officials ?? []).find((o: any) =>
      /referee/i.test(o?.position?.displayName ?? o?.position?.name ?? '')
    );
    const info: MatchInfo = {
      venue: v.fullName ?? null,
      city: addr.city ?? null,
      referee: ref?.displayName ?? null,
      attendance: typeof gi.attendance === 'number' ? gi.attendance : null,
    };
    if (!info.venue && !info.referee && info.attendance == null) return null;
    return info;
  } catch {
    return null;
  }
}

function mapFormEvents(entry: any): FormResult[] {
  const teamId = String(entry?.team?.id ?? '');
  return (entry?.events ?? []).slice(0, 5).map((e: any): FormResult => {
    const home = String(e?.homeTeamId ?? '') === teamId;
    const gf = home ? e?.homeTeamScore : e?.awayTeamScore;
    const ga = home ? e?.awayTeamScore : e?.homeTeamScore;
    const res: 'W' | 'L' | 'D' =
      e?.gameResult === 'W' ? 'W' : e?.gameResult === 'L' ? 'L' : 'D';
    return {
      result: res,
      opponent: e?.opponent?.abbreviation ?? '',
      score: `${gf ?? 0}-${ga ?? 0}`,
    };
  });
}

// Each team's last-5 form from summary.lastFiveGames, mapped to home/away by id.
export function mapSummaryForm(raw: unknown, homeId: string, awayId: string): MatchForm | null {
  try {
    const l5: any[] = (raw as any)?.lastFiveGames ?? [];
    const homeEntry = l5.find((t: any) => String(t?.team?.id) === homeId);
    const awayEntry = l5.find((t: any) => String(t?.team?.id) === awayId);
    if (!homeEntry && !awayEntry) return null;
    return {
      home: homeEntry ? mapFormEvents(homeEntry) : [],
      away: awayEntry ? mapFormEvents(awayEntry) : [],
    };
  } catch {
    return null;
  }
}

// Minute-by-minute commentary from summary.commentary.
export function mapSummaryCommentary(raw: unknown): CommentaryItem[] {
  try {
    const com: any[] = (raw as any)?.commentary ?? [];
    return com
      .map((c: any): CommentaryItem => ({
        minute: c?.time?.displayValue ?? '',
        text: c?.text ?? '',
      }))
      .filter((c) => c.text.length > 0);
  } catch {
    return [];
  }
}

// Recent head-to-head meetings from summary.headToHeadGames. Each group is
// keyed on a reference `team`; events carry home/away ids + the `opponent`.
export function mapSummaryH2H(raw: unknown): H2HMeeting[] {
  try {
    const group = ((raw as any)?.headToHeadGames ?? [])[0];
    if (!group) return [];
    const refId = String(group.team?.id ?? '');
    const refAbbr = group.team?.abbreviation ?? '';
    return (group.events ?? []).slice(0, 5).map((e: any): H2HMeeting => {
      const oppAbbr = e?.opponent?.abbreviation ?? '';
      const homeIsRef = String(e?.homeTeamId ?? '') === refId;
      const homeAbbr = homeIsRef ? refAbbr : oppAbbr;
      const awayAbbr = homeIsRef ? oppAbbr : refAbbr;
      const score = `${e?.homeTeamScore ?? 0}-${e?.awayTeamScore ?? 0}`;
      return { date: e?.gameDate ?? '', label: `${homeAbbr} ${score} ${awayAbbr}`.trim() };
    });
  } catch {
    return [];
  }
}

// Kick-by-kick penalty shootout from summary.shootout (per-team `shots` with
// `didScore`), mapped to OUR home/away by team id. null when no shootout.
export function mapSummaryShootout(
  raw: unknown,
  homeId: string,
  awayId: string
): ShootoutDetail | null {
  try {
    const teams: any[] = (raw as any)?.shootout ?? [];
    if (!Array.isArray(teams) || teams.length < 2) return null;
    const kicks = (entry: any): PenaltyKick[] =>
      (entry?.shots ?? []).map((s: any): PenaltyKick => ({
        order: Number(s?.shotNumber ?? 0),
        player: s?.player ?? '',
        scored: s?.didScore === true,
      }));
    const homeEntry = teams.find((t: any) => String(t?.id) === homeId);
    const awayEntry = teams.find((t: any) => String(t?.id) === awayId);
    if (!homeEntry || !awayEntry) return null;
    const home = kicks(homeEntry);
    const away = kicks(awayEntry);
    if (home.length === 0 && away.length === 0) return null;
    return { home, away };
  } catch {
    return null;
  }
}

// A clip is a "goal" clip (vs. analysis/interview/presser) when the headline
// mentions scoring. Keeps goal highlights sortable to the front.
const GOAL_RE = /\b(goals?|scores?|scored|winner|equali[sz]er|penalt|hat[- ]?trick|brace|strike)\b/i;

// Pick a progressive MP4 that plays directly in an HTML5 <video> (prefer 720p,
// then any .mp4). ESPN nests candidate URLs across links/source, so we scan the
// whole video object.
function pickMp4(video: any): string | null {
  const urls: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') {
      if (/^https?:\/\/[^"']+\.mp4(\?|$)/i.test(v)) urls.push(v);
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(video);
  if (urls.length === 0) return null;
  return urls.find((u) => /720p/i.test(u)) ?? urls.find((u) => /540p|360p/i.test(u)) ?? urls[0];
}

export function mapSummaryVideos(raw: unknown): MatchVideo[] {
  try {
    const videos: any[] = (raw as any)?.videos ?? [];
    const mapped: MatchVideo[] = videos
      .map((v: any): MatchVideo => {
        const headline: string = v?.headline ?? '';
        return {
          id: String(v?.id ?? v?.cerebroId ?? headline),
          headline,
          duration: typeof v?.duration === 'number' ? v.duration : null,
          thumbnail: v?.thumbnail ?? null,
          mp4Url: pickMp4(v),
          isGoal: GOAL_RE.test(headline),
        };
      })
      .filter((v) => v.mp4Url != null);
    // Goal clips first, otherwise keep ESPN's order.
    return mapped
      .map((v, i) => ({ v, i }))
      .sort((a, b) => Number(b.v.isGoal) - Number(a.v.isGoal) || a.i - b.i)
      .map(({ v }) => v);
  } catch {
    return [];
  }
}

function parseStat(stats: any[], name: string): number | null {
  const s = stats.find((x: any) => x.name === name);
  if (s == null) return null;
  const n = parseFloat(s.displayValue);
  return isNaN(n) ? null : n;
}

// American moneyline -> implied probability (0..1).
function moneylineToProb(ml: number | null | undefined): number | null {
  if (ml == null || isNaN(ml)) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

function teamIdFromRef(o: any): string | null {
  const ref: string = o?.team?.$ref ?? '';
  const m = /\/teams\/(\d+)/.exec(ref);
  return m ? m[1] : null;
}

/**
 * Market-implied win/draw/win probability from the first betting provider's
 * moneylines, with the bookmaker margin removed (normalised to 100). Mapped to
 * OUR home/away by team id. Returns null if no usable 3-way moneyline is present.
 */
export function mapWinProbability(
  raw: unknown,
  homeId: string,
  awayId: string
): WinProbability | null {
  try {
    const oddsList: any[] = (raw as any)?.odds ?? [];
    for (const o of oddsList) {
      const pHome = moneylineToProb(o?.homeTeamOdds?.moneyLine);
      const pAway = moneylineToProb(o?.awayTeamOdds?.moneyLine);
      const pDraw = moneylineToProb(o?.drawOdds?.moneyLine);
      if (pHome == null || pAway == null || pDraw == null) continue;

      // Assign the provider's home/away legs to OUR home/away by team id.
      const homeLegId = teamIdFromRef(o.homeTeamOdds);
      let ourHome = pHome;
      let ourAway = pAway;
      if (homeLegId && homeLegId === awayId) {
        ourHome = pAway;
        ourAway = pHome;
      }

      const total = ourHome + ourAway + pDraw;
      if (total <= 0) continue;
      return {
        home: Math.round((ourHome / total) * 1000) / 10,
        draw: Math.round((pDraw / total) * 1000) / 10,
        away: Math.round((ourAway / total) * 1000) / 10,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function buildTeamStats(statistics: any[]): TeamStats {
  return {
    possession: parseStat(statistics, 'possessionPct'),
    shots: parseStat(statistics, 'totalShots'),
    shotsOnTarget: parseStat(statistics, 'shotsOnTarget'),
    passes: parseStat(statistics, 'totalPasses'),
    corners: parseStat(statistics, 'wonCorners'),
    fouls: parseStat(statistics, 'foulsCommitted'),
  };
}

export function mapSummaryStats(
  raw: unknown,
  homeId: string,
  awayId: string
): MatchStats | null {
  try {
    const teams: any[] = (raw as any)?.boxscore?.teams;
    if (!Array.isArray(teams) || teams.length < 2) return null;
    const homeEntry = teams.find((t: any) => String(t.team?.id) === homeId);
    const awayEntry = teams.find((t: any) => String(t.team?.id) === awayId);
    if (!homeEntry || !awayEntry) return null;
    return {
      home: buildTeamStats(homeEntry.statistics ?? []),
      away: buildTeamStats(awayEntry.statistics ?? []),
    };
  } catch {
    return null;
  }
}

export function mapSummaryScorers(raw: unknown): Scorer[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => e.scoringPlay === true && e.team?.id != null)
    .map(
      (e: any): Scorer => ({
        teamId: String(e.team.id),
        player: e.participants?.[0]?.athlete?.displayName ?? '',
        minute: e.clock?.displayValue ?? '',
        penalty: !!e.penaltyKick,
        shootout: !!e.shootout,
      })
    );
}

// Yellow / red cards from the summary keyEvents (same shape as goals).
// "Yellow Red Card" (second yellow -> sending off) counts as a red.
export function mapSummaryCards(raw: unknown): Card[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => /card/i.test(e.type?.text ?? '') && e.team?.id != null)
    .map((e: any): Card => ({
      teamId: String(e.team.id),
      player: e.participants?.[0]?.athlete?.displayName ?? '',
      minute: e.clock?.displayValue ?? '',
      type: /red/i.test(e.type?.text ?? '') ? 'red' : 'yellow',
    }));
}

// Pick the light-mode player kit image from ESPN's jerseyImages list.
function jerseyImage(images: any): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const light = images.find((im: any) => !(im.rel ?? []).includes('dark'));
  return (light ?? images[0])?.href ?? null;
}

export function mapSummaryLineups(
  raw: unknown,
  homeId: string,
  awayId: string
): MatchLineups | null {
  try {
    const rosters: any[] = (raw as any)?.rosters ?? [];
    const homeEntry = rosters.find((r: any) => String(r.team?.id) === homeId);
    const awayEntry = rosters.find((r: any) => String(r.team?.id) === awayId);
    if (!homeEntry || !awayEntry) return null;

    const toTeamLineup = (entry: any): TeamLineup => {
      const formation: string = entry.formation ?? '';
      const players: LineupPlayer[] = (entry.roster ?? [])
        .filter((p: any) => p.starter === true)
        .map((p: any): LineupPlayer => ({
          name: p.athlete?.displayName ?? '',
          number: p.jersey ? Number(p.jersey) : null,
          position: p.position?.abbreviation ?? '',
          jersey: jerseyImage(p.athlete?.jerseyImages),
        }));
      return { formation, players };
    };

    const home = toTeamLineup(homeEntry);
    const away = toTeamLineup(awayEntry);
    // Rosters can be present before lineups are published (no starters yet) —
    // treat that as "no lineup" so the UI doesn't render an empty XI.
    if (!home.players.length || !away.players.length) return null;
    return { home, away };
  } catch {
    return null;
  }
}
