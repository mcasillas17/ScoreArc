import type { CSSProperties } from 'react';
import type { TeamProfile } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import TeamBadge from './TeamBadge';
import LanguageText from './LanguageText';

/**
 * How dark a club colour may be before the header falls back to the
 * competition accent.
 *
 * The page background is near-black, so a club whose primary is very dark
 * produces a header that is invisible rather than branded. América's own
 * `#ffff91` is fine; a club playing in black is not. Measured as perceived
 * luminance rather than raw RGB average, because #0000ff and #ffff00 have the
 * same average and nothing like the same readability.
 */
const MIN_LUMINANCE = 0.18;

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  // Rec. 601 luma, which is what "does this read on dark" actually depends on.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * A club colour usable as an accent, or null to keep the competition's.
 *
 * Returning null rather than a darkened variant is deliberate: a black-on-black
 * header is worse than a generic one, and silently lightening a club's colour
 * makes the page claim a brand the club does not have.
 */
export function usableAccent(color: string | null, altColor: string | null): string | null {
  for (const candidate of [color, altColor]) {
    if (!candidate) continue;
    const l = luminance(candidate);
    if (l !== null && l >= MIN_LUMINANCE) return candidate;
  }
  return null;
}

export default function TeamHeader(
  { profile, teamStyle }: { profile: TeamProfile; teamStyle: TeamStyle },
) {
  const accent = usableAccent(profile.color, profile.altColor);
  // Only override when the club's colour is readable; otherwise inherit the
  // competition accent already injected on the layout.
  const style = accent
    ? ({ ['--accent' as string]: accent, ['--accent-bright' as string]: accent } as CSSProperties)
    : undefined;

  return (
    <header className="tm-head" style={style}>
      <div className="tm-crest">
        <TeamBadge team={profile.team} size={64} style={teamStyle} />
      </div>
      <div className="tm-id">
        <h1 className="tm-name">{profile.team.name}</h1>
        {/* ESPN often sets location to the club name itself ("América"),
            and printing it under the name reads as a rendering bug. */}
        {profile.location && profile.location !== profile.team.name && (
          <p className="tm-loc">{profile.location}</p>
        )}
        <div className="tm-meta">
          {profile.record && (
            <span className="tm-record">
              <span className="tm-record-label">
                <LanguageText en="Record" es="Récord" />
              </span>
              <strong>{profile.record.summary}</strong>
              {profile.record.points !== null && (
                <span className="tm-pts">
                  {profile.record.points}{' '}
                  <LanguageText en="pts" es="pts" />
                </span>
              )}
            </span>
          )}
          {/* Provider-authored and English-only ("1st in Mexican Liga BBVA
              MX"). Left as sent rather than half-translated: our own backend
              builds this string from the standing row instead, so it becomes
              translatable when the frontend moves onto that API. */}
          {profile.standingSummary && (
            <span className="tm-standing">{profile.standingSummary}</span>
          )}
        </div>
      </div>
    </header>
  );
}
