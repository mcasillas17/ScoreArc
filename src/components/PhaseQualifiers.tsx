import type { Group } from '@/server/data/types';
import { computeQuarterfinals } from '@/server/data/leaguesCupTables';
import TeamBadge from './TeamBadge';

interface Props {
  groups: Group[];
  cut: number;
  teamStyle?: 'flag' | 'crest';
}

// The knockout ties for a cross-league cup, derived rather than fetched.
//
// The bracket is fixed and pre-seeded — MLS 1 v LMX 4, MLS 2 v LMX 3, and so
// on — so once both tables are final the pairings follow from results alone.
// That is why this renders while the provider still has no knockout fixture
// published: there is nothing left to find out.
export default function PhaseQualifiers({ groups, cut, teamStyle = 'crest' }: Props) {
  const ties = computeQuarterfinals(groups, cut);
  if (ties.length === 0) return null;

  return (
    <div className="lcq">
      <p className="lcq-note">
        Seeded pairings — the bracket is fixed, so no two clubs from the same league can
        meet before the semifinal.
      </p>
      <ol className="lcq-list">
        {ties.map((t) => (
          <li key={`${t.home.team.id}-${t.away.team.id}`} className="lcq-tie">
            <span className="lcq-side lcq-side-home">
              <span className="lcq-seed">{t.homeSeed}</span>
              <TeamBadge team={t.home.team} style={teamStyle} size={28} />
              <span className="lcq-name">{t.home.team.name}</span>
            </span>
            <span className="lcq-v">v</span>
            <span className="lcq-side lcq-side-away">
              <span className="lcq-name">{t.away.team.name}</span>
              <TeamBadge team={t.away.team} style={teamStyle} size={28} />
              <span className="lcq-seed">{t.awaySeed}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
