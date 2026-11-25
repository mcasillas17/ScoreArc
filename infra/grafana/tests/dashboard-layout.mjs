import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const directory = new URL('../dashboards/', import.meta.url);
const expected = new Map([
  ['scorearc-operations', [3, 4, 14, 22, 23, 24]],
  ['scorearc-reader-comparisons', [1, 2, 5, 6, 15, 16, 17, 18, 19]],
  ['scorearc-http-health', [7, 8, 9, 10]],
  ['scorearc-ingester-health', [11, 12, 13]],
  ['scorearc-espn-data-quality', [20, 21]],
]);
const files = readdirSync(directory).filter(name => name.endsWith('.json'));
assert.deepEqual(files.sort(), [...expected.keys()].map(uid => uid + '.json').sort());

// The suite keeps each panel ID in exactly one dashboard so the Loki smoke
// checks can identify each metric across the split.
export const panels = new Map();
for (const [uid, ids] of expected) {
  const dashboard = JSON.parse(readFileSync(new URL(uid + '.json', directory)));
  assert.equal(dashboard.uid, uid);
  assert.equal(dashboard.editable, false);
  assert.ok(dashboard.tags.includes('scorearc-operations-suite'));
  const isOverview = uid === 'scorearc-operations';
  assert.equal(dashboard.tags.includes('scorearc-operations-detail'), !isOverview);
  // Grafana serves / under a synthetic home UID. Link only to detail dashboards
  // there so that the overview never appears as its own destination.
  const navigationTag = isOverview ? 'scorearc-operations-detail' : 'scorearc-operations-suite';
  assert.ok(dashboard.links.some(link => link.type === 'dashboards' && link.keepTime &&
    link.tags?.includes(navigationTag)), uid + ' needs time-preserving navigation');
  assert.deepEqual(dashboard.panels.map(panel => panel.id).sort((a, b) => a - b), ids, uid);
  for (const panel of dashboard.panels) {
    assert.ok(!panels.has(panel.id), 'Duplicate panel ' + panel.id);
    panels.set(panel.id, panel);
  }
}
