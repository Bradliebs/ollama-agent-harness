/**
 * Sandbox guards — the runtime predicates tool implementations consult to
 * decide whether an operation is permitted under sandbox mode.
 *
 * Why a separate module from {@link ../permissions/sandboxSwitch}: the
 * dependency edge should be one-way (tools → permissions). Wiring the live
 * `isActive()` state via a setter here lets `tools/*` import a pure-tool
 * module without dragging in the permissions tree, and lets us write unit
 * tests against the guards without spinning up the full switch class.
 *
 * Server startup wires the predicate once:
 *
 *   import { sandboxSwitch } from '../permissions/sandboxSwitch';
 *   import { setSandboxStateProvider } from '../tools/sandboxGuards';
 *   setSandboxStateProvider(() => sandboxSwitch.isActive());
 *
 * Tools then call e.g. `isSandboxActive()` or
 * `evaluateSandboxNetworkUrl(url)` and get the right answer without
 * needing to know how state is held.
 */

import * as path from 'path';
import { URL } from 'url';

// ─── State provider wiring ──────────────────────────────────────────────

let stateProvider: () => boolean = () => false;

/**
 * Install the function that returns whether sandbox mode is currently
 * active. Called once at server startup; tests may rewire freely.
 */
export function setSandboxStateProvider(provider: () => boolean): void {
  stateProvider = typeof provider === 'function' ? provider : () => false;
}

/** Reset the provider to the default (always-off). For test teardown. */
export function resetSandboxStateProvider(): void {
  stateProvider = () => false;
}

export function isSandboxActive(): boolean {
  try {
    return Boolean(stateProvider());
  } catch {
    // A broken provider must not leak as a permissive answer. Fail closed:
    // when in doubt, behave as if sandbox is OFF (so we don't gratuitously
    // break tools), but loudly so the bug is noticeable. The server
    // installs a trivial provider so this branch should never run.
    return false;
  }
}

// ─── Path confinement ───────────────────────────────────────────────────

export interface SandboxPathDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Verify that `absoluteCandidate` lives inside `projectRoot`. When sandbox
 * is active, this is the stricter test that path resolution falls back to
 * AFTER `resolveProjectPath` would have returned a path via
 * `allowedExternalPaths`. The intent: in sandbox mode, the workspace is the
 * boundary; the operator's pre-approved external escape hatches are
 * temporarily ignored.
 */
export function evaluateSandboxPath(
  absoluteCandidate: string,
  projectRoot: string,
): SandboxPathDecision {
  if (!isSandboxActive()) return { ok: true };
  if (!absoluteCandidate || !projectRoot) return { ok: false, reason: 'sandbox: empty path' };
  const rel = path.relative(projectRoot, absoluteCandidate);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `sandbox: path resolves outside the workspace (${absoluteCandidate}). Allowed-external paths are ignored while sandbox is active.`,
  };
}

// ─── Shell binary allowlist ─────────────────────────────────────────────

/**
 * Curated list of executable basenames the shell tool may invoke when
 * sandbox is active. Deliberately narrow — heavy on read / inspect /
 * test, light on anything that mutates the system. Per-subcommand
 * gating (e.g. blocking `git push` while allowing `git status`) is a
 * deliberate follow-up; for now sandbox blocks the binary or permits all
 * its subcommands.
 *
 * Add to this list cautiously: each entry expands the sandbox blast
 * radius. Anything that can fetch from the network, write outside the
 * workspace, or modify external state belongs in unsandboxed mode.
 */
export const SANDBOX_SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Read / inspect
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'echo', 'pwd', 'find',
  'where', 'which', 'tree', 'wc', 'grep', 'rg', 'sed', 'awk',
  // VCS (read-heavy; mutating subcommands like `git push` will be gated
  // per-subcommand in a follow-up)
  'git',
  // Runtimes the agent uses to execute its own generated scripts under
  // agent-outputs/. These respect the path-confinement guard above so a
  // sandboxed `node script.js` can only read/write inside the workspace.
  'node', 'python', 'python3', 'ruby', 'deno', 'bun',
  // Build / test
  'tsc', 'jest', 'vitest', 'mocha', 'pytest',
  // Package managers — note these CAN fetch from npm/pypi which is a
  // network side-effect the network denylist does not cover. Acceptable
  // for first cut because the registries are well-known and the agent
  // operator opting into sandbox typically still wants `npm test` to
  // work. Tighten in a follow-up if needed.
  'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3',
]);

export function isShellBinaryAllowed(rawExecutable: string): boolean {
  if (!rawExecutable) return false;
  // Strip path so '/usr/bin/git' and 'C:\\Program Files\\Git\\bin\\git.exe'
  // both normalize to 'git'.
  const base = path.basename(rawExecutable).toLowerCase();
  // Strip Windows extension.
  const stripped = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return SANDBOX_SHELL_ALLOWLIST.has(stripped);
}

// ─── Network denylist (private / loopback / link-local) ────────────────

/**
 * Block requests to private / local network ranges when sandbox is
 * active. Catches the common "SSRF lite" risk where the agent is
 * convinced to hit `http://127.0.0.1:11434` or `http://169.254.169.254/`
 * (cloud metadata) while sandboxed.
 *
 * Limitations (deliberate, for honesty):
 *   - DNS resolution is NOT performed. A hostname like `intranet.example`
 *     that resolves to a private IP at request time will pass this check
 *     even though it should not. Resolving here adds latency to every
 *     fetch and a TOCTOU window (the resolver could return a different
 *     IP at fetch time). For first-cut sandbox this is an accepted gap;
 *     the principle is "block obvious local-network probes," not "be a
 *     full SSRF proxy."
 *   - IPv6 coverage is limited to ::1 and link-local fe80::/10.
 */
export interface SandboxNetworkDecision {
  ok: boolean;
  reason?: string;
}

const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,           // RFC 1122 "this network"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
];

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function looksLikeIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(host));
}

function isPrivateIPv6(host: string): boolean {
  const stripped = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (stripped === '::1') return true;
  if (stripped === '::') return true;
  if (stripped.startsWith('fe80:')) return true; // link-local
  if (stripped.startsWith('fc') || stripped.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}

export function evaluateSandboxNetworkUrl(rawUrl: string): SandboxNetworkDecision {
  if (!isSandboxActive()) return { ok: true };
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'sandbox: empty url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `sandbox: invalid url (${rawUrl})` };
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto === 'file:') {
    return { ok: false, reason: 'sandbox: file:// urls are blocked' };
  }
  if (proto !== 'http:' && proto !== 'https:') {
    return { ok: false, reason: `sandbox: protocol ${proto} is blocked (only http/https allowed)` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { ok: false, reason: 'sandbox: url missing hostname' };
  }
  if (PRIVATE_HOSTNAMES.has(host)) {
    return { ok: false, reason: `sandbox: hostname ${host} resolves locally and is blocked` };
  }
  if (looksLikeIPv4(host) && isPrivateIPv4(host)) {
    return { ok: false, reason: `sandbox: ${host} is a private/loopback IPv4 address and is blocked` };
  }
  if (host.includes(':') && isPrivateIPv6(host)) {
    return { ok: false, reason: `sandbox: ${host} is a private/loopback IPv6 address and is blocked` };
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `sandbox: hostname ${host} uses a private-network TLD and is blocked` };
  }
  return { ok: true };
}
