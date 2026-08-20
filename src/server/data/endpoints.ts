const site = (slug: string) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}`;

export const scoreboardUrl = (slug: string, range?: string) =>
  `${site(slug)}/scoreboard${range ? `?dates=${range}` : ''}`;
export const standingsUrl = (slug: string) =>
  `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
export const summaryUrl = (slug: string, event: string) => `${site(slug)}/summary?event=${event}`;
export const bracketUrl = (slug: string, range?: string) =>
  `${site(slug)}/scoreboard${range ? `?dates=${range}` : ''}`;
export const statisticsUrl = (slug: string) => `${site(slug)}/statistics`;
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
export const teamRosterUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}/roster`;

// The club's fixtures. This is also where the next fixture comes from: the
// profile payload carries a nextEvent array and it is empty, so reading it
// would render "no upcoming fixture" for a club that has four.
export const teamScheduleUrl = (slug: string, teamId: string) =>
  `${site(slug)}/teams/${encodeURIComponent(teamId)}/schedule`;
