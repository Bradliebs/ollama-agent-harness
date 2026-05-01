---
title: Ollama Agent Harness Changelog
description: Release notes generated from local RPI changes logs for Ollama Agent Harness
author: Bradliebs
ms.date: 2026-04-29
ms.topic: reference
keywords:
	- ollama
	- release notes
	- changelog
estimated_reading_time: 8
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
