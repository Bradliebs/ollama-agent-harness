---
title: Harness 20/10 Roadmap
description: Product and engineering roadmap for making Harness easier to pick up, safer to trust, and stronger at autonomous work
author: Bradliebs
ms.date: 2026-05-02
ms.topic: concept
keywords:
  - harness
  - autonomy
  - user experience
  - roadmap
estimated_reading_time: 8
---

## North Star

Harness should feel like a local autonomous workbench that can set itself up,
choose the right operating mode, execute work safely, explain what happened,
and improve from each run. The system already has the key ingredients:
local-first chat, tool dispatch, permissions, capability grants, session state,
skills, RAG, workflows, automation, output validation, Mycelium routing, model
routing, artifacts, model compare, and a browser UI.

The next step is composition. Users should not need to understand every tab
before they get value. Harness should guide them into the right mode, run the
right preflight checks, expose evidence as work happens, and make recovery or
follow-up obvious.

## Design Principles

* Keep the core agent loop simple and improve the harness around it.
* Make readiness visible before the user starts high-autonomy work.
* Prefer guided operating modes over adding more primary tabs.
* Show evidence for every consequential action: files, tools, commands,
  validation, model, route, and rollback state.
* Treat documents as durable outputs, not chat transcripts with nicer wrapping.
* Make autonomy adjustable rather than binary.
* Convert successful runs into reusable memory, skills, workflows, or routing
  reinforcement only when the evidence supports it.

## Primary Experience

Mission Control becomes the first-use and daily-use surface above the existing
tabs. It should route users into six operating modes:

| Mode | User intent | Harness behavior |
|------|-------------|------------------|
| Build | Change code, write files, create artifacts | Enables file tools, shows diffs, runs validation, captures evidence |
| Debug | Diagnose errors, tests, logs, or broken behavior | Ingests failure context, reproduces where possible, patches narrowly |
| Research | Search files, web, docs, and RAG | Uses read-only tools, citations, summaries, and source cards |
| Review | Inspect code or completed work | Runs review prompts, risk checks, tests, and missing-coverage analysis |
| Automate | Run repeated or autonomous work | Builds jobs, previews schedules, applies grants, tracks run history |
| Teach Harness | Improve skills, memory, workflows, or routing | Creates reviewable learning candidates with provenance |
| Document | Produce briefs, reports, specs, runbooks, and handoffs | Uses chat, evidence, artifacts, and project context to create exportable documents |

The existing left tabs remain available for power users. Mission Control should
link into them instead of replacing them.

## Workstream 1: Mission Control

Mission Control should replace the current generic welcome as the primary
landing surface once the app has enough context to guide the user.

Minimum viable scope:

* Show six mode cards with concise descriptions and current readiness state.
* Select a mode from the user prompt when confidence is high.
* Pre-fill the chat composer with mode-specific starter prompts.
* Link each mode to the existing panels it uses, such as Tools, RAG, Runs,
  Mycelium, Learning, and Skills.
* Persist the last selected mode per browser session.
* Keep keyboard-first chat available at all times.

Success criteria:

* A new user can identify the right starting point without reading the README.
* An experienced user can still bypass Mission Control and type directly.
* No existing tab or setting is removed.

## Workstream 2: Autonomy Run Builder

The autonomy loop is currently visible through the HUD and log modal, but it is
still started from the terminal. The browser should provide a first-class run
builder.

Minimum viable scope:

* Select or create a plan source, initially `IMPLEMENTATION_PLAN.md`.
* Preview pending tasks, anchors, targets, and estimated risk.
* Choose model, backend, permission mode, time budget, max iterations, and
  unproductive-turn limit.
* Run preflight checks before start: git status, model availability, tool
  grants, kill switch, validation scripts, and plan parse health.
* Start, pause, stop, and dry-run from the browser.
* Stream task status, files changed, validation results, and `.forge-run.log`.
* Open the final evidence card for each iteration.

Success criteria:

* A user can run a bounded autonomous coding session without opening a terminal.
* Every run has a visible stop path and a clear post-run summary.
* Failed iterations show the restore state and next recommended action.

## Workstream 3: Readiness Scorecard

Readiness should answer one question: what can Harness safely do right now?

Score categories:

* Chat readiness: model list, selected model, host/backend health, context window
* Coding readiness: file tools, allowed paths, git state, validation scripts
* Autonomy readiness: permission mode, grants, kill switch, plan parse health,
  time budget, model tool-call behavior
* Research readiness: web tools, RAG indexes, citation support
* Learning readiness: memory, skills, Mycelium, output validation, feedback
* Automation readiness: scheduler, shell allowlist, grants, due jobs, run logs

Minimum viable scope:

* Add a single `/api/readiness` endpoint that composes existing health sources.
* Render a compact score in Mission Control and a detailed panel on click.
* Provide next-action buttons for failed checks, such as open Settings, build
  RAG index, enable grant, or run doctor.
* Keep live-money or irreversible domains blocked unless their sandbox gates are
  satisfied.

Success criteria:

* Users know whether they are ready for chat, coding, research, or autonomy
  before starting a run.
* Failed checks explain the concrete fix without exposing secrets.

## Workstream 4: Evidence Cards

Every consequential run should produce an evidence card that can be reviewed,
exported, and used for learning.

Evidence fields:

* User request and detected mode
* Model and backend used
* Permission mode and capability grants used
* Tools called, success rate, and failures
* Files read, written, moved, deleted, and edited
* Commands run and validation status
* Output validation profile, score, findings, and user feedback
* Mycelium task classification, route explanation, protected edges, and reward
* Artifacts created and previews available
* Session ID, trace ID, and recovery or rollback state

Minimum viable scope:

* Define a shared evidence-card data shape.
* Populate it from existing chat, automation, autonomy, validation, and
  Mycelium events where available.
* Render evidence under assistant replies and in the Runs tab.
* Export evidence as Markdown or JSON.

Success criteria:

* A user can answer "what did it do and why should I trust it?" from one card.
* Evidence cards avoid raw secret values and cap large outputs.

## Workstream 5: Learning Loop

Harness already records session learning candidates, output validation trends,
model routing metrics, and Mycelium reinforcement. The 20/10 version should
close the loop in a visible, reviewable way.

Minimum viable scope:

* Add post-run recommendations from evidence cards.
* Offer reviewable promotions into memory, skills, workflow templates, or
  Mycelium reinforcement.
* Surface model-routing recommendations near model selection.
* Show when a recommendation is based on enough samples versus a weak signal.

Success criteria:

* Harness improves from repeated use without silently rewriting user policy.
* The user can accept, reject, or ignore every durable learning action.

## Workstream 6: Document Generation

Harness should generate durable documents from the work it already performs:
briefs, reports, specs, runbooks, handoffs, release notes, post-run summaries,
and evidence-backed decision records.

Minimum viable scope:

* Add a Document Studio surface inside Mission Control.
* Generate Markdown and HTML documents from chat transcripts, pasted source,
  and evidence cards.
* Save generated documents under `.harness/documents` with metadata.
* List and download generated documents from the browser.
* Keep document output reviewable before it becomes durable team knowledge.

Later export scope:

* Add PDF and DOCX export through optional local converters.
* Add reusable templates for ADRs, runbooks, project briefs, release notes,
  customer updates, implementation plans, and review reports.
* Attach evidence cards and validation summaries to generated documents.
* Allow automation and autonomy runs to produce handoff documents at completion.

Success criteria:

* A user can turn useful chat work into a polished artifact without leaving the
  browser.
* Generated documents preserve provenance: source, evidence, model, validation,
  and session context.
* Richer formats remain optional so local Markdown generation stays fast and
  dependency-light.

## Implementation Order

1. Add readiness scorecard API and UI summary.
2. Add Mission Control mode cards using the scorecard.
3. Define the evidence-card schema and render chat evidence first.
4. Extend evidence cards to autonomy and automation runs.
5. Build the browser Autonomy Run Builder on top of existing `.forge-*` state.
6. Add Document Studio with Markdown and HTML generation.
7. Add learning-loop promotions from completed evidence cards.
8. Add optional PDF and DOCX export once templates and provenance are stable.

This order gives users immediate clarity before adding more autonomous power.