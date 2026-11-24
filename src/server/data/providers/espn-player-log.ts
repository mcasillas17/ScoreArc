import type { CompetitionSeason } from '../competitions';
import type { GameLogRow, Match, MatchSummaryData } from '../types';
import type { ScoreboardFetchJson } from '../scoreboardWindow';
import { teamScheduleUrl, athleteEventLogUrl, athleteLineupEntryUrl } from '../endpoints';
import { mapScopedTeamSchedule } from './espn-team';
import { datedInEdition, editionPhase, EspnEditionError, object, providerYear, seasonIssue } from './espn-edition';

function incomplete(): never { throw new EspnEditionError('partial', 'player log'); }

function reference(value: unknown) {
  if (!object(value) || typeof value.$ref !== 'string') return null;
  const url = URL.parse(value.$ref);
  return url && ['http:', 'https:'].includes(url.protocol) && url.host === 'sports.core.api.espn.com' ? url.pathname : null;
}

/** The season-qualified core index names potential appearances, including matches
 * before a transfer. Use its references only as identifiers, never as fetch destinations. */
function indexedEvents(raw: unknown, rc: CompetitionSeason, athleteId: string) {
  const league = '/v2/sports/soccer/leagues/' + rc.competition.espnSlug;
  if (reference(raw) !== `${league}/seasons/${providerYear(rc.season)}/athletes/${athleteId}/eventlog`) throw new EspnEditionError('scope_mismatch', 'player log');
  const page = object(raw) && object(raw.events) ? raw.events : null;
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || page.count !== page.items.length ||
      page.pageIndex !== 1 || !(page.pageCount === 1 || (page.count === 0 && page.pageCount === 0))) return incomplete();
  const played = new Map<string, string>();
  const ambiguous = new Set<string>();
  const seen = new Set<string>();
  for (const row of page.items) {
    if (!object(row) || typeof row.played !== 'boolean') return incomplete();
    const path = reference(row.event);
    const id = path?.split('/').at(-1) ?? '';
    if (!/^[1-9]\d*$/.test(id) || path !== `${league}/events/${id}`) return incomplete();
    const key = id + '/' + row.teamId;
    if (seen.has(key)) return incomplete();
    seen.add(key);
    if (!row.played) continue;
    if (typeof row.teamId !== 'string' || !/^[1-9]\d*$/.test(row.teamId)) return incomplete();
    // A transfer can produce two candidates for the same head-to-head match.
    // Its side is ambiguous only if that match could enter the latest five.
    if (played.has(id)) ambiguous.add(id);
    else played.set(id, row.teamId);
  }
  return { played, ambiguous };
}

function gameLogRow(match: Match, teamId: string, playerId: string, summary: Pick<MatchSummaryData, 'lineups'>, entry?: string): GameLogRow | null {
  const home = match.home.id === teamId;
  const side = home ? 'home' : 'away';
  const player = summary.lineups?.[side].players.find(row => row.athleteId === playerId);
  if (!player?.stats) return incomplete();
  const appearance = entry ?? (player.starter ? 'Started' : player.stats.subIns === 1 ? 'Sub' : '');
  if (entry !== undefined && (player.starter === true) !== (entry === 'Started')) return incomplete();
  if (entry === undefined && !appearance) {
    if (player.stats.appearances !== 0 || player.stats.subIns !== 0) return incomplete();
    return null;
  }
  const { homeScore, awayScore } = match;
  const scored = homeScore !== null && awayScore !== null;
  let result = '';
  if (match.state === 'finished' && scored) result = homeScore === awayScore ? 'D' : (homeScore > awayScore) === home ? 'W' : 'L';
  return {
    eventId: match.id, appearance,
    stats: { ...player.stats, appearances: appearance ? 1 : null, subIns: appearance === 'Started' ? 0 : appearance === 'Sub' ? 1 : null },
    date: match.kickoff, atVs: home ? 'vs' : '@', opponent: home ? match.away : match.home,
    score: scored ? `${homeScore}-${awayScore}` : '', result,
    homeTeamId: match.home.id, awayTeamId: match.away.id, teamId, teamAbbr: match[side].abbr,
    ...(match.state === 'live' && { liveMatch: { state: 'live', homeScore, awayScore, minute: match.minute, statusName: match.statusName, statusDetail: match.statusDetail } }),
  };
}

export async function loadPlayerGameLog(rc: CompetitionSeason, id: string, fetchJson: ScoreboardFetchJson,
  roster: { teamId: string; appearances: number | null } | null,
  summary: (rc: CompetitionSeason, event: string, home: string, away: string, signal: AbortSignal) => Promise<Pick<MatchSummaryData, 'lineups'>>,
  signal = AbortSignal.timeout(3_000),
) {
  const options = { signal, maxBytes: 4 * 1024 * 1024 };
  const slug = rc.competition.espnSlug;
  const { played, ambiguous } = indexedEvents(await fetchJson(athleteEventLogUrl(slug, providerYear(rc.season), id), options), rc, id);
  const teams = [...new Set(played.values())];
  if (teams.length > 4) return incomplete();
  const phase = editionPhase(rc.season);
  const year = providerYear(rc.season);
  // Split competitions share a provider year. Its unfiltered schedule includes
  // the Liguilla. The regular-stage ordinal alone omits those playoff matches.
  const yearScope = phase ? { ...rc, season: { ...rc.season, id: String(year), phase: undefined,
    startsAt: `${year}-01-01T00:00:00Z`, endsAt: `${year + 2}-01-01T00:00:00Z` } } : rc;
  const otherPhase = phase === 'apertura' ? 'clausura' : phase === 'clausura' ? 'apertura' : undefined;
  const accounted = new Set<string>();
  const schedules = await Promise.all(teams.map(async team => {
    const raw = await fetchJson(teamScheduleUrl(slug, team, false, yearScope.season), options);
    const schedule = mapScopedTeamSchedule(raw, yearScope, team);
    if (!schedule.available || !object(raw) || !Array.isArray(raw.events)) return incomplete();
    const events = new Map(raw.events.filter(object).map(event => [event.id, event]));
    if (events.size !== raw.events.length) return incomplete();
    return schedule.matches.filter(match => {
      if (played.get(match.id) !== team) return false;
      const event = events.get(match.id);
      if (!event || !object(event.season)) return incomplete();
      const season = { ...event.season, type: event.seasonType };
      const inPhase = !phase || !seasonIssue(season, rc.season);
      if ((!inPhase && (!otherPhase || seasonIssue(season, { ...rc.season, phase: otherPhase }))) ||
          match.state === 'scheduled' || (inPhase && !datedInEdition(match.kickoff, rc.season))) return incomplete();
      accounted.add(match.id);
      return inPhase;
    });
  }));
  const matches = schedules.flat().sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff) || b.id.localeCompare(a.id));
  if (accounted.size !== played.size) return incomplete();
  // ESPN also marks unused substitutes as played in the season index. Check
  // the small lineup entries before fetching a full summary. Stop at five
  // appearances and cap a cold search through a long run on the bench.
  const rows: GameLogRow[] = [];
  const regular = roster && teams.length === 1 && teams[0] === roster.teamId &&
    roster.appearances !== null && roster.appearances >= 5 && roster.appearances >= matches.length - 2;
  const recent = regular ? matches.splice(0, 5) : [];
  if (recent.some(match => ambiguous.has(match.id))) return incomplete();
  const recentRows = await Promise.all(recent.map(async match => gameLogRow(match, played.get(match.id)!, id,
    await summary(rc, match.id, match.home.id, match.away.id, signal))));
  rows.push(...recentRows.filter((row): row is GameLogRow => row !== null));
  const needed = 5 - rows.length;
  const selected: { match: Match; teamId: string; appearance: string }[] = [];
  const limit = Math.min(matches.length, 24);
  for (let i = 0; i < limit && selected.length < needed;) {
    const count = Math.min(4, needed - selected.length, limit - i);
    const batch = await Promise.all(matches.slice(i, i + count).map(async match => {
      if (ambiguous.has(match.id)) return incomplete();
      const teamId = played.get(match.id)!;
      const url = athleteLineupEntryUrl(slug, match.id, teamId, id);
      const entry = await fetchJson(url, { signal, maxBytes: 64 * 1024 });
      if (!object(entry) || reference(entry) !== new URL(url).pathname || typeof entry.starter !== 'boolean' ||
          !object(entry.subbedIn) || typeof entry.subbedIn.didSub !== 'boolean' ||
          !object(entry.subbedOut) || typeof entry.subbedOut.didSub !== 'boolean') return incomplete();
      if (!entry.starter && !entry.subbedIn.didSub && !entry.subbedOut.didSub) return null;
      const appearance = entry.starter ? 'Started' : entry.subbedIn.didSub ? 'Sub' : '';
      return { match, teamId, appearance };
    }));
    i += count;
    for (const item of batch) if (item) selected.push(item);
  }
  if (limit < matches.length && selected.length < needed) return incomplete();
  const rest = await Promise.all(selected.map(async ({ match, teamId, appearance }) =>
    gameLogRow(match, teamId, id, await summary(rc, match.id, match.home.id, match.away.id, signal), appearance)));
  return rows.concat(rest.filter((row): row is GameLogRow => row !== null));
}
