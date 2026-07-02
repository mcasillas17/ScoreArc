import { describe, it, expect } from 'vitest';
import { scoreboardUrl, standingsUrl, summaryUrl, bracketUrl, statisticsUrl, newsUrl } from './endpoints';

describe('endpoint builders', () => {
  it('build fifa.world URLs', () => {
    expect(scoreboardUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard');
    expect(standingsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings');
    expect(summaryUrl('fifa.world', '760490')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=760490');
    expect(bracketUrl('fifa.world', '20260628-20260719')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260719');
    expect(bracketUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard');
    expect(statisticsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/statistics');
    expect(newsUrl('fifa.world')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news');
  });

  it('build Leagues Cup URLs from a different slug', () => {
    expect(scoreboardUrl('concacaf.leagues.cup')).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/scoreboard');
  });
});
