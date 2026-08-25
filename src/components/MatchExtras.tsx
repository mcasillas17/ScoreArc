import type { MatchInfo, MatchForm, FormResult, CommentaryItem, H2HMeeting, MatchLineups, TeamLineup, LineupPlayer } from '@/server/data/types';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDate, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/config';
import type { Translator } from '@/i18n/translate';
import { CollapsibleSection } from './Collapsible';
import PlayerName from './PlayerName';

function fmtYear(iso: string, locale: Locale, t: Translator): string {
  return formatDate(iso, locale, { year: 'numeric', month: 'short' }) ?? t('common.unavailable');
}

export function MatchInfoRow({ info }: { info: MatchInfo }) {
  const locale = useLocale();
  const place = [info.venue, info.city].filter(Boolean).join(' · ');
  return (
    <div className="mi-row">
      {place && <span className="mi-item">📍 {place}</span>}
      {info.referee && (
        <span className="mi-item mi-ref">
          <svg
            className="mi-ref-icon"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="9" cy="14" r="5.2" />
            <path d="M13.8 11.5 21 9.8v3.4l-7.2-1.5" />
            <path d="M9 8.8V6.2h2.4" />
          </svg>
          {info.referee}
        </span>
      )}
      {info.attendance != null && (
        <span className="mi-item">👥 {formatNumber(info.attendance, locale)}</span>
      )}
    </div>
  );
}

function FormPills({ form }: { form: FormResult[] }) {
  const t = useTranslations();
  const labelFor = (result: FormResult['result']) => {
    switch (result) {
      case 'W': return { short: t('matchDetails.formWinShort'), full: t('matchDetails.formWin') };
      case 'D': return { short: t('matchDetails.formDrawShort'), full: t('matchDetails.formDraw') };
      case 'L': return { short: t('matchDetails.formLossShort'), full: t('matchDetails.formLoss') };
    }
  };
  return (
    <span className="fm-pills">
      {form.map((f, i) => (
        <span
          key={i}
          className={`fm-pill fm-${f.result}`}
          title={`${labelFor(f.result).full} ${t('match.versus')} ${f.opponent} ${f.score}`}
          aria-label={`${labelFor(f.result).full} ${t('match.versus')} ${f.opponent} ${f.score}`}
        >
          {labelFor(f.result).short}
        </span>
      ))}
    </span>
  );
}

export function FormRow({
  form,
  homeAbbr,
  awayAbbr,
}: {
  form: MatchForm;
  homeAbbr: string;
  awayAbbr: string;
}) {
  const t = useTranslations();
  if (!form.home.length && !form.away.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">{t('matchDetails.recentForm')}</div>
      <div className="fm-team">
        <span className="fm-abbr">{homeAbbr}</span>
        <FormPills form={form.home} />
      </div>
      <div className="fm-team">
        <span className="fm-abbr">{awayAbbr}</span>
        <FormPills form={form.away} />
      </div>
    </div>
  );
}

export function H2HRow({ meetings }: { meetings: H2HMeeting[] }) {
  const locale = useLocale();
  const t = useTranslations();
  if (!meetings.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">{t('matchDetails.headToHead')}</div>
      <ul className="h2h-list">
        {meetings.map((m, i) => (
          <li key={i} className="h2h-item">
            <span>{m.label}</span>
            <span className="h2h-date">{fmtYear(m.date, locale, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommentaryFeed({ items }: { items: CommentaryItem[] }) {
  const t = useTranslations();
  if (!items.length) return null;
  // Latest first — most useful during a live match.
  const feed = [...items].reverse();
  return (
    <CollapsibleSection title={t('matchDetails.commentary', items.length)} tone="#a78bfa">
      <ul className="cm-list">
        {feed.map((c, i) => (
          <li key={i} className="cm-item">
            {c.minute && <span className="cm-min">{c.minute}</span>}
            <span className="cm-text">{c.text}</span>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}

// A stat ESPN did not send for this player renders as a dash, never a zero:
// an outfielder has no `saves` entry, and printing 0 there would claim they
// faced shots and stopped none.
function StatCell({ value }: { value: number | null }) {
  if (value == null) return <td className="ls-box-na">–</td>;
  return <td>{value}</td>;
}

function CardChips({ player }: { player: LineupPlayer }) {
  const t = useTranslations();
  const yellow = player.stats?.yellowCards ?? 0;
  const red = player.stats?.redCards ?? 0;
  if (!yellow && !red) return <td />;
  return (
    <td>
      {yellow > 0 && <span className="ls-card-chip ls-card-yellow" role="img" aria-label={t('matchDetails.yellowCardsCount', yellow)} />}
      {red > 0 && <span className="ls-card-chip ls-card-red" role="img" aria-label={t('matchDetails.redCardsCount', red)} />}
    </td>
  );
}

// Starters first, then the bench, each by shirt number. Unnumbered players go
// last rather than sorting as zero and jumping the goalkeeper.
function boxOrder(a: LineupPlayer, b: LineupPlayer): number {
  if (a.starter !== b.starter) return a.starter ? -1 : 1;
  return (a.number ?? 999) - (b.number ?? 999);
}

function BoxScoreTable({ team, abbr, playerBase }: { team: TeamLineup; abbr: string; playerBase?: string }) {
  const t = useTranslations();
  const players = team.players.filter((p) => p.stats != null).sort(boxOrder);
  if (players.length === 0) return null;
  // Only goalkeepers carry `saves`. Rendering the column for a team whose
  // payload has none would be a column of dashes.
  const showSaves = players.some((p) => p.stats!.saves != null);
  return (
    <div className="ls-box">
      <div className="ls-box-team">{abbr}</div>
      {/* Twelve columns do not fit a phone. Scroll the table, not the popup. */}
      <div className="ls-box-scroll">
      <table className="standings-table std-wide">
        <thead>
          <tr>
            <th>#</th>
            <th className="team-col">{t('matchDetails.player')}</th>
            <th title={t('matchDetails.position')}>{t('matchDetails.positionAbbreviation')}</th>
            <th title={t('matchDetails.goals')}>{t('matchDetails.goalsAbbreviation')}</th>
            <th title={t('matchDetails.assists')}>{t('matchDetails.assistsAbbreviation')}</th>
            <th title={t('matchDetails.shots')}>{t('matchDetails.shotsAbbreviation')}</th>
            <th title={t('matchDetails.shotsOnTarget')}>{t('matchDetails.shotsOnTargetAbbreviation')}</th>
            <th title={t('matchDetails.offsides')}>{t('matchDetails.offsidesAbbreviation')}</th>
            <th title={t('matchDetails.foulsCommitted')}>{t('matchDetails.foulsCommittedAbbreviation')}</th>
            <th title={t('matchDetails.foulsSuffered')}>{t('matchDetails.foulsSufferedAbbreviation')}</th>
            {showSaves && <th title={t('matchDetails.saves')}>{t('matchDetails.savesAbbreviation')}</th>}
            <th title={t('matchDetails.cards')} />
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => (
            <tr key={`${p.name}-${i}`}>
              <td className="rank-cell">{p.number ?? '–'}</td>
              <td className="team-cell">
                <PlayerName name={p.name} slug={p.playerSlug} playerBase={playerBase} className="team-name" />
                {!p.starter && <span className="ls-box-sub">{t('matchDetails.substitute')}</span>}
              </td>
              <td className="std-muted">{p.position}</td>
              <StatCell value={p.stats!.totalGoals} />
              <StatCell value={p.stats!.goalAssists} />
              <StatCell value={p.stats!.totalShots} />
              <StatCell value={p.stats!.shotsOnTarget} />
              <StatCell value={p.stats!.offsides} />
              <StatCell value={p.stats!.foulsCommitted} />
              <StatCell value={p.stats!.foulsSuffered} />
              {showSaves && <StatCell value={p.stats!.saves} />}
              <CardChips player={p} />
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/**
 * Per-player match statistics for both squads.
 *
 * `goalsConceded` and `shotsFaced` are deliberately not columns: ESPN repeats
 * the team's conceded count on every outfielder, so a per-player column would
 * read as eleven players each conceding the same goal.
 */
export function BoxScoreBlock({
  lineups,
  homeAbbr,
  awayAbbr,
  playerBase,
}: {
  lineups: MatchLineups;
  homeAbbr: string;
  awayAbbr: string;
  playerBase?: string;
}) {
  const t = useTranslations();
  // Checked on the data, not on the elements: a component returning null is
  // still a truthy JSX value, so testing the elements would always pass and
  // render an empty collapsible for matches with no player stats.
  const hasStats = [lineups.home, lineups.away].some((t) => t.players.some((p) => p.stats != null));
  if (!hasStats) return null;
  return (
    <CollapsibleSection title={t('matchDetails.boxScore')} tone="#38bdf8">
      <BoxScoreTable team={lineups.home} abbr={homeAbbr} playerBase={playerBase} />
      <BoxScoreTable team={lineups.away} abbr={awayAbbr} playerBase={playerBase} />
    </CollapsibleSection>
  );
}
