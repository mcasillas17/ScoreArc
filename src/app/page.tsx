import { dataService } from "@/server/data/service";
import type { Match, BracketRound } from "@/server/data/types";
import LiveScores from "@/components/LiveScores";
import BracketInteractive from "@/components/BracketInteractive";

export const dynamic = "force-dynamic";

export default async function Home() {
  let matches: Match[] = [];
  let bracket: BracketRound[] = [];

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
    <main className="main">
      <section id="bracket" className="bracket-section">
        <header className="bracket-head">
          <p className="bracket-eyebrow">FIFA World Cup 2026</p>
          <h1 className="bracket-title">Knockout Bracket</h1>
        </header>
        {bracket.length > 0 ? (
          <BracketInteractive rounds={bracket} />
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

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
