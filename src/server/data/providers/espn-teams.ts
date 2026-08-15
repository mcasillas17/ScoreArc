// ESPN's per-league club list: sports[0].leagues[0].teams[].team.id
//
// Used only to decide league membership for a cross-league cup. The cup's own
// payload gives no hint of which league a club belongs to — the team object
// carries id, name, abbreviation and colours, and nothing else.

export function splitLeagueTeamIds(raw: any): Set<string> {
  const teams = raw?.sports?.[0]?.leagues?.[0]?.teams;
  if (!Array.isArray(teams)) return new Set();
  const ids = teams
    .map((t: any) => t?.team?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  return new Set(ids);
}
