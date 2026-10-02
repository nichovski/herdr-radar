#!/usr/bin/env node
'use strict';

require('../lib/node-version');

// Copy this machine's saved Agents panel order and filter to every enabled
// saved Herdr machine (lib/sync.js). Started detached by bin/agent-view.js and
// the settings popup, so a key press never waits on the network.
//
//   node bin/sync-view.js            push now
//   node bin/sync-view.js --dry-run  print the remote commands, run none
//
// One worker at a time: a lock file keeps a second one out. The holder pushes
// again when the saved state changed while it was pushing.

const fs = require('node:fs');
const path = require('node:path');

const view = require('../lib/view');
const sync = require('../lib/sync');
const { stateRoot, ensureDir } = require('../lib/paths');

const LOCK = path.join(stateRoot, 'sync-view.lock');
const STALE_MS = 120000;

function lock(retry = true) {
  try {
    ensureDir(stateRoot);
    fs.closeSync(fs.openSync(LOCK, 'wx'));
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST' || !retry) return false;
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs < STALE_MS) return false;
      fs.rmSync(LOCK);
    } catch {
      return false;
    }
    return lock(false);
  }
}

if (process.argv.includes('--dry-run')) {
  sync.push(view.mode(), view.filter(), { dryRun: true, log: console.log });
} else {
  while (lock()) {
    const mode = view.mode();
    const filter = view.filter();
    try {
      sync.push(mode, filter);
    } finally {
      fs.rmSync(LOCK, { force: true });
    }
    if (view.mode() === mode && view.filter() === filter) break;
  }
}
