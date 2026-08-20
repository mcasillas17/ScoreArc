import type { Team } from "@/server/data/types";
import type { TeamStyle } from "@/server/data/competitions";
import Link from "next/link";
import { flagUrl } from "@/lib/flags";

function teamFallbackColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 30%)`;
}

interface TeamBadgeProps {
  team: Team;
  size?: number;
  label?: boolean;
  style?: TeamStyle;
  /**
   * Where this crest leads, if anywhere.
   *
   * Optional so a badge is inert unless a caller deliberately makes it a
   * link. Anything without a real team id -- a bracket placeholder for an
   * undecided slot -- then stays unlinked by default, instead of pointing at
   * /team/undefined, which is a 404 with a crest on it.
   */
  href?: string;
}

export default function TeamBadge({
  team,
  size = 32,
  label = false,
  style = 'flag',
  href,
}: TeamBadgeProps) {
  const disc: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    overflow: "hidden",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: teamFallbackColor(team.id),
    fontSize: Math.round(size * 0.3),
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
  };

  // For national style, prefer a full-bleed flagcdn flag; for club style,
  // prefer the ESPN crest and fall back to flag if no crest is available.
  const imgSrc = style === 'crest'
    ? (team.crestUrl ?? flagUrl(team.abbr))
    : (flagUrl(team.abbr) ?? team.crestUrl);

  const badge = (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
      }}
    >
      <span style={disc}>
        {imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imgSrc}
            alt={team.name}
            width={size}
            height={size}
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ width: size, height: size, objectFit: "cover" }}
          />
        ) : (
          team.abbr
        )}
      </span>
      {label && (
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {team.abbr}
        </span>
      )}
    </span>
  );

  if (!href) return badge;
  return (
    <Link href={href} className="tb-link" aria-label={team.name}>
      {badge}
    </Link>
  );
}
