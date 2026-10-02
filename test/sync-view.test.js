const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sync = require('../lib/sync');
const { pluginId } = require('../lib/paths');

const LIST = JSON.stringify([
  { id: 'aaa', label: 'Asus PC', target: 'x', session: 's', enabled: true, selected: false },
  { id: 'bbb', label: 'Old', target: 'y', session: 's', enabled: false, selected: false },
]);
const ok = (stdout = '') => ({ status: 0, stdout });
const invoke = (id, action) => ['--machine', id, 'plugin', 'action', 'invoke', `${pluginId()}.${action}`];

// A fake exec: records every call, answers the list and then `answer(args)`.
function fake(list, answer = () => ok()) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return args[0] === 'machine' ? list : answer(args);
  };
  return { calls, exec };
}

test('machines: enabled only, by id, label with spaces kept', () => {
  const { calls, exec } = fake(ok(LIST));
  assert.deepEqual(sync.machines(exec), [{ id: 'aaa', label: 'Asus PC' }]);
  assert.deepEqual(calls[0], ['machine', 'list', '--json']);
});

test('machines: no JSON, failed exit, or timeout means no machines', () => {
  assert.deepEqual(
    sync.machines(() => ok('not json')),
    [],
  );
  assert.deepEqual(
    sync.machines(() => ({ status: 1, stdout: LIST })),
    [],
  );
  assert.deepEqual(
    sync.machines(() => ({ status: null, error: { code: 'ETIMEDOUT' } })),
    [],
  );
});

test('commands: order then filter, by machine id', () => {
  const actions = (mode, filter) => sync.commands(mode, filter, 'aaa').map((args) => args.at(-1));
  assert.deepEqual(actions('grouped', 'all'), [`${pluginId()}.sync-active`, `${pluginId()}.sync-filter-all`]);
  assert.deepEqual(actions('recent', 'today'), [`${pluginId()}.sync-recent`, `${pluginId()}.sync-filter-today`]);
  assert.deepEqual(actions('date', '7d'), [`${pluginId()}.sync-date`, `${pluginId()}.sync-filter-7d`]);
  assert.deepEqual(actions(null, '3d'), [`${pluginId()}.sync-off`, `${pluginId()}.sync-filter-3d`]);
  assert.deepEqual(sync.commands('date', '3d', 'aaa')[0], invoke('aaa', 'sync-date'));
});

test('push: a failed order action skips that machine filter action and logs one line', () => {
  const list = ok(
    JSON.stringify([
      { id: 'aaa', label: 'Asus PC', enabled: true },
      { id: 'ccc', label: 'Second', enabled: true },
    ]),
  );
  const { calls, exec } = fake(list, (args) => (args[1] === 'aaa' ? { status: 1 } : ok()));
  const lines = [];
  sync.push('recent', '3d', { exec, log: (line) => lines.push(line) });
  assert.deepEqual(lines, [`Asus PC: ${pluginId()}.sync-recent failed (exit 1)`]);
  assert.deepEqual(calls.slice(1), [
    invoke('aaa', 'sync-recent'),
    invoke('ccc', 'sync-recent'),
    invoke('ccc', 'sync-filter-3d'),
  ]);
});

test('push: a timeout is a failure and logs ETIMEDOUT', () => {
  const { exec } = fake(ok(LIST), () => ({ status: null, error: { code: 'ETIMEDOUT' } }));
  const lines = [];
  sync.push('grouped', 'all', { exec, log: (line) => lines.push(line) });
  assert.deepEqual(lines, [`Asus PC: ${pluginId()}.sync-active failed (ETIMEDOUT)`]);
});

test('push: dry run logs the exact commands and runs only the list', () => {
  const { calls, exec } = fake(ok(LIST));
  const lines = [];
  sync.push('recent', '3d', { exec, log: (line) => lines.push(line), dryRun: true });
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith(`${pluginId()}.sync-recent  # Asus PC`));
  assert.ok(lines[1].endsWith(`${pluginId()}.sync-filter-3d  # Asus PC`));
});

test('pushes: false for --synced and --reapply, true for --flip and --filter', () => {
  assert.equal(sync.pushes(['node', 'a.js', '--recent', '--synced']), false);
  assert.equal(sync.pushes(['node', 'a.js', '--reapply']), false);
  assert.equal(sync.pushes(['node', 'a.js', '--flip']), true);
  assert.equal(sync.pushes(['node', 'a.js', '--filter']), true);
});

test('manifest: every sync action exists and carries --synced', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', 'herdr-plugin.toml'), 'utf8');
  const blocks = toml.split('[[actions]]').filter((block) => /^id = "sync-/m.test(block));
  const ids = blocks.map((block) => block.match(/^id = "(.+)"/m)[1]).sort();
  const wanted = [...Object.values(sync.MODE_ACTION), ...['all', 'today', '3d', '7d'].map((f) => `sync-filter-${f}`)];
  assert.deepEqual(ids, wanted.sort());
  // Last, so the order/filter flag is still the first `--` argument agent-view.js sees.
  for (const block of blocks) assert.match(block.match(/^command = .*$/m)[0], /"--synced"\]$/);
});
