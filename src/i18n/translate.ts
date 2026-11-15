import type { Locale } from './config';
import { en, type MessageKey, type Messages } from './messages/en';
import { es, esWomen } from './messages/es';
import { getCompetition } from '@/server/data/competitions';

const CATALOGS: Record<Locale, Messages> = { en, es };
// The same catalogs as a women's competition reads them. Built once.
const WOMEN: Record<Locale, Messages> = { en, es: { ...es, ...esWomen } };

type MessageArguments<Key extends MessageKey> =
  Messages[Key] extends (...args: infer Args) => string ? Args : [];

export type Translator = <Key extends MessageKey>(
  key: Key,
  ...args: MessageArguments<Key>
) => string;

export function createTranslator(messages: Messages): Translator {
  return ((key: MessageKey, ...args: unknown[]) => {
    const message = messages[key];
    return typeof message === 'function' ? Reflect.apply(message, undefined, args) : message;
  }) as Translator;
}

/**
 * `competitionId` is the competition the copy is about, when there is one. A
 * women's competition reads its locale's feminine forms; anything else, and
 * every page that is about no single competition, reads the base catalog.
 */
export function getTranslator(locale: Locale, competitionId?: string): Translator {
  const women = competitionId !== undefined && getCompetition(competitionId)?.category === 'women';
  return createTranslator((women ? WOMEN : CATALOGS)[locale]);
}
