<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Research

Date: 2026-04-30

## Scope

User selected all suggested follow-up work from the prior Phase 5 output:

1. Add a CLI command registry.
2. Design a tool registry.
3. Prototype local automations.
4. Improve doctor output.
5. Add a searchable session index.

## Assumptions

* Keep Harness TypeScript-first and local Ollama-focused.
* Borrow Hermes patterns, not Python implementation code.
* Preserve append-only JSONL sessions as the source of truth.
* Prefer small, tested primitives over broad gateway/provider/plugin expansion.

## Evidence

* `hermes-agent-main/hermes_cli/commands.py` uses a central `CommandDef` registry for aliases, help, gateway menus, and autocomplete.
* `hermes-agent-main/tools/registry.py` uses self-registration, metadata snapshots, toolset aliases, and availability checks.
* `hermes-agent-main/cron/jobs.py` and `hermes-agent-main/cron/scheduler.py` store scheduled agent jobs and outputs, with one-shot, interval, and cron schedules.
* `hermes-agent-main/hermes_state.py` uses SQLite and FTS5 for cross-session message search, while Harness uses append-only JSONL plus a simple semantic index.
* `hermes-agent-main/hermes_cli/doctor.py` reports environment, dependency, config, and tool availability checks with actionable messages.
* Harness surfaces to extend include `src/cli/index.ts`, `src/tools/index.ts`, `src/setup/health.ts`, `src/persistence/semanticMemory.ts`, and new local modules for automation.

## Selected Approach

* Add a typed command registry consumed by CLI help and parsing metadata without changing the CLI interaction model.
* Add a typed tool registry wrapper around existing tool constants to expose metadata and toolset grouping while preserving `getBuiltinTools()` behavior.
* Add local automation storage and runner helpers under `src/automation/` for schedule parsing, job persistence, script context, and output capture.
* Extend setup health with Node, package, session storage, tool, and automation checks.
* Add a derived searchable session index that stores lightweight entries in `.harness/memory/session-search-index.json`, preserving JSONL as source of truth.

## Artifact Completion

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%
