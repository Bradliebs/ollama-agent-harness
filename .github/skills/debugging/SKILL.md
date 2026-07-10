---
name: "debugging"
description: "Systematic debugging for the Ollama Agent Harness — reproduce, localize, reduce, fix, guard"
domain: "debugging"
confidence: "medium"
source: "authored for harness gap-fill"
triggers:
  - "debug this"
  - "why does this fail"
  - "test is failing"
  - "fix the error"
---

## Context

Debugging skill for the Ollama Agent Harness. The harness runs local Ollama models with a simple agent loop, permission gating, and append-only sessions. Most bugs surface as failing Jest tests, broken tool dispatch, permission misfires, or context-budget regressions. Debug by evidence, not by guessing — a small local model cannot afford speculative edits.

## Patterns

### Five-Step Triage

1. **Reproduce** — Get a deterministic failing case first. Mock the Ollama client (see the `testing` skill) so the failure does not depend on a live model. No reproduction, no fix.
2. **Localize** — Narrow to one subsystem: `core/` (loop), `tools/` (dispatch), `permissions/`, `context/`, `agents/`, `persistence/`. Use `code_graph callers <symbol>` / `code_graph callees <symbol>` to trace the call path before reading files.
3. **Reduce** — Strip the case to the minimum that still fails. Remove unrelated tools, rules, and history.
4. **Fix** — Change the smallest thing that makes the reduced case pass. One cause per fix.
5. **Guard** — Add a Jest test that fails before the fix and passes after, so the bug cannot return.

### Stop-the-Line Rule

When a build or test breaks, fix it before adding new behavior. Do not stack changes on a red bar.

### Numeric / Directional Trace

For any directional bug (a ratio, signed margin, inequality, truncation threshold, off-by-one), write a one-line numeric trace showing the condition firing before editing. Prose like "it should truncate when too big" hides inverted comparisons.

### Surface, Do Not Swallow

Errors in tool dispatch must return as tool results for the model to adapt to. A `catch` that logs and continues silently hides the bug and the next failure.

## Examples

### Reproduce with a mocked client

```typescript
it('recovers when a tool throws', async () => {
  mockOllama.chat.mockResolvedValueOnce({
    message: { role: 'assistant', tool_calls: [{ function: { name: 'bash', arguments: '{}' } }] },
    done: true,
  });
  tool.execute = jest.fn().mockRejectedValue(new Error('boom'));

  const events = [];
  for await (const event of queryLoop(config)) events.push(event);

  expect(events.some(e => e.type === 'tool_result' && e.result.error)).toBe(true);
});
```

### Localize with the code graph

```
code_graph callers dispatchTool
code_graph around checkPermission 1
```

## Anti-Patterns

- Editing source before a deterministic reproduction exists.
- Fixing a symptom in one call site when the cause is shared upstream.
- Adding a `try/catch` that swallows the error instead of returning it as a tool result.
- Landing a fix with no regression test to guard it.
- Writing a directional fix from prose without a numeric trace.
