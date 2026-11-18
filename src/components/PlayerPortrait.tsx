'use client';
/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';

export default function PlayerPortrait({ name, src }: { name: string; src: string | null }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showPhoto = src !== null && src !== failedSource;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('');
  return (
    <div className="ph-portrait" aria-hidden={showPhoto ? undefined : true}>
      {showPhoto ? (
        <img className="ph-headshot" src={src} alt={name} onError={() => setFailedSource(src)} />
      ) : (
        <span className="ph-initials">{initials}</span>
      )}
    </div>
  );
}
