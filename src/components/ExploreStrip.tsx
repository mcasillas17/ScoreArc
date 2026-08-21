import Link from 'next/link';
import LanguageText from './LanguageText';

/**
 * The ways into the site that are not a scoreline.
 *
 * Only Teams is a link, because only Teams exists. Players and simulation are
 * shown as what they are -- not yet built -- rather than linked to a 404 or
 * hidden entirely: the point of this strip is to say what the site is becoming,
 * and a card that says "coming next" does that honestly.
 */
export default function ExploreStrip({ teamCount }: { teamCount: number }) {
  return (
    <section className="ex">
      <h2 className="section-label">
        <LanguageText en="Explore" es="Explorar" />
      </h2>
      <div className="ex-grid">
        <Link href="/teams" className="ex-card">
          <b className="ex-title">
            <LanguageText en="Teams" es="Equipos" />
          </b>
          <span className="ex-desc">
            <LanguageText
              en="Every club across every competition, with squads and season stats."
              es="Todos los clubes de todas las competiciones, con plantel y estadísticas."
            />
          </span>
          <span className="ex-go">
            <LanguageText en={`${teamCount} clubs →`} es={`${teamCount} clubes →`} />
          </span>
        </Link>

        <div className="ex-card ex-card--soon" aria-disabled>
          <b className="ex-title">
            <LanguageText en="Players" es="Jugadores" />
          </b>
          <span className="ex-desc">
            <LanguageText
              en="Scorers, assists and season lines for every squad."
              es="Goleadores, asistencias y estadísticas de cada plantel."
            />
          </span>
          <span className="ex-soon">
            <LanguageText en="Coming next" es="Próximamente" />
          </span>
        </div>

        <div className="ex-card ex-card--soon" aria-disabled>
          <b className="ex-title">
            <LanguageText en="Simulate" es="Simular" />
          </b>
          <span className="ex-desc">
            <LanguageText
              en="Play a competition forward from where it stands today."
              es="Simula una competición desde su estado actual."
            />
          </span>
          <span className="ex-soon">
            <LanguageText en="Planned" es="Planeado" />
          </span>
        </div>
      </div>
    </section>
  );
}
