<!-- markdownlint-disable-file -->
# Review: telegram-v036-poller-guard

## Phase 4 Findings
* No code-review blocker found in the focused Telegram lock and status changes.
* Risk: the lock is local to the working directory and does not prevent a different checkout or different machine from using the same bot token. This is acceptable for the observed failure, which was duplicate local Harness processes in the same workspace.
* Risk: a force-killed owner leaves a stale lock file. The guard checks whether the recorded PID is alive, so stale files do not block startup.
* Risk: the chat-path smoke is not a true Telegram-network message. It validates the normalized request shape and downstream journal tool path, while Telegram transport itself is validated by status and poller logs.

## Final Validation Targets
* Focused Telegram tests pass.
* Focused Telegram plus web server tests pass.
* Full Jest suite passes.
* Typecheck passes.
* Build passes.
* Guarded server status reports lock ownership.
* Release workflow should be triggered by pushing tag `v0.3.6`.
