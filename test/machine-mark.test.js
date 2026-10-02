'use strict';

// Every row starts with a system icon, so a session from another machine
// stands out in a merged list. The default depends on the OS; `machine_mark`
// overrides it and an empty string turns it off. lib/config.js reads the
// config once at require time, so the override is read in a child process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../lib/config');
const state = require('../lib/state');

const root = path.join(__dirname, '..');

function readMark(toml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mark-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  const out = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/config').machineMark)"], {
    cwd: root,
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return out.stdout;
}

test('the default follows the platform', () => {
  const mark = (platform) => config.defaultMachineMark(platform);
  assert.equal(mark('win32'), '\uf17a');
  assert.equal(mark('linux'), '\uf17c');
  assert.equal(mark('darwin'), '\uf179');
  assert.equal(mark('freebsd'), '\uf108');
});

test('machine_mark overrides the default, and empty turns it off', () => {
  assert.equal(readMark('machine_mark = "X"\n'), 'X');
  assert.equal(readMark('machine_mark = ""\n'), '');
  assert.equal(readMark(''), config.defaultMachineMark());
});

test('composeLine puts the mark first, then the spinner', (t) => {
  t.after(() => (config.machineMark = original));
  const original = config.machineMark;
  const entry = { name: 'claude' };
  config.machineMark = 'M';
  const on = state.composeLine(entry, 'working', '', '', 0);
  assert.ok(on.titlePrefix.startsWith('M '), JSON.stringify(on.titlePrefix));
  assert.equal(on.titlePrefix, `M ${config.FRAMES[0]} `);
  config.machineMark = '';
  const off = state.composeLine(entry, 'working', '', '', 0);
  assert.equal(off.titlePrefix, `${config.FRAMES[0]} `);
});
