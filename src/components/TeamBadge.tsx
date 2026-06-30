import type { Team } from "@/server/data/types";

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
}

export default function TeamBadge({
  team,
  size = 32,
  label = false,
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

  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
      }}
    >
      <span style={disc}>
        {team.crestUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={team.crestUrl}
            alt={team.name}
            width={size}
            height={size}
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ width: size, height: size, objectFit: "contain" }}
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
}
