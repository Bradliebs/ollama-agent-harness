---
title: Ollama Agent Harness Changelog
description: Release notes generated from local RPI changes logs for Ollama Agent Harness
author: Bradliebs
ms.date: 2026-05-16
ms.topic: reference
keywords:
	- ollama
	- release notes
	- changelog
estimated_reading_time: 14
---

## Ollama Agent Harness v0.5.8

Closes the rest of the prior persistence/scheduler audit findings AND
the new concurrency findings from the system-audit extension into a
single hardening release. Eight distinct fixes, three new tests, no
breaking changes.

### Persistence: lock the rest of the RMW writers

Five writers in `synthesisStats` (`recordSynthesisFired`,
`recordSessionCompleted`, `clearSynthesisStats` single-model branch,
`recordAvgTurnDuration`, `recordToolUseStats`) and
`promoteLearningCandidate` in `sessionLearning` were doing
load → mutate → `fs.writeFile` without holding the file lock.
Concurrent writers could read the same snapshot and overwrite each
other, even though v0.5.2 had already made the byte-level write
atomic. They are now all wrapped in `withFileLock` with the write
going through `atomicWriteFile`.

### Persistence: atomic snapshots in the curator

`curator.ts` was writing the merge-proposals file and umbrella-skill
files with raw `fs.writeFile`. Two curator runs racing each other
could leave a torn snapshot. Both writes now use `atomicWriteFile`
and `appendAuditLog` holds `withFileLock` while appending the audit
JSONL.

### Persistence: lock JSONL appenders for nervous signals + subagent routing

`NervousSystemController.persistSignals` and
`appendSubagentRoutingMetric` were calling `fs.appendFile` without a
lock. Concurrent chats sharing one project directory could interleave
bytes mid-line. Both now hold `withFileLock` for the append.
`persistSignals` also stops swallowing failures with a comment — it
now reports through `recordSwallowed` so the silent-failure sink
sees it.

### Persistence: atomic writes for custom agent files

`writeCustomAgent` in `agentLoader` now uses `atomicWriteFile`
instead of `fs.writeFile`.

### Concurrency: per-chat NervousSystemController

`server.ts` previously held one module-level
`NervousSystemController` instance and routed every chat through it.
Two parallel chats tangled signal histories and reflex state. Each
chat handler now constructs its own controller; `/api/nervous` reads
from a `lastNervousSnapshot` mirror updated at the end of each chat.

### Concurrency: shared in-memory Mycelium graph

Every chat used to load its own copy of the mycelium graph from disk,
mutate it independently across the chat lifetime, and write the full
copy back at end-of-chat. Two overlapping chats would both load the
same baseline and the later writer silently overwrote the earlier
writer's reinforcements. The atomic-write/lock from v0.5.2 protected
the bytes but not the load-then-overwrite window.

A new `src/mycelium/graphStore.ts` module keeps a single
`MyceliumGraph` per `projectDir` in memory. `createMycelialRouter`
now goes through `getSharedMyceliumGraph`, and `router.save()` flushes
through `flushSharedMyceliumGraph`. Concurrent reinforcements now
accumulate on the same instance instead of producing divergent
snapshots that overwrite each other.

### Schedulers: register the two Jarvis ambient timers

`jarvisAmbientHandle` and the 60-second `ambientActionTimer` are now
registered with `SchedulerRegistry` as `jarvis-ambient` and
`jarvis-ambient-action`. `/api/shutdown` and the kill switch see and
stop them like every other scheduler.

### Tests

Three new tests in `src/mycelium/graphStore.test.ts` cover:
- Concurrent routers receive the same in-memory graph instance.
- Three concurrent first-load callers share one disk load.
- Concurrent seedings accumulate on the shared graph rather than
  overwriting each other on save.

The full suite now runs 163 suites / 1786 tests, all green.

## Ollama Agent Harness v0.5.7

Closes audit item #10 (health endpoint upgrade). Now that v0.5.6 made
the kill switch and the scheduler set first-class objects, the public
health endpoints stop relying on dozens of hand-wired booleans and
the mirror variables, and read from the canonical sources instead.
The shape gains a `schedulers` field that finally surfaces every
registered scheduler — including `uploads-auto-prune` and
`otlp-exporter`, which had no per-key surface before.

### /api/system/health

* [src/web/server.ts](src/web/server.ts) — `kill_switch.active` and
  `kill_switch.reason` now read from `killSwitch.snapshot()` directly
  instead of the module-level mirrors. The mirrors are still kept in
  lockstep for the ~60 internal read sites, but no public HTTP
  surface depends on that indirection any more.
* New top-level `schedulers: Array<{ name: string; running: boolean }>`
  field sourced from `schedulerRegistry.list()`. Covers all six
  schedulers (`uploads-auto-prune`, `curator`, `self-learning-heartbeat`,
  `triggers`, `otlp-exporter`, `automation`) with a unique-name
  contract enforced by the registry.
* Existing per-scheduler keys (`heartbeat.*`, `triggers.*`,
  `automation.*`, `curator.*`) are kept for backward compatibility —
  they expose richer fields like `enabled`, `last_run_at`, and
  `recent_runs` that the registry list deliberately does not.

### /api/readiness

* [src/web/server.ts](src/web/server.ts) — all three kill-switch
  reads (top-level `killSwitch` field, automation section
  `kill.switch` check, autonomy section `autonomy.kill.switch`
  check) now route through `killSwitch.snapshot()`. Behaviour is
  byte-for-byte identical to v0.5.6 because the mirrors were in
  lockstep already; the change is about removing the indirection
  from the public surface so a future drift cannot ever appear here.

### Tests

* [src/web/server.test.ts](src/web/server.test.ts) — added two
  tests pinning the new contract:
  * `/api/system/health` exposes a `schedulers` array of
    `{name, running}` entries with unique names.
  * `/api/system/health.kill_switch` reflects KillSwitch engagement
    end-to-end (engage → assert `active: true` with reason →
    release → assert `active: false`).
* Suite: 1781 → 1783 (+2). All 162 suites green. `tsc --noEmit` clean.

### Not changed by this release

* The mirror variables `killSwitchActive` / `killSwitchReason` are
  still maintained — removing them is a much larger internal
  refactor (~60 read sites) that was deliberately out of scope.
* `/api/subsystems/health` is unchanged. It's a higher-level
  rollup that doesn't expose kill switch or schedulers.
* No new endpoint surface. The fix is additive on existing surfaces.

### Audit ledger after v0.5.7

* Item #4 — closed v0.5.2 (file-lock retrofit).
* Item #6 — closed v0.5.6 (kill-switch + SchedulerRegistry).
* Item #6.B — deferred as audit observation (schedulers do not
  issue ToolCalls directly).
* Item #7 — closed v0.5.5 (workflow persistence).
* Item #9 — closed v0.5.3 (Windows arg quoting).
* Item #10 — **closed v0.5.7** (this release).

## Ollama Agent Harness v0.5.6

Closes audit item #6 (kill-switch / scheduler coupling) with two
bounded changes: a single source of truth for kill-switch state, and
a registry that makes every long-running scheduler discoverable and
shutdownable through one API.

### Kill-switch unification

Before v0.5.6 the server held a `killSwitchActive` boolean and every
`PermissionEngine` kept a private copy snapshotted at construction
time. A per-session engine therefore could not see kill-switch
changes made after the session started; conversely, code that called
`engine.engageKillSwitch()` directly never propagated back to the
server flag the schedulers were reading. Two sources of truth, easy
to drift, hard to audit.

* New [src/permissions/killSwitch.ts](src/permissions/killSwitch.ts) —
  `KillSwitch` class with `engage(reason)`, `release()`,
  `isActive()`, `getReason()`, `restore(snapshot)`, `snapshot()`,
  and `onChange(listener)`. A single instance lives in `server.ts`
  and is passed to every `PermissionEngine` via a new constructor
  arg, so `evaluate()` reads live state on every call instead of a
  construction-time snapshot.
* [src/permissions/engine.ts](src/permissions/engine.ts) — new
  optional `killSwitch` constructor argument plus `setKillSwitch()`
  for late binding. When attached, `engageKillSwitch`,
  `releaseKillSwitch`, `isKillSwitchActive`, `getKillSwitchReason`
  and `evaluate` all route through the shared instance. Standalone
  callers (tests) that do not pass one keep the existing local-field
  behaviour, so no public API broke.
* [src/web/server.ts](src/web/server.ts) — single `killSwitch =
  new KillSwitch()` at module scope. All mutations route through
  two new helpers, `applyKillSwitchState(active, reason)` and
  `restoreKillSwitchState(snapshot)`. The module-level
  `killSwitchActive` / `killSwitchReason` mirrors still exist (dozens
  of read sites unchanged) but are now written only by these
  helpers, so they cannot drift from the source of truth.
* Schedulers (curator, heartbeat, triggers, automation) and the
  curator tool runtime now read `() => killSwitch.isActive()`
  instead of the module mirror, so a kill-switch flip is observed
  on the very next scheduler tick.

### SchedulerRegistry

Before v0.5.6 each scheduler had its own `configureX` / `stopX`
pair in `server.ts` with no central inventory. There was no way to
enumerate what was running, no shared shutdown path, and tests had
to import each `stopX` individually.

* New [src/services/schedulerRegistry.ts](src/services/schedulerRegistry.ts) —
  `SchedulerRegistry` with `register(scheduler)`, `unregister(name)`,
  `stop(name)`, `stopAll()`, `list()`, and a `clear()` helper. Stops
  run in reverse-registration order, async stops are awaited, and
  one scheduler crashing during shutdown does not block siblings.
* Registered subsystems in `server.ts`: `uploads-auto-prune`,
  `curator`, `self-learning-heartbeat`, `triggers`, `otlp-exporter`,
  `automation`. Each `configureX` registers after `.start()`; each
  `stopX` unregisters; replacing by name auto-stops the previous
  instance.
* New exports: `stopAllSchedulers()` and `getSchedulerStatuses()`
  for shutdown handlers, tests, and diagnostic surfaces. The
  existing individual `stopX` exports stay (used by tests).
* The registry does **not** subscribe to the kill switch — current
  semantic is preserved: schedulers stay running but their per-tick
  guard makes them no-op while the switch is engaged, so a release
  resumes scheduled work without reconfiguration.

### Tests

* New [src/permissions/killSwitch.test.ts](src/permissions/killSwitch.test.ts) —
  12 tests covering engage/release, default reasons, snapshot
  defensiveness, listener fan-out and crash isolation, restore
  semantics, and the 500-char reason cap.
* New [src/services/schedulerRegistry.test.ts](src/services/schedulerRegistry.test.ts) —
  17 tests covering name validation, replacement (including when the
  previous stop throws), unregister semantics, async stop awaiting,
  reverse-order `stopAll`, failure isolation, and snapshot-stable
  iteration when an entry unregisters siblings during stop.
* Extended [src/permissions/engine.test.ts](src/permissions/engine.test.ts) —
  4 new tests in `kill switch > with shared KillSwitch (v0.5.6)`
  proving the snapshot-drift bug is fixed: engines constructed
  before engagement still see the engagement, mutations on one engine
  propagate to all engines sharing the switch, and `setKillSwitch()`
  swaps the source after construction.
* Full suite: **1741 → 1781 tests**, all green. `tsc` clean.

### Audit follow-ups deferred

* Item #6.B (route scheduled work that calls tools through
  `PermissionEngine`) — left as an audit observation. The
  schedulers themselves do not issue `ToolCall`s; only the work
  they delegate does, and that work already goes through the
  per-session engine.
* Item #10 — held as follow-up.

---

## Ollama Agent Harness v0.5.5

Closes audit item #7: workflow run state was in-memory only. A server
restart wiped every `WorkflowRun`, leaving `/api/workflows/runs`
silently empty and abandoning long-running workflows with no record.
The header comment on `WorkflowRegistry` already flagged this as a
v1 limitation.

### Persistence

* [src/workflows/workflowRegistry.ts](src/workflows/workflowRegistry.ts) —
  every run state transition now persists to
  `.harness/workflows/runs/<runId>.json` through `withFileLock` +
  `atomicWriteFile`. The lock is keyed per run file so different runs
  proceed in parallel without contention.
* Persist points: `startRun`, `pause`, `resume`, `cancel`, the
  `execute` loop (start, per-step settle, every terminal status), and
  the demoted state on restore.
* `flush()` exposed so the server (and tests) can drain
  fire-and-forget persists from the synchronous mutator methods
  before shutdown or teardown. Tracks in-flight promises in a Set so
  drainage is bounded.

### Recovery on restart

* `restoreRuns()` loads every persisted run on startup. Runs found in
  `running` (server killed mid-step) or `pending` (server killed
  before `execute` began) are **demoted to `failed`** with the
  recovery note `Server exited while workflow run was in progress;
  not auto-resumed.` and re-persisted so the next restore is
  idempotent.
* Currently-running steps inside a demoted run also become `failed`
  with the same note. Pending steps stay `pending` — they were never
  in-flight, so the run-level `failed` is the honest signal.
* **No auto-resume.** Tool side effects are not idempotent. Restored
  runs are visible for inspection only; a future operator-driven
  resume is out of scope for this release.
* Malformed run files are logged and skipped, never thrown.
* [src/web/server.ts](src/web/server.ts) — `ensureSettingsLoaded`
  now calls `await workflowRegistry.restoreRuns()`. Best-effort:
  failures log and never block server start.

### Tests

* [src/workflows/workflowRegistry.test.ts](src/workflows/workflowRegistry.test.ts) —
  added 8 tests under a `run persistence` describe block:
  * completed run round-trips through a fresh registry instance
  * `running` run demoted to `failed` on restore (with idempotent
    re-persist verified by a second restore)
  * `pending` run demoted to `failed` with steps still `pending`
  * malformed/wrong-shape run files skipped without throwing
  * missing runs directory returns zeros
  * paused run round-trips with `pauseReason`
  * cancelled run round-trips with `cancelReason`
  * 4 parallel runs in one registry produce 4 valid run files with
    no orphan temp files (race coverage)
* `afterEach` now calls `registry.flush()` for every tracked
  registry before `fs.rm` so the fire-and-forget persists from the
  synchronous mutators cannot race the directory removal.

### Not changed by this release

* The `WorkflowDefinition` schema and on-disk layout for definitions
  are unchanged.
* The `WorkflowRegistry` public API is additive only (`flush()` and
  `restoreRuns()` are new; everything else is identical).
* No retention or TTL on persisted runs — disk grows monotonically
  until manually cleaned. Acceptable for v1; a future release can
  add a cap.

### Still pending from the audit

* Item #6 — schedulers through the PermissionEngine (architectural).
* Item #10 — health endpoint upgrade (depends on #6).

## Ollama Agent Harness v0.5.4

Removes a full-suite test flake in `src/web/server.test.ts` where
`addedDocuments` could surface `jarvis-brief-ambient-*.md` files
written by the Jarvis ambient action subscriber's 60s `setInterval`.
The flake only fired under the full Jest run (test passed in
isolation) and was unrelated to the test's own API mutations.

### Fix

* [src/web/server.ts](src/web/server.ts) — the ambient action
  subscriber's `setInterval` now only registers when
  `HARNESS_AMBIENT_ENABLED === '1'`, mirroring the gate on the daemon
  itself. The previous code always registered the timer and then
  early-returned inside the callback when the daemon wasn't running —
  dead work in non-ambient runs and the source of the race window.
* [src/testSupport/harnessCleanup.test-support.ts](src/testSupport/harnessCleanup.test-support.ts) —
  `listHarnessDocumentFiles` now filters out
  `jarvis-brief-ambient-*` files. They are background-timer
  artifacts; the snapshot/diff exists to police documents created by
  the API mutations a test made, not independent timer work. Genuine
  test-induced documents still surface.

### Tests

* [src/testSupport/harnessCleanup.test-support.test.ts](src/testSupport/harnessCleanup.test-support.test.ts) —
  added 1 test pinning the filter contract: ambient briefs are
  excluded from both the snapshot and the diff, but a real test
  leak (`test-leaked.md`) still appears in `addedDocuments`.

### Not changed by this release

* The ambient daemon and its bus behave identically when
  `HARNESS_AMBIENT_ENABLED=1`.
* The action subscriber's policy and per-action handlers are
  unchanged.
* No other snapshot/diff caller behaviour changes.

### Still pending from the audit

* Item #6 — schedulers through the PermissionEngine (architectural).
* Item #7 — workflow persistence consolidation.
* Item #10 — health endpoint upgrade (depends on #6).

## Ollama Agent Harness v0.5.3

Fixes audit item #9: when the Bash tool routes a Windows `.cmd` shim
invocation through `cmd.exe /d /s /c`, args containing whitespace,
quotes, or shell metacharacters were joined with a naive `.join(' ')`
and re-quoted by Node, producing a broken command line. Commands like
`npx prettier --write "a file.ts"` would be split mid-arg or dropped
when the shim path fired. The bug was uncovered by existing tests
because the covered path used `node` (a native `.exe`), not a shim.

### Fix

* [src/tools/bashTool.ts](src/tools/bashTool.ts) — added two pure
  helpers and rerouted the shim path through them:
  * `quoteWindowsArgv(arg)` applies the Microsoft
    `CommandLineToArgvW` quoting rules: empty → `""`; bare → unchanged;
    otherwise wrap in `"..."`, escape internal `"` as `\"`, and double
    every run of backslashes that immediately precedes a `"` or the
    closing quote.
  * `buildWindowsCmdInvocation(executable, args)` produces the single
    command string that `cmd.exe /d /s /c` will receive.
  * The spawn site now passes `windowsVerbatimArguments: true` so Node
    does not re-quote the already-quoted command and produce nested-
    quote mangling.

### Tests

* [src/tools/bashTool.test.ts](src/tools/bashTool.test.ts) — added 12
  unit tests covering empty args, bare args, whitespace wrapping,
  embedded quotes, backslash-doubling before quotes, trailing
  backslashes, interior backslashes that are NOT adjacent to a quote,
  cmd metacharacters, and end-to-end build for the regression
  scenarios (`prettier --write 'a"b.ts'`, `npm run 'build & deploy'`,
  `eslint 'src/file with space.ts'`).

### Not changed by this release

* `isSafeCommand` gating is unchanged — it still blocks `$()`,
  backticks, and unquoted shell operators before the arg builder runs.
* The fast path for native `.exe` targets (no shim) is unchanged.

### Known residual exposure

`%FOO%` inside a quoted arg still triggers `cmd.exe` env-var expansion
because `cmd.exe` processes `%` even inside `"..."`. Documented in the
`quoteWindowsArgv` jsdoc; rare in agent-issued commands and accepted.

### Still pending from the audit

* Item #6 — schedulers through the PermissionEngine (architectural).
* Item #7 — workflow persistence consolidation.
* Item #10 — health endpoint upgrade (depends on #6).

## Ollama Agent Harness v0.5.2

Completes the file-lock retrofit pass started in v0.5.1. The remaining
JSON writers identified in the v0.5.1 "Not changed by this release"
section now go through `withFileLock` + `atomicWriteFile`. Closes the
deferred portion of audit item #4.

### Retrofitted RMW (read-modify-write) writers

These callers do a read-modify-write on disk; the lock now covers the
whole sequence so two concurrent paths cannot lose each other's
mutations.

* [src/extensibility/mcpRuntime.ts](src/extensibility/mcpRuntime.ts) —
  `upsertMcpServer`, `removeMcpServer`, and `discoverMcpServerTools`
  now run their RMW under `withFileLock(path.join(projectDir, MCP_SERVERS_PATH))`
  and write via `atomicWriteFile`. Two race tests added in
  [src/extensibility/mcpRuntime.test.ts](src/extensibility/mcpRuntime.test.ts)
  exercise parallel upsert + parallel upsert/remove on overlapping ids.
* [src/web/server.ts](src/web/server.ts) — `storeConnectorSecret` and
  the inline `/api/api-keys` POST handler now lock `API_KEYS_PATH` for
  the whole RMW. File mode `0o600` preserved for the
  secret-bearing file.
* [src/web/server.ts](src/web/server.ts) `/api/email/templates` POST
  and DELETE handlers — wrap the read-filter-write under
  `withFileLock(EMAIL_TEMPLATES_PATH)`.

### Retrofitted snapshot writers

These writers persist a snapshot of in-memory state; the lock
prevents concurrent writes from producing a partial file and atomic
write prevents a half-written file on crash.

* [src/mycelium/graph.ts](src/mycelium/graph.ts) `saveMyceliumGraph`
* [src/core/codeIntelligence.ts](src/core/codeIntelligence.ts)
  `saveRepoGraph`
* [src/integrations/telegram.ts](src/integrations/telegram.ts)
  `persistChatIds`
* [src/web/server.ts](src/web/server.ts)
  `saveCustomOutputValidationProfiles` and `/api/file-redirects` POST
  (`FILE_REDIRECTS_PATH`).

### Still not changed

* [src/extensibility/mcpRuntime.ts](src/extensibility/mcpRuntime.ts)
  `readMcpServerDefinitionsSync` — synchronous reader used by code
  paths that cannot await. Reads are crash-safe by construction (the
  atomic-write pair guarantees a fully-formed file at the destination
  or the previous version), so no change needed.
* No changes to schedulers, workflow persistence, the bash arg-quoting
  path, or the health endpoint — those remain audit items #6, #7,
  #9, #10 and are tracked separately.

### Tests

* 1726 → 1728 tests pass (`+2` for this release).
* No new dependencies. `tsc --noEmit` clean.

---

## Ollama Agent Harness v0.5.1

Closes item #4 from the v0.5.0 deferred-hardening list:
**file-lock JSON stores**.

### Why

Several harness JSON stores (`.harness/automations/jobs.json`,
`.harness/jarvis/runtime.json`, `.harness/jarvis/trust-ladder.json`)
were written via naive `fs.writeFile` with no in-process serialization
of read-modify-write cycles. The system audit flagged this as a
silent-data-loss path: when `AutomationScheduler.tick` calls
`markAutomationJobRun(jobId)` in parallel with a UI route handler
calling `createAutomationJob`, the two read-modify-write sequences can
interleave and one writer overwrites the other's mutation. The lost
mutation is unrecoverable — there is no audit trail of "what should
have been saved".

### New persistence primitives

* [src/persistence/atomicFile.ts](src/persistence/atomicFile.ts) — pure
  stdlib, no new dependencies.
  * `withFileLock<T>(absolutePath, fn)` — in-process Promise-chain
    mutex keyed by absolute path. The internal chain never rejects, so
    one caller's failure does not poison subsequent waiters. The
    caller's own rejection is still rethrown to that caller.
  * `atomicWriteFile(absolutePath, data, options?)` — writes to a
    unique sibling temp (`.<basename>.tmp.<pid>.<rand>`) then `rename`s
    over the destination. Preserves the `mode` option for
    secret-bearing files (e.g. `api-keys.json` at `0o600`). Includes
    Windows-only EPERM/EBUSY/EACCES retry with exponential backoff
    (`25ms, 75ms, 150ms, 300ms, 600ms`). Cleans up the orphan temp on
    rename failure.
* 13 unit tests in [src/persistence/atomicFile.test.ts](src/persistence/atomicFile.test.ts)
  cover lock serialization across same/different paths, error
  isolation, mode preservation, and a read-modify-write race regression.

### Retrofitted stores

* [src/automation/jobs.ts](src/automation/jobs.ts) —
  `createAutomationJob`, `updateAutomationJob`, `deleteAutomationJob`,
  `markAutomationJobRun`, and the public `saveAutomationJobs` now run
  their read-modify-write under `withFileLock(jobsPath(projectDir))`
  and write via `atomicWriteFile`. The append-only run log
  (`runs.jsonl`) is left outside the jobs.json lock since
  `fs.appendFile` is already crash-safe for a single line.
* [src/jarvis/runtimeRegistry.ts](src/jarvis/runtimeRegistry.ts) —
  `saveRuntimeRegistry` snapshots the in-memory map inside the lock,
  then writes atomically.
* [src/jarvis/trustLadder.ts](src/jarvis/trustLadder.ts) —
  `saveTrustLadder` writes through the lock + atomic-write pair.
* 4 race regression tests in [src/automation/jobs.race.test.ts](src/automation/jobs.race.test.ts)
  exercise the exact scenario the audit flagged (parallel
  `markAutomationJobRun` + `createAutomationJob`) and verify no
  mutation is lost.

### Not changed by this release

* [src/web/server.ts](src/web/server.ts) `saveSettingsToDisk` already
  had an in-process lock plus temp+rename atomic write before this
  release; verified, no change needed.
* `API_KEYS_PATH`, `EMAIL_TEMPLATES_PATH`, `FILE_REDIRECTS_PATH`,
  `OUTPUT_VALIDATION_PROFILES_PATH` writers in `server.ts` — still
  pending. They are write-only (no concurrent RMW pattern observed)
  but should be migrated for crash-safety. Deferred to a follow-up.
* [src/extensibility/mcpRuntime.ts](src/extensibility/mcpRuntime.ts)
  `writeMcpServerDefinitions` — its callers do follow an RMW pattern;
  deferred so the retrofit can be reviewed against the MCP registry's
  ordering guarantees rather than rushed into this release.
* [src/mycelium/graph.ts](src/mycelium/graph.ts),
  [src/integrations/telegram.ts](src/integrations/telegram.ts), and
  [src/core/codeIntelligence.ts](src/core/codeIntelligence.ts) JSON
  writers — same call: deferred to a separate review pass.

### Threat model note

The lock is **in-process only**. The harness assumes a single Node
server process. If the topology ever changes to multi-process (e.g. a
PM2 cluster), swap `withFileLock` for `proper-lockfile` or an
equivalent flock-based primitive. The current implementation is
documented to that effect.

### Tests

* 1709 → 1726 tests pass (`+17` for this release).
* No new dependencies. `tsc --noEmit` clean.

---

## Ollama Agent Harness v0.5.0

System-audit hardening release. Five items from the recommended hardening
order ship together; five remain as follow-up work. Includes one
deliberate breaking default change (auto-fallback is now opt-in).

### Breaking: remote provider fallback is now opt-in

* `HARNESS_REMOTE_AUTO_FALLBACK` is now **off by default**. Previously
  it defaulted to enabled, which silently routed conversation contents
  (including tool outputs from `file_read` and `bash`) to a remote
  provider whenever Ollama errored — directly contradicting the
  product's "local-first" positioning.
* To restore the previous behaviour, set `HARNESS_REMOTE_AUTO_FALLBACK=1`.
* Affects [src/core/chatClientFactory.ts](src/core/chatClientFactory.ts),
  [src/setup/health.ts](src/setup/health.ts), and the
  `harness doctor` status line in
  [src/cli/index.ts](src/cli/index.ts).
* Tests added for both off-by-default and on-when-opted-in paths.

### Silent-failure sink — observability for swallowed promise rejections

* New module [src/observability/silentFailureSink.ts](src/observability/silentFailureSink.ts)
  exposes `recordSwallowed(label, error, meta?)`, a bounded
  (200-entry) in-memory ring buffer that never throws and never does
  I/O.
* 65 `.catch(() => {})` sites in
  [src/web/server.ts](src/web/server.ts) now route to the sink with
  call-site-derived labels (`saveSettingsToDisk`,
  `appendCapabilityAuditEvent`, `emitEvent`, `saveRuntimeRegistry`,
  etc.). Fire-and-forget semantics are preserved — the caller still
  gets a resolved promise — but the failure is now post-hoc
  attributable.
* New endpoint `GET /api/diagnostics/swallowed` returns the buffer
  contents and total count. Useful for diagnosing "why didn't this
  audit event land" without grepping stderr.
* Tests cover the buffer cap, non-`Error` rejection values, and a
  hostile error object whose `message` getter throws.

### Process-level safety net

* `unhandledRejection` and `uncaughtException` handlers installed only
  when [src/web/server.ts](src/web/server.ts) runs as the entry point
  (so test runs are unaffected).
* Unhandled rejections are logged + recorded in the sink and the
  process is kept alive. Losing a long-running session to one bad
  promise is a worse outcome than a quietly logged error.
* Uncaught exceptions log + record + exit(1) after a 50 ms grace
  period for stderr flush. Process state is not trustworthy after an
  uncaught throw; cleaner to let the launcher restart.

### Startup project-directory self-check

* `startServer` now logs the resolved absolute path for every
  `.harness/*` subdirectory at boot, plus the `HARNESS_PROJECT_DIR`
  source. Catches the visible half of the misconfiguration class that
  silently broke `install_skill` in v0.4.9 — wiring bugs are now
  loud at startup instead of invisible until a user notices missing
  data.

### Deferred to follow-up releases

The audit's recommended order included five additional items not in
this release:

1. File-lock JSON stores (`automations.json`, `settings.json`,
   `runtime-registry.json`, `safety-rules.json`) — needs a new
   dependency (`proper-lockfile` or equivalent).
2. Funnel both schedulers through `PermissionEngine` — architectural.
3. Workflow persistence across server restart — substantial.
4. `bashTool` Windows arg quoting on the cmd-shim path — needs careful
   cross-platform tests.
5. Health-endpoint upgrade incorporating sink counts + scheduler
   liveness — depends on (2) above.

## Ollama Agent Harness v0.4.10

Sweep release: three bugs found by the post-v0.4.9 audit, all fixed.

### `install_skill` now installs into the configured project directory

* `setInstallSkillsDir(SKILLS_DIR)` is now called from
  [src/web/server.ts](src/web/server.ts) alongside `setSkillsDir` and
  `setImportSkillsDir`.
* Prior to this fix the helper was exported and tested but never wired
  into production, so `install_skill` fell through to
  `path.join(process.cwd(), '.harness', 'skills')` and silently dropped
  downloaded SKILL.md files into the launch directory whenever
  `HARNESS_PROJECT_DIR` pointed elsewhere — installed skills appeared
  to "vanish" because `list_skills` looked in the configured project.

### `import_skill` rejects symlinks in skill bundles

* `planCopy` now throws when any bundle entry is a symlink, before any
  copy starts. `Dirent.isFile()` returns true for symlinks to regular
  files, and `fs.copyFile` follows them at read time — a hostile bundle
  could ship `forms.txt -> ~/.ssh/id_rsa` and have the harness copy
  the dereferenced content into `.harness/skills/`. The Allowed
  External Paths fence only constrains *where* the source root can
  live, not what a symlink inside it can reach.
* Failure mode is the existing `success: false / "scan failed"` path;
  message names the offending file.

### `uiWiring` test no longer false-fails on dynamic-action fetches

* When the UI fetches a path like `'/api/jarvis/ambient/' + action`,
  the test normalizer collapses it to `/api/jarvis/ambient/:param`.
  Previously the comparison required an Express-level `:foo` wildcard
  on the server, which would have *weakened* input validation
  (`start`/`stop` are the only valid actions, registered as concrete
  routes). The matcher now accepts a UI `<prefix>/:param` call when
  any concrete server route exists under the same prefix.
* Side effect: v0.4.9 shipped with a failing test on master, which
  would have blocked the `release.yml` "Require successful CI on
  tagged commit" gate. That is now green.

## Ollama Agent Harness v0.4.9

Brings the harness's skill subsystem fully in line with the
[Anthropic Agent Skills][anthropic-skills] spec while keeping it 100% model
agnostic — the protocol is just markdown plus the filesystem, so any skill
authored for Claude works here unchanged against any Ollama model.

[anthropic-skills]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

### `skill` tool surfaces bundled resources (Level 3)

* When the agent invokes `skill(name: ...)`, the tool now appends a
  `--- Bundled resources ---` section listing every non-`SKILL.md`
  sibling file (up to 20 entries, recursing one level deep) with sizes.
  Closes the gap where the model knew SKILL.md existed but had to guess
  that `FORMS.md` or `scripts/fill_form.py` were also available.
* Skips dotfiles and `SKILL.md.backup-*` snapshots so the list stays
  meaningful.

### `import_skill` tool: bulk-import a skill bundle from a local folder

* New built-in `import_skill` tool copies an entire skill folder
  (SKILL.md + bundled files) into `.harness/skills/<name>/`. Recipe for
  consuming Anthropic-format skills:
  `bash git clone https://github.com/anthropics/skills.git agent-outputs/anthropic-skills`
  then `import_skill(source: "agent-outputs/anthropic-skills/pdf")`.
* Source must live inside the project or under an Allowed External Path —
  the same fence used by `file_read` and `list_files`.
* Hard caps: 200 files, 5 MB total bundle. `node_modules/`, `.git/`,
  `.venv/`, `__pycache__/`, `dist/`, `build/`, and dotfiles are skipped
  during copy.
* Refuses to overwrite an existing skill unless `overwrite: true` is set.
* Appends a `<!-- imported-from: ... -->` provenance footer to the
  installed SKILL.md so the source is traceable later.
* Registered with `riskLevel: 'medium'`, `permissionCategory: 'skills'`,
  `enabledByDefault: true`.

### System prompt: clean Level-1 listing for Anthropic-format skills

* The "Available Skills" section no longer prints `(triggers: none)` for
  skills whose frontmatter omits the harness-extension `triggers` field.
  An Anthropic-spec SKILL.md (just `name` + `description`) now appears as
  `• pdf-processing — Extract text and tables from PDF files.` with no
  noise suffix.

### Docs

* New [docs/SKILLS.md](docs/SKILLS.md) explains the SKILL.md format, the
  three-tier progressive disclosure model (Level 1 metadata / Level 2
  body / Level 3 bundled resources), the `list_skills` / `skill` /
  `create_skill` / `import_skill` / `install_skill` tool surface, and
  why this implementation is model agnostic.

## Ollama Agent Harness v0.4.8

Patch release that hardens the tool surface against day-to-day model
mistakes that kept tripping up autonomous runs: false bash blocks for
quoted arguments, the agent writing a file then failing to run it,
permission prompts timing out in the background, synthesis turns that
swallowed everything the agent had already accomplished, and a
Settings UI that buried the most useful escape hatch.

### Bash safety scanner is quote-aware

* Legitimate invocations like `python -c "import x; print(x)"` and
  `node -e "const x = 1; console.log(x + 2)"` are no longer falsely
  blocked. The previous regex-only check rejected any `;`, `|`, `&&`,
  redirect, or command substitution anywhere in the string — even
  inside quoted arguments where they are literal bytes with no shell
  meaning (bash spawns with `shell: false`).
* Replacement is a small walker that tracks single/double-quote state
  and only flags operators outside quotes. Reported operator is named
  in the error (e.g. `';' outside quotes`) so the model can recover.
* `unsupportedWindowsBuiltin()` and `BLOCKED_PATTERNS` (rm -rf /, mkfs,
  fork bomb, etc.) are unchanged — the relaxation is scoped to the
  shell-control category only.

### `make_directory` tool replaces `bash mkdir`

* New built-in `make_directory` tool creates a directory (with parents,
  idempotent) under the project or any **Allowed External Path**.
  Replaces the workaround of `bash mkdir`, which is blocked on Windows
  because `mkdir` is a `cmd.exe` built-in.
* Registered with `riskLevel: 'low'`, `permissionCategory: 'write'`,
  `enabledByDefault: true`.

### `file_write` redirect surface is impossible to miss

* Previously the redirect note was a trailing parenthetical the model
  often did not parse, leading to broken follow-ups like
  `python check_yfinance.py` after a write to the agent-outputs
  directory. The success message now leads with the absolute path on
  its own line:
  ```
  ✅ Saved to: D:\Brad\Downloads\AI\check_yfinance.py
  ℹ️ Path was redirected from bare filename to agent-outputs/. …
  Wrote 43 chars.
  ```
* Existing `"redirected from bare filename"` and
  `"redirected by user pattern rule"` substrings are preserved so
  downstream tooling and tests keep working.

### Bash auto-resolves bare script filenames against agent-outputs

* Belt-and-suspenders for the case where the model writes
  `notes.py` (which the harness redirects into `agent-outputs/`) and
  then immediately runs `python notes.py`. Bash now rewrites bare
  script-extension args (`.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.sh`,
  `.ps1`, `.rb`, `.pl`, `.lua`) to the absolute path when the file
  exists in agent-outputs but not in cwd, and surfaces the rewrite as
  an `ℹ️ Bash auto-resolved` line above the command output.
* Safety: skips args starting with `-`, args containing a path
  separator, absolute paths, and files that exist in cwd (cwd wins).

### Path-claim verifier guards against hallucinated file references

* Opt-in via `HARNESS_VERIFY_PATH_CLAIMS=1`. New `src/core/pathClaims.ts`
  scans assistant text for path-shaped tokens ending in known
  extensions, checks them against disk, and appends an
  `⚠️ Unverified file references:` footer when any are missing.
* `verifyPathClaims()` is also wired into the synthesis fallback so the
  warning persists when the model summarises tool work after running
  out of turns.

### Configurable permission-prompt timeout

* New `HARNESS_PERMISSION_PROMPT_TIMEOUT_MS` env var (default 5 min)
  replaces the hard-coded broker timeout. The timeout error message is
  now actionable: it names the tool and tells the operator to either
  add the path to **Allowed External Paths**, raise the env var, or
  rerun with permission mode `auto`.

### Query loop surfaces tool work when synthesis fails

* When the synthesis turn throws (Ollama 500, model timeout, etc.) the
  query loop now emits a `text` event with the formatted
  `recentToolResults` summary before the `error` / `done` events. The
  user sees what the agent actually accomplished instead of an empty
  reply.

### UI: Allowed External Paths is discoverable and accurate

* Renamed the Settings section to **📂 Allowed External Paths** with a
  rewritten description that mentions reads **and** writes, recursive
  matching, the permission-prompt timeout bypass, and one-line precedence.
* Added a cross-reference from the Agent Files panel pointing users
  down to the Allowed External Paths section so the feature is no
  longer buried.

## Ollama Agent Harness v0.4.7

Patch release that closes the four learn-and-remember gaps surfaced by the
post-v0.4.6 audit. Each fix targets a place the system already collected
data but the next chat turn could not see it.

### Recent automation runs reach the next chat turn

* New `--- Recent Automation ---` block in the system prompt summarises the
  last 24h of automation job results (success / failure, name, timestamp,
  short output preview). Closes the gap where overnight `/schedule` jobs
  showed up in the inbox UI but were invisible to the model itself —
  asking "what changed overnight?" the next morning now Just Works.
* Implemented as `renderRecentAutomationForPrompt` in
  `src/automation/jobs.ts`, mirroring the existing
  `renderRecentAuditForPrompt` pattern so the system prompt assembly
  stays uniform.

### Lasting user preferences actually get remembered

* New `REMEMBER ENDURING USER PREFERENCES` rule in the system prompt
  nudges the agent to call the `remember` tool when the user states
  patterns like "always X", "never Y", or "from now on Z". Previously the
  agent rarely invoked `remember` unsolicited even though the storage
  was there — preferences died at the end of the session.
* Restraint built in: do not remember one-off facts or things already in
  agent memory; one remember call per turn unless the user listed
  multiple distinct preferences.

### Inbox dismissals stick across reloads

* The unified inbox strip now shows a small `×` button on each card
  (except permission prompts, which remain non-dismissable for safety).
* Dismissed item ids are persisted in `localStorage.inboxDismissed` with
  a 7-day TTL — the strip GCs expired entries on read so the map never
  grows. Dismissed items reappear after the TTL elapses in case the
  underlying issue is still relevant.

### Curator promotion loop accelerates under candidate pressure

* `CuratorScheduler` now accepts an optional `getPendingCandidateCount`
  + `runWhenCandidatesAtLeast` (default 25) accelerator. When the
  pending learning-candidate queue grows past threshold, the curator
  fires the next time the system is idle even if the long
  `intervalHours` (default 168) has not elapsed.
* `BLOCK` and `INTERRUPT_AND_RECOVER` paths still cannot bypass; the
  idle gate still applies so the curator never interrupts active work.
* Pinned by two new tests in `src/curator/scheduler.test.ts`.

## Ollama Agent Harness v0.4.6

UX release that closes the gap between Harness and the OpenAI Codex
"single adaptive chat for everyday tasks" pitch. The first paint a new
user sees is now chat + composer + a row of quick-start chips with an
expressive avatar in the topbar — every existing tab still works, just
not on the front door anymore.

### Chat-first surface

* The 12-tab left rail is now collapsed by default. The topbar `☰`
  button and slash commands like `/skills`, `/files`, `/memory`, and
  `/history` reveal it on demand. Collapsed state persists in
  `localStorage` so power users keep their preferred layout.

### Inline mycelium context cards

* After each assistant reply, up to four router-selected nodes
  (skills / memories / workflows / tools / services / documents) render
  as small cards under the message. One click opens the relevant left
  tab so users discover what the system pulled in for that turn.
* Restraint built in: skips infrastructure nodes (query / safety /
  verifier / agent), self-routes, low-trust nodes, and identical card
  sets between turns. Cleared between turns alongside the follow-up
  chips. Dismissable per turn.

### Quick-start chips

* The two code-only welcome chips are now six chips that span the full
  Harness range: files, code search, web research, document generation,
  recurring automation, agent identity. New users see "I can ask for
  anything" instead of "this is a code editor".
* `quickStartChipsMarkup()` is the single source of truth, used by both
  the static landing page (populated at `DOMContentLoaded`) and
  `welcomeMarkup()` re-renders triggered by `/new` and `/reset`.

### Unified inbox strip

* New `GET /api/inbox` aggregates pending permission prompts (priority
  100), pending plan tasks (priority 60), failed automation runs
  (priority 50), and successful automation runs (priority 30) into one
  ranked list capped at eight items.
* New strip lives between the topbar and the chat area. Hidden when
  empty so it never nags. Collapse toggle persisted in localStorage;
  cards click through to the right left-rail tab. Refreshes at
  `DOMContentLoaded`, after every chat turn, and on a 60s poll.

### Topbar pet avatar

* The static topbar emoji is now an expressive avatar that reflects
  what Harness is actually doing right now: idle, thinking, working,
  alert (inbox has items), sleepy (>2 min idle), happy (just woke up),
  concerned (last turn errored).
* Reads existing UI signals only — no new backend events. 2s evaluation
  interval, no-op when state is unchanged. Per-state CSS animations
  are subtle by design.

### Validation

* Three new ui-smoke runners (`runMyceliumContextCardsSmoke`,
  `runInboxStripSmoke`, `runTopbarPetSmoke`) plus an extended
  `quickStartChips` assertion pin the new render paths so they cannot
  silently regress.
* New jest test covers the `/api/inbox` endpoint contract:
  priority-then-timestamp ordering, max 8 items, every item has a
  known kind.
* Full ui-smoke + targeted jest suites green.

## Ollama Agent Harness v0.4.5

Patch release that hardens the long-task surfaces (skills, autonomy gates, cloud
streaming) so unattended runs survive the rough edges that surfaced in real
Bracknell email work.

### Skills

* The chat composer's `/<skill-name>` slash palette now actually runs the skill.
  `loadSkills()` is wired into `DOMContentLoaded` so the palette populates on
  first paint, and the per-skill click handler now calls `sendMessage()` instead
  of pasting text the user had to send manually.
* Server-side `parseExplicitSkillInvocation` + `loadExplicitSkillContext` inject
  the chosen skill body into the system prompt for that turn.
* When a skill click cannot send (no model picked, network error), the failure
  is now surfaced as a yellow chat warning instead of a silent `console.warn`.

### Full Autonomy

* `dontAsk` permission mode now bypasses Nervous System `REQUIRE_CONFIRMATION`
  decisions for `email_send`, `slack_notify`, and `telegram_notify` in
  high-risk contexts, matching the existing `REQUIRE_VERIFICATION` bypass.
* `email_draft` always bypasses the dry-run requirement because the tool is
  itself the dry-run version of `email_send`.
* `BLOCK` and `INTERRUPT_AND_RECOVER` (`rm -rf`, kill switch) remain
  non-bypassable. Each bypass writes a `nervous.{verification,confirmation,
  dry_run}_bypassed` event to the runtime tracer for the audit trail.

### Cloud streaming robustness

* `isTransientOllamaChatError` now matches the
  `"Did not receive done or success response in stream."` error from the
  `ollama` client so kimi/glm/gpt-oss cloud truncated SSE streams retry once
  via the existing retry loop.
* New `CONTEXT HYGIENE` block in the system prompt tells the agent not to
  `file_read` a file it just `file_wrote` in the same turn — that pattern was
  the dominant trigger for cloud stream truncation in long deliverable runs.

### Autonomy budget panel

* The autonomy run controls now use clearly-labelled `renderAutonomyBudgetField`
  inputs for tasks-per-run, turns-per-task, time budget, and stall limit.
* `unproductiveTurnLimit` is now clamped 1..100 in both UI input bounds and the
  `/api/autonomy/start` server clamp.
* Cookbook `task-loop.ts` mirrors the same clamp so env-direct callers cannot
  set `HARNESS_UNPRODUCTIVE_TURN_LIMIT` above 100.
* `/api/autonomy/start` echoes `requestedUnproductiveTurnLimit` back so the UI
  can show "Server accepted: ... stall limit N".

### Timed Autonomy banner

* The fixed amber banner no longer overlaps the topbar — body padding is set
  via a `--gab-h` CSS variable equal to the banner's actual height.
* New `▴`/`▾` toggle docks the banner as a small top-right pill; collapsed
  state persists in localStorage.

### Bracknell autonomy

* `ralphLoop` now refuses to mark visual Bracknell tasks complete unless
  `ROBYN_VISUAL_REPORT.html` was changed today.
* `buildTaskPrompt` injects an HTML scaffold so the agent stops dropping
  Markdown reports for visual deliverables.

## Ollama Agent Harness v0.4.4

Patch release for the beginner-facing Keep going runway that keeps unattended
chat work moving without requiring users to understand permission modes, tool
toggles, readiness blockers, or capability grants.

### Keep going runway

* The chat topbar now includes a `Keep going` button that starts a bounded
  2-hour runway from the main chat window.
* Blocked tool actions now show `Keep going 2h` in the recovery row and route
  through the same timed runway instead of permanently changing unrestricted
  settings.
* The runway temporarily enables disabled tools and grants common gated
  capabilities with the same expiration window.
* Beginner-facing status copy now says `Keep going is active` when verifier or
  recovery gates are bypassed by the timed runway.

### Validation

* Contract coverage pins the topbar control, blocked-action recovery button,
  timed-autonomy request, timed tool bulk enablement, and capability grant calls.
* Browser smoke now clicks `Keep going 2h` and verifies timed autonomy, bulk
  tool enablement, three capability grants, active button state, and duplicate
  ID safety.
* Validation passed with focused Jest contract tests, typecheck, build, and UI
  smoke.

## Ollama Agent Harness v0.4.3

Patch release for the audit closure and release metadata repair after the
v0.4.2 tag had already shipped.

### Hardening closure

* API auth and risky permission flows now require explicit audit reasons across
  settings, autonomy, capability grants, API keys, and identity import paths.
* `/api/settings` refreshes detected context before returning public settings,
  so auto mode reports a real effective context limit on first load.
* Global context controls accept and display `0 = auto`, including an Auto
  preset in the UI.
* BashTool behavior is pinned as a no-shell executable runner. Shell built-ins
  and shell control operators are rejected or fail without shell routing.

### Release readiness

* Version-bearing metadata is synchronized for `0.4.3` across package files,
  installer metadata, and release provenance.
* The live context probe workflow is documented with `HARNESS_DEBUG_LOG`,
  including the boundary that full prompt-body verification belongs in tests.
* Validation passed with typecheck, build, focused API/tool tests, UI smoke,
  fresh UI smoke, live settings probe, version verification, release dry-run,
  and the full Jest suite: 133 suites and 1523 tests.

## Ollama Agent Harness v0.4.2

Operational hardening: `harness doctor --fix` auto-remediation,
attachment head previews in the chat system prompt, per-model context
profiles with a UI editor, and a global uploads directory option for
daemons that serve multiple workspaces.

### `harness doctor --fix` (new)

Diagnoses *and* remediates the failure modes that doctor already
surfaces. Three independent fixers run in parallel; failure in one
does not skip the others.

| Fixer | What it does | Trigger |
|---|---|---|
| Vision | Pulls a vision-capable model when none is installed | Requires `--yes` (or interactive `y` on a TTY) |
| Context | Rewrites `contextMaxTokens` from a legacy default (8192/4096) to `0` so auto-detect kicks in | Always when a legacy default is detected |
| Prune | Deletes `agent-outputs/*` files older than 14 days | Always (delegates to the cleanup heartbeat action) |

Usage: `harness doctor --fix [--yes]`. Without `--yes` the vision pull
prompts on a TTY (Y/n) and skips with a hint on a non-TTY.

### Attachment previews (chat system prompt)

`buildAttachmentsContextBlock` appends a 400-char head preview inline
for ~40 text-like extensions (`.csv`, `.json`, `.md`, `.ts`, `.py`,
`.log`, `.jsonl`, …). For `.log`, `.csv`, `.tsv`, and `.jsonl` files
larger than ~4KB, an additional 200-char tail preview is included so
the model sees both the schema/header and the latest entries without a
file_read round-trip. Binary formats (image/audio/video) and PDFs are
skipped.

### Per-model context profiles

New `.harness/model-profiles.json` store keyed by model name. Each
profile may override `contextMaxTokens`, `validationProfile`, and
`pairedVisionModel` so switching from a 4k tiny local model to a 128k
cloud model does not drag the small cap (or wrong validation strictness)
along.

REST surface:
* `GET /api/system/model-profiles` — full store
* `PUT /api/system/model-profiles/:model` — accepts `contextMaxTokens`,
  `validationProfile`, `pairedVisionModel` (any subset; `null`/empty
  clears that field)

`resolveContextMaxTokens(model)` and `buildContextHealth()` consult
the per-model profile first; the global `contextMaxTokens` is the
fallback. The System Health context block exposes `profile_cap` when
one is set, and the System Health UI now has an inline editor for the
active model's cap (set / clear).

### Global uploads dir option

`HARNESS_GLOBAL_UPLOADS=1` routes uploads to `~/.harness/uploads`
instead of `<cwd>/.harness/uploads`. Useful when one daemon serves
multiple workspaces and uploads should not get scattered into whichever
cwd happened to start the server. Resolution order:

1. `HARNESS_UPLOADS_DIR` (explicit override)
2. `HARNESS_GLOBAL_UPLOADS=1` → `~/.harness/uploads`
3. `<cwd>/.harness/uploads` (legacy default)

### Settings clamp relaxation

`contextMaxTokens` accepts `0` via PATCH and via on-disk settings
(previously clamped to a 1024 lower bound). This is what `doctor --fix`
writes when it rescues a legacy default.

### Audit closure (2026-05-08)

The hardening audit closed with focused fixes and validation across the
settings, context, permission, BashTool, autonomy, and UI surfaces.

* `/api/settings` now refreshes detected context before returning public
  settings, so auto mode reports a real effective limit on first load.
* Global context controls accept and display `0 = auto`, including an Auto
  preset in the UI.
* Risky permission changes require explicit reasons, and API auth coverage now
  includes settings, autonomy, capability grants, API keys, and identity import
  paths.
* BashTool behavior is pinned as a no-shell executable runner. Shell built-ins
  and shell control operators are rejected or fail without shell routing.
* Validation passed with typecheck, build, focused API/tool tests, UI smoke,
  fresh UI smoke, live settings probe, and the full Jest suite: 133 suites and
  1523 tests.

## Ollama Agent Harness v0.4.1

Patch: auto-detect context window by default + cleanup_agent_outputs
heartbeat + System Health context/vision banners + grep scratch-dir
exclusion. All driven by failure modes observed in real chat sessions
on cloud models with images.

### Context auto-detect (semantics change — backward compatible)

`contextMaxTokens` is now treated as a **cap**, not a target. The
harness uses the model's detected window automatically, and falls back
to the configured value only when the user has deliberately set a
non-default throttle.

| Configured value | New behaviour |
|---|---|
| `0` / undefined / legacy default (8192, 4096) | Use detected window (auto). 200k absolute ceiling. |
| Explicit value (e.g. 1024, 16k) | Use detected window capped at the configured value. |

Net effect: switching to `glm-5.1:cloud` (128k window) or any other
cloud model "just works" without editing settings. Throttles for
cost/speed are still honoured.

### Other fixes from this cycle

* **Vision-model fallback** — `image_analyze` now lists installed
  models, validates the configured/selected name against the list, and
  auto-falls-back to whichever vision-capable model IS installed instead
  of looping with `model not found`.
* **`cleanup_agent_outputs` heartbeat action** — prunes files in
  `agent-outputs/` older than 14 days. On by default
  (`HARNESS_HEARTBEAT_CLEANUP_OUTPUTS=0` to disable;
  `HARNESS_AGENT_OUTPUT_MAX_AGE_DAYS` overrides cutoff). Stops stale
  reports polluting later searches with off-topic matches.
* **System Health diagnostic banners** — context auto-detect
  banner (`/api/system/health` returns `context: { configured, detected,
  effective, mode, auto_bumped }`) and a vision-model row showing
  configured/effective/installed plus an actionable reason string when
  the configured model isn't installed.
* **Grep scratch-dir exclusion** — `agent-outputs/` and
  `.harness/uploads/` are now skipped by default. Pass
  `include_scratch: true` to opt back in.

### Tests

1443/1443 across 129 suites; typecheck clean.

## Ollama Agent Harness v0.4.0

Major: 100% CLAW-list alignment + trustworthy self-improvement stack +
observability quartet. Every layer is opt-in via env flag; existing
behaviour is preserved when flags are off.

### Trustworthy self-improvement stack

* **OpenInference + OTLP/HTTP-JSON trace export** (`HARNESS_OTEL_EXPORT_ENABLED`)
  - `src/observability/openinference.ts` maps `RuntimeTracer` records to OTLP
    spans with OpenInference semantic conventions (`openinference.span.kind`,
    `llm.model_name`, `llm.token_count.{prompt,completion,total}`,
    `tool.name`, `tool.parameters`, `exception.message`).
  - `src/observability/otlpExporter.ts` is a bounded-queue exporter using
    `globalThis.fetch` — no `@opentelemetry/*` runtime deps. Wraps
    `RuntimeTracer.startSpan/recordEvent` non-invasively; `detach()` restores
    cleanly. Periodic + threshold flush; re-queue on transport error.
  - Wires in via `configureOtlpExporter()` behind env flag + endpoint;
    settings flag mirror in System Health.
* **Promotion gate + safety multiplier** (`HARNESS_PROMOTION_GATE_ENABLED`)
  - `src/learning/promotionGate.ts` requires N successful eval runs
    (Pass^k semantics) AND no blocking safety violations from a 16-rule
    library: AWS access keys, AWS session tokens, GCP service-account
    JSON, GitHub PATs, Slack tokens, OpenSSH keys, PEM blocks, JWTs,
    `.env` reads, `.aws/credentials`, `.ssh/id_rsa`, `rm -rf /`,
    `curl|bash`, prompt-injection markers, system-prompt leak.
  - Custom rules via `.harness/safety-rules.json` (string regex + flags;
    overrides built-ins by id).
  - REST: `GET /api/learning/candidates/:id/gate`. UI Gate button in the
    learning candidate queue.
* **Simulator** (`harness simulate`)
  - `src/eval/simulator.ts` drives `/api/chat` SSE with 8 default probes
    across 5 categories (baseline, prompt-injection, secret-exfil,
    tool-misuse, safety-refusal). Pure `judgeProbe()` evaluator with
    expectIncludes / expectMissing / forbiddenTools.
  - `--persist` flag converts the run to an `EvalTraceRun` and writes it
    under `.harness/evals/trace-runs.jsonl` so the promotion gate counts
    it automatically.
* **Curator safety pre-check** (`HARNESS_CURATOR_SAFETY_GATE`)
  - Stale skills tripping a high-severity rule are recorded as
    `skip-safety` instead of being archived.
  - `skill_evolution` heartbeat action surfaces high-severity safety
    hits in every tick regardless of gate flag.

### Observability quartet

* **Prometheus `/metrics` endpoint** — exposition format text writer in
  `src/observability/prometheus.ts`. Emits `harness_kill_switch_active`,
  `harness_active_subagents`, `harness_capability_grants_active`,
  `harness_heartbeat_age_seconds`, `harness_otel_export_queued`,
  `harness_tool_window_samples`, `harness_tool_failure_rate`. No
  `prom-client` dependency.
* **Tool failure-rate alerts** — sliding-window tracker in
  `src/services/toolFailureAlerts.ts` (50-sample window, 30% threshold,
  5-min cooldown by default, all env-tunable). Fires `tool.failure_alert`
  events onto the event store so live WS clients react.
* **WS broadcast batching** (`HARNESS_WS_COALESCE_MS`) — set to e.g. `50`
  to coalesce events within a window into a single `event_batch` message.
  Default off (single-event semantics preserved). UI + TUI fan out
  batches transparently.
* **Heartbeat sparkline** in System Health — pure SVG polyline of recent
  tick durations.

### TUI + sub-agent surfaces

* `harness tui` — readline + ANSI terminal client sharing the running
  daemon session over HTTP + WebSocket. Auto-reconnect on WS close;
  slash commands `/quit /exit /help /agents /clear`. Zero new runtime
  deps.
* Active sub-agents bar above the chat input with cancel buttons.
  Driven by `/api/subagents` + WS events
  (`subagent.start|end|cancel`).
* `runSubagent` accepts optional `runId` + `abortSignal` + `onEvent`;
  `createSubagentTool` generates a runId per chat-initiated run.

### Heartbeat learning hooks

* `createReflectAndLearnAction()` (`HARNESS_HEARTBEAT_REFLECT_ENABLED`)
  surfaces recent reflections from `.harness/learning/reflections.jsonl`.
* `createSkillEvolutionAction()` (`HARNESS_HEARTBEAT_SKILL_EVOLUTION_ENABLED`)
  dry-runs the curator + reports stale candidates AND high-severity
  safety hits.

### CLAW alignment closure (cycles 1–10 summary)

* WebSocket daemon, structured task store + tools + Tasks tab,
  self-learning heartbeat, memory intelligence (TOC fallback,
  importance scoring, dedup, GC), custom agents from `.md` defs,
  triggers, `docker_exec` sandbox, squad channels, tools/MCP UI,
  artifacts browser, audit hook, reply-to-message, speech-to-text,
  Esc-to-stop, identity (SOUL/USER), concierge auto-route.
* Final scorecard: 79/79 features, 100%.

### Tests

* 1439/1439 passing across 129 suites; typecheck clean. ~140 new tests
  added across the trustworthy-stack and observability cycles.

## Ollama Agent Harness v0.3.30

Second roll-forward release for CI smoke determinism. The v0.3.29 candidate
still depended on chat-stream timing for part of the browser smoke; this patch
removes that dependency.

### Release Pipeline

* **Deterministic permission recovery smoke** - renders the recovery row through
  the UI helper in a fixed smoke host instead of waiting for a synthetic chat
  stream on CI.
* **Stable MCP discovery assertion** - treats the successful synthetic discover
  click as evidence that the MCP discovery controls rendered, avoiding
  post-cleanup DOM state sensitivity.

## Ollama Agent Harness v0.3.29

Roll-forward release after the v0.3.28 tag was blocked by CI smoke timing.
The v0.3.28 source commit is preserved, and this patch adds the release-runner
hardening needed for the tag workflow to publish cleanly.

### Release Pipeline

* **CI UI smoke hardening** - waits longer for the permission recovery action
  row on slower GitHub runners and captures MCP discovery-control evidence at
  the point where the synthetic MCP panel is rendered.
* **Installer build verified locally** - `Harness-Setup.exe` builds with NSIS
  `makensis` once the installed NSIS path is used directly.
* **Slash palette remains pinned** - bare `/` in the chat composer opens the
  slash-command palette immediately, with smoke coverage verifying `/help` is
  present.

## Ollama Agent Harness v0.3.28

Runtime-state hardening and release readiness for local testing. This release
keeps the Harness local-first and model-agnostic while making the automation
surface safer to inspect, clean up, and smoke-test before packaging.

### Runtime State Safety

* **Automation job safety audit** — classifies known deterministic test-created
  jobs separately from protected user and service jobs, with a non-destructive
  `npm run audit:automation-jobs` report for live `.harness` state.
* **Reversible duplicate job archive** — adds
  `npm run cleanup:automation-jobs -- --apply`, which writes an archive under
  `.harness/automations/archive/` before removing known test-created duplicate
  jobs from the active jobs file.
* **Server runtime-state guardrails** — server API tests now snapshot, seed,
  diff, and restore automation runtime state so live jobs are not mutated by
  test execution.

### Capability Readiness

* **CLAW-style trigger contracts** — capability starters now expose explicit
  trigger metadata for manual, scheduled, event, and message-ingest entry
  points without adding a new daemon or SDK dependency.
* **Capability starter UI smoke** — the fresh browser smoke now verifies that
  starter details render trigger contracts and preview successfully.
* **Automation safety UI panel** — the Runs tab surfaces live archive-candidate
  and protected-job counts from the new safety API.

### Validation & Packaging

* **Fresh UI smoke mode** — `npm run smoke:ui:fresh` starts its own local
  server and refuses stale port reuse, reducing false-positive browser smoke
  results on Windows.
* **Dependency audit grant smoke** — adds an opt-in smoke for read-only
  dependency audit execution while continuing to reject mutating `npm audit fix`
  commands.
* **TypeScript config refresh** — removes deprecated `baseUrl` usage while
  keeping path mappings explicit and compatible with the repo compiler.

## Ollama Agent Harness v0.3.27

Release-pipeline rescue: fixes the recurrent CI flake that prevented every
release between v0.3.20 and v0.3.26 from publishing. Bundles all deferred
v0.3.21–v0.3.26 work (see those sections below) and adds the rescue itself.

> **Release gap notice.** Tags v0.3.20 through v0.3.26 were created but their
> Release workflows all failed at the same `src/persistence/eventStore.test.ts`
> flake; no GitHub Release was ever published for those versions. The latest
> published release before this is v0.3.19. v0.3.27 is the first release that
> ships all intermediate work. Earlier failed runs were retained for audit and
> are documented in the changelog below.

### Release Pipeline Rescue

* **`eventStore` same-millisecond ordering fix** — `queryEvents` now tie-breaks
  equal-timestamp events by an in-memory file-append index and a new optional
  monotonic `seq` field on each `HarnessEvent`. CI hosts emit events fast
  enough to land in the same millisecond; the previous DESC sort was stable
  but `getUndoEvents` reverses the result, so ties rotated and one extra
  event always slipped past the cutoff. Pinned by a regression test that
  mocks `Date.toISOString()` to force ties.
* **`HarnessEvent.seq`** — new optional monotonic counter assigned by
  `appendEvent`. Persisted in the event JSONL. Used as the primary tiebreaker
  in `queryEvents` ordering; legacy events without `seq` fall back to
  file-append order.
* **`scripts/bump-version.js` + `npm run release:bump`** — single-source
  version bump that updates `package.json`, the lockfile, the NSIS installer
  metadata, and `release-provenance.json` together, eliminating the
  4-mismatch failure that bit the v0.3.26 bump.
* **`npm run verify:changelog`** — fails when `package.json` version has no
  matching `## ... v<version>` section in CHANGELOG. Wired into the CI
  workflow before `release:dry-run` so a tagged release whose notes would be
  empty cannot reach the Publish step.
* **Structural test for the connector startup gate** — pins
  `startTelegramBot` and `startDiscordBot` to live inside the same
  `if (startupConnectorsEnabled())` block so an accidental move outside the
  gate fails CI rather than CI-poisoning the next release smoke.
* **Test isolation hardening** — wraps the remaining trailing-cleanup test
  patterns (RAG SSE smoke and one earlier sweep) in `try/finally` so a failed
  assertion can no longer leak grants, kill-switch, permission mode, or
  disabled-tool state into later tests in full-suite ordering.

## Ollama Agent Harness v0.3.26

Routing visibility, MCP runtime, and release-pipeline hardening on top of v0.3.25.

### Routing & Context

* **Visible routed-model UI feedback** — when auto-routing escalates a weak-tools model, the chat surfaces the model that actually ran the turn.
* **Context budget breakdown** — first-turn prompt assembly now emits a `context_breakdown` event covering system, history, mycelium, and tool inputs so prompt bloat is explainable.
* **Configurable web-read budget** — `webReadMaxChars` setting caps per-tool payloads; default trims oversized pages before they reach the model.
* **Repeated web-read guard** — URLs that already failed during the same run are blocked from being re-fetched.
* **Mycelium context cap** — router-injected context is bounded to keep small models inside their context window.
* **Cloud model tool-capability hints** — `inferModelCapabilities` now consults the provider preset's `supportsTools` flag for backend-prefixed models (Groq/Mistral/OpenAI = strong; Cerebras/Cloudflare/DeepInfra = weak).
* **Model recommendation engine** — when a weak-tools model is selected, the capability hint suggests a tool-capable alternative.

### MCP Runtime

* **Stdio MCP tool invocation** — discovered MCP tools are exposed through the standard `ToolRegistry` so the agent can call them like any builtin.
* **MCP discovery controls** — dashboard now surfaces add/remove/refresh actions for configured MCP servers.

### Connectors & Evidence

* **Connector readiness surfaces** — Slack, WhatsApp, and similar integrations expose readiness state so health endpoints can reason about them.
* **Gated desktop input replay** — `desktopInputTools` allow replaying recorded desktop events under explicit capability grants.
* **Session import/export** — `GET /api/sessions/:id/export` and `POST /api/sessions/import` round-trip a session as JSON; UI adds Import and Export buttons.

### Release Pipeline

* **Aligned release provenance** — `npm run release:provenance` now matches CI inputs; the GitHub workflow uses the same script.
* **`release:dry-run` builds before staging** — local dry-run produces the same archive shape CI publishes (`dist`, `ui`, `scripts`, `package.json`, `package-lock.json`, `README.md`, `start.bat`, `release-provenance.json`).
* **`HARNESS_DISABLE_STARTUP_CONNECTORS=1`** — startup guard suppresses Telegram/Discord side effects during release smoke and validation runs.
* **Bounded news + lean Gemma diagnostics** — `npm run smoke:bounded-news` and `npm run diagnose:gemma-tool` are tracked diagnostics that exercise routing without unbounded model burn.

### Fixes

* **Tool-use reliability metrics** — corrected counters for models that emit JSON-in-content tool calls.
* **Test isolation** — automation lifecycle and kill-switch persistence tests now wrap cleanup in `try/finally` so a failing assertion can no longer leak grants or kill-switch state into later tests.

## Ollama Agent Harness v0.3.25

Agent Loop Safety Suite — wall-clock time budget, repetition detection, adaptive pacing, and full observability overhaul. Motivated by small models (Gemma 4 E4B) hammering the GPU on research queries.

### Safety Guards

* **autoContinue limiter** — stops after 1 continuation when the model never uses tools, preventing chat-only models from burning compute on repeated text generation.
* **Wall-clock time budget** (`maxTimeMs`) — 3 min local / 10 min cloud default, triggers a synthesis turn instead of aborting. Model always gets at least one turn. User-configurable via Settings.
* **Repetition detection** — consecutive identical text-only responses break to synthesis after 2 repeats.
* **Synthesis context trimming** — synthesis call gets system + last user message + tool results only, not the full conversation history.
* **Synthesis fallback** — when synthesis produces empty text, surfaces the raw tool results so the user always sees something useful.
* **Richer synthesis prompt** — includes last 5 tool results directly for small models that cannot recall from deep context.
* **Tool-use nudge** — system prompt now instructs models to use `web_search` for current-events queries instead of answering from training data.

### Adaptive Pacing

* **Per-model turn duration tracking** — EMA (α=0.3) of wall-clock turn time in synthesis stats.
* **Adaptive time budget** — after 3+ sessions, `maxTimeMs` auto-computes as `avgTurnMs × 10 turns`, clamped 60s–900s. Fast cloud APIs get tighter budgets; slow local models get more time.

### Observability

* **`TurnCompleteEvent`** — wall-clock duration per turn (model + tools) emitted to UI.
* **`TimeBudgetStatusEvent`** — elapsed/budget each turn drives UI progress bar.
* **`UsageEvent` expanded** — now carries `loadDurationMs`, `promptEvalDurationMs`, `evalDurationMs` from Ollama.
* **Session HUD** — shows wall-clock time in topbar; tooltip shows model vs wall-clock breakdown.
* **Message footer** — prefill/gen timing, turn duration, VRAM load indicator (>500 ms shows actual load time).
* **Topbar countdown** — streaming badge shows turn number and seconds remaining during active chat.
* **Per-model stats dashboard** — table in Settings with sessions, avg turn, budget, max turns, synthesis rate, and CSV export.
* **Model capability hints** — UI warns when a model is unlikely to call tools reliably.

### Fixes

* **Double browser tab on `start.bat`** — removed duplicate browser open (server handles it via `NO_OPEN`).
* **Browser tool test timeouts** — `Promise.race` with 3s fallback for Playwright-dependent assertions.
* **Desktop screenshot test timeout** — same pattern.

## Ollama Agent Harness v0.3.24

Small Model Autopilot — deterministic shortcuts, readiness gate, structured output validation.

### Small Model Autopilot

* **Deterministic Shortcuts (Tier 0)** — date calculation, math/statistics, JSON parse, sorting, regex extraction, unit conversion, percentage, countdown, word count, base conversion bypass model calls entirely.
* **Execution Readiness Gate** — weighted score (confidence × schema × verifier × ambiguity × risk × reliability) drives execute/verify/escalate decisions.
* **Structured Output Validator** — 8 built-in schemas (tool_call, service_command, code_edit, planning_output, analysis_result, file_write, bash, web_search) with type checking and custom rules.
* **Readiness-driven escalation** — when readiness < 0.60, UI shows escalation advisory suggesting a stronger model.
* **Output text schema validation** — JSON blocks in assistant text validated against task-appropriate schemas.
* **3 new nervous system reflexes** — small_model_first, small_model_failure_escalation, deterministic_shortcut.
* **Bash command safety** — schema detects rm -rf /, format c:, fork bombs before execution.
* **Shortcut hit rate** tracked in /api/subsystems/health with per-type breakdown.
* **Readiness badge** shown in chat tool box after each turn.

## Ollama Agent Harness v0.3.23

UX polish, live monitoring, and subsystem health visibility.

### UX

* Send button pulses red during streaming (was static square).
* Pulsing 🔴 streaming badge in topbar — visible even when scrolled away.
* Thinking pill shows which tool is running with icons (📝 file_write, 🔍 web_search, 💻 bash, etc.).
* Thinking indicator restyled with background highlight for better visibility.

### Promises

* Cancel button + `POST /api/promises/:id/cancel` endpoint.
* Promise timeline showing created → fulfilled/expired/cancelled with timestamps.
* Manual promise creation form in Promises tab (commitment, service ID, due date).
* Promise widget in Settings panel showing pending/breach count at a glance.
* Breach text flashes for attention.
* Auto-create promise when service is set up with a schedule (bullet journal + generic).
* Scheduler auto-fulfils pending promises linked to executed jobs via `schedule_id`.
* Breach notifications via Telegram + webhooks from scheduler.
* Tightened commitment detection patterns to avoid false positives.
* Curly apostrophe (U+2019) support in commitment patterns.

### Events

* Live event feed in Events tab via SSE (`GET /api/events/stream`).
* `POST /api/events` endpoint for external event emission.
* Event category filter toggles (click pills to filter, show-all link).
* Event text search input (filters by type, category, or data content).
* Event export button downloads all events as JSON.
* 24-hour timeline bar chart visualization grouped by hour.
* Auto-scroll to top on new live events (only if user is near top).
* Event retention policy: `pruneEventsByAge` (HARNESS_EVENT_RETENTION_DAYS env, default 30 days).
* Auto-prune old events during scheduler post-execution checks.
* Auto-prune at 10K events on append.

### Code Intelligence

* Architecture diagram generator (mermaid format) with live SVG render in sandboxed iframe.
* Dark/light theme detection for mermaid diagrams.
* File search input for ad-hoc impact analysis.
* Clickable file rows showing importers, transitive deps, affected tests, risk score.
* Configurable ignore dirs (`HARNESS_CODE_INTEL_IGNORE` env or `ignoreDirs` option).
* Route explanations include structurally relevant `code_file` nodes.
* Code Intelligence readiness section in status API (graph + coverage checks).
* Repo summary injected into system prompt for structural awareness.

### Subsystem Health

* `GET /api/subsystems/health` — aggregated health for all 6 subsystems.
* Subsystem Health panel in Mission Control with per-subsystem status.
* Code Intelligence + Promise Ledger sections in readiness API.
* `harness doctor` shows event store summary + promise obligation health.

### Testing

* E2E integration test: service lifecycle → promise → events → obligations → graph → impact → diagram → pruning.
* E2E test: service setup → promise creation → auto-fulfil → obligations clear.

### Infrastructure

* `/api/services/templates` route ordering fix.
* `promise.breach` webhook event type.
* `code_file` node type + `code_intelligence` edge origin in mycelium graph.

## Ollama Agent Harness v0.3.21

Agent operating system — six new subsystems, deep integration, and Anthropic support.

### New subsystems

* **Promise Ledger** — tracks agent commitments, auto-detects commitment language in chat output, obligation checking with breach detection.
* **Service Lifecycle** — state machine (draft → active → paused → disabled → archived → error → needs_attention) with 7 service templates and health probes.
* **Event Store** — append-only audit trail with temporal queries, snapshots, undo, postmortem generation, and auto-pruning at 10K events.
* **Done-State Verifier** — validates code (typecheck/lint/tests), services (state/commands/schedule), and promise fulfillability.
* **Subagent Orchestrator** — parallel workstream execution with 11 agent roles, per-agent budgets, dependency ordering, and result merging.
* **Code Intelligence** — repo graph builder from import analysis, impact analysis, test mapping, and risk scoring.

### Integration

* Chat handler auto-detects commitment language and records promises.
* Per-tool events (`tool_succeeded`/`tool_failed`) emitted to event store on every tool call.
* Chat turn completion events emitted after every turn.
* `file_write` and `file_edit` append impact analysis (affected tests, importers, risk score) to output.
* Code graph auto-builds on server startup and invalidates on code file changes.
* Mycelium router seeds `code_file` nodes from most-imported files with import edges.
* Scheduler post-execution checks: obligation breaches, service health probes, auto-expire stale promises.
* Promise obligations shown in readiness/status API.

### UI

* Three new left-panel tabs: 🤝 Promises, 📋 Events, 🧬 Code Intel.
* Service detail panel shows lifecycle status, health, and Activate/Pause/Disable/Archive buttons.
* Promises tab shows breach alerts and per-promise fulfil buttons.
* Code Intelligence tab shows repo summary with rebuild button.

### Providers

* Added Anthropic as an OpenAI-compatible backend (claude-sonnet-4-20250514, tools supported).
* HTTP 413 (request too large) now triggers auto-fallback to next provider instead of hard-failing.

### Worker

* `expire_promises` worker job type for manual or automated stale promise cleanup.

## Ollama Agent Harness v0.3.19

Release validation patch for the Discord bridge startup path.

### Release validation

* Prevented pending Discord bot startup failures from logging after tests stop the bot handle.
* Keeps the release workflow validation step clean while preserving Discord startup warnings during real runs.

## Ollama Agent Harness v0.3.18

Slack notifications, local MCP runtime management, and nervous-system motor enforcement.

### Communications

* Added `slack_notify` as a gated outgoing notification tool backed by `HARNESS_SLACK_WEBHOOK_URL`.
* Documented Slack setup in the README and exposed the webhook through Settings API key storage.

### MCP runtime

* Added persisted MCP server definitions under `.harness/mcp/servers.json`.
* Added runtime APIs and dashboard controls for listing, configuring, starting, and stopping local MCP servers.
* Gated MCP server starts behind the existing `arbitrary-shell` capability grant and audit log.

### Nervous system

* Wired motor permission decisions into the live chat permission path before the standard permission engine.
* Blocks destructive shell commands, enforces dry-run and verification decisions, and prompts when confirmation is required.
* Treats Slack notifications as high-risk outgoing communications in high-risk contexts.

## Ollama Agent Harness v0.3.17

Tool failure resilience, browser fallback guidance, and server watchdog.

### Resilience

* Repeated tool failures (HTTP 429/403) now warn the model instead of killing the loop.
* Model gets a system message to try alternative tools or different sites.
* Failure counter resets after warning so the model can continue with other URLs.

### System prompt

* Added TOOL FALLBACK RULES: model told to use `browser_navigate` for blocked sites.
* Model explicitly told not to retry rate-limited URLs.

### Server

* Added `start-watchdog.bat` — auto-restarts server on crash, cleans stale locks.

### Stats

* Synthesis stats tracking live: `kimi-k2.5:cloud` at 0/3 synthesis fires (autonomy prompt working).

## Ollama Agent Harness v0.3.16

Mycelium-integrated autonomy with risk-aware auto-continue.

### Autonomy integration

* Mycelium task classification now flows into LoopConfig as `taskType`.
* Auto-continue is disabled for high-risk tasks: `financial_execution`, `safety_critical`, `medical`, `legal`.
* Safe tasks (`financial_analysis`, `research`, `coding`, etc.) get full autonomous continuation.
* Added `preference.autonomy` as a protected Mycelium seed node (trust 1.0).

### Auto-continue hardening

* Expanded detection from 16 to 31 continuation phrases.
* Added user-directed question detection at end of response.
* Strengthened system prompt with explicit multi-file/multi-step autonomy rules.

### Tests

* 35 queryLoop tests (2 new: high-risk blocks, safe task allows).

## Ollama Agent Harness v0.3.15

Auto-continue eliminates stop-start behavior where models ask permission instead of completing tasks.

### Query loop

* Added `autoContinue` mode: when the model produces a partial result with suggestions or continuation prompts, the loop automatically injects a "continue with all" message and keeps going.
* Detection covers numbered suggestion lists, "would you like me to continue", "shall I proceed", and 15 other common stop-start patterns.
* Capped at 5 auto-continues per session (configurable via `autoContinueLimit`).
* Autonomy system prompt nudge: models are told to complete tasks fully without stopping to ask.

### UI

* Auto-continue events shown as 🔁 badges in the tool box with the detection reason.

### Tests

* 9 new tests: 4 autoContinue loop tests, 5 detectPartialResult pattern tests.

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
