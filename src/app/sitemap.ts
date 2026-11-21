import type { MetadataRoute } from 'next';
import { SUPPORTED_LOCALES } from '@/i18n/config';
import { listCompetitions, supportsResource, type EditionResource, type Season } from '@/server/data/competitions';

const BASE = 'https://www.scorearc.futbol';

// The section routes of an edition and the resource each page requires —
// the same resolveResource() gate the page itself applies, so nothing listed
// here answers 404.
const SECTIONS: [suffix: string, resource: EditionResource][] = [
  ['/standings', 'standings'],
  ['/matches', 'scores'],
  ['/teams', 'teams'],
  ['/players', 'players'],
  ['/news', 'news'],
];

// The edition root renders only a bracket (or the Liguilla projection); for
// everything else it redirects to a section, which is listed on its own.
function hasRootPage(season: Season): boolean {
  return (season.format.hasBracket && supportsResource(season, 'bracket')) ||
    (season.projection === 'liguilla' && supportsResource(season, 'standings'));
}

function entry(path: string): MetadataRoute.Sitemap[number] {
  return {
    url: `${BASE}/${SUPPORTED_LOCALES[0]}${path}`,
    alternates: { languages: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, `${BASE}/${l}${path}`])) },
  };
}

// ponytail: config-derived pages only. Team and player pages are reachable
// from these by links; listing them needs a data read per edition — add when
// search coverage of those pages is actually short.
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ['', '/competitions', '/teams', '/news'];
  for (const competition of listCompetitions()) {
    for (const season of Object.values(competition.seasons)) {
      const root = `/c/${competition.id}/${season.id}`;
      if (hasRootPage(season)) paths.push(root);
      for (const [suffix, resource] of SECTIONS) {
        if (supportsResource(season, resource)) paths.push(root + suffix);
      }
    }
  }
  return paths.map(entry);
}
