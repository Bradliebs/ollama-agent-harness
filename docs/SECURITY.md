---
title: Security Model
description: Local service access controls, cloud data boundaries and ownership safeguards
ms.date: 2026-10-08
---
<!-- markdownlint-disable MD013 -->

## Security Model

The harness is local-first. By default every process binds to loopback, so nothing is reachable from other machines on the network. This document describes the controls that keep it that way and the few places where you opt out of them.

Loopback binding does not mean offline execution. Selected cloud models, remote
Ollama endpoints and network tools send data externally. Ollama can retain cloud
authentication independently of shell API keys; clearing those variables is not
a local-only safeguard. The bounded benchmark checks remote route metadata in
cloud mode, but still trusts the daemon to honor it. See
[Workflow Outcome Benchmarks](VALIDATION-PROFILES.md#workflow-outcome-benchmarks).

Use the harness as an ordinary user: tools inherit that user's filesystem and
process rights. The background supervisor stops only its owned child; installer
maintenance requires an exclusive lease. Do not kill a PID copied from an old
marker or remove unresolved ownership files without investigating them. These
are lifecycle safeguards, not a sandbox against other code running as that user.
See [Background Lifecycle](MODERNIZATION-STATUS.md#background-lifecycle).

## Bind hosts

| Process | Default bind | Override |
|---------|--------------|----------|
| Web server / dashboard | Loopback; launchers normally use port 4300, terminal UI normally 3000; use printed URL | `HOST` and `PORT` env vars |
| ccmem memory sidecar | `127.0.0.1:8765` | `--host` flag |

The dashboard is unauthenticated by default because loopback already limits access to this machine. If you change `HOST` to a non-loopback address (for example `0.0.0.0`) to share the UI on your network, you **must** also set `HARNESS_API_AUTH_TOKEN` — API auth turns on automatically in that case and requests without the token are rejected. The UI can drive shell and file tools, so never expose it without the token.

`HARNESS_API_AUTH_REQUIRED` overrides the automatic choice: `1` requires the token even on loopback, and `0` turns auth off. Setting `0` while a token is configured is reported as an insecure override; never set it on a non-loopback bind.

## API auth token

`HARNESS_API_AUTH_TOKEN` is a bearer token (sent as `Authorization: Bearer <token>` or the `X-Harness-Api-Token` header), not a cookie. The server emits no CORS headers, so cross-origin browsers cannot read API responses. Auth is required when the token is set **or** when the server binds to a non-loopback address.

## Cross-origin / CSRF guard

On loopback the API token is optional, so a malicious web page you happen to visit could try to drive the local agent through your browser (classic CSRF). State-changing `/api` requests (`POST`, `PUT`, `PATCH`, `DELETE`) get a defense-in-depth check:

- requests the browser flags as `Sec-Fetch-Site: cross-site` are rejected, and
- requests with an `Origin` header whose host is not in the loopback allow-list (`127.0.0.1`, `localhost`, `::1`) are rejected.

Non-browser clients — the CLI, the Telegram bridge, and the in-process autonomy loop — send neither header and pass through unchanged. The guard runs only on loopback; non-loopback binds rely on the auth token instead.

## ccmem (memory sidecar) auth

The ccmem sidecar is unauthenticated by default. Set `HARNESS_CCMEM_TOKEN` on both the service and the harness to require `Authorization: Bearer <token>` on every endpoint except `GET /health` (left open as a liveness probe). This stops other local processes and users on the same machine from reading or poisoning the memory bank.

`start.bat` and `start.sh` generate a token, persist it to `.harness/ccmem/token` (mode `0600` on POSIX), and export it to both processes, so the supported launch path is authenticated out of the box. When the harness starts on its own (for example `npm run serve`), it reads the same token file at boot unless `HARNESS_CCMEM_TOKEN` is already set in the environment. Leaving the variable unset keeps the original zero-config behaviour, and memory stays best-effort either way: a token mismatch or an unreachable sidecar returns empty results rather than failing the request.

### Rotating the ccmem token

The Python service reads its token once at startup, so rotation is restart-bound rather than hot:

1. Stop the ccmem service.
2. Delete `.harness/ccmem/token` (or write a new value into it).
3. Restart via `start.bat` / `start.sh`, which regenerates the file when missing and re-exports it to both processes.

Do not change the token on only one side while the service is running — the client would then get `401` until both sides share the new value.

## Webhook secrets

Webhooks are stored in `.harness/webhooks.json` (mode `0600`) because the file holds delivery secrets in the clear. When a webhook has a secret, each delivery is signed with `X-Webhook-Signature: sha256=<hmac>` so the receiver can verify it. `GET /api/webhooks` redacts secrets to `***`; the cleartext value never leaves the server. Deliveries retry transient failures (network errors and `5xx`) with bounded backoff and record the last outcome per webhook; `4xx` responses are treated as permanent and are not retried.

## Local file storage

Secrets on disk are written atomically with mode `0600`:

- `.harness/api-keys.json` — remote backend API keys, plus connector secrets saved from the UI (Discord bot token, Slack webhook URL, WhatsApp access token). Older installs that kept these in `settings.json` are migrated on load.
- `.harness/ccmem/token` — ccmem shared token
- `.harness/webhooks.json` — webhook registry and secrets

The Telegram bot token set from the UI is the exception: it is saved in `.harness/settings.json`, which is not mode-restricted. On a shared machine, prefer setting `HARNESS_TELEGRAM_BOT_TOKEN` in the environment.

## Agent-side safeguards

These limit what the agent itself can do, independent of who can reach the API. All are on by default; [System breakdown §5](SYSTEM-BREAKDOWN.md#5-environment-flags) lists the switches.

- **Permission modes.** Deny rules override allow rules in every mode. `dontAsk` auto-approves tool calls, except where the two checks below stop them.
- **Provenance checks** (`HARNESS_PROVENANCE`). Web, browser and inbound-email output is untrusted. If an email recipient, URL or shell command in a side-effecting call appears only in untrusted content, the harness asks for your approval and shows where the value came from, even in `dontAsk`; unattended runs deny the call. It is a heuristic tripwire: values the model invents are not flagged.
- **Protected paths.** The loop blocks file tools from modifying paths that match the task contract's blocked paths or the globs in `.harness/protected-paths.json` (a JSON array). `bash` and `docker_exec` commands that look like writes (`>`, `rm`, `mv`, `sed -i`, `Set-Content`, …) and name a protected path are blocked too. The shell check is a heuristic: a command that builds the path indirectly can get past it.
- **Untrusted-content wrapping.** External text reaches the model inside `<external_content>` markers and is treated as data, not instructions.
- **Secret redaction.** Traces, events and every line of the run logs in `.harness/runs/` pass through the secret redactor before they are written.
- **Git checkpoints** (`HARNESS_RUN_GIT_CHECKPOINT=1`, opt-in) use a separate index and exclude `.harness/`, so keys and settings never enter the checkpoint history.
- **Optional tool inspectors.** Egress, repetition and adversary inspectors, plus a browser URL allow-list, are off by default; see [Capability Sandbox](CAPABILITY-SANDBOX.md).

## What can leave the machine

Beyond the model you pick, these features can send prompts or run content to other models:

| Feature | Default | What is sent | How to keep it local |
|---|---|---|---|
| Chat model routing and in-run escalation | **Balanced** (on) | The turn, to a stronger model when the selected one is weak for the task, the prompt is large, or the run is stuck. Candidates include hosted providers whose API keys are configured and installed Ollama `:cloud` models | Settings → Chat model routing → **Keep selected model** |
| Research checks with a critic (`HARNESS_VERIFY_RESEARCH=critic` or `gate`) and the adversary inspector (`HARNESS_INSPECTOR_ADVERSARY=1`) | off | The flagged claims and best-matching source excerpts (research checks) or the pending tool call (adversary), to a critic model from a different family. The default preference list is mostly Ollama `:cloud` models | Leave them off. Or set `HARNESS_CRITIC_MODEL` to a local model and don't install the `:cloud` models in the default list: if the chosen critic fails, research checks try the next installed candidate |
| `harness replay`, `harness benchmark-history`, `POST /api/replays` | on demand | Recorded run prompts, to every model you name | Name only local models |
| `harness probe` and capability-probe jobs | on demand | Synthetic probe prompts, to the probed model | Probe only local models |

`HARNESS_DAILY_SPEND_USD` caps daily spend on remote backends; it does not stop data from leaving.
