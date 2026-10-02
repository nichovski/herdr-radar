process.env.TZ = 'Europe/Berlin';

const test = require('node:test');
const assert = require('node:assert/strict');

const herdr = require('../lib/herdr');
const state = require('../lib/state');
const view = require('../lib/view');
const { Frame } = require('../lib/frame');

const at = (iso) => new Date(iso).getTime();
const NOW = at('2026-06-10T12:00:00+02:00');
const DAY = 86400000;

test('dayAge counts local calendar days', () => {
  assert.equal(view.dayAge(at('2026-06-10T00:01:00+02:00'), NOW), 0);
  assert.equal(view.dayAge(at('2026-06-09T23:59:00+02:00'), at('2026-06-10T00:01:00+02:00')), 1);
  assert.equal(view.dayAge(NOW - 30 * DAY, NOW), 7);
  assert.equal(view.dayAge(NOW + DAY, NOW), 0);
  assert.equal(view.dayAge(null, NOW), null);
  assert.equal(view.dayAge(at('2026-03-29T00:10:00+01:00'), at('2026-03-30T00:30:00+02:00')), 1);
});

test('dateSection maps ages to headers', () => {
  const label = (age) => view.DATE_LABELS.get(view.dateSection(age));
  assert.deepEqual([0, 1, 2, 6, 7, null].map(label), [
    'Today',
    'Yesterday',
    'Last 7 days',
    'Last 7 days',
    'Older',
    'No activity',
  ]);
});

test('filterFor builds the filter tree', () => {
  assert.equal(view.filterFor('all'), null);
  const tree = (values) => ({
    op: 'any',
    filters: [
      { op: 'in', field: { token: 'day_age' }, values },
      { op: 'not', filter: { op: 'exists', field: { token: 'day_age' } } },
    ],
  });
  assert.deepEqual(view.filterFor('today'), tree(['0']));
  assert.deepEqual(view.filterFor('3d'), tree(['0', '1', '2']));
  assert.deepEqual(view.filterFor('7d'), tree(['0', '1', '2', '3', '4', '5', '6']));
});

test('params: filter all keeps the old payload, a filter adds label and filter', () => {
  const source = herdr.source();
  const sortKey = [{ field: { token: 'sort_key' }, order: 'desc' }];
  assert.deepEqual(view.params('recent', 'all'), { source, label: 'recent', sort: sortKey });
  assert.equal('filter' in view.params('grouped', 'all'), false);
  const dated = view.params('date', '3d');
  assert.equal(dated.label, 'date · 3 days');
  assert.deepEqual(dated.filter, view.filterFor('3d'));
});

test('resolve: date joins the cycle', () => {
  const cycle = [null, 'grouped', 'recent', 'date'];
  assert.deepEqual(
    cycle.map((mode) => view.resolve(mode, { op: 'cycle' })),
    ['grouped', 'recent', 'date', null],
  );
  assert.equal(view.resolve('recent', { set: 'date' }), 'date');
  assert.equal(view.resolve('date', { op: 'flip' }), 'grouped');
  assert.equal(view.resolve('date', { op: 'filter' }), 'date');
});

test('nextFilter cycles all, today, 3d, 7d', () => {
  assert.deepEqual(['all', 'today', '3d', '7d', 'nope'].map(view.nextFilter), ['today', '3d', '7d', 'all', 'today']);
});

const stamps = { a: NOW - 5 * 60000, b: NOW - DAY, c: NOW - 3 * DAY, d: NOW - 20 * DAY, u: null };
const keys = {
  minuteKey: (pane) => (stamps[pane] === null ? null : String(Math.floor(stamps[pane] / 60000)).padStart(12, '0')),
  wsKeys: new Map(),
  tabKeys: new Map(),
};
const entries = ['d', 'u', 'b', 'a', 'c'].map((pane) => ({ pane, workspace: `ws-${pane}` }));
const frame = new Frame('test');
const order = (mode, days) => frame.displayOrder(entries, mode, keys, days, NOW);

test('displayOrder date: newest first, unstamped last, sections assigned', () => {
  const rows = order('date', null);
  assert.deepEqual(
    rows.map((e) => e.pane),
    ['a', 'b', 'c', 'd', 'u'],
  );
  assert.deepEqual(
    rows.map((e) => view.DATE_LABELS.get(e.workspace)),
    ['Today', 'Yesterday', 'Last 7 days', 'Older', 'No activity'],
  );
});

test('displayOrder with a filter drops old panes and keeps unstamped', () => {
  assert.deepEqual(
    order('date', 3).map((e) => e.pane),
    ['a', 'b', 'u'],
  );
  assert.deepEqual(
    order('recent', 1).map((e) => e.pane),
    ['u', 'a'],
  );
});

test('displayOrder grouped: headers land on the first visible pane', () => {
  const same = entries.map((e) => ({ ...e, workspace: 'w' }));
  const rows = frame.displayOrder(same, 'grouped', keys, 1, NOW);
  assert.deepEqual([...state.groupBoundaries(rows).heads], ['a']);
});

test('displayOrder recent with filter all returns the same list', () => {
  assert.equal(order('recent', null), entries);
});

test('paneJobs publishes day_age and republishes when only the day changes', async (t) => {
  const sent = [];
  t.mock.method(herdr, 'reportMetadataAsync', async (_pane, _source, tokens) => {
    if ('day_age' in tokens) sent.push(tokens.day_age);
    return true;
  });
  t.mock.method(herdr, 'reportMetadata', () => true);
  const f = new Frame('test');
  const entry = { pane: 'w:p1', workspace: 'w', tab: 't', name: 'claude', title: 'x' };
  const stamp = at('2026-06-10T23:00:00+02:00');
  const pkeys = {
    minuteKey: () => String(Math.floor(stamp / 60000)).padStart(12, '0'),
    wsKeys: new Map(),
    tabKeys: new Map(),
  };
  for (const now of [stamp + 60000, stamp + 2 * 3600000, stamp + 2 * 3600000]) {
    const jobs = [];
    f.paneJobs(entry, 'idle', { tabs: new Map(), keys: pkeys, indent: '', spinStep: 0 }, now, [], jobs);
    await Promise.all(jobs);
  }
  assert.deepEqual(sent, ['0', '1']);
});

test('day_age is an owned token, cleared with the rest, kept by a non-purge clearAll', async (t) => {
  assert.ok(state.OWNED_TOKENS.includes('day_age'));
  const seen = [];
  t.mock.method(herdr, 'reportMetadataAsync', async (_pane, _source, tokens) => {
    seen.push(tokens);
    return true;
  });
  t.mock.method(herdr, 'reportMetadata', (_pane, _source, tokens) => {
    seen.push(tokens);
    return true;
  });
  await state.clearState('src', 'w:p1');
  assert.ok(seen.some((tokens) => tokens.day_age === null));
});

test('a non-purge clearAll keeps day_age with the other sort keys', async (t) => {
  const cleared = [];
  t.mock.method(herdr, 'panesAsync', async () => [{ pane_id: 'w:p9', tokens: { day_age: '0', tab_key: 'x' } }]);
  t.mock.method(herdr, 'workspacesAsync', async () => []);
  t.mock.method(herdr, 'reportMetadataAsync', async (_pane, _source, tokens) => {
    cleared.push(...Object.keys(tokens));
    return true;
  });
  await state.clearAll('src');
  assert.ok(cleared.includes('tab_key'));
  assert.equal(cleared.includes('day_age'), false);
});

test('targetFilter: a named filter wins, a bad name cycles, no op keeps the saved one', () => {
  assert.equal(view.targetFilter({ op: 'filter', filter: '3d' }), '3d');
  assert.equal(view.targetFilter({ op: 'filter', filter: 'nope' }), view.nextFilter(view.filter()));
  assert.equal(view.targetFilter({ op: 'filter' }), view.nextFilter(view.filter()));
  assert.equal(view.targetFilter({ set: 'recent' }), view.filter());
});
