import { describe, it, expect } from 'vitest';
import { COMPETITIONS } from '@/server/data/competitions';

// The Leagues Cup's root shows its phase tables ("Qualified for the Knockout")
// until the draw is complete, and the bracket after. A nav item reading
// "Bracket" describes that page for a minority of the competition — and, while
// the knockout is still being drawn, describes a page that is not shown at all.
describe('the root nav label for a phased cup', () => {
  it('identifies a cross-league cup by its computed tables', () => {
    expect(COMPETITIONS['leagues-cup'].seasons['2026'].computedTables).toBeDefined();
  });

  // The World Cup root really is a bracket for the whole knockout, so it keeps
  // the literal label.
  it('leaves a straight knockout competition alone', () => {
    expect(COMPETITIONS['world-cup'].seasons['2026'].computedTables).toBeUndefined();
  });
});
