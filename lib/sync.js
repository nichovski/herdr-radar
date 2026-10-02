'use strict';

// Copy this machine's Agents panel order and filter to every enabled saved
// Herdr machine, so two PCs show the same panel. The remote end is eight fixed
// plugin actions (herdr-plugin.toml sync-*): actions take no arguments, so each
// state is its own action. Run from the detached worker bin/sync-view.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { stateRoot, ensureDir, pluginId } = require('./paths');
const { binary } = require('./herdr');

const MODE_ACTION = { grouped: 'sync-active', recent: 'sync-recent', date: 'sync-date', null: 'sync-off' };

function run(args, timeout) {
  return spawnSync(binary(), args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Enabled saved machines, addressed by id: a label can hold spaces.
function machines(exec = run) {
  try {
    const result = exec(['machine', 'list', '--json'], 5000);
    if (result.status !== 0) return [];
    return JSON.parse(result.stdout)
      .filter((machine) => machine.enabled === true)
      .map(({ id, label }) => ({ id, label }));
  } catch {
    return [];
  }
}

function commands(mode, filter, id) {
  // The dotted id: a remote server rejects `--plugin` ("unknown option").
  const invoke = (action) => ['--machine', id, 'plugin', 'action', 'invoke', `${pluginId()}.${action}`];
  return [invoke(MODE_ACTION[mode]), invoke(`sync-filter-${filter}`)];
}

function append(line) {
  try {
    ensureDir(stateRoot);
    fs.appendFileSync(path.join(stateRoot, 'sync-view.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is a courtesy; a push never fails over it.
  }
}

// A failed order action skips that machine's filter action; no retry.
function push(mode, filter, { exec = run, log = append, dryRun = false } = {}) {
  const list = machines(exec);
  if (!list.length && dryRun) log('sync: no enabled saved machines');
  for (const { id, label } of list) {
    for (const args of commands(mode, filter, id)) {
      if (dryRun) {
        log(`${binary()} ${args.join(' ')}  # ${label}`);
        continue;
      }
      const result = exec(args, 20000);
      if (result.status !== 0) {
        log(`${label}: ${args.at(-1)} failed (${result.error?.code ?? `exit ${result.status}`})`);
        break;
      }
    }
  }
}

// A sync action or a startup re-apply must not push on: that would loop.
function pushes(argv) {
  return !argv.includes('--synced') && !argv.includes('--reapply');
}

module.exports = { machines, commands, push, pushes, MODE_ACTION };
