/**
 * The ScoreArc mark: a ring, an arc sweeping over it, a hub at the centre —
 * one round of the radial bracket, its qualification arc, and the trophy.
 *
 * Inlined rather than loaded as an image so it inherits `currentColor`, which
 * is how the shipped `scorearc-mark-mono.svg` is authored. That lets the mark
 * take the brand colour in the header and a competition's own accent wherever
 * that is what should lead.
 */
export default function BrandMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="ScoreArc"
    >
      {/* The round the competition is at. */}
      <circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="5" opacity="0.28" />
      {/* The qualification arc — the part that is decided. */}
      <path d="M32 10A22 22 0 0 1 51 43" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      {/* The trophy at the centre. */}
      <circle cx="32" cy="32" r="5.5" fill="currentColor" />
    </svg>
  );
}
