import type { Season } from './competitions';

const site = (slug: string) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}`;

export const scoreboardUrl = (slug: string, range?: string) =>
  `${site(slug)}/scoreboard${range ? `?dates=${range}` : ''}`;
const seasonQuery = (year?: number) => year === undefined ? '' : '?season=' + year;
export const standingsUrl = (slug: string, year?: number) =>
  `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings${seasonQuery(year)}`;
export const summaryUrl = (slug: string, event: string) => `${site(slug)}/summary?event=${encodeURIComponent(event)}`;
export const statisticsUrl = (slug: string, year?: number) => `${site(slug)}/statistics${seasonQuery(year)}`;
export const newsUrl = (slug: string) => `${site(slug)}/news`;
// Every club in a league. Used to decide which of a cross-league cup's two
// tables a club belongs to, since the cup's own payload carries no league
// membership on the team object.
export const teamsUrl = (slug: string) => `${site(slug)}/teams`;

// A single club within one competition. Verified keyless and HTTP 200 on
// 2026-08-19 for mex.1/teams/227.
//
// Team ids reach these from a route parameter, so they are encoded rather than
// interpolated raw.
export const teamUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}`;

// The whole squad, with each player's season statistics inline -- one request
// for a complete squad stat table, not one per player. Note that not every
// athlete carries a statistics block: 7 of 35 on the recorded fixture have
// none at all, because they have not played.
export const teamRosterUrl = (slug: string, teamId: string, year?: number) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}/roster${seasonQuery(year)}`;

// The club's schedule -- results by default, upcoming matches with
// `fixture=true` (ESPN's parameter name, not ours). It is one or the other, never both: verified 2026-08-19,
// the bare call returned 4 events all finished while `?fixture=true` returned
// 13 all upcoming. A page wanting upcoming AND played has to ask twice, and
// the next match comes from the second call (the profile's nextEvent array
// is empty on this provider).
export const teamScheduleUrl = (slug: string, teamId: string, upcoming = false, season?: Pick<Season, 'id' | 'providerYear' | 'phase'> | string) => {
  const query = new URLSearchParams();
  if (upcoming) query.set('fixture', 'true');
  if (season) {
    const { id, providerYear, phase } = typeof season === 'string' ? { id: season } : season;
    query.set('season', String(providerYear ?? id.slice(0, 4)));
    // ESPN's public schedule selects the split by ordinal, not its internal
    // season-type id (14277). Verified against the recorded Apertura payload.
    if ((phase ?? id.split('-')[1]) === 'apertura') query.set('seasontype', '1');
    if ((phase ?? id.split('-')[1]) === 'clausura') query.set('seasontype', '2');
  }
  return `${site(slug)}/teams/${encodeURIComponent(teamId)}/schedule${query.size ? `?${query}` : ''}`;
};

// Athletes live on a DIFFERENT host and a different API version from everything
// else in this file -- site.web.api / common/v3, not site.api / site/v2.
// Verified keyless and HTTP 200 on 2026-08-22 for mex.1/athletes/297287.
//
// Three sibling paths are dead and must not be called: /gamelog returns 500,
// /splits and /stats return 404. The game log comes from /overview.
const webCommon = (slug: string) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/soccer/${slug}`;

export const athleteUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}`;

export const athleteOverviewUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}/overview`;

export const athleteBioUrl = (slug: string, athleteId: string) =>
  `${webCommon(slug)}/athletes/${encodeURIComponent(athleteId)}/bio`;
