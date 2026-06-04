# Ollama Agent Harness — System Breakdown

**Version**: v0.6.4 (2026-06-02)
**Tests**: 2392 / 2393 across 206 suites (1 known flake) · **Modules**: 234 source · 206 test files
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

- **Local-first.** Every storage path is under `.harness/` in the
  current working directory. No daemon-side cloud database.
- **Model-agnostic.** Ollama is the default backend, but the chat
  client factory abstracts Cerebras, Groq, GitHub Models, OpenAI,
  Mistral, OpenRouter, Replicate, and Cloudflare. No code path
  assumes Claude- or GPT-specific behaviour.
- **Env-gated additions.** Every new behaviour added since v0.4.0
  defaults OFF via a `HARNESS_*_ENABLED` env flag. Existing installs
  keep working without reading release notes.
- **Test-as-spec.** 2392 passing tests are the ground truth for
  behaviour. When this document and a test disagree, the test wins.

## 2. Top-level layout

```
src/
  agents/         Sub-agent orchestration, model routing, custom-agent loader
  automation/     Background scheduler, job-safety guards, recurring tasks
  cli/            `harness` entry point, command registry, parser
  context/        System-prompt assembly + injection (incl. concept-memory recall)
  core/           Chat client, query loop, validation, fallback routing,
                  tracing, structured output, rate limiting
  curator/        Memory curation scheduler
  eval/           Adversarial probes + simulator (eval traces)
  extensibility/  MCP server bridge + capability template starters
  goal/           `/goal` outer loop: verification-driven autonomous iteration
  integrations/   Discord, Slack, Telegram, Teams, GitHub PR
  jarvis/         Ambient/voice layer: trust ladder, knowledge graph, model
                  council, predictive engine, daily brief, MCP server, voice
  learning/       Reflection extractor, candidate promotion gate, eval traces
  models/         Vision-model registry, model capability inference
  mycelium/       Context router graph (long-term routing memory)
  nervous/        Reflex layer (signal-driven heuristics)
  observability/  Prometheus, OpenInference, OTLP exporter
  permissions/    Engine, audit log, prompt broker, capability registry
  persistence/    Session storage, event store, promise ledger, continuity
  presets/        Bundled preset data
  reports/        Comparison-report rendering
  safety/         Prompt-injection defence
  services/       Heartbeat, triggers, concierge, squads, identity, tasks,
                  memory intelligence, model profiles, capability registry,
                  concept-memory client, operate-mode, Apex (goal/kanban/
                  morning-priority), worker queue
  setup/          `doctor`, `doctor --fix`, health probes
  tools/          File/grep/web/PDF/image/audio/squad/agent/task/docker tools
  tui/            Terminal client (readline + ANSI, no Ink)
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
| `ollamaClient.ts`, `openAiCompatibleClient.ts` | Backend adapters |
| `fallbackChatClient.ts` | Auto-fallback on rate-limit / 5xx |
| `queryLoop.ts` | Tool dispatch, turn budget, structured output validation |
| `outputValidation.ts` | Profile-driven final-answer checks |
| `synthesisStats.ts` | Per-model adaptive `maxTurns` |
| `rateLimiter.ts` | Local + remote throttle |
| `readinessGate.ts` | Pause until backend reports ready |
| `tracing.ts` | RuntimeTracer (in-memory) feeding the OTLP exporter |
| `structuredOutputValidator.ts` | JSON-schema enforcement |

State: per-session in `.harness/sessions/`. Backend choice is decided
at `chatClientFactory.createChatClient()` time and re-decided per
request when the daemon restarts.

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

The 30+ built-in tools the model can call. Roughly grouped:

| Group | Tools |
|---|---|
| Filesystem | `file_read`, `file_write`, `list_files`, `grep_search`, `list_uploads` |
| Web | `web_read`, `web_search`, `image_analyze`, `pdf_read`, `audio_transcribe` |
| Process | `docker_exec` (capability-gated), shell tool (capability-gated) |
| Agent | `task_*`, `agent_*`, `squad_inspect`, `subagent` factory |
| Memory | `memory_*`, mycelium tools, identity tools |
| Other | `kill_switch_status`, MCP bridge tools, capability template starters |

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
| Sessions | `.harness/sessions/*.json` | Conversation transcript per session |
| Event store | `.harness/events/events.jsonl` | Domain events (promise, service, tool, system) |
| Promise ledger | `.harness/promises/*.json` | Tracked obligations (e.g. "I will follow up") |
| Continuity | `.harness/continuity.json` | Cross-session context bridge |
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
| `conceptMemoryClient.ts` | Best-effort TS client for the ccmem sidecar (v0.6.4) | `.harness/ccmem/bank.db` (via sidecar) |
| `modelProfiles.ts` | Per-model `contextMaxTokens` / `validationProfile` / `pairedVisionModel` | `.harness/model-profiles.json` |
| `capabilityRegistry.ts` | Opt-in grants with controls | `.harness/capabilities/*.json` |
| `capabilityTemplates.ts` + starters | Templated capability bootstrap | derived |
| `promiseLedger.ts` | Obligation tracking | `.harness/promises/*` |
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

- `src/safety/injectionDefence.ts` — prompt-injection defence over tool
  output and untrusted content.
- `src/reports/comparisonReport.ts` — renders structured comparison
  reports (e.g. product/option comparisons).
- `src/presets/` — bundled preset data.

### 3.7 Web server (`src/web`)

A single Express app at `src/web/server.ts` (~8200 lines). REST + SSE
+ WebSocket. Static SPA served from `ui/`. Major route groups:

| Prefix | Purpose |
|---|---|
| `/api/chat` | SSE streaming chat |
| `/api/sessions/*` | List, read, delete, search, export |
| `/api/upload`, `/api/uploads/*` | Attachment ingestion |
| `/api/agents`, `/api/subagents/*` | Custom-agent + sub-agent lifecycle |
| `/api/tasks/*` | Task store CRUD |
| `/api/triggers/*` | Trigger CRUD |
| `/api/squads/*` | Squad CRUD |
| `/api/identity/*` | Identity CRUD + import/export |
| `/api/permissions/*`, `/api/audit*`, `/api/capabilities*` | Security surface |
| `/api/system/health` | Setup doctor + context/vision/heartbeat banners |
| `/api/system/feature-flags` | Runtime toggles for env-gated features |
| `/api/system/model-profiles[/:model]` | Per-model profile CRUD (v0.4.2) |
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

CLI: `harness simulate [--probe <id>] [--category <name>] [--probe-timeout <ms>] [--persist]`.

### 3.12 Learning (`src/learning`)

| Module | Responsibility |
|---|---|
| `sessionLearning.ts` | Extracts candidates from finished sessions |
| `promotionGate.ts` | Multiplicative safety gate + pass-count threshold |
| `evalTrace.ts` | Persists eval-trace runs the gate consults |

REST: `/api/learning/candidates*`, `/api/learning/candidates/:id/gate`.

### 3.13 TUI (`src/tui`)

`harness tui` opens a terminal client that shares the running daemon's
session. Built on readline + ANSI escapes only — zero new runtime
dependencies. Auto-reconnects on WebSocket close. Slash commands:
`/quit`, `/exit`, `/help`, `/agents`, `/clear`.

### 3.14 Integrations (`src/integrations`)

Discord, Slack, Telegram, Teams, GitHub PR. Each one is a
self-contained adapter; nothing here is required for the core chat
loop. Tokens come from `.harness/secrets/connectors.json` (auto-migrated
from legacy plain-text settings on first read).

## 4. Storage layout (`.harness/`)

```
.harness/
  settings.json                   ← user-tunable runtime config
  secrets/
    connectors.json               ← Discord/Slack/Telegram tokens (gitignored)
    api-keys.json                 ← Cerebras/Groq/GitHub keys
  sessions/<id>.json
  uploads/                        ← drag-drop attachments (UI / API)
  agent-outputs/                  ← corral for bare-filename file_write
  agents/<id>.md                  ← custom agent definitions
  squads/*.json + sessions.json   ← squad config + session→squad mapping
  identity/{SOUL.md, USER.md, structured.json}
  capabilities/*.json             ← grants
  promises/*.json
  tasks/tasks.json
  triggers/triggers.json
  audit.log                       ← JSONL
  events/events.jsonl             ← JSONL
  heartbeat/runs.jsonl            ← JSONL, auto-pruned at 1000
  concierge/log.jsonl             ← JSONL, auto-pruned at 5000
  mycelium/graph.json
  evals/trace-runs.jsonl
  ccmem/bank.db                   ← concept-cell semantic memory (v0.6.4, SQLite)
  model-profiles.json             ← per-model overrides (v0.4.2)
  file-write-redirects.json       ← optional path-pattern redirects
  curator/state.json
```

## 5. Environment flags

The exhaustive list of `HARNESS_*` flags. All default OFF unless noted.

### Feature gates

| Var | Default | Effect |
|---|---|---|
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
| `HARNESS_OTEL_EXPORT_ENABLED` | off | Push spans to OTLP collector |
| `HARNESS_PROMOTION_GATE_ENABLED` | off | Block learning-candidate promotion on safety / pass count |
| `HARNESS_AUDIT_LOG` | on | Set to `off` to disable audit log writes |
| `HARNESS_WS_COALESCE_MS` | 0 | When > 0, batch WS events into `event_batch` |

### Path overrides

| Var | Effect |
|---|---|
| `HARNESS_UPLOADS_DIR` | Absolute or project-relative uploads dir |
| `HARNESS_GLOBAL_UPLOADS=1` | (v0.4.2) `~/.harness/uploads` |
| `HARNESS_AGENT_OUTPUT_DIR` | Absolute or project-relative outputs dir |

### Backend keys (read by `chatClientFactory`)

`OLLAMA_HOST`, `OLLAMA_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`,
`GITHUB_TOKEN` / `GITHUB_MODELS_TOKEN`, `OPENAI_API_KEY`,
`MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `REPLICATE_API_TOKEN`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

### Routing

| Var | Effect |
|---|---|
| `HARNESS_BACKEND` | Which OpenAI-compatible preset to use |
| `HARNESS_REMOTE_AUTO_FALLBACK` | `0` to disable rate-limit auto-fallback |
| `HARNESS_REMOTE_FALLBACK_ORDER` | Comma-separated fallback chain |

### Media

| Var | Effect |
|---|---|
| `HARNESS_VISION_MODEL` | Vision model to use for `image_analyze` |
| `HARNESS_AUDIO_TRANSCRIBE_COMMAND` | Shell command with `{input}` placeholder |
| `HARNESS_PDF_OCR_COMMAND` | Optional OCR command for `pdf_read` |

All env flags also have settings.json mirrors via `PATCH /api/system/feature-flags`
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

### Stale `agent-outputs/` polluting `grep_search` results

Heartbeat prunes at 14 days by default. Force a manual prune:
`harness doctor --fix`.

### A capability grant locked you out of `docker_exec`

Check `/api/capabilities` for active grants. Re-grant via the UI
Capabilities tab (capability `arbitrary-shell`).

### Tool failures spike

`/api/system/health` shows the tool-failure-alert state. Default
threshold: 30% over a 50-sample / 10-min window with a 5-min cooldown.
Tunable via `HARNESS_TOOL_FAILURE_*` env vars.

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

- 2392 / 2393 tests across 206 suites. **Every cycle stays green** bar
  one known flake.
- Pre-existing flake: `src/web/server.test.ts › returns discovery
  payloads … sessionSearch.fresh: true → false` flakes intermittently
  on master. Confirmed unrelated to recent work.
- Run focused: `npx jest <file>` or `npx jest -t "<name pattern>"`.
- Run full: `npx jest --silent`.
- Typecheck: `npx tsc --noEmit`.

## 10. Where to file changes

| Need | Goes in |
|---|---|
| New tool the model can call | `src/tools/<name>.ts` + register in `src/tools/registry.ts` |
| New background action | `src/services/selfLearningHeartbeat.ts` factory |
| New REST route | `src/web/server.ts` (one file by design) |
| New UI tab/control | `ui/index.html` + `ui/app.js` |
| New backend | `src/core/chatClientFactory.ts` preset entry |
| New custom agent | `.harness/agents/<id>.md` markdown file |
| New capability | `src/services/capabilityRegistry.ts` constant + UI action |
| New env flag | Read at boot in `src/web/server.ts`; mirror via `feature-flags` PATCH if user-toggleable |
| New eval probe | `src/eval/probes.ts` |

## 11. Out-of-scope (deliberately not done)

- **No daemon-side cloud database.** Everything is `.harness/`. Adding
  Postgres / SQLite would break the local-first promise.
- **No model-specific runtime hooks.** The harness runs many backends;
  Claude- or GPT-specific behaviour stays out of `core/queryLoop.ts`.
- **No HybridTurtle features here.** The Harness repo and HybridTurtle
  are separate concerns. Per user preference, HybridTurtle gets verify
  / harden, not new features.

## 12. Status snapshot at v0.6.4

| Surface | State |
|---|---|
| Tests | 2392 / 2393 green (206 suites); 1 known flake |
| Typecheck | Clean |
| Headline feature | ccmem concept-cell semantic memory (dual-write `remember`, meaning-based recall) |
| Autonomous experiences | Apex family (`/goal`, PDF→wiki, Kanban→autonomy, competitor research, memory wiki, morning priority) — renamed from Hermes |
| Startup | Hardened (BOM path fix, clearer `npm install` errors, ccmem auto-launch) |
| Open backlog | None blocking |
| Recommended next action | Use the harness for real work. Return to code only when something actually breaks. |
