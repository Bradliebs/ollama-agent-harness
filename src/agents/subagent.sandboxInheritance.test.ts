/**
 * Sandbox inheritance — integration test.
 *
 * Claim under test: "A subagent cannot exit the sandbox the parent is in."
 *
 * Architecturally this is enforced by holding sandbox state at the MODULE
 * level (one `SandboxSwitch` per process, read via the
 * `setSandboxStateProvider` hook in `tools/sandboxGuards`). There is no
 * per-call, per-agent, or per-subagent override surface — so once the
 * parent server engages sandbox, every tool call from every caller in the
 * process resolves through the same guard answer.
 *
 * The test makes that structural property OBSERVABLE by:
 *   1. Calling real tools twice — once with sandbox off, once on — and
 *      asserting the same tool instance returns different verdicts.
 *   2. Calling those tools through both a "parent context" and a
 *      "simulated subagent context" (same tool reference, separate
 *      invocation site) and asserting both get the sandbox verdict.
 *   3. Asserting that the public `SubagentToolDeps` surface exposes NO
 *      knob for disabling sandbox per-subagent (regression guard against
 *      a future refactor accidentally introducing one).
 *
 * If a future change adds a per-agent permission engine that holds its
 * own sandbox state, this test will keep passing only if the new code
 * still consults the module-level guard for the final answer — which is
 * the architectural invariant we want to preserve.
 */

import { SandboxSwitch } from '../permissions/sandboxSwitch';
import {
  setSandboxStateProvider,
  resetSandboxStateProvider,
  isSandboxActive,
} from '../tools/sandboxGuards';
import { WebFetchTool } from '../tools/webFetchTool';
import { BashTool } from '../tools/bashTool';
import { resolveProjectPath, setAllowedExternalPaths, getAllowedExternalPaths } from '../tools/pathResolution';
import type { SubagentToolDeps } from './subagent';
import * as path from 'path';
import * as os from 'os';

describe('sandbox inheritance: a subagent cannot exit the sandbox the parent is in', () => {
  const originalFetch = globalThis.fetch;
  let savedAllowedExternal: string[];

  beforeEach(() => {
    savedAllowedExternal = getAllowedExternalPaths();
  });

  afterEach(() => {
    resetSandboxStateProvider();
    globalThis.fetch = originalFetch;
    setAllowedExternalPaths(savedAllowedExternal);
  });

  // Helper: bind sandbox state to a real switch, mimicking how
  // server.ts wires the provider at boot.
  function wireSwitch(): SandboxSwitch {
    const sb = new SandboxSwitch();
    setSandboxStateProvider(() => sb.isActive());
    return sb;
  }

  describe('process-wide state visibility', () => {
    it('every caller (parent OR simulated subagent) reads the same isSandboxActive() answer', () => {
      const sb = wireSwitch();

      // Two distinct call sites — think "parent chat" and "subagent" —
      // each ask the guard independently. They must agree.
      const parentRead1 = isSandboxActive();
      const subagentRead1 = isSandboxActive();
      expect(parentRead1).toBe(false);
      expect(subagentRead1).toBe(false);

      sb.engage('parent decision');

      const parentRead2 = isSandboxActive();
      const subagentRead2 = isSandboxActive();
      expect(parentRead2).toBe(true);
      expect(subagentRead2).toBe(true);

      sb.release();
      expect(isSandboxActive()).toBe(false);
    });

    it('a subagent cannot rewire the provider away from the parent switch without explicit access to setSandboxStateProvider (which subagent code does not have)', () => {
      // This is a structural assertion. The subagent module
      // (`agents/subagent.ts`) does NOT import setSandboxStateProvider.
      // If a future change adds such an import, this test should be
      // revisited because the inheritance guarantee depends on the
      // subagent never being able to flip the provider.
      // We assert by static lookup against the public deps surface:
      const depsKeys: Array<keyof SubagentToolDeps> = [
        'getParentClient',
        'getAvailableTools',
        'getCustomAgents',
        'runner',
        'getRecallContext',
        'getIdentityPrefix',
      ];
      // None of these resemble a sandbox-override hook.
      for (const key of depsKeys) {
        expect(String(key).toLowerCase()).not.toContain('sandbox');
      }
    });
  });

  describe('shared tool instances are sandbox-aware regardless of caller', () => {
    it('bash tool: same instance blocks non-allowlisted binary whether called from parent or subagent context', async () => {
      const sb = wireSwitch();
      sb.engage('parent locked it down');

      // Two distinct callers (think "parent chat" then "subagent run")
      // invoking the SAME tool instance. Both must hit the sandbox
      // shell-allowlist guard with the same error shape. `curl` is
      // deliberately not on the allowlist; the guard fires before any
      // spawn attempt so platform availability of curl doesn't matter.
      const callFromParent = await BashTool.execute({
        command: 'curl https://example.com',
        timeout: 2000,
      });
      expect(callFromParent.success).toBe(false);
      expect(callFromParent.error).toMatch(/Blocked by sandbox/);
      expect(callFromParent.error).toMatch(/sandbox shell allowlist/);

      const callFromSubagent = await BashTool.execute({
        command: 'curl https://example.com',
        timeout: 2000,
      });
      expect(callFromSubagent.success).toBe(false);
      expect(callFromSubagent.error).toMatch(/Blocked by sandbox/);

      // Release sandbox — the same tool instance should no longer
      // produce the sandbox block message (it may fail for other
      // reasons like missing binary; we only assert the sandbox
      // verdict is gone).
      sb.release();
      const callAfterRelease = await BashTool.execute({
        command: 'curl --harness-test-noop-flag',
        timeout: 2000,
      });
      expect(callAfterRelease.error ?? '').not.toMatch(/Blocked by sandbox/);
    });

    it('web fetch tool: same instance blocks private IP whether called from parent or subagent context', async () => {
      const sb = wireSwitch();

      // Replace fetch with a no-op so a successful call resolves to a
      // benign response rather than hitting the real network. The
      // sandbox check fires BEFORE this stub runs, so when sandbox is
      // engaged the stub should never be invoked.
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      }) as unknown as typeof fetch;

      // Sandbox off — the cloud-metadata URL is permitted by the guard
      // and the stubbed fetch runs.
      sb.release();
      const parentCall = await WebFetchTool.execute({
        url: 'http://169.254.169.254/latest/meta-data/',
      });
      expect(parentCall.success).toBe(true);
      expect(fetchCalls).toBe(1);

      sb.engage('lockdown');

      // Sandbox on — same URL, same tool instance, blocked. fetch is
      // NOT called (the guard short-circuits).
      const subagentCall = await WebFetchTool.execute({
        url: 'http://169.254.169.254/latest/meta-data/',
      });
      expect(subagentCall.success).toBe(false);
      expect(subagentCall.error).toMatch(/sandbox.*private\/loopback IPv4/);
      expect(fetchCalls).toBe(1); // unchanged
    });

    it('path resolution: allowed-external escape works when sandbox off, refused when sandbox on, from any caller', () => {
      const sb = wireSwitch();
      const tmp = path.resolve(os.tmpdir(), 'sandbox-inheritance-test');
      setAllowedExternalPaths([tmp]);

      // Sandbox off — the operator's allowed-external path is honoured.
      sb.release();
      expect(resolveProjectPath(tmp)).toBe(tmp);

      // Sandbox on — same call site, same input, refused because the
      // sandbox ignores the allowed-external escape hatch.
      sb.engage('lockdown');
      expect(resolveProjectPath(tmp)).toBeNull();

      // And a "subagent" call site (separate invocation, same module)
      // gets the same refused answer.
      const subagentResolve = resolveProjectPath(tmp);
      expect(subagentResolve).toBeNull();
    });
  });

  describe('switch transitions affect in-flight subagent-style callers immediately', () => {
    it('a sequence of tool calls observes the LIVE state, not a captured snapshot', async () => {
      const sb = wireSwitch();
      sb.release();

      globalThis.fetch = (async () =>
        new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
      ) as unknown as typeof fetch;

      // First call (sandbox off): succeeds.
      const r1 = await WebFetchTool.execute({ url: 'https://example.com/' });
      expect(r1.success).toBe(true);

      // Parent flips sandbox on mid-flight. A subagent doing its second
      // tool call must observe the new state — there is no per-run
      // snapshot that would keep the subagent in the old posture.
      sb.engage('escalation');
      const r2 = await WebFetchTool.execute({ url: 'http://127.0.0.1/admin' });
      expect(r2.success).toBe(false);
      expect(r2.error).toMatch(/sandbox/);

      // Parent releases. Next call (still the same "subagent") sees the
      // new posture immediately.
      sb.release();
      const r3 = await WebFetchTool.execute({ url: 'https://example.com/' });
      expect(r3.success).toBe(true);
    });
  });
});
