---
name: "git-workflow"
description: "Git workflow for the Ollama Agent Harness — atomic commits, small changes, safe history"
domain: "git"
confidence: "medium"
source: "authored for harness gap-fill"
triggers:
  - "commit this"
  - "write a commit message"
  - "git workflow"
  - "stage my changes"
---

## Context

Git workflow skill for the Ollama Agent Harness. Changes should land as small, self-contained commits that each leave the test suite green. The harness has destructive-action guardrails; this skill keeps history clean without bypassing them.

## Patterns

### Atomic Commits

One logical change per commit. A subsystem fix, its regression test, and any directly-orphaned cleanup belong together; unrelated edits do not. Keep diffs reviewable — roughly one concern, not a grab bag.

### Commit Message Shape

- Imperative subject under ~72 chars: `fix permission deny ordering`.
- Body explains the *why*, not a restatement of the diff.
- Reference the subsystem when it aids scanning: `context: cap oversized tool results`.

### Green Before Commit

Run `npm test` (or the affected subset) before committing. Do not commit on a red bar. Stop-the-line: a broken build is fixed before new work stacks on it.

### Stage Deliberately

Review the diff before staging. Stage only files that belong to the current logical change. Never blanket-add build output, secrets, or unrelated edits.

### Safe History

Local rebasing and amending of unpushed commits is fine. Do not force-push shared branches, hard-reset away unfamiliar work, or amend published commits without explicit confirmation — these are hard to reverse.

## Examples

### Focused commit

```
git add src/permissions/evaluate.ts src/permissions/evaluate.test.ts
git commit -m "fix: deny rule must override more specific allow"
```

### Inspect before staging

```
git status --short
git diff src/context/
```

## Anti-Patterns

- One commit mixing an unrelated refactor with a bug fix.
- Committing with failing or unrun tests.
- `git add -A` that sweeps in build artifacts or stray edits.
- Force-pushing a shared branch or hard-resetting unfamiliar changes.
- Commit messages that restate the diff instead of the reason.
