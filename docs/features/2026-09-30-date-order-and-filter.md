# Date order and date filter

**Date:** 2026-09-30 · **Branch/PR:** `feat/date-view` on `nichovski/herdr-radar` · **Author:** Bogdan

## What it does

- A new Agents panel order, `date`: one flat list, newest first, under a header
  per day: Today, Yesterday, Last 7 days, Older, and No activity.
- A date filter that shows only agents active in the last N calendar days.
  One action, `view-filter`, cycles all, today, 3 days, 7 days. It works with
  every order (`active`, `recent`, `date`).
- `date` joins the `view-toggle` cycle (active, recent, date, off), has a
  `--date` flag on `bin/agent-view.js`, and is a choice in the settings popup.
- The panel label shows the filter, for example `recent · today`, so a missing
  row is explained.

"Sort by date" already existed: `recent` and `date` both order by last
activity, newest first. No oldest-first variant was added.

## Why

With many agents open it is hard to tell today's work from last week's. The
plugin already tracks a last-activity stamp per pane; this uses it for
grouping and filtering.

Decisions:

- **Date used is last activity**, not session start. Session start is not
  tracked and would need a new source.
- **Local calendar days, not rolling 24 hours.** "Today" and "Yesterday" are
  calendar words. Filters follow it: today is age 0, 3 days is ages 0 to 2,
  7 days is ages 0 to 6.
- **Herdr has no numeric filter.** Its view filter supports `eq`, `in`,
  `exists`, `not`, `any`, `all` on a token. So each pane publishes a `day_age`
  token (`'0'` to `'7'`) and the filter is `in` over the allowed values.
  A bucket token (today / yesterday / week) was rejected: the 3 day filter
  cuts across the "Last 7 days" bucket.
- **Panes with no stamp stay visible** under every filter, in "No activity".
  Most are agents that have not worked yet; hiding them under "today" would
  make a new agent vanish. Filter branch: `not exists day_age`.
- **The filter is stored in `agent-view.filter`**, beside `agent-view.on`, not
  in `config.toml`. It is toggled state, and a config key would need a daemon
  restart. It is written only when the user cycles it, so `--reapply` and mode
  changes never create the file. A missing or unknown value means `all`.
- **The filter is ignored while the order is `off`.** Herdr's own order has no
  view to carry it; the action only saves the choice.

## How it works

- `lib/view.js`: `SORTS.date` (same sort as `recent`), `FILTERS`,
  `dayAge(at, now)`, `dateSection(age)`, `DATE_LABELS`, `filterFor(name)`,
  `params(mode, name)`, `filter()` / `setFilter()` / `nextFilter()`. With
  filter `all`, `params` is the exact old payload with no `filter` key, so
  `active` and `recent` behave as before.
- `lib/frame.js`: every pane publishes `day_age` with its sort keys. It is
  part of `sortPair`, so a change is re-sent in the same report. The daemon's
  2 second heartbeat recomputes every frame, so a midnight change is
  republished within 2 seconds with no extra deadline.
- `displayOrder` filters first, then sorts. In `date` mode it also rewrites
  `entry.workspace` to a section id (`date:0`...), so the existing
  `writeGroups` draws the day headers with `DATE_LABELS`. Headers and gaps are
  computed on the filtered display order, so a hidden pane never carries the
  header of a group.
- `lib/state.js`: `day_age` is an owned token (cleanup and unconfigure remove
  it). A non-purge stop keeps it with the other sort keys, so the settings
  popup's daemon restart does not flash hidden rows back.
- `lib/daemon.js` and `bin/agent-view.js`: the `view` control message takes
  `op: 'filter'`. A client that gets `applied` back from an old daemon with no
  `filter` in the reply falls back to the standalone path.
- Tests: `test/date-view.test.js`.

## Notes

- Verified: 100 of 100 tests, `npm run check`, and Herdr accepted all 12 mode
  and filter payloads on a live server. A probe showed `herdr agent list`
  returns every agent even while a view filter is active, so hidden panes stay
  in the plugin's snapshot and do not flap.
- Not seen rendering: the installed plugin is a separate copy of the code, so
  the filter and the day headers have not been looked at on a real sidebar with
  this branch's daemon.
- Known and left: with `split_corner = true` (off by default) a filter can
  leave a corner mark on a visible split pane whose tab head is hidden.
  Cosmetic, rejected as not worth the code.
- Not done: the READMEs still describe two orders and no filter.
- The first frame after upgrade rewrites each pane's sort keys once, because
  `day_age` is part of the rewrite check.
- Review: GLM and DeepSeek through pi did not run (pi hung or dropped the
  diff). A separate Claude reviewer ran instead. It raised three low findings:
  two fixed (stale daemon reply, stale toml description), one rejected
  (split corner).
