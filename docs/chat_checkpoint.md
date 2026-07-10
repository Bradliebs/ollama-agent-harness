# Chat Checkpoint — Governance of Learning

_Last updated: 2026-06-11 • Repo: `ollama-agent-harness` • Branch: `dev` (v0.6.5)_

## Goal

Strategic objective: **accumulate learning without drifting.** A 5-capability
governance audit found memory proposal review and conflict detection already
existed; source auditing, approval workflows, and grounded reporting were only
partial. This work closed those gaps in two phases.

## Decisions made

- **Scope:** Phase 1 (drift-critical) + Phase 2 (legibility) both implemented.
  Rejected adding a human approval gate to experiments — it would undercut the
  automation that already works.
- **Everything additive and default-off:** no behavior changes unless a flag is
  set. No new dependencies.
- **Session provenance via `AsyncLocalStorage`, not a process-global env var.**
  `Tool.execute(input)` has no session context and sessions run concurrently
  (subagents/squads); a global would race and risk *false* lineage. The async
  context scopes the id to the dispatch call-tree. `HARNESS_SESSION_ID` env var
  kept as a fallback. Absent context ⇒ no lineage recorded (never a wrong one).
- **Dropped `sourceCandidateId`** (was in the plan) — no consumer, avoided
  speculative code.
- **No enforce-override approval event** — there is no override path (enforce
  simply blocks), so nothing to log.
- **ccmem SQLite lineage deferred** — real lineage needs a schema migration;
  only the ccmem `label` string was enriched with the session id.
- **Commit hygiene:** staged only the 12 governance files; left the unrelated
  prior fork work and `jest-full.txt` uncommitted.
- **Mainline sync** done with the repo's `scripts/sync-branches.ps1`
  (`merge --ff-only`, no force). Stashed fork work to pass the script's
  dirty-tree guard, then popped it back.

## Files changed (committed `801261d`)

| File | Change |
| --- | --- |
| `src/services/memoryIntelligence.ts` | `MemorySection` + `AppendSectionOptions` gain optional `sourceSessionId` / `createdByTool`; `IMPORTANCE_RE` extended with optional `source-session` / `created-by` groups; parse + append round-trip them (backward compatible). |
| `src/services/memoryIntelligence.test.ts` | Provenance round-trip + backward-compat tests. |
| `src/services/memoryConflictDetector.ts` | `DEFAULT_CONFLICT_BLOCK_THRESHOLD = 0.8` + pure `selectBlockingConflicts(conflicts, threshold)`. |
| `src/services/memoryConflictDetector.test.ts` | `selectBlockingConflicts` unit tests. |
| `src/tools/memoryTools.ts` | `remember` stamps provenance meta; opt-in enforce gate; ccmem label carries session. |
| `src/tools/memoryTools.provenance.test.ts` | **New.** Provenance stamping (env + async context) and enforce ON/OFF/low-confidence. |
| `src/tools/sessionContext.ts` | **New.** `AsyncLocalStorage` session context: `runWithSessionId` / `getCurrentSessionId`. |
| `src/core/queryLoop.ts` | Binds `session.getSessionId()` around tool dispatch via `runWithSessionId`. |
| `src/learning/sessionLearning.ts` | `reviewLearningCandidate` emits a queryable `approval` event on promote/reject (best-effort). |
| `src/learning/sessionLearning.test.ts` | Approval-event assertion test. |
| `src/experiments/report.ts` | `renderScorecardReport`: pure grounded markdown citing every scorecard field behind the verdict. |
| `src/experiments/report.test.ts` | Grounded report renderer tests. |

### Environment variables introduced

- `HARNESS_MEMORY_CONFLICT_ENFORCE=1` — opt into blocking conflicting memory writes (default off = advisory warn-then-write).
- `HARNESS_MEMORY_CONFLICT_THRESHOLD` — block threshold, default `0.8`.
- `HARNESS_SESSION_ID` — best-effort provenance fallback (async context preferred).

## Current status

- **Committed:** `801261d` on `dev`.
- **Pushed:** `origin/dev`, `origin/main`, `origin/master` all point at `801261d`
  (fast-forwarded, no force).
- **Tests:** full suite green — **276 suites / 3230 tests**. `npm run typecheck`
  clean.
- **Working tree (uncommitted):** unrelated prior "fork" work remains —
  modified `src/eval/benchmark.ts`, `src/experiments/{runner,manifest,types}.ts`,
  `src/experiments/holdout-battery.test.ts`, `docs/AUTORESEARCH-EXPERIMENTS.md`;
  untracked `cookbook/auto-research.holdout-battery-{hardened,overconfident-baseline,replicated}.manifest.json`,
  `src/eval/benchmark.replicates.test.ts`, `jest-full.txt`.
  > Note: an automated/formatter edit touched several of these files plus
  > `src/services/memoryIntelligence{,.test}.ts` after the commit — re-check
  > current contents and re-run typecheck/tests before committing them.

## Next steps

1. **Decide on the uncommitted fork work** (holdout-battery / replicate infra).
   Verify it (typecheck + jest), then commit it on its own — exclude `jest-full.txt`.
2. **Wire enforce mode + provenance into a real product path** if desired (a host
   that sets the session and flips `HARNESS_MEMORY_CONFLICT_ENFORCE`), and
   validate the mechanism end-to-end on that path rather than only in unit tests.
3. **ccmem lineage (optional):** add the SQLite migration so concept cells carry
   real source metadata, not just an enriched label.
4. **Surface `renderScorecardReport`** wherever experiment results are shown
   (CLI `--show`, web UI) so the grounded narrative is actually consumed.

## Unresolved issues / risks

- **Enforce mode validated only in unit tests.** Per project memory, a mechanism
  tuned/tested on one shape can invert on the real path — confirm on a real
  retrieval/write path before relying on it.
- **Threshold 0.8 is a heuristic.** Confidence ranges: duplicate fires ≥0.70,
  supersession 0.5–0.9, negation 0.45–0.85, contradiction 0.40–0.80. 0.8 blocks
  only high-confidence conflicts; revisit if false-blocks or misses appear.
- **`HARNESS_SESSION_ID` is unset by any host today** — provenance currently
  populates only through the `queryLoop` async-context binding. Other entry
  points (direct tool calls, other loops) record no session unless they wrap
  dispatch with `runWithSessionId`.
- **Post-commit automated edits** to memory + experiments files are unreviewed
  (see status note).
- **A daemon may still be listening on port 4301** from earlier in the session;
  stop with `Get-NetTCPConnection -LocalPort 4301 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }` if needed.
