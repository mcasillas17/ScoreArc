'use client';

import { useState } from 'react';

/**
 * A competition's logo, falling back to its emblem.
 *
 * The emoji is not dead weight: it is what renders when the image fails, which
 * covers a reader offline, an ad blocker eating a third-party CDN, and ESPN
 * changing or blocking the path. Every competition therefore keeps an emblem
 * whether or not it has a logo.
 *
 * `size` is a HEIGHT, not a box. ESPN's league logos are not all square: MLS
 * and LaLiga are badges, but Liga MX and the Leagues Cup are wide wordmarks,
 * and forcing those into a square shrank them to an illegible smudge. Height is
 * fixed so rows stay aligned; width is free up to a cap.
 */
export default function CompetitionMark({
  logo,
  logoInvert = false,
  emblem,
  name,
  size = 24,
}: {
  logo?: string;
  logoInvert?: boolean;
  emblem: string;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (!logo || failed) {
    return (
      <span
        className="cm-mark cm-mark--emblem"
        style={{ height: size, minWidth: size, fontSize: Math.round(size * 0.82) }}
        role="img"
        aria-label={name}
      >
        {emblem}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="cm-mark"
      src={logo}
      alt={name}
      style={{ height: size, maxWidth: size * 2.8, filter: logoInvert ? 'invert(1)' : undefined }}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
