import type { Translator } from '@/i18n/translate';
import type { Group } from '@/server/data/types';

const SIMPLE_GROUP_ID = /^(?:[A-Za-z]|\d+)$/;

export function translatedGroupName(group: Group, t: Translator): string {
  if (group.labelKey !== undefined) return t(group.labelKey);
  if (SIMPLE_GROUP_ID.test(group.id)) return t('group.name', group.id.toUpperCase());
  return group.name;
}
