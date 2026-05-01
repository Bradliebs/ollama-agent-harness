<!-- markdownlint-disable-file -->

# Hermes Good Patterns Second Pass Research

Date: 2026-04-30

## Scope

User request: "All, I want to take all that is good from hermes."

This pass continues the earlier Hermes adaptation by selecting additional patterns that fit Harness without replacing its local-first TypeScript architecture.

## Assumptions

* Borrow useful patterns, not Python code.
* Keep the core query loop simple and avoid gateway/platform expansion.
* Avoid dynamic plugin code execution. Manifest-only discovery is safer for this Harness.
* Preserve append-only JSONL sessions; derived indexes remain rebuildable.

## Evidence

* Hermes model catalog caches a remotely fetched manifest with TTL and stale fallback.
* Hermes plugins use manifests, enabled/disabled semantics, and metadata before loading tools/hooks.
* Hermes cron jobs compute due work, advance next-run timestamps, and keep output under a local runtime directory.
* Harness already has initial command/tool registries, automation storage, and session search primitives from the prior pass.
* Harness has existing skill and hook systems, so manifest discovery should inventory extensions rather than execute arbitrary code.

## Selected Approach

* Add a local model catalog module that validates a small manifest schema, caches it under `.harness/cache`, supports TTL, and falls back to stale cache or built-in presets.
* Add manifest-only extension discovery for `.harness/plugins/**/plugin.json`, `.harness/plugins/**/plugin.yaml`, and existing `.harness/skills/**/SKILL.md` files.
* Extend automation helpers with due-job discovery and run-completion bookkeeping for once and interval jobs.
* Extend the session search index with metadata, freshness checks, and rebuild summaries.
* Add focused Jest coverage for each new behavior.

## Explicitly Deferred

* Full provider/gateway expansion, because Harness is local Ollama-focused.
* Executable plugin loading, because this would introduce trust and sandboxing questions beyond the current request.
* SQLite FTS, because a derived JSON index is already consistent with existing local runtime state.

## Success Criteria

* Model catalog cache validates manifests and works offline with stale cache or fallback presets.
* Extension discovery returns safe metadata without executing plugin code.
* Automation jobs can be queried for due work and marked complete with updated next-run/last-run state.
* Session search index can report freshness and rebuild metadata.
* Targeted tests, full typecheck, full Jest, and build pass.