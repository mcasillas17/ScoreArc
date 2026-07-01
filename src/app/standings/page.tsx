import { dataService } from "@/server/data/service";
import type { Group } from "@/server/data/types";
import GroupTable from "@/components/GroupTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ScoreArc · Group Stage Standings",
  description:
    "FIFA World Cup 2026 group stage results and standings for all 12 groups.",
};

export default async function StandingsPage() {
  let groups: Group[] = [];
  try {
    groups = await dataService.getGroups();
  } catch {
    // ESPN feed unavailable — render empty state
  }

  return (
    <main className="main">
      <section id="standings">
        <header className="page-head">
          <p className="bracket-eyebrow">FIFA World Cup 2026</p>
          <h1 className="bracket-title">Group Stage Results</h1>
          <p className="page-subtitle">Final standings across all 12 groups.</p>
        </header>

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
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
