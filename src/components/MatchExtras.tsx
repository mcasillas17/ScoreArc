import type { MatchInfo, MatchForm, FormResult, CommentaryItem, H2HMeeting } from '@/server/data/types';

function fmtYear(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

export function MatchInfoRow({ info }: { info: MatchInfo }) {
  const place = [info.venue, info.city].filter(Boolean).join(' · ');
  return (
    <div className="mi-row">
      {place && <span className="mi-item">📍 {place}</span>}
      {info.referee && <span className="mi-item">🗒️ {info.referee}</span>}
      {info.attendance != null && (
        <span className="mi-item">👥 {info.attendance.toLocaleString()}</span>
      )}
    </div>
  );
}

function FormPills({ form }: { form: FormResult[] }) {
  return (
    <span className="fm-pills">
      {form.map((f, i) => (
        <span
          key={i}
          className={`fm-pill fm-${f.result}`}
          title={`${f.result} vs ${f.opponent} ${f.score}`}
        >
          {f.result}
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
  if (!form.home.length && !form.away.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">Recent form</div>
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
  if (!meetings.length) return null;
  return (
    <div className="fm-block">
      <div className="fm-title">Head to head</div>
      <ul className="h2h-list">
        {meetings.map((m, i) => (
          <li key={i} className="h2h-item">
            <span>{m.label}</span>
            <span className="h2h-date">{fmtYear(m.date)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommentaryFeed({ items }: { items: CommentaryItem[] }) {
  if (!items.length) return null;
  // Latest first — most useful during a live match.
  const feed = [...items].reverse();
  return (
    <details className="cm-block">
      <summary className="cm-summary">
        Commentary <span className="cm-count">{items.length}</span>
      </summary>
      <ul className="cm-list">
        {feed.map((c, i) => (
          <li key={i} className="cm-item">
            {c.minute && <span className="cm-min">{c.minute}</span>}
            <span className="cm-text">{c.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
