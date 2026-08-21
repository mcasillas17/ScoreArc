import type { Locale } from './config';
import { en, type Messages } from './messages/en';
import { es } from './messages/es';

const CATALOGS: Record<Locale, Messages> = { en, es };

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale];
}
