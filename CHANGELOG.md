---
title: Ollama Agent Harness Changelog
description: Release notes generated from local RPI changes logs for Ollama Agent Harness
author: Bradliebs
ms.date: 2026-05-03
ms.topic: reference
keywords:
	- ollama
	- release notes
	- changelog
estimated_reading_time: 12
---

## Ollama Agent Harness v0.3.14

Synthesis turn telemetry, adaptive maxTurns, and stats management.

### Telemetry

* Added `synthesis_fired` LoopEvent emitted when the bonus synthesis turn triggers.
* Per-model synthesis frequency tracked in `.harness/synthesis-stats.json`.
* Adaptive maxTurns: models firing synthesis >40% of sessions automatically get +10 turns (cap 40).

### API

* `GET /api/synthesis-stats` — per-model stats with adaptive maxTurns.
* `DELETE /api/synthesis-stats?model=name` — reset stats for one model or all.

### UI

* Model capability hint shows adaptive turns badge with reset link when bumped.
* Synthesis turn surfaced in tool box during chat.

### Doctor

* `harness doctor` includes synthesis turn stats section with per-model ratios.

### Tests

* 11 new synthesisStats tests, 1 new queryLoop telemetry assertion.

## Ollama Agent Harness v0.3.13

Bonus synthesis turn prevents silent tool-only exits across all consumers.

### Query loop

* Added bonus synthesis turn when `maxTurns` exhausted on tool calls — the model gets one extra turn with tools stripped, forcing a text summary.
* Added `max_turns_synthesized` done reason to distinguish successful synthesis from hard max-turns stops.
* Added system prompt nudge reminding models to always produce text after tool use.

### Consumer updates

* CLI, Telegram, and UI fallback messages now handle `max_turns_synthesized` with distinct messaging.
* Exported `buildConsoleToolOnlyResponse` from CLI for direct testing.
* UI SSE consumer tracks `doneReason` from done events for accurate fallback selection.

### Tests

* 950 total tests passing (8 new: 3 queryLoop synthesis, 4 CLI fallback, 1 Telegram fallback).

## Ollama Agent Harness v0.3.12

Discord bot integration, browser URL allowlist, capability enforcement, and recommended model guide.

### Discord integration

* Added Discord bot bridge — same pattern as Telegram, forwards messages to /api/chat.
* API routes: `/api/discord/status`, `/api/discord/token`, `/api/discord/stop`.
* Auto-starts on server boot if `HARNESS_DISCORD_BOT_TOKEN` is set.
* Channel filtering via `HARNESS_DISCORD_ALLOWED_CHANNEL_IDS`.

### Browser safety

* Added URL allowlist via `HARNESS_BROWSER_URL_ALLOWLIST` env var.
* Supports exact domains and wildcard patterns (e.g. `*.gov.uk`).
* Browser page tools now enforce `browser-page-access` capability grant at execution time.
* Denied if no active grant or kill switch engaged.

### Capability enforcement

* `browser-page-access` capability policy added (10 gated capabilities total).
* Permission check now validates grants before browser tool execution.

### Documentation

* Added recommended models for tool use (local Ollama and Mistral API).
* Updated tool list with all browser and calendar tools.

### Tests

* 941 total tests passing (3 new URL allowlist tests).

## Ollama Agent Harness v0.3.11

Browser automation, calendar write, shopping skill, model guide, and capability grants.

### Browser automation

* Added 6 Playwright-based browser tools: `browser_navigate`, `browser_click`, `browser_fill`, `browser_read`, `browser_screenshot`, `browser_close`.
* All disabled by default and gated behind `browser-page-access` capability grant.
* Navigate/click/fill rated high risk; read/screenshot medium; close low.

### Calendar

* Added `calendar_write` tool for creating and appending events to .ics files.

### Shopping assistant skill

* Added `shopping-assistant` repo skill with supervised shopping workflow.
* Mandatory human approval at checkout — never enters payment details or clicks buy autonomously.

### Model guide

* Added recommended models for tool use to README (local Ollama and Mistral API).
* Includes pull commands, VRAM guidance, and role-based stack recommendations.

### Tests

* Added 20 browser tool tests and 11 calendar tool tests.
* 938 total tests passing (up from 918).

## Ollama Agent Harness v0.3.9

Beginner-friendly UI overhaul, multi-backend model routing, agentic OS services, Windows installer, and npm global install.

### Beginner UX

* Simplified welcome screen — Mission Control hidden behind an "Advanced" toggle.
* Guided tour opens automatically for first-time visitors.
* Cleaner greeting, tool chips, and model hint text.

### New services

* Model router with multi-backend support and fallback chat client.
* Capability registry for runtime service inventory with dynamic health checks.
* Worker queue for local-model background task processing.
* Mode classifier mapping user intent to six operating modes.
* Command extractor for structured JSON service commands.
* Replicate client integration.

### API routes

* `GET /api/worker/status` — worker queue pending/history.
* `GET /api/modes/classify?message=...` — mode classification with confidence scores.

### Distribution

* Published to npm: `npm install -g ollama-agent-harness`.
* NSIS Windows installer (855KB) with Node.js/Ollama checks and desktop shortcut.
* `prepublishOnly` script ensures build runs before publish.
* `files` and `engines` fields added to package.json.

### Housekeeping

* Removed non-project files from tracking (Bracknell, forge-memory, copilot-tracking).
* Secrets audit — clean, no API keys in repo.
* Fixed audit event type allowlist in server tests.

## Ollama Agent Harness v0.3.8

Patch release for output validation defaults, secret-safe Telegram release smoke coverage, audit triage visibility, and safer Agent Files guidance.

### Output validation

* Defaulted omitted `skipOnLowSignal` settings to true so casual or low-signal prompts do not trigger strict Oracle Prime section failures.
* Updated the browser fallback defaults to match the safer server behavior.
* Added regression coverage for low-signal validation skipping when older settings omit the field.

### Release and diagnostics

* Added `scripts/telegram-smoke.js` and `npm run smoke:telegram` to verify Telegram status shape without exposing or bundling bot tokens.
* Added `scripts/audit-triage.js` and `npm run audit:triage` to group current npm audit findings into actionable compatibility clusters.
* Updated release smoke to assert the new diagnostic scripts are included in release archives.

### Agent files

* Clarified runtime prompt guidance so user-allowed external folders remain available for tools and data, while scratch files and generated outputs prefer the configured Agent Files output folder.

## Ollama Agent Harness v0.3.7

Patch release for browser tool transcript hardening, external-file safety, and broader agentic operating-service routing.

### Browser chat and external files

* Collapsed browser tool activity behind a concise disclosure while keeping failed tool events visible.
* Added regression coverage for tool activity summaries and prompt guidance that steers routine Bullet Journal work away from external script rewrites.
* Required confirmation before editing protected program files in allowed external folders, even in `dontAsk` mode, while preserving data-file writes.

### Operating services

* Broadened agentic routing so ongoing searches such as looking for books or finding available rooms become operating services.
* Kept routine external Bullet Journal task commands out of the internal operating-service path.
* Made generic site-monitor notification wording match the requested condition instead of assuming every check is for room availability.

### Windows startup

* Made `start.bat` and `start-background.bat` clear stale port-4000 Harness listeners before launching.

## Ollama Agent Harness v0.3.6

Patch release for Telegram response cleanup and duplicate-poller diagnostics.

### Telegram reliability

* Added a local Telegram poller lock so duplicate Harness server processes do not silently compete for bot updates.
* Exposed Telegram poller lock status through `/api/telegram/status` for faster diagnostics.
* Updated Telegram `/help` with bullet journal shortcuts: `/add`, `/complete`, and `/log`.

### Tool-only responses

* Cleaned Telegram fallback replies so internal tool output such as `skill`, `list_files`, `file_read`, and `recall` is not shown to users.
* Added readable terminal and browser fallbacks when a model completes a tool-only turn without final text.

## Ollama Agent Harness v0.3.5

Patch release for CI release validation and release metadata accuracy.

### Release validation

* Fixed autonomy snapshot restore on Linux by invoking `git reset` and `git clean` without shell expansion, preserving `.forge-*` state while removing failed-iteration stray files.
* Verified the previously failing snapshot restore tests in a WSL/Linux temp checkout.

### About panel

* Ignored stale `release-provenance.json` fields when they belong to a different package version.
* Added regression coverage so `/api/about` reports the current package version archive, manifest, and release URLs after a version bump.

## Ollama Agent Harness v0.3.4

Patch release for release metadata accuracy.

### About panel

* Ignored stale `release-provenance.json` fields when they belong to a different package version.
* Added regression coverage so `/api/about` reports the current package version archive, manifest, and release URLs after a version bump.

## Ollama Agent Harness v0.3.3

Patch release for Telegram bullet-journal task routing.

### Telegram task handling

* Prevented Operating Services from intercepting explicit requests to add tasks to an existing bullet journal.
* Added regression coverage so `Add a task to my bullet journal...` falls through to normal model/tool handling instead of creating or mutating `.harness/services/bullet_journal`.
* Verified the live Telegram bridge receives messages on the clean current server without duplicate polling conflicts.

## Ollama Agent Harness v0.3.2

Patch release for configured communication behavior and Telegram reply reliability.

### Telegram and communication tools

* Added the `telegram_notify` tool so models use the saved Harness Telegram bridge instead of inventing local bot-token configuration.
* Updated chat instructions to steer models toward configured communication tools for Telegram and email.
* Improved Telegram bridge replies for tool-only turns. Successful tool results now produce a useful completion summary instead of `No response from the model`.
* Added Telegram bridge tests for empty final model responses and stream error summaries.

### Evidence retention

* Bounded run evidence storage to the latest 1,000 entries while preserving the existing newest-first read behavior.
* Added retention coverage for evidence pruning.

## v0.3.0 (2026-05-03)

Major feature release: document generation, Telegram integration, email sending, task management, and Mission Control.

### Document generation
* **`document_export` tool.** Generate CSV, Excel (.xlsx), Word (.docx), and PDF files directly from chat. Models auto-detect numbers, percentages, and currency in Excel. Tables supported in Word and PDF. Uses pure-JS libraries (exceljs, docx, pdfkit) — no native dependencies.
* **Document Studio in Mission Control.** Generate briefs, reports, runbooks, specs, ADRs, release notes, and handoffs from chat context or pasted source. Download as Markdown, HTML, PDF, or DOCX.
* **Clipboard paste.** Ctrl+V images in the chat input auto-upload for vision analysis.

### Telegram bot
* **Full Telegram integration.** Talk to Oracle from your phone via a Telegram bot. Text, photos, files, and voice messages all supported.
* **Inline progress.** See "⏳ Working... (3 tool calls: web_search, file_write)" while Oracle processes your request.
* **Telegram commands.** `/task`, `/schedule`, `/status` work from the phone.
* **Automation notifications.** Completed jobs push alerts to your Telegram chat.
* **Persistent chat IDs.** Notification recipients survive server restarts.

### Email
* **`email_send` tool.** Send real emails via SMTP with attachments. Configure SMTP in Settings → API Keys. Supports Gmail, Outlook, and any SMTP provider.
* **Email attachments.** Attach PDF reports, Excel spreadsheets, or any file to outgoing emails.
* **Sent mail archive.** Copies saved to `.harness/email/sent/`.

### Mission Control & task management
* **Task creation form in Autonomy Builder.** Type a task description and press Enter — no more editing `IMPLEMENTATION_PLAN.md` by hand.
* **Per-task ✓ complete and ✕ delete buttons.** Mark tasks done or remove them from the browser.
* **`/task` and `/schedule` chat commands.** Add tasks and recurring jobs from the chat input.
* **Job templates.** One-click setup for daily digest, hotel monitor, weekly report, and email reminder.
* **Run-now button.** Trigger any automation job immediately without waiting for the schedule.

### Readiness & evidence
* **Readiness API contract tests.** Plan-complete state shows warn (not blocked). Score bounds, metadata, and kill switch tested.
* **Evidence store hardened.** Streaming readline reader for large JSONL files. Corrupt-line tolerance.
* **Plan-complete shows "Plan complete — all N task(s) done" instead of red blocked card.**

### Infrastructure
* **`start-background.bat` and `stop-server.bat`.** Run the server as a background process that survives terminal close.
* **Stale-dist guardrail.** Server warns on startup when source files are newer than compiled output.
* **`start.bat` always rebuilds.** No more stale compiled code.
* **Settings merge on save.** Running server no longer overwrites file edits to unmanaged fields.
* **Injectable clock in `RateLimiter`.** Eliminates parallel test flake from `Date.now` global mutation.
* **682 tests, 66 suites, 0 failures.** Full test coverage for document tool, evidence store, snapshots, learning engine, rate limiter, session search, workflow registry, readiness API, and preflight contract.

## v0.2.4 (2026-05-02)

Follow-up release on the same day as v0.2.3. Three real user-visible bugs found while shipping v0.2.3 and fixed before the next user touch.

### Headline: chat agents can now move files into a user-chosen folder

* **`file_move` tool.** New built-in. Cross-device fallback to copy+unlink on EXDEV. Refuses to overwrite without `overwrite=true`. Refuses to move directories so an accidental "move my folder" call cannot sweep a subtree. Resolves the recurring "I cannot move files outside the project" agent claim by actually giving it the tool.
* **`file_delete` tool.** New built-in. Refuses to delete directories.
* **System prompt rule #6 is built dynamically.** When `getAllowedExternalPaths()` is non-empty (the Agent Files folder is set), the prompt lists those folders and tells the agent it can write to any path inside them, AND tells it to use `file_move` instead of `read+write` for move requests. Stops the false "I cannot write outside my project directory" refusal that v0.2.3 still had.
* **`agentOutputDir` auto-allows writes.** Setting an Agent Files folder in Settings now also adds it to the allowed-external-paths list, so `file_write`/`file_read`/`list_files`/`file_move`/`file_delete` accept absolute paths into it. Previously the redirect existed but the path-confinement check still rejected absolute writes outside the project.

### UI / dashboard
* **Settings panel + artifact panel never push content offscreen.** Right Settings panel becomes a fixed overlay starting at 1400px viewport (was 900px). Artifact panel is `position:fixed` instead of `position:absolute` so it never anchors to an offscreen container. Both close on **Escape** via a global keydown handler.
* **Simple "Agent Files" folder field replaces the dense pattern-rules editor at the top of the Files section.** Pattern rules are still available under a collapsed "⚙ Advanced" sub-section. One input + Save covers the 95% case.
* **🗂 Browse button + inline directory picker** for the Agent Files input. Preset chips (Home, Desktop, Documents, Downloads, Project root, agent-outputs/), Up button, current path, "Use this folder" action, immediate subdirectory list. Eliminates the typo failure mode and discoverability problem.

### Tests + smoke
* **12 new tests** for `FileMoveTool` and `FileDeleteTool` (move success, overwrite refusal/with-flag, directory rejection, source/destination outside-project rejection, same-path rejection, parent-dir creation, delete success, delete-dir refusal, missing-file error).
* **Release smoke** updated: the assertion was looking for an old start.bat phrase ('Installing dependencies with npm ci'); current bootstrapper says 'call npm ci'. Loosened to `assertContains('npm ci')` which is the load-bearing part.

### New API endpoints
* `GET /api/browse-dirs` — directory browser for the folder picker (NOT confined to PROJECT_DIR; the whole point is picking a folder elsewhere).
* Top-level `agentOutputDir` field in `/api/settings` (GET + POST), persisted to `.harness/settings.json`.

## v0.2.3 (2026-05-02)

Hardening release on top of v0.2.2. Five batches of verification, one user-driven feature (`file_write` pattern redirects), no new chat-surface features. 12 new tests, 590/590 jest pass.

### file_write pattern redirects (the headline)
- **`File-Write Redirects` section in Settings.** Route any agent `file_write` whose path matches a glob into a chosen folder (typically a sibling repo). Solves the recurring "another agent keeps dropping files in my repo root" problem at the tool layer rather than relying on `.gitignore`. Persisted to `.harness/file-write-redirects.json`; env override via `HARNESS_FILE_WRITE_REDIRECTS`.
- **Pattern syntax:** `*` matches any chars except `/`, `**` matches across separators, case-insensitive. First matching rule wins. Basename always preserved at destination.
- **Rule preview.** Type a sample path → click 🔍 Preview → see which rule (if any) catches it and where the file would land. Reads from the form (not the server) so unsaved edits show. Catches typos like `lottery_*` (underscore) before saving.
- **Priority:** user pattern rules > bare-filename `agent-outputs/` redirect > project root. Tool result message tells the agent where the file actually landed.
- **API:** `GET /api/file-redirects` returns rules + source + envOverride flag; `POST /api/file-redirects` persists + invalidates cache; `POST /api/file-redirects/preview` is read-only (rules in body, NOT persisted).
- **12 new tests** for the redirect logic (matching, ordering, fall-through, JSON tolerance, preview helper).

### Doctor + smoke surfaces
- **`harness doctor --watch [seconds]`.** Re-runs setup health on a fixed interval (default 5s, clamped 1..3600). Useful when toggling API keys in the UI to confirm doctor reflects them, or when bringing Ollama up/down. Watch mode stays exit 0 — it's a monitoring view, not a one-shot check.
- **`npm run smoke:remote-backends`.** Exercises one cheap model per OpenAI-compatible backend (Cerebras, Groq, GitHub Models, Mistral, OpenRouter, OpenAI) end-to-end through the CLI. Skips backends with no configured key.
- **`npm run diagnose:mistral`.** One-shot direct call to `api.mistral.ai` with a clear PASS/FAIL plus actionable hints for 401 (re-check key), 422 (try a different model id), 429 (rate limited).
- **doctor → smoke discoverability.** `formatSetupHealth` now prints a tip pointing at `npm run smoke:remote-backends` when at least one backend is configured.
- **UI/preset alignment smoke.** `scripts/ui-smoke.js` now cross-checks `REMOTE_API_KEY_FIELDS` (UI) against `OPENAI_COMPATIBLE_PRESETS` (factory) and reports orphan key entries with no backend client. Catches the v0.2.2 Anthropic drift bug class.
- **Settings-collapse persistence smoke.** Five static checks assert `setupSettingsCollapse` exists, is invoked at init, reads + writes `settingsOpenSections`, and renders the search input.

### API key surface (security + clarity)
- **API-key leak protection tests.** Three jest tests assert that `GET /api/api-keys`, `POST` round-trip, and `POST` of disallowed key names never echo any secret value (file-stored or env-stored).
- **File-source provenance preserved across env promotion.** `loadStoredApiKeys()` copies `.harness/api-keys.json` values into `process.env` so the chat client factory can read them. New `FILE_SOURCED_KEYS` tracker means `GET /api/api-keys` correctly reports `source: 'file'` for keys you entered through the UI, not the misleading `source: 'env'`. UI badge now shows `stored` instead of `from env`.
- **Removed orphan Anthropic UI row.** No Anthropic chat client was wired in `OPENAI_COMPATIBLE_PRESETS` so saving a key there had no client to invoke. The env var name remains in `ALLOWED_API_KEY_NAMES` for autonomy-container passthrough.

### Repo hygiene
- Relocated unrelated lottery scripts (created in the Harness root by another agent session) to `C:/AI/Lottery-Toolkit/`. Broadened `.gitignore` to catch `lottery-*/`, `lottery-*.js`, `lottery-*.html`, and individual orphan filenames.

## v0.2.2 (2026-05-02)

Dashboard 100x release. Brings the harness UI up to parity with leading AI chat UIs (Claude artifacts, ChatGPT regenerate, Cursor diffs, Perplexity citations, Open WebUI tok/s, t3.chat compare) while keeping the unique surfaces (Mycelium, output validation, capability gating, agent-outputs).

### Dashboard
- **Per-message regenerate + copy.** 🔁/📋 buttons under every assistant message; regenerate slices history and re-runs from the original user prompt.
- **Follow-up suggestion chips.** 3 heuristic next-prompt chips after every reply ("Add tests for that code", "Show a diff", "Diagnose the error", etc).
- **Inline diff preview for `file_edit`.** Unified-diff style trace items with red `-` / green `+` lines, capped at 12 per side. `file_write` shows a 3-line content preview + char count.
- **Artifact panel.** Side panel slides in for fenced code blocks ≥ 8 lines OR HTML/SVG/markdown/mermaid blocks. Tabs across the top for recent artifacts (max 12). Sandboxed iframe preview, source view, copy + download.
- **Web citations.** Successful `web_read` calls add to a per-turn citation list rendered as numbered Sources under the reply, plus `[n]` superscript links rewriting raw URLs in the visible text.
- **Live tok/s indicator.** Thinking pill updates every 250ms during streaming with `~N.N tok/s` (chars/4 / elapsed).
- **Side-by-side model compare.** ⚖️ button toggles compare mode + reveals a second-model picker; next prompt is sent in parallel to two models with a `✅ Keep this` button on each column.
- **"Preparing model..." pill no longer stuck.** Updates label on first model event of any type (`tool_call → 'Calling tools...'`, `usage → 'Working...'`, `context → 'Compacting context...'`).
- **Validation-failed badge.** UI surfaces a ⚠️ row when `done.reason === 'completed_with_validation_failures'`.
- **Auto-promote `oracle-prime` → `coding-answer`** when productive tools succeeded; emits new `output_validation_profile_promoted` SSE event so the swap is visible.

### Settings panel UX
- **Wider panel** (480px from 320px) with a sticky header and search bar.
- **Collapsible sections.** All 20+ settings groups are now `<details>`-style — click the heading to fold/unfold. Open state persists in localStorage.
- **Filter by text.** Type any term in the search bar to surface only matching sections.

### Backends
- **Mistral, Cerebras, Groq, GitHub Models, OpenRouter, OpenAI** are now selectable from the UI dropdown (`<backend>/<model>` ids). Falls back gracefully — UI still works if Ollama is down but you have remote keys.
- **`agent-outputs/` directory.** `file_write` redirects bare-filename writes for new files into `<project>/agent-outputs/` so scratch files stop piling up at the repo root. Configurable via `HARNESS_AGENT_OUTPUT_DIR`. Existing files and explicit subdirectory paths are unchanged.
- **API key entry in Settings.** New "Remote API Keys" section with masked input fields for each backend. Stored in `.harness/api-keys.json` (chmod 600). `GET /api/api-keys` returns which keys are configured (without revealing values) and whether each comes from env or file. Env vars always take precedence.
- **Backend pill on dropdown.** Remote models display `[backend]` next to the model name so you can tell at a glance whether a pick will burn API credits.

### Test count
- 572 → 579+ (added per-message regenerate, follow-up chip, validation auto-promotion, agent-outputs redirect, smoke wrapper, and snapshot E2E tests).

---

## v0.2.1 (2026-05-02)

Patch release focused on autonomy-loop hardening, validation UX, and headless reliability after a session of bug-hunting.

### Critical fixes
- **Snapshot-restore data loss on Windows.** `git clean -fd -e '.forge-*'` was passing literal single quotes to git on cmd.exe, voiding the exclude. Every failed-iteration restore was silently wiping `.forge-history.jsonl` and `.forge-state.json`. Drop the quotes; pinned by `src/automation/taskLoopSnapshot.test.ts` + an end-to-end test that drives the actual `ralphLoop` failure path.
- **`/api/chat` `done.reason` was misleading.** When output validation failed the loop still emitted `reason: 'completed'`, contradicting the FAIL findings the UI rendered. Now emits `reason: 'completed_with_validation_failures'` so the contradiction is machine-readable. UI surfaces it as a ⚠️ badge.
- **`oracle-prime` validator rejecting legitimate coding work.** `oracle-prime` is the fallback profile for ambiguous prompts, but applying it to a session that wrote files produced FAIL findings for missing reasoning sections (REFRAME / SCENARIO MAP / etc) the user never asked for. Loop now silently auto-promotes `oracle-prime` → `coding-answer` when productive tools (file_write/file_edit) succeeded. Emits a new `output_validation_profile_promoted` SSE event so the swap is auditable.

### UX
- **"Preparing model..." pill stuck through tool-call phase.** The thinking element only updated on SSE keepalive comments and only got removed on `text` events. If the model went through tool calls first, users saw the static label for the entire run. Now updates on the first model event of any type (`tool_call → 'Calling tools...'`, `usage → 'Working...'`, `context → 'Compacting context...'`).
- **Bare-filename writes now redirect to `agent-outputs/`.** `file_write` was letting the model dump scratch files (`run-all-analysis.js`, etc.) straight into the repo root, where they cluttered git status and were hard to find. New behavior: bare filename + no existing file → write goes to `<project>/agent-outputs/<filename>`. Existing files and explicit subdirectory paths are unchanged. Configurable via `HARNESS_AGENT_OUTPUT_DIR`. `agent-outputs/` is gitignored.

### Autonomy loop
- **`ralphLoop` is now exported with optional `RalphLoopHooks { implementTask?, validateTask? }`** so tests can drive the budget/halt/snapshot-restore control flow without spawning the real harness CLI. Production callers omit hooks and get unchanged behavior.
- **`HARNESS_TIME_BUDGET_MS` halt path** now covered by `src/automation/taskLoopBudget.test.ts`.
- **End-to-end snapshot-restore test** (`src/automation/taskLoopSnapshotE2E.test.ts`) drives the actual failure branch and asserts `.forge-history.jsonl` survives, stray files are wiped, and the plan is re-marked failed.

### Headless smoke
- **`scripts/headless-smoke.js` had four silent regressions** (wrong CLI path, no timeout, no `--mode dontAsk`, no `--unproductive-turn-limit`). All fixed. Wrapper now hardened with a 60s default timeout (`HARNESS_SMOKE_TIMEOUT_MS`), a build-presence check, and a `HARNESS_SMOKE_CLI_PATH` env override for tests.
- **Wrapper-layer test suite** (`src/automation/headlessSmokeWrapper.test.ts`) pins the smoke wrapper's contracts so the same class of regression cannot recur silently.
- **`npm run smoke:headless`** registered as a runnable script.

### Repo hygiene
- **`.gitignore` `*.js` exception is now `!scripts/*.js`** (blanket un-ignore) instead of per-file. Two real source files (`scripts/headless-smoke.js`, `scripts/autonomy-docker.js`) were silently dropped from `git status` by the per-file rules.
- **`scripts/autonomy-docker.js`** added to tracked sources (was untracked).
- **`cookbook/README.md`** documents the exported `ralphLoop` signature and `RalphLoopHooks` interface.

### Test count
- 559 → 572 (+13: snapshot/budget/auto-promote/wrapper/agent-outputs).

---

## v0.2.0 (2026-05-01)

Major release adding the mycelial context router, agent identity system, full autonomy mode, 5 new tools, automation CRUD, and beginner-friendly setup.

### Mycelial Context Router
- Adaptive graph system (`src/mycelium/`) that learns which tools, skills, and memories work best for different queries
- Spread activation, weighted route selection, reinforcement based on tool success rates
- Semantic relevance via Ollama embeddings with keyword fallback
- New Mycelium tab showing nodes, edges, and episodes. API: GET/DELETE `/api/mycelium`
- Tool chain tracking feeds success/failure signals into reinforcement

### Agent Identity
- Configurable agent name, avatar emoji (12 options), and personality
- 6 personality presets: professional, friendly, concise, mentor, creative, pirate
- Multi-profile save/load/delete with JSON export/import
- Name and avatar in topbar, chat bubbles, session history, and welcome screen
- Model-specific profile suggestions when selecting a model

### Full Autonomy Mode
- One-click Full Autonomy button sets dontAsk mode and enables all tools
- `autoGrantGatedCapabilities` creates 8-hour grants for all 9 gated capabilities at chat start
- Kill switch (Ctrl+Shift+K) remains the emergency stop

### Capability System
- 9 gated capabilities: shell, background jobs, self-modifying code, multi-agent swarm, desktop control, browser profile, skill install, email, calendar
- 3 blocked: password manager, live trading, skill marketplace. 0 design-only
- Grant lifecycle with create/revoke/auto-expire and audit trail
- Shell command allowlist presets with path traversal rejection

### New Tools
- `desktop_screenshot`: platform-native screen capture (disabled by default)
- `browser_bookmarks`: read-only Chrome/Edge bookmarks (disabled by default)
- `install_skill`: install skills from GitHub/Gist/GitLab URLs (disabled by default)
- `email_draft`: create .eml draft files for manual review (disabled by default)
- `calendar_read`: parse local .ics files for upcoming events

### Automation
- Job CRUD: create, edit, toggle, delete from Runs tab or API
- AutomationScheduler with heartbeat, idle gate, kill-switch guard
- Run history with output viewer. Scheduler settings in Settings panel

### Setup and Onboarding
- `start.bat` (Windows) and `start.sh` (Mac/Linux) with auto-install, auto-build, browser auto-open
- Guided first-chat tutorial in the welcome screen (5 interactive steps)
- START-HERE.md rewritten as complete beginner guide
- README.md updated with all new features

### Speech Input
- Auto-send on mic button toggle off with hourglass indicator

### Testing
- 365 tests across 48 suites. Runner, grant, automation, tool, and personality tests added

## Unreleased

### LocalAgentHarness session

Multi-iteration session that closed the LocalAgentHarness spec gaps against the existing harness and added the Skill Curator, workflow runner, and supporting safety surfaces.

* **Kill switch** (`src/permissions/engine.ts`, `src/web/server.ts`, `ui/app.js`): `PermissionEngine.engageKillSwitch` denies every tool call (including reads) while engaged. Toggle from any view with **Ctrl+Shift+K**; a fixed red banner stays at the top while active. State persists in `.harness/settings.json` so a stop survives restarts.
* **Tool registry metadata** (`src/types/tool.ts`, `src/tools/registry.ts`): `ToolRegistryEntry` now carries `riskLevel` (low / medium / high), `permissionCategory`, and `canDryRun` for every builtin. `GET /api/tools` exposes the data; the Tools tab renders risk badges, category pills, read-only / dry-run flags, and a per-tool **Disable / Enable** toggle. Disabled tools persist across restarts.
* **Extended skill schema** (`src/extensibility/skillLoader.ts`): SKILL.md frontmatter now parses optional `when_to_use`, `required_tools`, `risk_level`, `steps`, `examples`, `validation_checks`, `rollback_notes`. Existing skills keep working.
* **Workflow runner** (`src/workflows/workflowRegistry.ts`): declarative tool-call sequences in `.harness/workflows/<name>.{yaml,json}` with dry-run, pause, resume, cancel, and `${variables.foo}` substitution. Permission denials surface as a distinct `denied` step status. Bundled `project_health_check.yaml` and `nightly_curator.yaml` workflows.
* **Runs page** (`src/web/server.ts`, `ui/app.js`): dedicated tab with status badges, duration, error rows, transcript open + ID copy actions. Also surfaces the most recent curator audit log entries color-coded by outcome.
* **Local RAG** (`src/persistence/ragIndex.ts`, `src/web/server.ts`, `ui/app.js`): tree picker with checkboxes (no more typing folder paths), preview with per-path diagnostics (matched / missing / empty / unsupported), backend badge (auto-detects Ollama embeddings vs offline hash fallback), build progress streamed via SSE, search results with **Read in chat / Ask about this / Copy** buttons. Saves picker preferences as a sidecar so **Load paths** and **Rebuild** survive restarts.
* **`rag_search` and `rag_list_indexes` tools** (`src/tools/ragTools.ts`): builtin tools registered in the `rag` toolset so the agent can query indexes directly. Read-only, default-allowed.
* **Skill install / scaffold** (`src/web/server.ts`, `ui/app.js`): one-click install of `.github/skills/<name>` into runtime `.harness/skills/<name>` (with overwrite confirmation) plus a starter SKILL.md scaffold for malformed runtime folders. Skill diagnostics surface in both the Skills tab and the Discovery panel.
* **Skill Curator** (`src/curator/curator.ts`, `src/curator/scheduler.ts`): background skill maintenance with two phases.
  * Phase 1 (deterministic): `findStaleSkills` flags skills past `staleDays` with at least `minViewsBeforeArchive` views; `runDeterministicPhase` moves up to `maxArchivePerRun` unpinned candidates to `.harness/skills/_archive/<name>/`. Reversible via Restore.
  * Phase 2 (LLM): asks the configured model to cluster related skills into umbrella merges, writes proposals to `.harness/curator/proposals.md`, parsed into structured cards with **Preview** and **Apply merge** buttons. Pinned source skills are skipped, never archived. Verified end-to-end against gemma4:e4b: model produced a 1-cluster proposal in 57s, parser extracted it correctly, apply path wrote umbrella + archived 3 source skills.
  * Heartbeat scheduler ticks every 60s, runs an hourly maintenance check, and only triggers the curator when (a) enabled, (b) interval elapsed, (c) idle threshold met, (d) kill switch not active.
  * Per-skill usage in `.harness/skill-usage.json` tracks `useCount`, `viewCount`, `lastUsedAt`, `lastViewedAt`, `pinned`, `archived`. `SkillTool` and `ListSkillsTool` record use / view; `/api/chat` also records a use when the user message matches a skill trigger phrase.
  * Audit log at `.harness/curator/log.jsonl`. Settings live in `.harness/settings.json#curator` (Settings panel exposes Enable, Interval (h), Idle threshold (min), Stale (days), Min views before archive, Max archives per run, Enable LLM merge phase). Defaults: weekly interval, 2-hour idle threshold, 60-day stale, 5-archive cap, LLM phase off.
* **`curator_preview` tool** (`src/tools/curatorTools.ts`): read-only tool that runs the curator's deterministic phase in dry-run mode. Used by the bundled `nightly_curator` workflow.
* **Discovery panel curator card** (`src/web/server.ts`, `ui/app.js`): scheduler state, last-run timestamp, recent audit events surfaced alongside extensions / automations / session search.
* **Smoke fixes**: tab discovery in `scripts/ui-smoke.js` and `ui/app.js` now matches by `onclick` substring (icon prefixes broke `textContent === 'Skills'`); `app.js?v=3` cache-buster regex; SSE endpoints use `res.on('close')` not `req.on('close')` (POST request body consumption fires `req.close` too early).
* **Tests**: 42 suites / 276 tests (up from 228 at session start). New coverage: kill switch, tool registry metadata, extended skill schema, workflow runner (5 cases incl. dry-run + denied + pause/resume + cancel), RAG preview / streaming / tools / prefs, skill install / scaffold / pin, curator deterministic phase / LLM proposals / archive cap / kill-switch gating, scheduler skip conditions, merge proposal parser + apply (name conflict, pinned source skipped), curator_preview tool, /api/curator + /api/curator/proposals + apply round-trip.
* **Verified live**: kill switch via real HTTP routes; RAG end-to-end with Ollama nomic-embed-text (cosine 0.48 vs hash 0.30); curator preview against real workspace; LLM merge end-to-end (gemma4:e4b returned valid proposal, applied to disk, cleaned up); `nightly_curator` workflow against the live server (all 3 steps completed).

## Ollama Agent Harness v0.1.14

## Changes

### Validation Observability Changes

Added validation source trend drill-downs, visible auto-selection notices, About manifest links, public validation exports, and stricter release manifest smoke checks.

* `src/learning/evalTrace.ts` - records whether output validation was auto-selected or manually selected and includes that source in trend exports.
* `src/web/server.ts` - streams auto-selection profile notices and returns companion manifest links in About metadata.
* `ui/app.js` - renders auto-selection notices, source trend drill-downs, and manifest links.
* `src/index.ts` - exports validation profile suggestion and template APIs for package consumers.
* `.github/workflows/release.yml` and `scripts/release-smoke.js` - verify companion manifest fields and archive digest before and after publishing.

## Validation

* Focused tests, TypeScript typecheck, full Jest, build, UI smoke, release manifest generation, and release archive smoke should pass before release.

## Ollama Agent Harness v0.1.13

## Changes

### Automatic Validation Guidance Changes

Added automatic output-validation profile selection, template examples, validation fix suggestions, and a companion SHA manifest for release assets.

* `src/core/outputValidation.ts` - adds deterministic profile suggestion, template examples, and plain-English fix suggestions on validation findings.
* `src/web/server.ts` - adds a suggestion API, persists auto-select settings, applies auto-selected profiles for chat, and reads local companion SHA manifests.
* `ui/index.html` and `ui/app.js` - add an auto-select toggle, visible manual override, template good and bad examples, and preview fix suggestions.
* `.github/workflows/release.yml` and `scripts/release-manifest.js` - publish a companion `*.zip.sha256.json` manifest with the final archive digest.
* `scripts/ui-smoke.js` and `scripts/release-smoke.js` - cover the new validation UI and release manifest checks.

## Validation

* Focused tests, TypeScript typecheck, full Jest, build, UI smoke, release manifest generation, and release archive smoke should pass before release.

## Ollama Agent Harness v0.1.12

## Changes

### Validation Guidance Changes

Added one-click validation templates, validator preview, persisted walkthrough progress, and release verification guidance.

* `src/core/outputValidation.ts` - adds installable custom validation profile templates for factual, coding, release, and decision outputs.
* `src/web/server.ts` - adds APIs for validation templates, validation preview, persisted walkthrough state, and release verification status.
* `ui/index.html` and `ui/app.js` - add visible template install buttons, a paste-and-preview validator, completed walkthrough state, and release verification controls.
* `scripts/ui-smoke.js` - covers template install, preview rendering, walkthrough completion state, and release verification UI.

## Validation

* Focused web server tests, TypeScript typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke should pass before release.

## Ollama Agent Harness v0.1.11

## Changes

### Beginner Proof Onboarding Changes

Added visible onboarding, profile preset import/export, installed-version metadata, and interaction smoke coverage for the guided validation profile flow.

* `ui/index.html` and `ui/app.js` - add a first-run walkthrough checklist, profile preset import/export controls, and a Settings About panel.
* `src/web/server.ts` - adds `/api/about` for installed version and release provenance metadata.
* `.github/workflows/release.yml` - includes `release-provenance.json` in packaged release archives.
* `scripts/ui-smoke.js` - verifies guided profile form creation through Playwright interactions.
* `scripts/release-smoke.js` - verifies release archives include provenance metadata.

## Validation

* Focused web server tests, TypeScript typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke should pass before release.

## Ollama Agent Harness v0.1.10

## Changes

### Release Note Extraction Hardening Changes

Fixed changelog fallback extraction to use line-based section parsing instead of an unsupported end-of-string regex token.

* `scripts/release-notes.js` - parses changelog version sections by heading boundaries so release notes are not truncated by ordinary text.

## Validation

* Regenerated v0.1.8 and v0.1.9 fallback release notes from downloaded published assets and republished both release bodies with matching provenance.

## Ollama Agent Harness v0.1.9

## Changes

### Release Note Pruning Changes

Fixed generated release notes so CI fallback output includes only the requested changelog version section plus release provenance.

* `scripts/release-notes.js` - extracts the requested version section from `CHANGELOG.md` when `.copilot-tracking` changes are not available in CI.

## Validation

* Release note generation was validated with a missing changes directory to match the CI fallback path.

## Ollama Agent Harness v0.1.8

## Changes

### Beginner Proof Validation Experience Changes

Added beginner-friendly profile authoring, validation trend export, and release provenance in generated release notes.

* `ui/index.html` and `ui/app.js` - add guided custom profile form controls that write valid profile JSON for users.
* `src/learning/evalTrace.ts` - exports output-validation trend data with raw validation results.
* `src/web/server.ts` - adds a JSON download endpoint for validation trend exports.
* `scripts/release-notes.js` - adds commit SHA, asset name, asset size, and SHA-256 digest to release notes when an asset is provided.
* `.github/workflows/release.yml` - passes the packaged release asset and commit SHA into release note generation.

## Validation

* Focused learning and web server Jest suites, TypeScript typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke passed locally before release packaging.

## Ollama Agent Harness v0.1.7

## Changes

### Validation Profile UX And Release Verification Changes

Added custom profile schema diagnostics, deterministic score tuning fields, and post-publish release asset verification.

* `src/core/outputValidation.ts` - reports field-level custom profile schema errors and supports `scorePenalty`, `warnBelowScore`, and `failBelowScore`.
* `src/web/server.ts` - rejects invalid custom profile saves with structured error details.
* `ui/app.js` - validates profile JSON in the Settings editor before save.
* `.github/workflows/release.yml` - downloads the published release zip after upload and runs archive smoke validation.
* `README.md` - documents custom profile validation, scoring thresholds, and published asset verification.

## Validation

* Focused output-validation and web server Jest suites, TypeScript typecheck, full Jest, build, UI smoke, and release archive smoke passed locally before release packaging.

## Ollama Agent Harness v0.1.6

## Changes

### Output Validation Profiles And Trends Changes

Added output-validation documentation, custom deterministic profile authoring, validation trend summaries in the Learning panel, and release validation for the output-validation feature set.

* `README.md` - documented output-validation profiles, CLI usage, custom profile JSON, and structural validation limits.
* `src/core/outputValidation.ts` - added custom profile definitions with deterministic text and length checks.
* `src/core/queryLoop.ts` - pairs custom profile instructions with the final-answer validation path.
* `src/learning/evalTrace.ts` - summarizes output-validation run trends by profile and validation status.
* `src/web/server.ts` - exposes custom profile APIs, loads `.harness/output-validation-profiles.json`, and includes validation trend payloads.
* `ui/app.js` and `ui/index.html` - add custom profile editing controls and output-validation trend rendering.
* `scripts/ui-smoke.js` - validates the new profile authoring and trend UI hooks.

## Validation

* Focused output-validation Jest suites and TypeScript typecheck passed locally before release packaging.

## Ollama Agent Harness v0.1.5

## Changes

### Doctor Release Audio Presets Changes

Added a shared setup health module, `harness doctor`, optional audio sample validation, release archive smoke testing, compiled release startup, and beginner model preset documentation. Published commit `c069787` and verified `v0.1.3` release automation.

* `src/setup/health.ts` - shared setup readiness checks for Ollama, vision models, and audio transcription.
* `src/setup/health.test.ts` - coverage for shared setup health and audio sample validation.
* `src/cli/index.test.ts` - coverage for doctor option parsing and terminal output formatting.
* `scripts/release-smoke.js` - release
* `src/cli/index.ts` - added `harness doctor` and reusable CLI parsing/formatting exports.

### README Release Health Changes

Added first-run setup health checks, release badges, and a tag-triggered GitHub release packaging workflow. Published commit `2253926` and verified `v0.1.2` release automation.

* `.github/workflows/release.yml` - validates, builds, packages, and publishes release
* `README.md` - added CI and release badges plus latest release link.
* `package.json` - bumped version to `0.1.2`.
* `package-lock.json` - bumped lockfile version metadata to `0.1.2`.
* `scripts/ui-smoke.js` - added first-run health element and function checks.

### Setup Flow CI Release Assets Changes

Completed all continued work from the prior Suggested Next Work list.

* `.github/workflows/ci.yml`
* First-run setup panel in the browser welcome screen
* Release `v0.1.1` with `ollama-agent-harness-v0.1.1.
* `package.json`
* `package-lock.json`

### Media Settings Release Baseline Changes

Completed all continued work from the prior Suggested Next Work list.

* `README.md`
* Media tool settings in the browser Settings panel
* Git tag and GitHub release: `v0.1.0`
* `src/web/server.ts`
* `src/web/server.test.ts`

### Vision Audio Replay Links GitHub Changes

Completed all requested follow-up work and pushed the repository to GitHub.

* `src/tools/multimodalTools.ts`
* `src/tools/multimodalTools.test.ts`
* GitHub remote: `https://github.com/Bradliebs/ollama-agent-harness.git`
* `src/tools/index.ts`
* `src/index.ts`

### Replay Multimodal Beginner UX Changes

Implemented all latest follow-ups plus the beginner-focused multimodal and recovery UX request: live/mock replay adapter support, weather source ranking, replay source links, model media capability hints, image/audio attachment affordances, and clearer Resume/Fork recovery copy.

* `.copilot-tracking/research/2026-04-29/replay-multimodal-beginner-ux-research.md`
* `.copilot-tracking/plans/2026-04-29/replay-multimodal-beginner-ux-plan.instructions.md`
* `.copilot-tracking/details/2026-04-29/replay-multimodal-beginner-ux-details.md`
* `.copilot-tracking/plans/logs/2026-04-29/replay-multimodal-beginner-ux-log.md`
* `src/learning/evalTrace.ts`

### Weather Context Replay Evals Changes

Implemented all three continuation items: sparse weather fallback extraction, detected context visibility, and replayable eval examples for weather regressions.

* `src/tools/webSearchTool.test.ts`
* `src/tools/webSearchTool.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/web/server.ts`

### Eval Runner Provenance Calibration Smoke Changes

Implemented all four continuation items: eval runner and trends, candidate provenance details, apply-calibration workflow, and expanded Learning panel smoke coverage.

* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`
* `src/web/server.ts`

## Validation

* Typecheck, tests, build, and release archive smoke are expected to pass before publishing.
