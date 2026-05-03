<!-- markdownlint-disable-file -->
# Details: telegram-v036-poller-guard

## Implementation
* Added `.harness/telegram-poller.lock.json` as a local Telegram polling ownership lock.
* `startTelegramBot` refuses to start polling when another live PID owns the lock.
* `stopTelegramBot` releases the lock when the current process owns it.
* Added `getTelegramPollingLockInfo()` for status reporting.
* `/api/telegram/status` now includes `pollingLock` with path, PID, active state, and current-process ownership.
* Telegram `/help` now lists `/add`, `/complete`, and `/log` bullet journal shortcuts.
* Bumped package version to `0.3.6` and added changelog notes.

## Runtime Smoke
* Request: `Add a task to my bullet journal to smoke test guarded Telegram poller 2026-05-03...`
* Tool result: `[OK] Added: smoke test guarded Telegram poller`.
* External task ID: `4` in `C:\AI\Oracle\bullet-journal\data\tasks.json`.
* Known caveat: default `oracle-prime` output validation failed the terse confirmation, but tool execution succeeded.
