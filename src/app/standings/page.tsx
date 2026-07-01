import { dataService } from "@/server/data/service";
import type { Group, TopScorer } from "@/server/data/types";
import StandingsLive from "@/components/StandingsLive";

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

        <StandingsLive initialGroups={groups} initialScorers={scorers} />
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
