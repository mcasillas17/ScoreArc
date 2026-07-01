'use client';

import { useState } from 'react';
import type { MatchVideo } from '@/server/data/types';

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function Clip({ video }: { video: MatchVideo }) {
  const [playing, setPlaying] = useState(false);
  const dur = fmtDuration(video.duration);

  return (
    <figure className="mh-clip">
      <div className="mh-frame">
        {playing && video.mp4Url ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            className="mh-video"
            src={video.mp4Url}
            poster={video.thumbnail ?? undefined}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <button
            type="button"
            className="mh-thumb-btn"
            onClick={() => setPlaying(true)}
            aria-label={`Play: ${video.headline}`}
          >
            {video.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="mh-thumb"
                src={video.thumbnail}
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
            {video.isGoal && <span className="mh-goal">⚽ Goal</span>}
            {dur && <span className="mh-dur">{dur}</span>}
          </button>
        )}
      </div>
      <figcaption className="mh-cap">{video.headline}</figcaption>
    </figure>
  );
}

export default function MatchHighlights({ videos }: { videos: MatchVideo[] }) {
  if (!videos || videos.length === 0) return null;
  return (
    <div className="mh-block">
      <div className="mh-title">Highlights</div>
      <div className="mh-row">
        {videos.map((v) => (
          <Clip key={v.id} video={v} />
        ))}
      </div>
    </div>
  );
}
