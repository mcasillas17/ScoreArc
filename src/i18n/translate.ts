import type { Locale } from './config';
import { en, type MessageKey, type Messages } from './messages/en';
import { es } from './messages/es';

const CATALOGS: Record<Locale, Messages> = { en, es };

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

export function getTranslator(locale: Locale): Translator {
  return createTranslator(CATALOGS[locale]);
}
