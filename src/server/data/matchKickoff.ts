// ESPN uses ISO timestamps at minute precision; the reader uses RFC3339
// seconds. Require an explicit timezone and reject Date.parse's rollover of
// impossible dates (for example February 30) and its non-ISO guesses ("0").
const KICKOFF = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function isMatchKickoff(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = KICKOFF.exec(value);
  if (!parts || parts[0] !== value || !Number.isFinite(Date.parse(value))) return false;
  return new Date(`${parts[1]}T00:00:00Z`).toISOString().slice(0, 10) === parts[1];
}
