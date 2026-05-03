<!-- markdownlint-disable-file -->
# Research: telegram-v036-poller-guard

## Findings
* Current branch before work: `master` at `de1f2ab fix: improve tool-only chat responses`.
* Duplicate poller confirmed: PID `10536` owned port `4000`; PID `22380` also ran `dist/web/server.js` and caused Telegram `409 Conflict` polling errors.
* Stopped duplicate PID `22380` before implementing the guard.
* Release workflow triggers on tags matching `v*.*.*` and validates with typecheck, full Jest, build, release smoke, and published asset smoke.
* Live About endpoint after rebuild reports version `0.3.6` and v0.3.6 release URLs.

## Validation Notes
* Telegram status after guarded restart reported `configured: true`, `running: true`, and polling lock PID `17444` owned by current process.
* Journal smoke via chat path added `smoke test guarded Telegram poller` to `C:\AI\Oracle\bullet-journal\data\tasks.json`.
* Internal `.harness/services/bullet_journal/state.json` did not receive the smoke task.
