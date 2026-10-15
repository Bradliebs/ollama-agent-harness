---
title: System Breakdown
description: Subsystem reference with dated inventory and current modernization pointers
ms.date: 2026-10-08
---

## Current Status and Historical Inventory

Package metadata remains v0.6.5, with unreleased modernization work on `dev`.
The latest full Jest result is 358 suites, 4,050 passed tests and one skipped,
exit 0 (2026-10-08). See [Modernization Status](MODERNIZATION-STATUS.md) for current runtime,
MCP, cloud, lifecycle and recovery contracts and their remaining qualification gaps.
Subsystem tables, the storage layout, environment flags (§ 5) and CLI commands
(§ 6) were brought up to date on 2026-10-08. The § 12 status snapshot is the
June v0.6.5 record and is kept as history.

**Version**: v0.6.5 (2026-06-23) plus unreleased development work
**License**: see repo root · **Audience**: operators, contributors, future-you

This document is the single-page system reference. It covers every
subsystem, the data it owns, the env flags that gate it, and the
operational surface it exposes. Use it as a map when something breaks
or when you are deciding where a new piece of work belongs.

## 1. What this is

A local-first TypeScript daemon that runs LLM agents end-to-end on your
own machine. The user surface is a chat web UI, a TUI client, and a
CLI. The agent itself is a tool-using loop wrapped in observability,
permissions, persistence, and self-improvement infrastructure.

Design constraints that show up everywhere in the codebase:

- **Local-first.** Workspace state lives under the resolved project directory;
  installation ownership markers are separate. Explicit cloud inference and
  network tools send data outside the machine.
- **Model-agnostic.** Ollama is the default backend, but the chat
  client factory abstracts Cerebras, Groq, GitHub Models, OpenAI,
  Mistral, OpenRouter, Replicate, and Cloudflare. No code path
  assumes Claude- or GPT-specific behaviour.
- **Explicit opt-ins.** Experimental features retain their documented gates;
  runtime fixes and minimum Node requirements are not all feature-flagged.
- **Test-as-spec.** Tests document expected behavior; independent artifact
  checks and live qualification remain necessary to establish task success.

## 2. Top-level layout

```
src/
  agents/         Sub-agent orchestration, model routing (incl. in-run
                  escalation targets), custom-agent loader
  automation/     Background scheduler, job-safety guards, recurring tasks
  budget/         Daily-spend cap decorator for remote backends
  cli/            `harness` entry point, command registry, parser
  context/        System-prompt assembly (incl. concept-memory recall),
                  compaction, history window, governed working state
  core/           Chat clients, query loop, run supervisor, scaffolding,
                  deferred tool loading, validation, fallback routing,
                  tracing, structured output, rate limiting
  curator/        Skill curation (stale / failing skills, merge proposals)
  eval/           Adversarial probes + simulator, run replay and history
                  benchmarks, cost tracking
  experiments/    AutoResearch paired baseline-vs-candidate experiments
  extensibility/  Skill loader + usage/lifecycle, MCP bridge, capability
                  template starters
  goal/           `/goal` outer loop: verification-driven autonomous iteration
  governed/       Shadow-first governance pass and human-gated review queue
  integrations/   Discord, Slack, Telegram, WhatsApp, outbound webhooks
  jarvis/         Ambient/voice layer: trust ladder, knowledge graph, model
                  council, predictive engine, daily brief, MCP server, voice
  learning/       Reflection extractor, run lessons, candidate promotion
                  gate, eval traces
  models/         Model catalog, capability probes + profiles, per-model
                  request adapter, vision-model registry
  mycelium/       Context router graph (long-term routing memory)
  nervous/        Reflex layer (signal-driven heuristics)
  observability/  Prometheus, OpenInference, OTLP exporter
  permissions/    Engine, audit log, prompt broker, kill switch, shell-risk
                  classifier, capability checks
  persistence/    Sessions, event store, continuity, run logs, side-effect
                  ledger, git checkpoints, snapshots, RAG + semantic memory
  presets/        Comparison-report category schemas (JSON)
  prompts/        Minimal prompt template engine
  reports/        Comparison-report rendering
  safety/         Injection defence, untrusted-content envelope, secret
                  redactor, provenance checks, tool inspectors
  services/       Heartbeat, triggers, concierge, squads, identity, tasks,
                  memory intelligence, model profiles, capability registry,
                  concept-memory client, operate-mode, Apex (goal/kanban/
                  morning-priority), promise ledger, worker queue
  setup/          `doctor`, `doctor --fix`, health probes
  tools/          File/grep/web/PDF/image/audio/browser/email/calendar/
                  squad/agent/task/docker tools
  tui/            Terminal client (readline + ANSI, no Ink)
  verification/   Research-claim checks, critic models, verification panel
  web/            Express server, routes, UI wiring, WS
  workflows/      Workflow runner glue
ccmem/            FastAPI concept-cell semantic memory sidecar (Python)
ui/               Static SPA served by the web daemon
docs/             Operator-facing reference
.copilot-tracking/  RPI artifacts (research, plans, changes, reviews, memory)
.harness/         Runtime state (sessions, settings, uploads, outputs, …)
agent-outputs/    Corral for bare-filename writes from file_write
```

## 3. Subsystem reference

For each subsystem: what it owns, where its state lives, what env flags
control it, and which routes / CLI commands surface it.

### 3.1 Chat loop (`src/core`)

The heart of the agent. `queryLoop` drives the LLM call → tool call →
LLM call cycle until either a `done` event fires or one of the safety
limits trips.

| Module | Responsibility |
|---|---|
| `chatClientFactory.ts` | Picks Ollama / OpenAI-compatible / Replicate impl by env or settings |
| `ollamaClient.ts`, `openaiClient.ts`, `replicateClient.ts` | Backend adapters |
| `fallbackChatClient.ts` | Auto-fallback on rate-limit / 5xx |
| `queryLoop.ts` | Tool dispatch, turn budget, context budgeting and compaction, structured output validation, in-run escalation, run-log recording |
| `supervisor.ts` | Progress-based stuck detection (warn → change strategy → escalate → ask the human) and per-run token/USD budgets |
| `scaffolding.ts` | Light / medium / heavy scaffolding levels for weaker models |
| `toolLoading.ts` | Deferred tool loading: core + relevant tools offered, `tool_search` loads the rest |
| `toolLoopGuards.ts`, `sourceLedger.ts` | Repeated-call and duplicate-result guards; sources read for answer footers |
| `taskConductor.ts` | Plan → step → verify conductor used by task runs |
| `outputValidation.ts` | Profile-driven final-answer checks |
| `synthesisStats.ts` | Per-model adaptive `maxTurns` |
| `rateLimiter.ts` | Local + remote throttle |
| `readinessGate.ts` | Pause until backend reports ready |
| `tracing.ts` | RuntimeTracer (in-memory) feeding the OTLP exporter |
| `structuredOutputValidator.ts` | JSON-schema enforcement |

State: per-session in `.harness/sessions/`; per-run event logs in
`.harness/runs/`. Backend choice is decided at
`chatClientFactory.createChatClient()` time and re-decided per request
when the daemon restarts.

### 3.2 Agents (`src/agents`)

Sub-agent orchestration. The harness can spawn isolated agents with
their own prompt + tool subset.

| Module | Responsibility |
|---|---|
| `subagent.ts` | `createSubagentTool`, run lifecycle, abort signal, registry hook |
| `agentLoader.ts` | Reads custom agent defs from `.harness/agents/*.md` |
| `modelRouting.ts` | Small / default / strong helper-model picker |

State: `.harness/agents/*.md` markdown agent definitions. Each one is
parsed once and cached by id.

REST: `GET /api/agents`, `GET /api/subagents`, `POST /api/subagents/:id/cancel`.

### 3.3 Tools (`src/tools`)

The ~70 runtime tools the model can call (`getRuntimeTools`). Roughly grouped:

| Group | Tools |
|---|---|
| Filesystem | `file_read`, `file_write`, `file_edit`, `file_move`, `file_delete`, `make_directory`, `list_files`, `list_uploads`, `add_workspace_path`, `grep` |
| Web and browser | `web_search`, `web_read`, `web_fetch`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_read`, `browser_screenshot`, `browser_close`, `browser_bookmarks` (page tools capability-gated) |
| Media and documents | `image_analyze`, `audio_transcribe`, `pdf_read`, `pdf_metadata`, `pdf_render_page`, `pdf_extract_tables`, `document_export`, `document_read`, `desktop_screenshot`, `desktop_input_replay` |
| Process | `bash` (no shell operators), `docker_exec` (capability-gated) |
| Memory and recall | `remember`, `recall`, `semantic_recall`, `rag_search`, `rag_list_indexes`, `kg_recall`, `code_graph` |
| Skills and learning | `skill`, `list_skills`, `create_skill`, `install_skill`, `import_skill`, `improve_skill`, `reflect`, `analyze_patterns`, `promote_pattern`, `consolidate`, `evolve`, `curator_preview` |
| Agents, squads and tasks | `create_custom_agent`, `list_agents`, `delete_agent`, `create_squad`, `update_squad`, `delete_squad`, `squad_route`, `squad_inspect`, `task_manage`, `task_progress` |
| Communication and personal | `email_draft`, `email_send`, `email_inbox`, `email_delete`, `slack_notify`, `telegram_notify`, `calendar_read`, `calendar_write`, `shopping_list`, `reading_list` |

The loop adds `state_update` when the working state is injected and
`tool_search` under deferred tool loading. MCP servers contribute further
tools at runtime.

Path resolution lives in `tools/pathResolution.ts`:

- `getUploadsDir()` — order: `HARNESS_UPLOADS_DIR` > `HARNESS_GLOBAL_UPLOADS=1`
  (~/.harness/uploads) > `<cwd>/.harness/uploads`.
- `maybeRedirectAgentOutput()` — bare-filename writes corralled into
  `agent-outputs/` (override via `HARNESS_AGENT_OUTPUT_DIR`).
- File-write redirect rules from `.harness/file-write-redirects.json`
  for "send anything matching `lottery-*` to that-other-project" cases.

### 3.4 Permissions & audit (`src/permissions`)

Decides whether a tool call is allowed. Three layers:

1. **Engine** (`engine.ts`) — declarative tool allowlist per mode
   (`default`, `acceptEdits`, `dontAsk`).
2. **Capability registry** (`services/capabilityRegistry.ts`) — opt-in
   grants for sensitive tools (`arbitrary-shell`, etc.) with audit log
   + kill-switch + allowlist controls.
3. **Audit log** (`audit.ts`) — JSONL append at `.harness/audit.log`.
   `renderRecentAuditForPrompt` injects a signal-only block into the
   chat system prompt when ≥2 failures in a 10-min window.

REST: `/api/permissions/*`, `/api/audit*`, `/api/capabilities*`.

### 3.5 Persistence (`src/persistence`)

| Store | Path | Purpose |
|---|---|---|
| Sessions | `.harness/sessions/*.jsonl` | Append-only conversation transcript per session |
| Run logs | `.harness/runs/<runId>.jsonl` (newest 500 runs, 300 MB cap) | Event-sourced record of each run: message deltas, raw model responses, tool calls and results, compaction snapshots. Secrets are redacted before writing. Rebuilds the exact prompt of any turn and feeds replay and lessons |
| Side-effect ledger | `.harness/side-effects.jsonl` | File changes and notifications per run and step, with how to undo them (`runReverter.ts`) |
| Git checkpoints | `refs/harness/runs/<runId>` in the workspace repo | Opt-in whole-workspace snapshot per run (`HARNESS_RUN_GIT_CHECKPOINT=1`); never includes `.harness/` |
| Snapshots | `.harness/snapshots/` | Point-in-time backups (pre-recovery, repair script) |
| Event store | `.harness/events/events.jsonl` | Domain events (promise, service, tool, system) |
| Promise ledger | `.harness/promises.jsonl` | Tracked obligations (e.g. "I will follow up") |
| Continuity | Session transcript (`compact_boundary` and `continuity_checkpoint` events) | Summary checkpoint written at each compaction so a resumed session keeps what was compacted |
| Heartbeat history | `.harness/heartbeat/runs.jsonl` (auto-pruned at 1000) | Self-learning tick log |
| Concierge log | `.harness/concierge/log.jsonl` (auto-pruned at 5000) | Routing decisions |

### 3.6 Services (`src/services`)

The largest subsystem. Each service is a focused background or
on-demand capability.

| Service | Responsibility | State |
|---|---|---|
| `taskStore.ts` | Multi-step task tracking | `.harness/tasks/tasks.json` |
| `selfLearningHeartbeat.ts` | Periodic actions: cleanup, reflect, skill-evolution, work-assigned, identity-gc, agent-outputs prune | env: `HARNESS_HEARTBEAT_*` |
| `triggerScheduler.ts` | Pattern → action triggers | `.harness/triggers/triggers.json` |
| `concierge.ts` | Heuristic intent classifier; routes to delegate or direct | `.harness/concierge/log.jsonl` |
| `squad.ts` + `squadSessions.ts` | Multi-agent channels with regex routing | `.harness/squads/*.json` |
| `identity.ts` | SOUL / USER / structured identity rendered into chat prompt | `.harness/identity/*` |
| `memoryIntelligence.ts` | Semantic memory lookup over session history | derived |
| `conceptMemoryClient.ts` | Best-effort TS client for the ccmem sidecar (v0.6.5) | `.harness/ccmem/bank.db` (via sidecar) |
| `modelProfiles.ts` | Per-model `contextMaxTokens` / `validationProfile` / `pairedVisionModel` | `.harness/model-profiles.json` |
| `capabilityRegistry.ts` | Opt-in grants with controls | Grants in `settings.json` (`capabilityGrants`); audit in `.harness/capabilities/audit.jsonl` |
| `capabilityTemplates.ts` + starters | Templated capability bootstrap | derived |
| `promiseLedger.ts` | Obligation tracking | `.harness/promises.jsonl` |
| `artifactCatalog.ts` | Walks `agent-outputs/`, auto-tags by ext | derived |
| `subagentRegistry.ts` | In-memory map of active sub-agents | RAM only |
| `toolFailureAlerts.ts` | Sliding-window failure-rate alarm | RAM + event store |
| `agenticServiceMode.ts` | Operate-mode classifier + handler (vs build mode) | `.harness/` operate state |
| `goalExpander.ts` + `goalSlashCommand.ts` | `/goal` natural-language → structured goal (Apex) | derived |
| `kanbanBridge.ts` | Kanban board → autonomy bridge (Apex) | derived |
| `morningPriority.ts` | Daily morning-priority prompt (Apex) | derived |
| `workerQueue.ts` + `workerExecutors.ts` | Background worker queue with persistence | `.harness/` worker state |

### 3.6a Concept memory sidecar (`ccmem/` + `services/conceptMemoryClient.ts`)

A bundled FastAPI sidecar (`ccmem/service.py`, port 8765) implementing
the Tyukin & Gorban (2018) concept-cell scheme. Each remembered item is
stored as a unit-vector "neuron" with a per-cell firing threshold in
`.harness/ccmem/bank.db` (SQLite). Endpoints: `/write`, `/write_many`,
`/query`, `/bind`, `/health`, `/cells`.

- `memoryTools.ts` dual-writes every `remember` call to ccmem alongside
  the existing markdown memory files.
- `context/assembly.ts` adds a `Concept memory recall` section to the
  auto-recall buffer (shared 4 000-char cap).
- `start.bat` step 6 auto-launches ccmem when Python is present and
  defaults `ccmemUrl` to `http://localhost:8765`.
- Best-effort: if the sidecar is down the harness behaves identically.

### 3.6b Goal loop (`src/goal`)

The `/goal` autonomous outer loop. Drives a goal through verification-gated
iterations until a terminal state. Agnostic of *how* each iteration works —
the caller supplies a `runIteration` callback. Enforces iteration/time
budgets, re-reads goal status between iterations (external pause/abandon
wins), runs verification before and after each iteration, and persists
progress so it survives a crash. Modules: `loop.ts`, `judge.ts`,
`verification.ts`, `shellRunner.ts`, `resume.ts`, `bootResume.ts`,
`runRegistry.ts`, `store.ts`, `queryLoopRunner.ts`, `loopConfig.ts`.

### 3.6c Jarvis layer (`src/jarvis`)

Ambient + voice + reasoning layer. Self-contained; none of it is
required for the core chat loop. Key modules:

| Module | Responsibility |
|---|---|
| `trustLadder.ts` | Per-capability autonomy rungs (confirm vs act autonomously) |
| `knowledgeGraph.ts` (+ compaction, viz) | Entity/fact/edge store with recall and Mermaid export |
| `modelCouncil.ts` | Multi-model deliberation (`runCouncil`) |
| `predictiveEngine.ts` + `predictiveAdapter.ts` | Mines next-action suggestions from event history |
| `ambientDaemon.ts` + `ambientActions.ts` | Ambient signal collection and reactions |
| `dailyBrief.ts` + `briefScheduler.ts` + `briefTrigger.ts` | Composes and schedules a daily brief |
| `mcpServer.ts` + `mcpStdio.ts` | Harness-as-MCP-server bridge (stdio + in-process) |
| `voice.ts` | Speech-to-text / text-to-speech / wake-word config |
| `inboundTriage.ts` | Classifies inbound channel messages into buckets |
| `permissionGate.ts` + `permissionFeedback.ts` + `grantBridge.ts` | Permission gating fed back into the trust ladder |
| `runtimeRegistry.ts` | Tracks which optional runtime features are installed |

### 3.6d Safety / reports / presets

- `src/safety/injectionDefence.ts` — prompt-injection scanning of user
  messages and (by default) tool output.
- `src/safety/untrustedWrap.ts` — wraps external content in
  `<external_content>` so the model treats it as data.
- `src/safety/secretRedactor.ts` — redacts API keys and tokens from traces
  and run logs.
- `src/safety/provenance.ts` — on by default (`HARNESS_PROVENANCE=0`
  disables). A side-effecting call whose recipient, URL or command appears
  only in web, browser or email content needs the user's approval, even in
  `dontAsk`; unattended runs deny it.
- `src/safety/toolInspectors/` — opt-in inspectors (repetition, network
  egress, LLM adversary judge, large-response spooling); see
  [Capability sandbox](CAPABILITY-SANDBOX.md).
- `src/reports/comparisonReport.ts` — renders structured comparison
  reports (e.g. product/option comparisons).
- `src/presets/` — comparison-report category schemas (JSON), loaded by
  `services/comparisonSchema.ts`.

### 3.6e Context (`src/context`)

| Module | Responsibility |
|---|---|
| `assembly.ts` | Builds the system context (base prompt, memory files, skill list, recall), split into stable and per-message sections; token estimates; section caps shrink for windows under 32k |
| `compaction.ts` | Per-turn compaction: cap tool results, shorten long arguments of older tool calls under pressure, then snip or summarise (keeping the previous summary) |
| `toolOutputCompaction.ts` | Strips ANSI noise and head/tail-truncates long tool output |
| `historyWindow.ts` | Fits prior chat history beside the system prompt and tool definitions, cut on fixed blocks so the resent prefix stays cacheable |
| `workingState.ts` | Governed working state: plan, facts, decisions, invariants and enforced protected paths |

### 3.6f Models (`src/models`)

| Module | Responsibility |
|---|---|
| `probeRunner.ts` + `probes/` | `harness probe` suite: tool calling, structured output, instruction following, plan coherence, usable context |
| `capabilityProfile.ts` | Saved profiles in `.harness/model-profiles/<model>.json` and the recommendations derived from scores |
| `adapter.ts` | Per-model request plan (`HARNESS_ADAPTER_MODE=profile`): tool subset, JSON tool calls for weak native callers |
| `modelCatalog.ts`, `modelRegistry.ts`, `modelRouter.ts`, `roleRouting.ts` | Catalog cache, model registry and routing helpers |
| `visionModels.ts` | Vision-model detection |

REST: `GET /api/model-profiles`, `GET /api/model-profiles/:model`,
`POST /api/model-profiles/:model/probe` (asynchronous job).

### 3.6g Verification (`src/verification`)

| Module | Responsibility |
|---|---|
| `claimCheck.ts` | Checks figures in a research answer against the pages read |
| `researchVerifier.ts` | Research-answer verdicts (`HARNESS_VERIFY_RESEARCH=check` by default; `annotate`, `critic`, `gate`) |
| `criticModel.ts` | Picks critic models from a different family than the worker (`HARNESS_CRITIC_MODEL`) |
| `critic.ts`, `panel.ts`, `metrics.ts`, `builtinSignals.ts` | Verification panel signals and metrics |

### 3.7 Web server (`src/web`)

A single Express app at `src/web/server.ts` (~8,600 lines) plus extracted
route modules. REST + SSE + WebSocket. Static SPA served from `ui/`.
Major route groups:

| Prefix | Purpose |
|---|---|
| `/api/chat` | SSE streaming chat |
| `/api/sessions/*` | List, read, delete, search, export |
| `/api/upload`, `/api/uploads/*` | Attachment ingestion |
| `/api/agents`, `/api/subagents/*` | Custom-agent + sub-agent lifecycle |
| `/api/tasks/*` | Task store CRUD |
| `/api/goals/*` | `/goal` loop: create, start, pause, resume, abandon, undo |
| `/api/triggers/*` | Trigger CRUD |
| `/api/squads/*` | Squad CRUD |
| `/api/identity/*` | Identity CRUD + import/export |
| `/api/permissions/*`, `/api/audit*`, `/api/capabilities*` | Security surface |
| `/api/run-logs[/:runId]`, `POST /api/run-logs/:runId/revert` | Run logs and per-step (or `{"mode":"git"}` whole-workspace) rollback (`runRoutes.ts`) |
| `/api/replays[/:jobId]` | Replay recorded runs against other models (`replayRoutes.ts`) |
| `/api/model-profiles[/:model]`, `POST /api/model-profiles/:model/probe` | Capability profiles and probe jobs (`modelProfileRoutes.ts`) |
| `/api/working-memory`, `/api/review-queue/*`, `/api/replay-*`, `/api/governed-metrics` | Governed loop (see [Governed loop](GOVERNED-LOOP.md)) |
| `/api/webhooks/*` | Outbound webhooks, test delivery, dead-letter redelivery |
| `/api/system/health` | Setup doctor + context/vision/heartbeat banners |
| `/api/system/feature-flags` | Runtime toggles for env-gated features |
| `/api/system/model-profiles[/:model]` | Per-model settings overrides: context cap, validation profile, paired vision model (v0.4.2) |
| `/api/setup/health` | Lightweight doctor for the UI |
| `/api/learning/*` | Candidate queue + promotion gate |
| `/api/promises/*` | Promise ledger |
| `/api/events*`, `/api/events/summary` | Event store reader |
| `/api/artifacts*` | agent-outputs browser |
| `/api/output-validation/*` | Profile config + feedback replay |
| `/metrics` | Prometheus exposition (v0.4.0) |
| `/ws` | WebSocket fanout (with optional `event_batch` coalescing) |

`buildAttachmentsContextBlock` (v0.4.2) injects an authoritative file
list with inline head (and head+tail for `.log/.csv/.tsv/.jsonl`)
previews into the chat system prompt so the model rarely needs a
`file_read` round-trip for "what's in this attachment?" questions.

### 3.8 Setup / Doctor (`src/setup`)

| Module | Responsibility |
|---|---|
| `health.ts` | Doctor probes (Ollama, vision, audio, PDF OCR, local fs, mycelium, backends, fallback) |
| `doctorFix.ts` (v0.4.2) | Auto-remediation: vision pull (`--yes` or TTY Y/n), context legacy-default rewrite, agent-outputs prune |

CLI: `harness doctor [--watch] [--fix [--yes]]`.

### 3.9 Observability (`src/observability`)

| Module | Responsibility |
|---|---|
| `prometheus.ts` | Pure formatter for `/metrics` (no `prom-client` dep) |
| `openinference.ts` | TraceRecord/Event → OTLP span JSON mappers |
| `otlpExporter.ts` | Bounded queue, eager+timer flush, re-queue on transport error |

Env: `HARNESS_OTEL_EXPORT_ENABLED=1`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`.

Metrics published: `harness_kill_switch_active`,
`harness_active_subagents`, `harness_capability_grants_active`,
`harness_heartbeat_age_seconds`, `harness_otel_export_queued`,
`harness_tool_window_samples`, `harness_tool_failure_rate`.

### 3.10 Mycelium router (`src/mycelium`)

A long-term reward-weighted routing graph. Classifies user intent and
routes through nodes (safety / agent / verifier / workflow). Episodes
update edge weights with reward; weak edges are archived on `decay` /
`prune`. Storage: `.harness/mycelium/graph.json` (env-overrideable).

CLI: `harness mycelium {init|seed|status|route|decay|prune|export|classify}`.
Inspector UI in the More menu surfaces nodes / edges / recent episodes.

See [docs/MYCELIUM-ROUTER.md](MYCELIUM-ROUTER.md) for the full graph
contract.

### 3.11 Eval (`src/eval`)

| Module | Responsibility |
|---|---|
| `probes.ts` | 8 default probes across baseline / prompt-injection / secret-exfil / tool-misuse / safety-refusal |
| `simulator.ts` | Drives a running daemon over `/api/chat` SSE; emits a structured run record the promotion gate can ingest |
| `replay.ts` | Re-runs a recorded chat against other models with the recorded tool results (deterministic) or live read-only tools; history benchmarks; reports turns, tokens, cached tokens, distinct cacheable prefixes, cost, unsupported claims and stuck runs |
| `costTracker.ts` | Per-model token prices (backend-prefixed ids resolve too) |

CLI: `harness simulate [--probe <id>] [--category <name>] [--probe-timeout <ms>] [--persist]`,
`harness replay <runId|--last N> --model <m> [--live] [--defer-tools]`,
`harness benchmark-history --models a,b [--last N] [--defer-tools]`.

### 3.12 Learning (`src/learning`)

| Module | Responsibility |
|---|---|
| `sessionLearning.ts` | Extracts candidates from finished sessions |
| `lessons.ts` | Lessons from each finished run's log (blocked sites, stuck requests, unsupported figures, budget overruns) in `.harness/learning/lessons.json`; recalled into prompts only with `HARNESS_LESSONS=recall`; also records skill outcomes |
| `promotionGate.ts` | Multiplicative safety gate + pass-count threshold |
| `evalTrace.ts` | Persists eval-trace runs the gate consults |
| `autonomyPrompt.ts`, `promptApproval.ts` | Gated evolved prompt for unattended runs (`HARNESS_APPLY_EVOLVED_PROMPT_AUTONOMY=1`) |

REST: `/api/learning/candidates*`, `/api/learning/candidates/:id/gate`.

### 3.13 TUI (`src/tui`)

`harness tui` opens a terminal client that shares the running daemon's
session. Built on readline + ANSI escapes only — zero new runtime
dependencies. Auto-reconnects on WebSocket close. Slash commands:
`/quit`, `/exit`, `/help`, `/agents`, `/clear`.

### 3.14 Integrations (`src/integrations`)

Discord, Slack, Telegram, WhatsApp and outbound webhooks. Each one is a
self-contained adapter; nothing here is required for the core chat
loop. Connector tokens are stored with the API keys in
`.harness/api-keys.json` (mode `0600`; legacy plain-text values in
`settings.json` are migrated there on first load) or come from the
environment variables in § 5.

## 4. Storage layout (`.harness/`)

```
.harness/
  settings.json                   ← user-tunable runtime config
  api-keys.json                   ← backend API keys and connector tokens (mode 0600)
  sessions/<id>.jsonl             ← append-only transcripts
  runs/<runId>.jsonl              ← per-run event logs (newest 500, 300 MB cap)
  side-effects.jsonl              ← per-step file changes and how to undo them
  snapshots/                      ← backups (pre-recovery, repair script)
  uploads/                        ← drag-drop attachments (UI / API)
  agents/<id>.md                  ← custom agent definitions
  skills/<name>/SKILL.md          ← workspace skills (+ _history/, _archive/)
  skill-usage.json                ← skill use counts, outcomes, probation, pins
  squads/*.json + sessions.json   ← squad config + session→squad mapping
  identity/{SOUL.md, USER.md, structured.json}
  capabilities/audit.jsonl        ← grant lifecycle audit (grants live in settings.json)
  promises.jsonl
  tasks/tasks.json
  triggers/triggers.json
  audit.log                       ← JSONL
  events/events.jsonl             ← JSONL
  heartbeat/runs.jsonl            ← JSONL, auto-pruned at 1000
  concierge/log.jsonl             ← JSONL, auto-pruned at 5000
  mycelium/graph.json
  evals/trace-runs.jsonl
  learning/lessons.json           ← lessons from finished runs
  ccmem/bank.db                   ← concept-cell semantic memory (v0.6.5, SQLite)
  ccmem/token                     ← ccmem shared token
  model-profiles.json             ← per-model settings overrides (v0.4.2)
  model-profiles/<model>.json     ← capability profiles from `harness probe`
  protected-paths.json            ← optional paths tools must never modify
  daily-spend.json                ← spend ledger for HARNESS_DAILY_SPEND_USD
  file-write-redirects.json       ← optional path-pattern redirects
  curator/log.jsonl + proposals.md
agent-outputs/                    ← corral for bare-filename file_write (project root)
```

## 5. Environment flags

The `HARNESS_*` variables the runtime in `src/` reads, grouped by area.
Boolean flags turn on with `1` unless noted; flags that default **on**
turn off with `0`. Several have longer explanations in the
[README "What's new" list](../README.md#whats-new-since-v065-in-development) and in
[CAPABILITY-SANDBOX.md](CAPABILITY-SANDBOX.md). The autonomy loop
(`cookbook/task-loop.ts`) and the smoke / diagnostic scripts under
`scripts/` read further variables of their own, documented in each
file's header. `HARNESS_DIR`, `HARNESS_ROOT`, `HARNESS_STATE_DIR` and
`HARNESS_SKILL_DIR` appear in the code as constants or template
placeholders, not settings.

### Agent loop and run recording

| Var | Default | Effect |
|---|---|---|
| `HARNESS_RUN_LOG` | on | Record every chat run to `.harness/runs/<runId>.jsonl` (secrets redacted) |
| `HARNESS_RUN_GIT_CHECKPOINT` | off | Also snapshot the whole workspace (except `.harness/`) per run in a shadow git index |
| `HARNESS_SUPERVISOR` | on | Run supervisor: progress check → strategy change → stop and ask |
| `HARNESS_RUN_MAX_TOKENS` | 1,500,000 | Per-run token budget enforced by the supervisor |
| `HARNESS_RUN_MAX_USD` | unset | Per-run USD cap for priced models |
| `HARNESS_LOOP_HARDENING` | on | Iteration budget, repeat/no-progress guards |
| `HARNESS_LOOP_INACTIVITY_MS` | 0 (off) | Abort a model call that streams nothing for this long |
| `HARNESS_PERMISSION_PROMPT_TIMEOUT_MS` | 300000 | How long a permission prompt waits before it counts as denied |
| `HARNESS_GOVERNED_SHADOW` | off | Emit `governed_shadow` events (governed-runtime dry run) |
| `HARNESS_CONDUCTOR` | off | CLI headless runs go through the task conductor (plan → steps) |
| `HARNESS_SURGICAL_CRITIC` | off | Task conductor's fix prompt names the failing and passing checks instead of a generic "diagnose and fix" |
| `HARNESS_LEAD` | off | CLI headless runs use the lead agent: parallel sub-agent workstreams, verified and re-planned until they pass |
| `HARNESS_DEBUG_LOG` | unset | File path; append raw model requests/responses for debugging |
| `HARNESS_MAX_TURNS` | 30 | Turn cap for runs started by `POST /api/autonomy/start` |

`POST /api/autonomy/start` also passes `HARNESS_MODEL`, `HARNESS_BACKEND`,
`HARNESS_PERMISSION_MODE`, `HARNESS_TIME_BUDGET_MS`,
`HARNESS_UNPRODUCTIVE_TURN_LIMIT` and `HARNESS_HOME` to the autonomy loop
from the request body; set them yourself only when running
`cookbook/task-loop.ts` directly.

### Context and tokens

| Var | Default | Effect |
|---|---|---|
| `HARNESS_WORKING_STATE` | off | `on` adds the typed working state (plan, facts, decisions, open questions) |
| `HARNESS_WORKING_STATE_POSITION` | system | `tail` sends the working state as the last message instead |
| `HARNESS_PROMPT_LAYOUT` | default | `cache` keeps the system prompt byte-stable and moves per-turn context into a `<harness_context>` message |
| `HARNESS_TOOL_LOADING` | off | `deferred` offers core + relevant tools and `tool_search`; `auto` defers only when schemas take a large share of the window |
| `HARNESS_ADAPTER_MODE` | off | `profile` fits tools and tool-call format to the model's capability profile |
| `HARNESS_SCAFFOLD_MODE` | off | `profile`, `light`, `medium` or `heavy` scaffolding |
| `HARNESS_TOOL_COMPRESSION_ENABLED` | on | Compress large tool results before they enter history |
| `HARNESS_TOOL_COMPRESSION_MAX_CHARS` | built-in | Character cap used by that compression |
| `HARNESS_CHAT_MYCELIUM_SHORTLIST` | off | Use the Mycelium router's tool shortlist for web chat |
| `HARNESS_STREAM_TEXT` | on | Web chat shows the reply live as it is generated (`text_delta` previews, replaced by the final checked `text`) when the request sets `streamText: true`, as the web UI does; `0` turns it off for everyone |

### Verification and learning

| Var | Default | Effect |
|---|---|---|
| `HARNESS_VERIFY_RESEARCH` | check | `off`, `check`, `annotate`, `critic` or `gate`; checks research answers against the pages read |
| `HARNESS_CRITIC_MODEL` | auto | Critic model for `critic`/`gate` research checks and the adversary inspector |
| `HARNESS_VERIFY_PATH_CLAIMS` | off | Append a footer flagging file paths in the final answer that don't exist |
| `HARNESS_VERIFY` | auto | `1`/`0` forces post-completion code verification on/off (the CLI turns it on when `package.json` exists). Runs typecheck, ESLint and npm/pytest/go/cargo tests in the project root; a failing check goes back to the model once to fix |
| `HARNESS_LESSONS` | record | `off`, `record`, or `recall` (also injects up to four relevant lessons) |
| `HARNESS_PROMOTION_GATE_ENABLED` | off | Block learning-candidate promotion on safety / pass count |
| `HARNESS_PROMOTION_REQUIRE_EXPERIMENT` | off | Also require a confirming experiment (`HARNESS_PROMOTION_EXPERIMENT_ID`, `HARNESS_PROMOTION_CANDIDATE_VARIANT_ID`) |
| `HARNESS_EXPERIMENT_PROMPT_OVERRIDE` | off | Let chat requests carry their own `systemPrompt` (experiments only) |
| `HARNESS_APPLY_EVOLVED_PROMPT_AUTONOMY` | off | Autonomy runs use the approved evolved system prompt |
| `HARNESS_CURATOR_SAFETY_GATE` | off | Curator won't archive a skill that matches a high-severity safety rule (logged as `skip-safety`) |
| `HARNESS_DISABLE_BUILD_GATE` | off | Skip the post-chat build check on changed files |

### Security, permissions and API

| Var | Default | Effect |
|---|---|---|
| `HARNESS_API_AUTH_TOKEN` | unset | Bearer token (or `X-Harness-Api-Token` header) for `/api/*` |
| `HARNESS_API_AUTH_REQUIRED` | auto | Override: auth is on when a token is set or the bind is non-loopback; `0` with a token is an insecure override |
| `HARNESS_PROVENANCE` | on | Untrusted web/browser/email content cannot authorise side effects, even in `dontAsk` |
| `HARNESS_NERVOUS_ALLOW_UNVERIFIED` | off | Let nervous-system actions run without verification (always bypassed in `dontAsk`) |
| `HARNESS_AUDIT_LOG` | on | `off` disables audit log writes |
| `HARNESS_DAILY_SPEND_USD` | unset | Daily spend cap for remote backends (`.harness/daily-spend.json`) |
| `HARNESS_FILE_WRITE_REDIRECTS` | unset | JSON array of file-write redirect rules; overrides `.harness/file-write-redirects.json` |
| `HARNESS_BROWSER_URL_ALLOWLIST` | unset | Comma-separated domains (wildcards allowed) the browser tools may visit |
| `HARNESS_INSPECTOR_*`, `HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD` | off | Tool inspectors (egress, repetition, adversary) and response spooling; see [CAPABILITY-SANDBOX.md](CAPABILITY-SANDBOX.md) |
| `HARNESS_MEMORY_CONFLICT_ENFORCE` | off | Block memory writes that conflict with existing entries |
| `HARNESS_MEMORY_CONFLICT_THRESHOLD` | built-in | Similarity (0–1] that counts as a conflict |
| `HARNESS_TOOL_ALERT_THRESHOLD`, `HARNESS_TOOL_ALERT_WINDOW`, `HARNESS_TOOL_ALERT_MIN_SAMPLES`, `HARNESS_TOOL_ALERT_COOLDOWN_MS` | 0.30 / 50 / 10 / 300000 | Tool-failure alert tuning (per tool) |

### Backends and models

| Var | Default | Effect |
|---|---|---|
| `HARNESS_BACKEND` | ollama | OpenAI-compatible preset to use (`cerebras`, `groq`, `github`, …) |
| `HARNESS_MODEL_<ROLE>` | unset | Model for a loop role (`MAKER`, `JUDGE`, `PLANNER`, `READBACK`); beats `models.config.json` |
| `HARNESS_REMOTE_AUTO_FALLBACK` | on | `0` disables rate-limit auto-fallback |
| `HARNESS_REMOTE_FALLBACK_ORDER` | built-in | Comma-separated fallback chain |
| `HARNESS_REMOTE_FALLBACK_COOLDOWN_MS` | 30000 | How long a rate-limited backend is skipped |
| `HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS` | 2 | Ollama chat attempts on transient errors (1–5) |
| `HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS` | 500 | Delay between those attempts |
| `HARNESS_OLLAMA_EMPTY_RETRY_MAX_ATTEMPTS` | 5 | Retries when Ollama returns an empty reply |
| `HARNESS_OLLAMA_EMPTY_RETRY_DELAY_MS` | 300 | Delay between empty-reply retries |

Backend keys read by `chatClientFactory`: `OLLAMA_HOST`, `OLLAMA_API_KEY`,
`CEREBRAS_API_KEY`, `GROQ_API_KEY`, `GITHUB_TOKEN` / `GITHUB_MODELS_TOKEN`,
`OPENAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`,
`REPLICATE_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### Memory, skills and knowledge

| Var | Default | Effect |
|---|---|---|
| `HARNESS_CCMEM_URL` | `http://localhost:8765` | Concept-memory sidecar URL |
| `HARNESS_CCMEM_TOKEN` | unset | Sidecar auth token (otherwise read from `.harness/ccmem/token` if present) |
| `HARNESS_GLOBAL_SKILLS_DIR` | `~/.harness/skills` | Global skills tier |
| `HARNESS_RAG_MODEL` | `nomic-embed-text` | Embedding model for the RAG index |
| `HARNESS_RAG_BACKEND` | auto | `ollama` or `hash` embeddings for PDF-to-wiki ingestion |
| `HARNESS_CODE_INTEL_IGNORE` | unset | Comma-separated directories code intelligence skips |
| `HARNESS_SESSION_ID` | unset | Session id recorded as the source of memory writes, for hosts that set one process-wide |

### Background services and UI

| Var | Default | Effect |
|---|---|---|
| `HARNESS_PROFILE` / `HARNESS_ASSISTANT` | unset | `HARNESS_PROFILE=assistant` (or `HARNESS_ASSISTANT=1`) turns the personal-assistant features on by default |
| `HARNESS_HEARTBEAT_ENABLED` | off | Run periodic actions |
| `HARNESS_HEARTBEAT_INTERVAL_MIN` | 5 | Tick cadence |
| `HARNESS_HEARTBEAT_REFLECT_ENABLED` | off | Surface reflections in tick |
| `HARNESS_HEARTBEAT_SKILL_EVOLUTION_ENABLED` | off | Dry-run stale-skill detection |
| `HARNESS_HEARTBEAT_CLEANUP_OUTPUTS` | on | Prune stale agent-outputs |
| `HARNESS_AGENT_OUTPUT_MAX_AGE_DAYS` | 14 | Cutoff for the prune above |
| `HARNESS_TRIGGERS_ENABLED` | off | Run trigger scheduler |
| `HARNESS_CONCIERGE_ENABLED` | off | Insert concierge note into prompt |
| `HARNESS_CONCIERGE_AUTO_ROUTE` | off | Concierge can dispatch without asking |
| `HARNESS_SQUAD_AUTO_ROUTE` | off | Squad routing engaged on every chat turn |
| `HARNESS_AMBIENT_ENABLED` | profile | `1`/`0` forces the ambient watchers on/off |
| `HARNESS_AMBIENT_GIT_POLL_MS` | 15000 | Ambient git watcher poll interval |
| `HARNESS_AMBIENT_SCHEDULER_MS` | 0 (off) | Ambient scheduler interval |
| `HARNESS_OTEL_EXPORT_ENABLED` | off | Push spans to OTLP collector |
| `HARNESS_EVENT_RETENTION_DAYS` | 30 | Automation event retention |
| `HARNESS_DISABLE_STARTUP_CONNECTORS` | off | Don't start messaging connectors at boot |
| `HARNESS_WS_COALESCE_MS` | 0 | When > 0, batch WS events into `event_batch` |
| `HARNESS_SESSION_VIEW_THROTTLE_MS` | 80 | Session-view snapshot throttle |
| `HARNESS_UI_SMOKE_CHAT` | off | Test hook for the UI permission-recovery smoke |

### Paths

| Var | Effect |
|---|---|
| `HARNESS_PROJECT_DIR` | Project directory: where `.harness/` state lives and the root tools resolve paths against. Defaults to the cwd, or `~/apex-workspace` when the cwd is the harness checkout |
| `HARNESS_UPLOADS_DIR` | Absolute or project-relative uploads dir |
| `HARNESS_GLOBAL_UPLOADS=1` | Use `~/.harness/uploads` |
| `HARNESS_AGENT_OUTPUT_DIR` | Absolute or project-relative outputs dir |
| `HARNESS_BUILD_TARGETS` | Extra writable build paths (path-delimited; set by the autonomy loop) |
| `HARNESS_PANDOC_PATH` | `pandoc` executable for PDF/DOCX conversion |

### Messaging and email

| Var | Effect |
|---|---|
| `HARNESS_DISCORD_BOT_TOKEN`, `HARNESS_DISCORD_ALLOWED_CHANNEL_IDS` | Discord bot and the channels it answers in |
| `HARNESS_SLACK_WEBHOOK_URL` | Slack incoming webhook |
| `HARNESS_TELEGRAM_BOT_TOKEN`, `HARNESS_TELEGRAM_ALLOWED_CHAT_IDS` | Telegram bot; it refuses to start without an allow-list unless `HARNESS_TELEGRAM_ALLOW_ANY_CHAT=1` |
| `HARNESS_WHATSAPP_ACCESS_TOKEN`, `HARNESS_WHATSAPP_PHONE_NUMBER_ID`, `HARNESS_WHATSAPP_ALLOWED_RECIPIENTS` | WhatsApp Cloud API; all three are required |
| `HARNESS_WEBHOOK_URL`, `HARNESS_WEBHOOK_SECRET` | Outbound webhook, HMAC-signed with the secret |
| `HARNESS_SMTP_HOST`, `HARNESS_SMTP_PORT`, `HARNESS_SMTP_USER`, `HARNESS_SMTP_PASS`, `HARNESS_SMTP_FROM` | SMTP for sending email |
| `HARNESS_IMAP_HOST`, `HARNESS_IMAP_PORT` | IMAP for reading email (host falls back to SMTP host; port 993) |

### Media

| Var | Effect |
|---|---|
| `HARNESS_VISION_MODEL` | Vision model to use for `image_analyze` |
| `HARNESS_AUDIO_TRANSCRIBE_COMMAND` | Shell command with `{input}` placeholder |
| `HARNESS_WHISPER_BIN` | Whisper executable for `audio_transcribe` |
| `HARNESS_WHISPER_BINARY` + `HARNESS_WHISPER_MODEL` | whisper.cpp binary and model for Jarvis voice |
| `HARNESS_WHISPER_PYTHON` + `HARNESS_WHISPER_MODEL_NAME` | Python whisper for Jarvis voice (model default `base.en`) |
| `HARNESS_PDF_OCR_COMMAND` | Optional OCR command for `pdf_read` |
| `HARNESS_PDF_RENDER_COMMAND` | Page renderer for `pdf_render_page` (`{input}`, `{page}`, `{output}`) |
| `HARNESS_BROWSER_*` | Browser session, profile, channel, CDP URL, headful mode; see [CAPABILITY-SANDBOX.md](CAPABILITY-SANDBOX.md) |

Some flags also have settings.json mirrors via `PATCH /api/system/feature-flags`
(keys: `heartbeatEnabled`, `triggersEnabled`, `conciergeEnabled`,
`conciergeAutoRoute`, `squadAutoRoute`, `otelExportEnabled`).

## 6. CLI commands

```text
harness                     interactive chat with the local daemon
harness -p "..."            single-prompt headless mode
harness doctor              setup + auth health probes
harness doctor --watch [s]  re-run every N seconds
harness doctor --fix [-y]   auto-remediate (vision / context / prune)   ← v0.4.2
harness mycelium <sub>      router graph commands
harness tui                 terminal client over the daemon
harness simulate [...]      run probes and emit an eval-trace run
harness replay <runId|--last N> --model <m> [--model <m>] [--live] [--defer-tools] [--json]
                            replay recorded runs against other models
harness benchmark-history --models a,b [--last 10] [--defer-tools] [--json]
                            replay recent tool-using chats across candidates
harness probe <model> [--backend b] [--host url] [--max-context n] [--samples n]
                            measure a model and save its capability profile
```

Full flag list: `harness --help`. Backend selection: `--backend cerebras`
(or env `HARNESS_BACKEND`). Output validation: `--validate-output coding-answer`.

## 7. Operational runbook

### A model produces gibberish or refuses to use tools

1. Check the System Health "Context auto-detected as N tokens" banner —
   tiny models with 4k windows behave very differently than 128k cloud
   models.
2. Run `harness doctor --fix` — it will rewrite a stale legacy default
   to auto-mode.
3. If using a small open-weight model, consult the user-memory note
   (`/memories/llm-backends.md`) — `gemma4:e4b/26b` and
   `qwen2.5-coder:7b/14b` have known tool-emission issues mitigated by
   the JSON-in-content fallback parser.

### `image_analyze` says "vision not configured"

1. Look at the System Health Vision banner — it tells you whether the
   configured model is installed.
2. Run `harness doctor --fix` — on a TTY it will offer to pull
   `llava:latest` (~4GB).
3. Or pull manually: `ollama pull llava:latest`.

### Daemon serves multiple workspaces and uploads scatter

Set `HARNESS_GLOBAL_UPLOADS=1` and restart the daemon. All uploads
land in `~/.harness/uploads/`.

### Switching from a tiny local model to a big cloud model drags wrong settings

Open System Health. Find the **Per-model profile for `<active model>`**
panel. Set the cap to `0` (auto) for the cloud model. Switch back to
the small model and set its cap to whatever throttle you want. Profiles
persist across daemon restarts via `.harness/model-profiles.json`.

### Stale `agent-outputs/` polluting `grep` results

Heartbeat prunes at 14 days by default. Force a manual prune:
`harness doctor --fix`.

### A capability grant locked you out of `docker_exec`

Check `/api/capabilities` for active grants. Re-grant via the UI
Capabilities tab (capability `arbitrary-shell`).

### Tool failures spike

`/api/system/health` shows the tool-failure-alert state. Defaults: a tool
alerts when at least 30% of its last 50 calls failed (needs at least 10
calls), then stays quiet for 5 minutes. Tune with `HARNESS_TOOL_ALERT_THRESHOLD`,
`HARNESS_TOOL_ALERT_WINDOW`, `HARNESS_TOOL_ALERT_MIN_SAMPLES` and
`HARNESS_TOOL_ALERT_COOLDOWN_MS`.

## 8. Release pipeline

| Step | Command |
|---|---|
| 1. Stage | `git add <changed files>` (skip `.copilot-tracking/`, user data) |
| 2. Commit | `git commit -m "feat: vX.Y.Z – ..."` (subject ≤ 72 chars, body bullets) |
| 3. Tag | `git tag -a vX.Y.Z -m "..."` |
| 4. Push | `git push origin master --follow-tags` |
| 5. Verify | `git log --oneline -3` shows new commit + tag |

For release artifacts (zip + installer) see [docs/RELEASE-PIPELINE.md](RELEASE-PIPELINE.md).

## 9. Test discipline

- 4,050 tests across 358 suites (2026-10-08), 1 skipped. **Every cycle
  stays green.** `src/persistence/gitCheckpoint.test.ts` runs real `git`
  and has a 30 s timeout for slow Windows runners.
- Run focused: `npx jest <file>` or `npx jest -t "<name pattern>"`.
- Run full: `npx jest --silent`.
- Typecheck: `npx tsc --noEmit`.

## 10. Where to file changes

| Need | Goes in |
|---|---|
| New tool the model can call | `src/tools/<name>.ts` + register in `src/tools/registry.ts` |
| New background action | `src/services/selfLearningHeartbeat.ts` factory |
| New REST route | A `src/web/<area>Routes.ts` router module mounted from `src/web/server.ts` (or an existing one for that area) |
| New UI tab/control | `ui/index.html` + `ui/app.js` |
| New backend | `src/core/chatClientFactory.ts` preset entry |
| New custom agent | `.harness/agents/<id>.md` markdown file |
| New capability | `src/services/capabilityRegistry.ts` constant + UI action |
| New env flag | Read where it's used; add it to [§5](#5-environment-flags); mirror via `feature-flags` PATCH if user-toggleable |
| New eval probe | `src/eval/probes.ts` |

## 11. Out-of-scope (deliberately not done)

- **No daemon-side cloud database.** Everything is `.harness/`. Adding
  Postgres / SQLite would break the local-first promise.
- **No model-specific runtime hooks.** The harness runs many backends;
  Claude- or GPT-specific behaviour stays out of `core/queryLoop.ts`.
- **No HybridTurtle features here.** The Harness repo and HybridTurtle
  are separate concerns. Per user preference, HybridTurtle gets verify
  / harden, not new features.

## 12. Status snapshot at v0.6.5

| Surface | State |
|---|---|
| Tests | 2392 / 2393 green (206 suites); 1 known flake |
| Typecheck | Clean |
| Headline feature | ccmem concept-cell semantic memory (dual-write `remember`, meaning-based recall) |
| Autonomous experiences | Apex family (`/goal`, PDF→wiki, Kanban→autonomy, competitor research, memory wiki, morning priority) — renamed from Hermes |
| Startup | Hardened (BOM path fix, clearer `npm install` errors, ccmem auto-launch) |
| Open backlog | None blocking |
| Recommended next action | Use the harness for real work. Return to code only when something actually breaks. |
