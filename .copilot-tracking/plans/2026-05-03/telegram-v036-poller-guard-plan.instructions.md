<!-- markdownlint-disable-file -->
# Plan: telegram-v036-poller-guard

## Task Overview
Continue all Phase 5 suggested work items from the Telegram settings release checkpoint.

## Scope
* Stop duplicate Telegram poller process.
* Verify live journal task flow writes to `C:\AI\Oracle\bullet-journal\data\tasks.json`.
* Add a local Telegram poller guard and status diagnostics.
* Clarify Telegram command help for bullet journal shortcuts.
* Prepare and publish patch release `v0.3.6`.

## Success Criteria
* Only one local `node dist/web/server.js` process remains.
* `/api/telegram/status` reports a current active poller lock owned by the server process.
* No fresh Telegram `409 Conflict` errors appear after the guarded restart.
* Smoke task lands in external Oracle bullet journal tasks, not internal `.harness/services/bullet_journal`.
* Tests, typecheck, build, commit, tag, and release push complete.
