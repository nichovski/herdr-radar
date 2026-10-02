'use strict';

// The one Herdr surface the CLI does not wrap: `agent.view.set` / `clear`,
// the socket API that reorders the sidebar's Agents panel. Newline-delimited
// JSON over a local socket; the server answers one request and hangs up, so
// every call opens its own connection.
//
// While a view override is active Herdr disables the panel's own
// grouped/priority toggle, so whoever installs one owns the way back out —
// bin/agent-view.js keeps an on-disk flag for exactly that.

const fs = require('node:fs');
const path = require('node:path');

const { stateRoot, ensureDir } = require('./paths');
const { call } = require('./ipc');
const { source, reloadConfig } = require('./herdr');

const FLAG = () => path.join(stateRoot, 'agent-view.on');
const FILTER_FLAG = () => path.join(stateRoot, 'agent-view.filter');

// Both orders sort by recency and nothing else. Attention states deliberately
// do not outrank it: a question left hanging on purpose should sink with time
// like everything else — the colours already say what each row is.
//
// `grouped` keeps the workspace grouping while ordering by activity at both
// levels: the first key is the workspace's own recency bucket ($ws_key, equal
// across a workspace's panes, so a stable sort keeps each workspace
// contiguous), the second is the pane's own ($sort_key). `recent` drops the
// grouping and ranks every pane flat.
const SORTS = {
  grouped: {
    label: 'active',
    sort: [
      { field: { token: 'ws_key' }, order: 'desc' },
      // Between the workspace and the pane: panes sharing a tab are one split
      // screen and rank as a unit (lib/frame.js sortKeys).
      { field: { token: 'tab_key' }, order: 'desc' },
      { field: { token: 'sort_key' }, order: 'desc' },
    ],
  },
  recent: {
    label: 'recent',
    sort: [{ field: { token: 'sort_key' }, order: 'desc' }],
  },
  // Same ranking as `recent`; only the headers differ (lib/frame.js).
  date: {
    label: 'date',
    sort: [{ field: { token: 'sort_key' }, order: 'desc' }],
  },
};

// Show only agents active in the last N calendar days, whatever the order.
const FILTERS = {
  today: { days: 1, label: 'today' },
  '3d': { days: 3, label: '3 days' },
  '7d': { days: 7, label: '7 days' },
};
const FILTER_CYCLE = ['all', 'today', '3d', '7d'];

// Local calendar days from `at` to `now`, capped at 7. Null without a stamp.
function dayAge(at, now) {
  const day = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  };
  return typeof at !== 'number' ? null : Math.min(7, Math.max(0, day(now) - day(at)));
}

// The `date` order's header a pane sits under, from its day age.
function dateSection(age) {
  if (age === null) return 'date:4';
  return age < 2 ? `date:${age}` : age < 7 ? 'date:2' : 'date:3';
}
const DATE_LABELS = new Map([
  ['date:0', 'Today'],
  ['date:1', 'Yesterday'],
  ['date:2', 'Last 7 days'],
  ['date:3', 'Older'],
  ['date:4', 'No activity'],
]);

// Panes without a `day_age` token stay visible: no stamp is not old.
function filterFor(name) {
  const days = FILTERS[name]?.days;
  if (!days) return null;
  return {
    op: 'any',
    filters: [
      { op: 'in', field: { token: 'day_age' }, values: Array.from({ length: days }, (_, i) => String(i)) },
      { op: 'not', filter: { op: 'exists', field: { token: 'day_age' } } },
    ],
  };
}

function params(mode, name = 'all') {
  const spec = SORTS[mode];
  const filter = filterFor(name);
  if (!filter) return { source: source(), label: spec.label, sort: spec.sort };
  return { source: source(), label: `${spec.label} · ${FILTERS[name].label}`, sort: spec.sort, filter };
}

// `chosen` is the persisted filter unless the caller is applying a new one.
function apply(mode, chosen = filter()) {
  if (!SORTS[mode]) return Promise.resolve(null);
  return call('agent.view.set', params(mode, chosen));
}

function clear() {
  return call('agent.view.clear', { source: source() });
}

// The order nobody has chosen yet: active first, stale last. Sorting by
// activity is the plugin's point, so a fresh install gets it without a key
// press; `off` is the choice that has to be made explicitly.
const DEFAULT_MODE = 'grouped';

// The persisted intent, not the server state: the override dies with the
// server, and the startup hook re-applies whatever this says. Values are the
// SORTS keys, or `off`; null means no view (Herdr's own order). A missing or
// unreadable flag is the default, NOT off — off is written out as a word so
// that "never chose" and "chose Herdr's order" stay distinguishable.
function mode() {
  try {
    const value = fs.readFileSync(FLAG(), 'utf8').trim();
    if (value === 'off') return null;
    return value in SORTS ? value : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

// The persisted date filter, beside the mode flag. Missing or unknown is `all`.
function filter() {
  try {
    const value = fs.readFileSync(FILTER_FLAG(), 'utf8').trim();
    return value in FILTERS ? value : 'all';
  } catch {
    return 'all';
  }
}

function setFilter(value) {
  try {
    ensureDir(stateRoot);
    fs.writeFileSync(FILTER_FLAG(), value, 'utf8');
  } catch {
    // The view still switched; only persistence failed.
  }
}

function nextFilter(current) {
  const i = FILTER_CYCLE.indexOf(current);
  return FILTER_CYCLE[i < 0 ? 1 : (i + 1) % FILTER_CYCLE.length];
}

// The filter a request lands on: a named one wins, `filter` with no valid name
// cycles, any other request keeps the saved one.
function targetFilter(message) {
  if (message.op !== 'filter') return filter();
  return FILTER_CYCLE.includes(message.filter) ? message.filter : nextFilter(filter());
}

// The panel's OTHER layer. `apply`/`clear` above reorder the rows; this decides
// whether the rows are ours at all — the `[ui.sidebar.*]` block that paints the
// logos, the state colours and the group headers. Herdr exposes no socket call
// for it, so switching it means rewriting config.toml and reloading the server:
// a file write and a process spawn against `apply`'s single socket roundtrip,
// which is why only the native<->plugin toggle pays for it and the
// active<->recent flip does not.
//
// Lazily required: this is the cold path, and bin/configure pulls in the whole
// palette to rebuild the block.
// Callers run this BEFORE apply()/clear(): the reload it triggers is the one
// event that could plausibly drop a socket-installed override, so the socket
// call goes last and the ordering stops mattering.
function setRows(on) {
  const result = require('./managed-config').setSidebarRows(on);
  if (result.changed) reloadConfig();
  return result;
}

// The mode a request lands on, from the current one. One table for the daemon
// and the thin client, so a key does the same thing whether or not a daemon
// answered it. `op` is a transition (flip / native / cycle); `set` names a
// mode outright, or `off`.
function resolve(current, { op, set } = {}) {
  if (op === 'flip') return current === 'grouped' ? 'recent' : 'grouped';
  if (op === 'native') return current ? null : 'grouped';
  if (op === 'cycle') {
    return current === null ? 'grouped' : current === 'grouped' ? 'recent' : current === 'recent' ? 'date' : null;
  }
  if (set === 'off') return null;
  if (set === 'grouped' || set === 'recent' || set === 'date') return set;
  return current;
}

// Always a write, never a delete: removing the flag would mean "default"
// (see mode()), and the default is not off.
function setMode(value) {
  try {
    ensureDir(stateRoot);
    fs.writeFileSync(FLAG(), value ?? 'off', 'utf8');
  } catch {
    // The view still switched; only persistence failed.
  }
}

module.exports = {
  call,
  apply,
  clear,
  mode,
  setMode,
  filter,
  setFilter,
  nextFilter,
  targetFilter,
  params,
  filterFor,
  dayAge,
  dateSection,
  DATE_LABELS,
  FILTERS,
  setRows,
  resolve,
  DEFAULT_MODE,
};
