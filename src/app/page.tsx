import { dataService } from "@/server/data/service";
import type { Group, Match, BracketRound } from "@/server/data/types";
import LiveScores from "@/components/LiveScores";
import GroupTable from "@/components/GroupTable";
import RadialBracket from "@/components/RadialBracket";
import Sidebar from "@/components/Sidebar";

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
    <div className="app-shell">
      <Sidebar />

      <main className="main">
        <section id="bracket" className="bracket-section">
          <header className="bracket-head">
            <p className="bracket-eyebrow">FIFA World Cup 2026</p>
            <h1 className="bracket-title">Knockout Bracket</h1>
          </header>
          {bracket.length > 0 ? (
            <RadialBracket rounds={bracket} />
          ) : (
            <div className="empty-section">
              <p className="empty-text">Bracket data is unavailable right now.</p>
            </div>
          )}
        </section>

        <section id="live">
          <h2 className="section-label">Live Scores</h2>
          <LiveScores initialMatches={matches} />
        </section>

        {groups.length > 0 ? (
          <section id="standings">
            <h2 className="section-label">Group Stage</h2>
            <div className="groups-grid">
              {groups.map((group) => (
                <GroupTable key={group.id} group={group} />
              ))}
            </div>
          </section>
        ) : (
          <section id="standings" className="empty-section">
            <p className="empty-text">Group data is unavailable right now.</p>
          </section>
        )}

        <footer className="site-footer">
          <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
        </footer>
      </main>
    </div>
  );
}
