---
title: Capability Sandbox Requirements
description: Policy and sandbox requirements for high-risk Harness capability connectors
author: Microsoft
ms.date: 2026-05-01
ms.topic: concept
keywords:
  - capabilities
  - sandbox
  - permissions
  - automation
estimated_reading_time: 5
---

## Purpose

Harness names high-power capability surfaces before it enables them. The capability matrix is the source of truth for current posture, required controls, and connector readiness. Any connector that can touch credentials, money, external communications, desktop input, browser profiles, third-party code, or background execution must satisfy these sandbox requirements before implementation moves beyond design-only or blocked status.

## Baseline requirements

Every high-risk connector needs these controls before it can run:

* Explicit capability grant with a visible reason and expiration time.
* Audit log entry for grant creation, connector invocation, and revocation.
* Kill-switch enforcement before and during execution.
* Dry-run or preview mode for every state-changing action.
* Narrow allowlist for accounts, recipients, domains, commands, files, or sources.
* Redaction for secrets, tokens, cookies, and personal data in prompts, logs, traces, and UI output.
* Rollback or compensating action where the domain supports it.
* Human confirmation for irreversible, monetary, credential, or external-communication actions.

## Connector readiness gates

### Full desktop computer control

Desktop control is gated. Screenshot capture and bounded text/key/wait replay require explicit grants, previewable action plans, kill-switch checks during execution, and before/after screenshot evidence. Screen-state capture does not yet redact sensitive regions, so desktop tools remain disabled by default.

### Browser profile access

Browser profile access stays design-only until profile grants can be scoped to explicit browser profiles, cookie/session access can be redacted, and profile data never enters traces by default.

### Password manager access

Password manager access stays blocked until a credential broker supports one-shot secret use, no raw secret logging, and explicit user confirmation for each credential release.

### Arbitrary shell

Shell execution is gated. Background shell execution requires active grants for both arbitrary shell and background autonomous jobs. Future command allowlists should separate read-only inspection commands from mutating commands.

### Auto-installing third-party skills

Third-party skill installation stays design-only until installers verify source allowlists, provenance metadata, signatures or checksums, sandboxed extraction, and rollback through snapshots.

### Live broker trading

Live broker trading stays blocked until paper-trading mode, account allowlists, hard notional limits, order previews, and human confirmation are enforced before any live order.

### Email sending

Email sending stays design-only until draft-only mode, recipient allowlists, content preview, and human send confirmation exist.

### Calendar editing

Calendar editing stays design-only until change previews, attendee allowlists, conflict checks, and undo or compensating updates exist.

### Background autonomous jobs

Background jobs are gated. Jobs that execute scripts or invoke high-risk tools need capability-scoped grants, time budgets, run logs, and kill-switch checks.

## Capability template starters

Capability template starters are preview-first. Clients can inspect starter detail through the template starter API, then call the action API with `action: "preview"` to see the write targets without persisting anything. Creation only happens when the client sends `action: "create"`.

Document starters write generated artifacts under `.harness/documents` using the same document generation path as the Documents panel. Automation starters create disabled-by-policy-normal jobs under `.harness/automations/jobs.json`; running script-backed starters still requires active `arbitrary-shell` and `background-autonomous-jobs` grants, command allowlist matching, and capability audit entries.

The Dependency Vulnerability Scan starter uses `npm audit --audit-level=moderate`, which matches the read-only dependency audit preset. Without active grants, execution is blocked and an `automation_script.denied` audit event records the command and job id.

### Self-modifying code

Self-modifying code is gated. Code changes need pre-change snapshots, focused validation commands, and a reviewable diff before any automation treats generated code as trusted.

### Internet skill marketplace

Internet marketplace execution stays blocked until source trust, malware scanning, signature verification, sandbox install, and rollback are implemented.

### Multi-agent swarm

Multi-agent swarm behavior is gated. Fan-out execution needs role boundaries, per-agent budgets, parent-controlled tool access, and aggregate run logging.

## Tool-call inspectors

Inspectors run inside the dispatcher between the model's tool-call decision and tool execution. They can deny, approve, or pause a call. All inspectors are off by default — opt in per environment variable. Source of truth: [`src/safety/toolInspectors/buildFromEnv.ts`](../src/safety/toolInspectors/buildFromEnv.ts).

| Env var | Effect when set | Notes |
| --- | --- | --- |
| `HARNESS_INSPECTOR_REPETITION_MAX=<n>` | Blocks the same `(tool, args)` call after `n` consecutive repeats within a turn. | Catches stuck loops. `n` must be a positive finite number; invalid values silently disable. |
| `HARNESS_INSPECTOR_EGRESS=approve` | Requires human approval before any shell tool runs a command that looks like network egress (curl, wget, npm install, etc.). | Approval prompt goes through the standard permission UI. |
| `HARNESS_INSPECTOR_EGRESS=deny` | Same detection, denies the call outright. | Use for hardened sessions. |
| `HARNESS_INSPECTOR_EGRESS_ALLOW=a.com,b.org` | Domain allowlist consulted before approve/deny fires. | CSV, applies to both `approve` and `deny` modes. |
| `HARNESS_INSPECTOR_EGRESS_TOOLS=bash,custom_shell` | Override the set of tool names treated as "shell" for egress detection. | CSV. Default covers builtin shell-ish tools. |
| `HARNESS_INSPECTOR_ADVERSARY=1` | Adds the LLM-graded adversary judge. Each tool call is scored against `.harness/adversary.md`; high-risk calls get blocked or surfaced for approval. | **Cost:** one extra model call per inspected tool call. Requires `.harness/adversary.md` to exist; otherwise the inspector no-ops at construction time. Same-model adjudication risk applies — pair with a stronger judge model when possible. |
| `HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD=<n>` | Tool responses larger than `n` characters get spooled to disk and replaced with a pointer in the conversation. | Keeps context windows healthy on tools that return large blobs. Off when unset; invalid values silently disable. |

