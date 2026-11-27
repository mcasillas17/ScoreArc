'use client';

import { useState } from 'react';
import type { MatchVideo } from '@/server/data/types';
import { isSafeHttpsUrl } from '@/lib/providerUrls';
import { useTranslations } from '@/i18n/I18nProvider';
import { BallIcon } from './MatchIcons';

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function Clip({ video }: { video: MatchVideo }) {
  const t = useTranslations();
  const [playing, setPlaying] = useState(false);
  const dur = fmtDuration(video.duration);
  const safeMp4 = isSafeHttpsUrl(video.mp4Url) ? video.mp4Url : null;
  const safeThumbnail = isSafeHttpsUrl(video.thumbnail) ? video.thumbnail : null;

  return (
    <figure className="mh-clip">
      <div className="mh-frame">
        {playing && safeMp4 ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            className="mh-video"
            src={safeMp4}
            poster={safeThumbnail ?? undefined}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <button
            type="button"
            className="mh-thumb-btn"
            onClick={() => safeMp4 && setPlaying(true)}
            disabled={!safeMp4}
            aria-label={t('matchDetails.playHighlight', video.headline)}
          >
            {safeThumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="mh-thumb"
                src={safeThumbnail}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="mh-thumb mh-thumb-fallback" />
            )}
            <span className="mh-play" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            {video.isGoal && <span className="mh-goal"><BallIcon size={12} />{t('matchDetails.goal')}</span>}
            {dur && <span className="mh-dur">{dur}</span>}
          </button>
        )}
      </div>
      <figcaption className="mh-cap">{video.headline}</figcaption>
    </figure>
  );
}

export default function MatchHighlights({ videos }: { videos: MatchVideo[] }) {
  const t = useTranslations();
  if (!videos || videos.length === 0) return null;
  return (
    <div className="mh-block">
      <div className="mh-title">{t('matchDetails.highlights')}</div>
      <div className="mh-row">
        {videos.map((v) => (
          <Clip key={v.id} video={v} />
        ))}
      </div>
    </div>
  );
}
