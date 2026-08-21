import type { Locale } from './config';
import { getMessages } from './getMessages';
import type { MessageKey, Messages } from './messages/en';

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
  return createTranslator(getMessages(locale));
}
