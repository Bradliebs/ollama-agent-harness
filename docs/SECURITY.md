<!-- markdownlint-disable MD013 -->
# Security Model

The harness is local-first. By default every process binds to loopback, so nothing is reachable from other machines on the network. This document describes the controls that keep it that way and the few places where you opt out of them.

## Bind hosts

| Process | Default bind | Override |
|---------|--------------|----------|
| Web server / dashboard | `127.0.0.1:4300` | `HOST` env var |
| ccmem memory sidecar | `127.0.0.1:8765` | `--host` flag |

The dashboard is unauthenticated by default because loopback already limits access to this machine. If you change `HOST` to a non-loopback address (for example `0.0.0.0`) to share the UI on your network, you **must** also set `HARNESS_API_AUTH_TOKEN` — API auth turns on automatically in that case and requests without the token are rejected. The UI can drive shell and file tools, so never expose it without the token.

## API auth token

`HARNESS_API_AUTH_TOKEN` is a bearer token (sent as `Authorization: Bearer <token>`), not a cookie. The server emits no CORS headers, so cross-origin browsers cannot read API responses. Auth is required when the token is set **or** when the server binds to a non-loopback address.

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

- `.harness/api-keys.json` — remote backend API keys
- `.harness/ccmem/token` — ccmem shared token
- `.harness/webhooks.json` — webhook registry and secrets
