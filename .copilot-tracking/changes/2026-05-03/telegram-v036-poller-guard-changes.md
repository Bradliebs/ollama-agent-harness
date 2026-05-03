<!-- markdownlint-disable-file -->
# Changes: telegram-v036-poller-guard

## Files Changed
* `src/integrations/telegram.ts`: added local poller lock, status helper, cleaner help text.
* `src/web/server.ts`: exposed poller lock diagnostics in `/api/telegram/status`.
* `src/integrations/telegram.test.ts`: added slash command and poller lock coverage.
* `package.json`: bumped to `0.3.6`.
* `package-lock.json`: bumped to `0.3.6`.
* `CHANGELOG.md`: added v0.3.6 release notes.

## Process Changes
* Stopped duplicate local server PID `22380`.
* Restarted guarded server on port `4000`.
