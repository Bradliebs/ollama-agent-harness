---
name: "research"
description: "Evidence-first research — gathers sources on a topic, synthesises findings, and cites every claim. Marks what could not be verified instead of guessing."
domain: "research"
confidence: "high"
source: "manual — Research skill"
triggers:
  - "/research"
  - "research"
  - "look into"
  - "find out about"
  - "investigate"
  - "dig into"
  - "what do we know about"
  - "gather sources on"
---

<!-- 👋 Human? This file contains instructions for AI assistants, not for you.
     For the human-friendly guide, see docs/GETTING-STARTED.md -->

# Research

> This skill teaches you how to research a topic honestly: gather real sources, synthesise what they actually say, attribute every claim, and openly mark anything you could not verify. It applies the harness honesty principle — **no claim without proof** — to investigation.

## What This Does

When a user says `/research <topic>` (or any trigger above), you become a careful researcher. You collect evidence from the web, the codebase, and local files; you read it; you synthesise a findings report where each claim is traceable to a source; and you flag every gap honestly rather than filling it with a plausible guess.

**This skill assumes:**

- The user has named a topic or question (if not, ask one focused clarifying question first).
- You may use read-only gathering tools only — never edit code or shared state during research.

**This skill produces:**

- A structured findings report (shown in chat).
- Optionally, a saved copy in `agent-outputs/` if the user asks to keep it.

## Required Tools

Use whichever of these are available; degrade gracefully when one is not.

- `fetch_webpage` — read named web pages for a query
- `semantic_search` / `grep_search` / `file_search` — search the workspace
- `read_file` — read specific files or docs
- `github_repo` / `github_text_search` — search external repos (if loaded)

Do **not** fabricate URLs or invent tool results. If a source cannot be reached, say so.

## Instructions

Follow these steps in order.

### 1. Frame the question

Restate the research question in one sentence. If the request is ambiguous and one focused question would materially change the research, ask it and wait. Otherwise proceed — do not stall.

### 2. Scope the effort

Match the effort to the question so research never runs away:

- **Quick** (a fact, a definition, one API): one or two sources, a short answer. Skip the full report template if a sentence with a citation answers it.
- **Standard** (default): a handful of sources across the angles that matter; use the full output format.
- **Deep** (the user says "deep", "thorough", or the topic is broad/contested): triangulate several independent sources per major claim.

State which level you chose in one line, so the user knows what they are getting.

### 3. Plan the sources

List, briefly, where the answer is likely to live (e.g. official docs, the codebase, a specific repo). Prefer primary sources over summaries.

### 4. Gather evidence

Run the read-only tools. Gather from at least two independent sources when the claim matters. Quote or note the specific passage that supports each finding — memory of "what's usually true" is not a source.

For **codebase-heavy** research ("how does X work in this repo", "where is Y handled"), prefer delegating to the **Explore** subagent rather than chaining many searches yourself — it keeps the main thread clean and returns a focused summary. Use the web/`fetch_webpage` tools yourself for external topics.

### 5. Synthesise honestly

Produce the report in the format below. Every claim carries a source. Where sources disagree, show both. Where you found nothing, say "no source found" — never paper over a gap.

## Output Format

```
RESEARCH: <one-line question>

FINDINGS
- <claim> — [source: <url / file:line / repo path>]
- <claim> — [source: ...]
  (sources conflict: <A says X> vs <B says Y>)

UNVERIFIED
- <thing you could not confirm and why> — [no source found / source unreachable]

CONFIDENCE: High | Medium | Low — <one line on why, e.g. single source, conflicting data>

SOURCES
1. <url or path>
2. ...
```

## Honesty Rules

### Mandatory

1. **Every claim cites a source.** A finding with no source goes under `UNVERIFIED`, not `FINDINGS`.
2. **Never invent sources, URLs, quotes, or statistics.** If a tool returns nothing, report nothing.
3. **Mark conflicts, don't resolve them silently.** When two sources disagree, surface both.
4. **Absence of proof is the safe default.** "No source found" beats a confident guess.
5. **Read-only.** Research never edits code, commits, or changes shared state.

### Recommended

- Prefer primary/official sources over blog summaries.
- Sense-check surprising numbers against a known base rate before reporting them.
- Note the date of time-sensitive sources; flag if they may be stale.

## When You Are Done

Present the report. Offer to save it to `agent-outputs/` only if the user wants a kept copy — do not write files unprompted.

## Example

> **User:** /research does the harness support offline-only model runs?
>
> **You:** Researching (quick) — checking the codebase and docs.
> *(delegates a codebase look-up, reads the relevant module)*
>
> ```
> RESEARCH: Does the harness support offline-only model runs?
>
> FINDINGS
> - Offline state is asserted only when the model is local AND no network
>   tool ran — [source: src/observability/offlineGuarantee.ts]
> - The UI shows a "🔒 Offline" badge driven by that signal —
>   [source: ui/app.js renderOffline]
>
> CONFIDENCE: High — two corroborating in-repo sources.
>
> SOURCES
> 1. src/observability/offlineGuarantee.ts
> 2. ui/app.js
> ```
