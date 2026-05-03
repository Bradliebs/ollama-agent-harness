---
title: Operating Services
description: Contract for deterministic Agentic Service Mode services, persisted state, scheduler behavior, and model-agnostic routing
author: Bradliebs
ms.date: 2026-05-03
ms.topic: concept
keywords:
  - agentic service mode
  - operating services
  - local-first
  - scheduler
estimated_reading_time: 4
---

## Purpose

Operating services are local, deterministic service agents that keep state across chat turns. They handle ongoing requests such as reminders, bullet journals, site checks, and daily follow-ups without asking a chat model to scaffold an app or write task files.

The harness routes these requests to `OPERATE_MODE` before model selection. This matters because the harness supports many model backends, and different models phrase tool plans differently. Service setup and service commands must work even when no model is selected.

## Storage Contract

Each service stores its definition and mutable state under `.harness/services/`.

```text
.harness/services/
  bullet_journal/
    service.json
    state.json
  site_monitor_<hash>/
    service.json
    state.json
```

`service.json` describes the operating contract:

* Service id and service name
* Purpose and supported commands
* Persistent state schema
* Schedule metadata and automation job id
* Reminder, review, transition, archive, safety, and interaction rules
* Storage location for detail views and automation prompts

`state.json` contains mutable data such as tasks, notes, observations, reviews, reminders, enabled state, and pause state.

## Deterministic Commands

Bullet Journal commands include:

* `add task ...`
* `update task ...: ...`
* `close task ...`
* `reopen task ...`
* `add note ...`
* `show today`
* `show open tasks`
* `show closed tasks`
* `daily review`
* `weekly review`
* `set reminder time ...`
* `pause reminders`
* `resume reminders`

Generic operating-service commands include:

* `show status`
* `show status for <service-id-or-url>`
* `site monitor <service-id-or-url> add note ...`
* `record observation ...`
* `site monitor <service-id-or-url> pause reminders`
* `site monitor <service-id-or-url> resume reminders`

When more than one generic operating service exists, unscoped generic commands return an ambiguity message and list targetable service ids. This keeps command routing predictable across models.

## Scheduler Behavior

Operating services use the existing automation scheduler instead of a separate scheduling subsystem.

* Setup creates or updates `.harness/automations/jobs.json`.
* Scheduled prompts include the service id, service state path, original request, and no-build instruction.
* Pausing reminders disables the linked automation job.
* Resuming reminders enables the linked automation job.
* `executeDueJobs` only runs enabled jobs, so paused services remain quiet.

## Build Overrides

`OPERATE_MODE` is for ongoing service behavior. Explicit software requests still route to build mode.

Examples that stay in operate mode:

* `remind me daily to review my tasks`
* `keep me honest on overdue invoices`
* `check https://example.com/rooms daily to see if a room is free`
* `send me a telegram reminder`

Examples that route to build mode:

* `build an app that reminds me daily`
* `make a website that monitors room availability`
* `generate a document template that reminds me daily`
* `write code that sends me reminders`

## Discovery and Detail Views

The Discovery tab uses progressive disclosure:

1. `/api/discovery` lists operating-service summaries.
2. The Operating Services panel renders service names, purposes, update times, and detail controls.
3. `/api/services/:id` returns the full service definition and state when the user asks for details.

This mirrors the useful part of `claude-mem`'s memory design: show compact context first, then fetch details on demand. The harness does not copy the Claude-specific plugin hook stack, Bun worker, SQLite store, or Chroma vector index for operating services.

`/api/services` supports `limit` and `offset` query parameters for larger service lists. Responses include `total`, `limit`, `offset`, and lifecycle metadata.

## Mode Classifier

The harness classifies every user message into one of six modes before routing to a model or service handler.

| Mode | Purpose |
|------|---------|
| `chat` | Answer a question or have a conversation |
| `build` | Create an artifact, app, script, file, dashboard, document, UI, or code project |
| `operate` | Create or update an ongoing agentic service with persistent state, reminders, commands, reviews, and scheduled behaviour |
| `automate` | Create a recurring workflow that runs with tools, files, and a scheduler |
| `research` | Investigate, compare, gather sources, or analyse information |
| `maintain` | Monitor or maintain something over time |

The classifier applies pattern-matching rules with priorities. Operate-mode patterns (priority 90) win over build-mode patterns (priority 40) unless the user explicitly requests software (e.g. "build an app that..."). When suppression occurs, the response includes the suppressed mode for transparency.

Source: `src/services/modeClassifier.ts`

## Capability Registry

Before promising ongoing reminders, notifications, or proactive updates, the harness checks whether the required capabilities exist at runtime.

Built-in capabilities and their default status:

| Capability | Default Status |
|------------|----------------|
| `scheduler` | available |
| `local_files` | available |
| `shell` | available |
| `code_runner` | available |
| `test_runner` | available |
| `ollama` | available |
| `notifications` | unavailable |
| `email` | unavailable |
| `calendar` | unavailable |
| `browser` | unavailable |
| `vector_memory` | unavailable |
| `cloud_models` | unavailable |
| `telegram` | unavailable |

When a service feature requires unavailable capabilities, the harness reports the limitation honestly rather than promising behaviour it cannot deliver.

Source: `src/services/capabilityRegistry.ts`

## Model Registry and Router

The model registry stores detailed metadata for each available model: strengths, weaknesses, cost level, privacy level, speed level, context limits, JSON/tool support, and enabled state.

Model roles:

| Role | Purpose |
|------|---------|
| `local.general` | Classification, summarisation, task extraction, note cleanup, daily reminders, log scanning, memory compression |
| `local.coder` | Codebase scanning, code edits, debugging drafts, test explanation |
| `local.summariser` | Summarisation, compression, daily/weekly review generation |
| `local.embedder` | Vector memory and retrieval |
| `cloud.reasoner` | Architecture, complex reasoning, ambiguous planning, difficult debugging |
| `cloud.reviewer` | High-quality final review, safety assessment |

The model router maps each task type to a preferred role and selects the cheapest enabled model that fits. If no model matches the preferred role, it falls back to any enabled model. Privacy-sensitive tasks can force local-only routing.

Source: `src/models/modelRegistry.ts`, `src/models/modelRouter.ts`

## Worker Queue

Local models handle cheap background tasks through an in-memory worker queue. Job types include:

* `classify_task` — classify new tasks by type
* `extract_tasks` — extract structured tasks from notes
* `summarise_notes` — summarise daily notes
* `summarise_weekly` — summarise weekly review
* `compress_memory` — compress memory
* `scan_logs` — scan logs for patterns
* `detect_failures` — detect repeated failures
* `generate_reminder` — generate reminder drafts
* `refresh_summary` — refresh project summaries
* `validate_json` — validate JSON outputs

Each job tracks its service ID, model ID, input, output, status, error, and timestamps.

Source: `src/services/workerQueue.ts`

## JSON Command Extraction

Service commands can be extracted from natural language using rule-based patterns or parsed from structured JSON produced by a local model.

Example: "Add task call dentist tomorrow and note I felt tired today" extracts:

```json
{
  "commands": [
    { "type": "add_task", "title": "call dentist", "due_date": "2026-05-04" },
    { "type": "add_note", "content": "I felt tired today" }
  ]
}
```

All commands are validated against the service's supported command types and required fields before any state mutation. State transition events are logged for auditability.

Source: `src/services/commandExtractor.ts`

## Nervous System Integration

The nervous system includes an `ONGOING_SERVICE_REQUEST` signal type and a corresponding reflex. When the reflex fires:

* The run state notes that operate mode is active and build mode is suppressed
* The `service.operate_mode` node is added to the required nodes list
* Subsequent routing respects the operate-mode classification

Source: `src/nervous/reflexes.ts`, `src/nervous/signals.ts`

## Mycelial Graph Extensions

The mycelial graph includes node types for the agentic OS layer:

* `model` — LLM model entries with role metadata
* `provider` — LLM backend providers (Ollama, OpenAI, Anthropic)
* `service` — operating service definitions
* `service_state` — mutable service state
* `scheduler` — scheduler entries
* `command_handler` — service command handlers
* `notification_template` — notification message templates
* `capability` — runtime capability entries
* `background_worker` — local model worker entries

Graph edges capture relationships: `service → command_handler`, `command_handler → model`, `service → scheduler`, `scheduler → notification_template`, `model → provider`, `service → capability`, `worker → model`, and `agent → model`.

The mycelial router learns which models work well for each task type, which command handlers succeed, and when cloud models are worth the cost.

Source: `src/mycelium/graph.ts`, `src/mycelium/seeds.ts`

## Portable Export and Import

Operating services can be exported as a portable JSON payload through `/api/services/export`.

```json
{
  "version": 1,
  "exported_at": "2026-05-03T12:00:00.000Z",
  "source": "ollama-agent-harness",
  "services": [
    {
      "service": { "service_id": "bullet_journal" },
      "state": { "service_id": "bullet_journal", "mode": "operate" }
    }
  ]
}
```

Import through `/api/services/import` with that JSON body. Existing services are skipped by default. Pass `overwrite=true` only when replacing the local service definition and state is intentional.

Enabled imported services recreate local automation jobs during import. The importer does not trust stale job ids from another checkout; it writes local job ids back into `service.json` and schedule metadata.

The payload is plain JSON rather than an archive so it is easy to inspect, diff, redact, and move between checkouts without extra dependencies.

## Lifecycle Capture Audit

Operating services use existing harness capture surfaces instead of a dedicated memory worker:

* Chat interception records deterministic `OPERATE_MODE` responses.
* Evidence cards record service export and import actions.
* Evidence cards record service definition, state, and automation job writes.
* Automation run logs record scheduled service executions.
* `.harness/services/` stores the current service contract and mutable state.
* Discovery detail views provide progressive disclosure for service state.

This is the model-agnostic version of the lifecycle lesson from `claude-mem`: capture at stable boundaries, but do not depend on Claude Code hooks or one model's behavior.

## Privacy Posture

Operating-service state is local to the harness checkout unless the user explicitly exports, copies, or sends it through a tool.

The service prompt includes local state paths so scheduled runs can read and update the right service. It does not upload service state to a cloud backend by itself. If the selected model backend is remote for normal chat, `OPERATE_MODE` setup and deterministic commands still complete locally before model execution.

## Design Principles Borrowed from Claude-Mem

`claude-mem` is useful as a design reference, not as a dependency.

* Use stable lifecycle points for capture and summaries.
* Prefer progressive disclosure over dumping all memory into context.
* Keep persistence local and explicit.
* Make troubleshooting paths visible through APIs and UI panels.

For this harness, those ideas map to evidence cards, transcripts, automation run logs, Mycelium episodes, memory palace entries, and operating-service detail views. The implementation remains model-agnostic and local-first.
