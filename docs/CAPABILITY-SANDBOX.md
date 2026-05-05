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

### Self-modifying code

Self-modifying code is gated. Code changes need pre-change snapshots, focused validation commands, and a reviewable diff before any automation treats generated code as trusted.

### Internet skill marketplace

Internet marketplace execution stays blocked until source trust, malware scanning, signature verification, sandbox install, and rollback are implemented.

### Multi-agent swarm

Multi-agent swarm behavior is gated. Fan-out execution needs role boundaries, per-agent budgets, parent-controlled tool access, and aggregate run logging.
