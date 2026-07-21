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
