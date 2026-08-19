import type { CompetitionSeason } from '@/server/data/competitions';
import type { BannerFeed } from '@/server/data/banner';
import UpcomingTicker from './UpcomingTicker';

// The fixture band that leads a competition's landing page — the bracket for a
// cup, the standings for a league. Callers decide whether to render it at all
// (see getBannerFeed), because one of them falls back to a different band
// entirely when there are no published fixtures.
export default function UpcomingBanner({ feed, rc }: { feed: BannerFeed; rc: CompetitionSeason }) {
  return (
    <section id="live">
      <h2 className="section-label">{feed.weekOnly ? 'Upcoming This Week' : 'Next Up'}</h2>
      <UpcomingTicker
        initialMatches={feed.matches}
        apiBase={`/api/${rc.competition.id}/${rc.season.id}`}
        teamStyle={rc.competition.teamStyle}
        weekOnly={feed.weekOnly}
      />
    </section>
  );
}
