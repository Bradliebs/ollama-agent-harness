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

Browser profile access is gated by capability grants, and the page-acting tools now ship an audit log, redaction-by-default, and an explicit cookie/session vault. Domain scoping remains the one outstanding hardening item before profile-touching modes could be considered for anything other than deliberate, user-driven use.

The headless `browser` toolset (navigate, click, fill, read, screenshot) is gated by the `browser-page-access` capability. The page-acting tools enforce that grant at execute time by reading `.harness/settings.json` from the working directory, so direct, CLI, and cookbook call paths are blocked without an active grant — not only the web chat loop. `browser_close` is intentionally ungated because it only releases resources.

Launch behaviour is selected by environment variables, in precedence order. With none set, the tools keep their default behaviour: a fresh, headless, bundled-Chromium profile with no access to your real sessions.

| Variable | Effect |
| --- | --- |
| `HARNESS_BROWSER_CDP_URL` | Attach to an already-running Chrome over CDP (e.g. `http://127.0.0.1:9222`). Reuses your live tabs; `browser_close` disconnects instead of closing your tab. |
| `HARNESS_BROWSER_PROFILE_DIR` | Launch a persistent context against the given profile directory so logins survive across runs. |
| `HARNESS_BROWSER_SESSION` | Restore a named session-vault entry (cookies + storage saved under `.harness/browser-sessions/`) into a fresh context, instead of pointing at a raw profile directory. |
| `HARNESS_BROWSER_HEADFUL` | When truthy, show a visible browser window instead of running headless. |
| `HARNESS_BROWSER_CHANNEL` | Use an installed browser channel (`chrome`, `msedge`) instead of bundled Chromium. |

The CDP and persistent-profile modes reach your real logged-in sessions and remain opt-in. Three hardening features now back the page tools:

* **Audit log.** Every navigate, click, fill, read, and screenshot (including capability denials) is appended to `.harness/browser-audit.jsonl` with a timestamp, launch mode, target URL, and outcome. Readable via `GET /api/browser/audit` and the Settings panel.
* **Redaction by default.** The audit log never stores page text or cookie values. `browser_fill` values are masked by default, and URLs can be narrowed to their origin (dropping path/query tokens) via the `browserRedaction` setting.
* **Cookie/session vault.** `POST /api/browser/sessions/:name` saves the live browser login as a named Playwright `storageState` snapshot under `.harness/browser-sessions/`; the listing API returns metadata only and never echoes cookie values. Set `HARNESS_BROWSER_SESSION=<name>` to auto-restore it.

Domain scoping is not yet implemented, so profile-touching use stays a deliberate, user-driven choice rather than a sandboxed default.


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

