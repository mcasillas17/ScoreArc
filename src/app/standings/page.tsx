import { dataService } from "@/server/data/service";
import type { Group, TopScorer } from "@/server/data/types";
import GroupTable from "@/components/GroupTable";
import TopScorersTable from "@/components/TopScorersTable";
import ThirdPlaceTable from "@/components/ThirdPlaceTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ScoreArc · Standings",
  description:
    "FIFA World Cup 2026 standings — top scorers, best third-placed teams, and all 12 group tables.",
};

export default async function StandingsPage() {
  let groups: Group[] = [];
  let scorers: TopScorer[] = [];
  try {
    groups = await dataService.getGroups();
  } catch {
    // ESPN feed unavailable — render empty state
  }
  try {
    scorers = await dataService.getTopScorers();
  } catch {
    // ESPN stats unavailable — table renders its own empty state
  }

  return (
    <main className="main">
      <section id="standings">
        <header className="page-head">
          <p className="bracket-eyebrow">FIFA World Cup 2026</p>
          <h1 className="bracket-title">Standings</h1>
          <p className="page-subtitle">
            Top scorers, the third-place race, and full group tables.
          </p>
        </header>

        <div className="std-columns">
          <div className="std-block">
            <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
            <TopScorersTable scorers={scorers} />
          </div>

          <div className="std-block">
            <h2 className="std-block-title">Best Third-Placed Teams</h2>
            {groups.length > 0 ? (
              <ThirdPlaceTable groups={groups} />
            ) : (
              <p className="empty-text">Group data is unavailable right now.</p>
            )}
          </div>
        </div>

        <div className="std-block">
          <h2 className="std-block-title">Group Stage Results</h2>
          {groups.length > 0 ? (
            <div className="groups-grid">
              {groups.map((group) => (
                <GroupTable key={group.id} group={group} />
              ))}
            </div>
          ) : (
            <div className="empty-section">
              <p className="empty-text">Group data is unavailable right now.</p>
            </div>
          )}
        </div>
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
