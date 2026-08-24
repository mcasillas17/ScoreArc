'use client';

import type { CompetitionSeason } from '@/server/data/competitions';
import type { BannerFeed } from '@/server/data/banner';
import MatchWheel from './MatchWheel';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';

// The fixture band that leads a competition's landing page — the bracket for a
// cup, the standings for a league. Callers decide whether to render it at all
// (see getBannerFeed), because one of them falls back to a different band
// entirely when there are no published fixtures.
export default function UpcomingBanner({ feed, rc }: { feed: BannerFeed; rc: CompetitionSeason }) {
  const locale = useLocale();
  const t = useTranslations();
  return (
    <section id="live">
      <h2 className="section-label">
        {feed.weekOnly ? t('upcoming.thisWeek') : t('upcoming.nextUp')}
      </h2>
      <MatchWheel
        teamBase={`/${locale}/c/${rc.competition.id}/${rc.season.id}/team`}
        initialMatches={feed.matches}
        apiBase={`/api/${rc.competition.id}/${rc.season.id}`}
        teamStyle={rc.competition.teamStyle}
        weekOnly={feed.weekOnly}
      />
    </section>
  );
}
