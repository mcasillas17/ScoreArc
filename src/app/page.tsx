import { dataService } from "@/server/data/service";
import type { Group, Match, BracketRound } from "@/server/data/types";
import LiveScores from "@/components/LiveScores";
import GroupTable from "@/components/GroupTable";
import RadialBracket from "@/components/RadialBracket";

export const dynamic = "force-dynamic";

export default async function Home() {
  let groups: Group[] = [];
  let matches: Match[] = [];
  let bracket: BracketRound[] = [];

  try {
    groups = await dataService.getGroups();
  } catch {
    // ESPN feed unavailable — render empty state
  }

  try {
    matches = await dataService.getMatches();
  } catch {
    // ESPN feed unavailable — SSE client will retry live
  }

  try {
    bracket = await dataService.getBracket();
  } catch {
    // ESPN bracket unavailable — render empty state
  }

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <div className="wordmark">
            <span className="wordmark-ball">⚽</span>
            <span className="wordmark-text">ScoreArc</span>
          </div>
          <p className="header-subtitle">FIFA World Cup 2026 · Live</p>
        </div>
      </header>

      <main className="main">
        <section className="bracket-section">
          <h2 className="section-label">Knockout Bracket</h2>
          {bracket.length > 0 ? (
            <RadialBracket rounds={bracket} />
          ) : (
            <div className="empty-section">
              <p className="empty-text">Bracket data is unavailable right now.</p>
            </div>
          )}
        </section>

        <section>
          <h2 className="section-label">Live Scores</h2>
          <LiveScores initialMatches={matches} />
        </section>

        {groups.length > 0 ? (
          <section>
            <h2 className="section-label">Group Stage</h2>
            <div className="groups-grid">
              {groups.map((group) => (
                <GroupTable key={group.id} group={group} />
              ))}
            </div>
          </section>
        ) : (
          <section className="empty-section">
            <p className="empty-text">Group data is unavailable right now.</p>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </>
  );
}
