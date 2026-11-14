import { expect, it } from 'vitest';
import { splitTotals } from './PlayerHeader';

const t = (name: string, display: string) => ({ name, label: name, display, value: Number.isNaN(Number(display)) ? null : Number(display) });

it('leads with goals once scored, then assists, else the first figure', () => {
  const apps = t('starts-subIns', '3 (7)');
  expect(splitTotals([apps, t('totalGoals', '4'), t('goalAssists', '9')]).lead?.name).toBe('totalGoals');
  expect(splitTotals([apps, t('totalGoals', '0'), t('goalAssists', '2')]).lead?.name).toBe('goalAssists');
  const gk = splitTotals([apps, t('cleanSheet', '5'), t('totalGoals', '0'), t('goalAssists', '0')]);
  expect(gk.lead?.name).toBe('cleanSheet');
  expect(gk.rest.map(f => f.name)).toEqual(['totalGoals', 'goalAssists']);
});

it('reads "3 (7)" as starts and substitute appearances, and tolerates anything else', () => {
  expect(splitTotals([t('starts-subIns', '3 (7)')]).apps).toEqual({ starts: 3, subs: 7 });
  expect(splitTotals([t('starts-subIns', '–')]).apps).toBeNull();
  expect(splitTotals([]).lead).toBeUndefined();
});
