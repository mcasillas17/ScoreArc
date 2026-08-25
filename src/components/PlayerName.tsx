import Link from 'next/link';

/**
 * A player's name, linked to their page when we hold both a competition-scoped
 * playerBase and a resolved slug -- the player counterpart to TeamLink /
 * teamHref (see MatchDetailPopup.tsx and teamHref.ts).
 *
 * Linked by slug, never by the provider's athlete number -- and only when the
 * roster index resolved one, so a player it hasn't indexed (a mid-window
 * loanee, a broken index) renders as plain text rather than a dead or wrong
 * link. Slug encoding mirrors teamHref's.
 */
export default function PlayerName({
  name,
  slug,
  playerBase,
  className,
  linkClassName,
}: {
  name: string;
  slug?: string | null;
  playerBase?: string;
  className?: string;
  /** Extra class(es) appended only when the name renders as a link. */
  linkClassName?: string;
}) {
  if (playerBase && slug) {
    const cls = linkClassName ? [className, linkClassName].filter(Boolean).join(' ') : className;
    return (
      <Link className={cls} href={`${playerBase}/${encodeURIComponent(slug)}`}>
        {name}
      </Link>
    );
  }
  return <span className={className}>{name}</span>;
}
