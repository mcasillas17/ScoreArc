import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { BracketRound, Group } from '@/server/data/types';
import UpcomingBanner from '@/components/UpcomingBanner';
import { getBannerFeed } from '@/server/data/banner';
import BracketInteractive from '@/components/BracketInteractive';
import StandingsLive from '@/components/StandingsLive';
import PhaseQualifiers from '@/components/PhaseQualifiers';
import SeasonSwitcher from '@/components/SeasonSwitcher';
import { bracketShapeFor, knockoutIsReady } from '@/components/bracketShape';
import SiteFooter from '@/components/SiteFooter';
import { getTranslator } from '@/i18n/translate';
import { ogUrl, safeCrest, shareMetadata } from '@/lib/ogUrl';
import { projectLiguilla } from '@/server/data/liguillaProjection';

export const dynamic = 'force-dynamic';

type SeasonParams =
  | { locale: string; comp: string; season: string }
  | Promise<{ locale: string; comp: string; season: string }>;
type PageSearchParams =
  | { c?: string | string[]; name?: string | string[]; crest?: string | string[] }
  | Promise<{ c?: string | string[]; name?: string | string[]; crest?: string | string[] }>;

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params, searchParams }: { params: SeasonParams; searchParams: PageSearchParams }): Promise<Metadata> {
  const { locale, comp, season } = await params;
  const query = await searchParams;
  if (!isLocale(locale)) notFound();
  const rc = resolveSeason(comp, season);
  if (!rc) return {};
  const t = getTranslator(locale);
  const label = `${rc.competition.shortName} ${rc.season.label}`;
  const champ = firstSearchParam(query.c);
  const name = firstSearchParam(query.name) ?? champ;
  // Echoed into canonical/hreflang, so it is validated, not trusted: an
  // attacker-crafted ?crest= must not land in our own canonical tag.
  const crest = safeCrest(firstSearchParam(query.crest));
  const predictionQuery = champ
    ? `?c=${encodeURIComponent(champ)}&name=${encodeURIComponent(name ?? champ)}${
        crest ? `&crest=${encodeURIComponent(crest)}` : ''
      }`
    : '';
  const localizedPath = (pathLocale: 'en' | 'es') =>
    `/${pathLocale}/c/${rc.competition.id}/${rc.season.id}${predictionQuery}`;
  const alternates = {
    canonical: localizedPath(locale),
    languages: { en: localizedPath('en'), es: localizedPath('es') },
  };
  if (!champ) {
    const og = ogUrl({ compId: rc.competition.id, comp: label, locale });
    const title = t('meta.competition.title', rc.competition.name);
    // Same description the layout builds: this return replaces the layout's
    // openGraph WHOLESALE, so anything left out here (siteName, type,
    // description) silently vanishes from the most-shared URL on the site.
    const description = t('meta.competition.description', rc.competition.shortName, rc.season.label);
    return { title, alternates, ...shareMetadata(title, description, og) };
  }
  const championName = name ?? champ;
  const og = ogUrl({ champ, name: championName, crest, compId: rc.competition.id, comp: label, locale });
  const title = t('meta.predictedChampion.title', rc.competition.shortName, championName);
  const description = t(
    'meta.predictedChampion.description',
    rc.competition.shortName,
    championName,
  );
  return {
    title,
    description,
    alternates,
    ...shareMetadata(title, description, og),
  };
}

export default async function Workspace({ params }: { params: SeasonParams }) {
  const { locale, comp, season } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const rc = resolveSeason(comp, season);
  if (!rc) notFound();
  // A league's headline view IS its table, and the table lives at /standings
  // for every competition — so a season root with nothing of its own
  // redirects rather than render a second copy of the table. A projected
  // Liguilla IS something of its own; that branch returns below, after the
  // shared banner setup.
  if (!rc.season.format.hasBracket && rc.season.projection !== 'liguilla') {
    redirect(`/${locale}/c/${rc.competition.id}/${rc.season.id}/standings`);
  }

  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  // Crests in the tables below link here. Competition-scoped because a club's
  // record and squad only mean something inside one competition.
  const teamBase = `/${locale}/c/${rc.competition.id}/${rc.season.id}/team`;
  const { teamStyle } = rc.competition;
  // A finished (non-current) edition is view-only.
  const readOnly = rc.season.id !== rc.competition.currentSeasonId;

  // The fixture band leads every competition page.
  const feed = await getBannerFeed(rc);
  // Null rather than an empty section: a competition that really has no
  // fixtures left (a finished edition) should show no band at all, not a
  // heading over nothing. Kept as a nullable value, not an always-truthy
  // element, because the phase branch below falls back on it being null.
  const liveSection = feed.matches.length > 0 ? <UpcomingBanner feed={feed} rc={rc} /> : null;
  const footer = <SiteFooter />;

  // The projected Liguilla: real seeds in the quarters from the live table,
  // placeholders inward. Renders through the same RadialBracket as a real
  // knockout; only the data is synthetic, and the note says so. When the real
  // draw is published, hasBracket flips true in config and this branch's own
  // !hasBracket retires it.
  if (!rc.season.format.hasBracket && rc.season.projection === 'liguilla') {
    let groups: Group[] = [];
    try { groups = await dataStore.getStandings(rc); } catch {}
    const projected = projectLiguilla(groups);
    return (
      <main className="main">
        <section id="bracket" className="bracket-section">
          <header className="bracket-head">
            <p className="bracket-eyebrow">{rc.competition.shortName} · {rc.season.label}</p>
            <h1 className="bracket-title">{t('bracket.projectionTitle')}</h1>
          </header>
          {projected ? (
            <>
              <p className="bracket-projection-note">{t('bracket.projectionNote')}</p>
              <div className="edition-fade">
                {/* The interactive shell, not bare RadialBracket: it owns the
                    "build your bracket" predict mode, which is real here — the
                    quarters are fully seeded. poll={false} because there is no
                    bracket feed behind a projection to poll. */}
                <BracketInteractive
                  rounds={projected}
                  apiBase={apiBase}
                  teamStyle={teamStyle}
                  compId={rc.competition.id}
                  seasonId={rc.season.id}
                  compShortName={rc.competition.shortName}
                  seasonLabel={rc.season.label}
                  shape={bracketShapeFor(rc.season)}
                  emblem={rc.competition.emblem}
                  logo={rc.competition.logo}
                  logoInvert={rc.competition.logoInvert}
                  championTitleKey={rc.competition.championTitleKey}
                  accent={rc.competition.bracketAccent}
                  predictionEnabled
                  poll={false}
                />
              </div>
            </>
          ) : (
            <div className="empty-section"><p className="empty-text">{t('bracket.unavailable')}</p></div>
          )}
        </section>
        {!readOnly && liveSection}
        {footer}
      </main>
    );
  }

  let bracket: BracketRound[] = [];
  try { bracket = await dataStore.getBracket(rc); } catch {}

  // A cross-league cup whose table the provider never publishes (Leagues Cup).
  // Its phase-one tables ARE the competition until the knockout starts, and
  // they also determine the knockout, so they lead the page rather than
  // sitting under an empty bracket.
  const computed = rc.season.computedTables;
  let phaseGroups: Group[] = [];
  if (computed) {
    try { phaseGroups = await dataStore.getStandings(rc); } catch {}
  }
  // Not `bracket.length === 0`: one published fixture is not a knockout. That
  // test handed the page over on the Leagues Cup's second quarterfinal of four,
  // replacing a complete set of phase tables with a bracket holding half a
  // round and two empty rings.
  if (computed && phaseGroups.length > 0 && !knockoutIsReady(bracket, bracketShapeFor(rc.season))) {
    // Real fixtures win. The derived ties existed because the provider had
    // published none — now that it has, they carry the actual kickoff times
    // and the actual venue, which the seeded pairing cannot know: seeding
    // fixes who plays whom, not who hosts. Fall back to the derived ties only
    // while nothing is published.
    const banner = liveSection ?? (
      <section id="live">
        <h2 className="section-label">{t('upcoming.nextUp')}</h2>
        <div className="lcq-banner">
          <PhaseQualifiers
            groups={phaseGroups}
            cut={computed.cut}
            teamStyle={teamStyle}
            round={computed.nextRound}
          />
        </div>
      </section>
    );
    return (
      <main className="main">
        {!readOnly && banner}
        <section id="phase" className="std-wide">
          <header className="bracket-head">
            <p className="bracket-eyebrow">{rc.competition.name} · {rc.season.label}</p>
            <h1 className="bracket-title">{t('standings.qualifiedFor', t(computed.labelKey))}</h1>
          </header>
          <StandingsLive
            teamBase={teamBase}
            initialGroups={phaseGroups}
            initialScorers={[]}
            initialAssists={[]}
            apiBase={apiBase}
            teamStyle={teamStyle}
            showThirdPlace={false}
            qualification={{ cut: computed.cut, labelKey: computed.labelKey }}
          />
        </section>
        {footer}
      </main>
    );
  }

  return (
    <main className="main">
      <section id="bracket" className="bracket-section">
        <header className="bracket-head">
          <p className="bracket-eyebrow">{rc.competition.shortName}</p>
          <h1 className="bracket-title">{t('bracket.knockout')}</h1>
          <SeasonSwitcher competition={rc.competition} activeSeasonId={rc.season.id} />
        </header>
        {bracket.length > 0
          ? <div key={rc.season.id} className="edition-fade"><BracketInteractive rounds={bracket} apiBase={apiBase} teamStyle={teamStyle} compId={rc.competition.id} seasonId={rc.season.id} compShortName={rc.competition.shortName} seasonLabel={rc.season.label} emblem={rc.competition.emblem} logo={rc.competition.logo} logoInvert={rc.competition.logoInvert} trophyImage={rc.competition.trophyImage} championTitleKey={rc.competition.championTitleKey} accent={rc.competition.bracketAccent} shape={bracketShapeFor(rc.season)} readOnly={readOnly} /></div>
          : <div className="empty-section"><p className="empty-text">{t('bracket.unavailable')}</p></div>}
      </section>
      {!readOnly && liveSection}
      {footer}
    </main>
  );
}
