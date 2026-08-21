/**
 * What the home digest's "What's on" block is showing, and how it says so.
 *
 * A scores site with nothing on it reads as broken, so an empty state is never
 * the answer: with nothing live and no kickoff in the window, the block leads
 * with recent results and the heading says that is what they are.
 */
export type WhatsOnMode = 'live' | 'upcoming' | 'recent';

export interface Bilingual {
  en: string;
  es: string;
}

/**
 * How far off the next kickoff is, in plain words.
 *
 * A duration is the difference between two instants, so it is the one time
 * fact that is safe to format on the server: unlike "Thursday 8pm", it means
 * the same thing in every timezone. Deliberately approximate — "in about 4
 * hours" cannot be wrong by the time the page is read the way "in 3h 58m" can.
 */
export function untilKickoff(ms: number): Bilingual | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return {
      en: minutes <= 1 ? 'in a minute' : `in ${minutes} minutes`,
      es: minutes <= 1 ? 'en un minuto' : `en ${minutes} minutos`,
    };
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return {
      en: hours === 1 ? 'in about an hour' : `in about ${hours} hours`,
      es: hours === 1 ? 'en aproximadamente una hora' : `en aproximadamente ${hours} horas`,
    };
  }
  const days = Math.round(hours / 24);
  return {
    en: days === 1 ? 'in about a day' : `in about ${days} days`,
    es: days === 1 ? 'en aproximadamente un día' : `en aproximadamente ${days} días`,
  };
}

/**
 * The line under the digest's title. It states which of the three things the
 * block is showing, so "recent results" is never mistaken for "what's next".
 */
export function whatsOnHeadline(
  mode: WhatsOnMode,
  count: number,
  msToNextKickoff: number | null,
): Bilingual {
  if (mode === 'live') {
    return {
      en: count === 1 ? '1 match live right now.' : `${count} matches live right now.`,
      es: count === 1 ? '1 partido en vivo ahora mismo.' : `${count} partidos en vivo ahora mismo.`,
    };
  }
  if (mode === 'upcoming') {
    const away = msToNextKickoff === null ? null : untilKickoff(msToNextKickoff);
    if (!away) {
      return {
        en: 'Nothing live right now — here is what is next.',
        es: 'Nada en vivo ahora mismo — esto es lo que sigue.',
      };
    }
    return {
      en: `Nothing live right now — next kickoff ${away.en}.`,
      es: `Nada en vivo ahora mismo — próximo silbatazo ${away.es}.`,
    };
  }
  return {
    en: 'Nothing live right now — here are the latest results.',
    es: 'Nada en vivo ahora mismo — estos son los últimos resultados.',
  };
}
