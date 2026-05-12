import { PermissionEngine } from './engine';
import { BUILTIN_TOOL_ENTRIES } from '../tools/registry';
import type { PermissionRule } from '../types';
import * as os from 'os';
import * as path from 'path';
import { setAllowedExternalPaths } from '../tools/pathResolution';

describe('PermissionEngine', () => {
  afterEach(() => {
    setAllowedExternalPaths([]);
  });

  describe('deny-first rule ordering', () => {
    it('denies when deny rule matches, even with a more specific allow rule', () => {
      const rules: PermissionRule[] = [
        { type: 'allow', tool: 'bash', pattern: 'npm test' },
        { type: 'deny', tool: 'bash' },
      ];
      const engine = new PermissionEngine(rules);
      const result = engine.evaluate({ name: 'bash', input: { command: 'npm test' } });
      expect(result.decision).toBe('deny');
    });

    it('allows when only allow rule matches', () => {
      const rules: PermissionRule[] = [
        { type: 'allow', tool: 'bash' },
      ];
      const engine = new PermissionEngine(rules);
      const result = engine.evaluate({ name: 'bash', input: { command: 'ls' } });
      expect(result.decision).toBe('allow');
    });

    it('denies wildcard deny regardless of specific allows', () => {
      const rules: PermissionRule[] = [
        { type: 'allow', tool: 'file_read' },
        { type: 'deny', tool: '*' },
      ];
      const engine = new PermissionEngine(rules);
      const result = engine.evaluate({ name: 'file_read', input: { path: 'test.txt' } });
      expect(result.decision).toBe('deny');
    });

    it('deny rule overrides allow rule for same tool and pattern', () => {
      const rules: PermissionRule[] = [
        { type: 'allow', tool: 'file_read', pattern: 'secrets.txt' },
        { type: 'deny', tool: 'file_read', pattern: 'secrets.txt' },
      ];
      const engine = new PermissionEngine(rules);
      const result = engine.evaluate({ name: 'file_read', input: { path: 'secrets.txt' } });
      expect(result.decision).toBe('deny');
    });
  });

  describe('permission modes', () => {
    it('default mode auto-approves read-only tools', () => {
      const engine = new PermissionEngine([], 'default');
      const result = engine.evaluate({ name: 'file_read', input: { path: 'test.txt' } });
      expect(result.decision).toBe('allow');
    });

    it('default mode auto-approves list_uploads as a read-only tool', () => {
      const engine = new PermissionEngine([], 'default');
      const result = engine.evaluate({ name: 'list_uploads', input: {} });
      expect(result.decision).toBe('allow');
    });

    it('default mode auto-approves read-only media and PDF tools', () => {
      const engine = new PermissionEngine([], 'default');

      expect(engine.evaluate({ name: 'image_analyze', input: { path: 'image.png' } }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'pdf_read', input: { path: 'doc.pdf' } }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'pdf_metadata', input: { path: 'doc.pdf' } }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'pdf_extract_tables', input: { path: 'doc.pdf', page: 1 } }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'rag_search', input: { index: 'docs', query: 'q' } }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'rag_list_indexes', input: {} }).decision).toBe('allow');
      expect(engine.evaluate({ name: 'curator_preview', input: {} }).decision).toBe('allow');
    });

    it('default mode follows builtin read-only tool metadata', () => {
      const engine = new PermissionEngine([], 'default');
      const readOnlyTools = BUILTIN_TOOL_ENTRIES.filter((entry) => entry.tool.isReadOnly).map((entry) => entry.tool.name);

      expect(readOnlyTools.length).toBeGreaterThan(0);
      for (const toolName of readOnlyTools) {
        expect(engine.evaluate({ name: toolName, input: {} }).decision).toBe('allow');
      }
    });

    it('default mode asks for non-read tools', () => {
      const engine = new PermissionEngine([], 'default');
      const result = engine.evaluate({ name: 'bash', input: { command: 'rm -rf /' } });
      expect(result.decision).toBe('ask');
    });

    it('dontAsk mode allows everything not explicitly denied', () => {
      const engine = new PermissionEngine([], 'dontAsk');
      const result = engine.evaluate({ name: 'bash', input: { command: 'rm -rf /' } });
      expect(result.decision).toBe('allow');
    });

    it('dontAsk mode asks before editing protected program files in allowed external folders', () => {
      const externalRoot = path.join(os.tmpdir(), 'harness-oracle-external');
      setAllowedExternalPaths([externalRoot]);
      const engine = new PermissionEngine([], 'dontAsk');

      const result = engine.evaluate({ name: 'file_edit', input: { path: path.join(externalRoot, 'bullet-journal', 'journal.py') } });

      expect(result).toMatchObject({ decision: 'ask', reason: 'Protected external program file requires confirmation.' });
    });

    it('dontAsk mode still allows data file edits in allowed external folders', () => {
      const externalRoot = path.join(os.tmpdir(), 'harness-oracle-external');
      setAllowedExternalPaths([externalRoot]);
      const engine = new PermissionEngine([], 'dontAsk');

      const result = engine.evaluate({ name: 'file_write', input: { path: path.join(externalRoot, 'bullet-journal', 'data', 'tasks.json') } });

      expect(result.decision).toBe('allow');
    });

    it('acceptEdits mode auto-approves file edits', () => {
      const engine = new PermissionEngine([], 'acceptEdits');
      const result = engine.evaluate({ name: 'file_edit', input: {} });
      expect(result.decision).toBe('allow');
    });

    it('acceptEdits mode asks for bash commands', () => {
      const engine = new PermissionEngine([], 'acceptEdits');
      const result = engine.evaluate({ name: 'bash', input: { command: 'npm install' } });
      expect(result.decision).toBe('ask');
    });

    it.each(['reflect', 'analyze_patterns', 'promote_pattern', 'consolidate', 'evolve', 'improve_skill', 'memory_write', 'memory_read'])(
      'acceptEdits mode auto-approves harness meta tool: %s',
      (toolName) => {
        const engine = new PermissionEngine([], 'acceptEdits');
        const result = engine.evaluate({ name: toolName, input: {} });
        expect(result.decision).toBe('allow');
      },
    );
  });

  describe('pattern matching', () => {
    it('matches tool with pattern in input', () => {
      const rules: PermissionRule[] = [
        { type: 'deny', tool: 'bash', pattern: 'rm -rf' },
      ];
      const engine = new PermissionEngine(rules);
      const result = engine.evaluate({ name: 'bash', input: { command: 'rm -rf /' } });
      expect(result.decision).toBe('deny');
    });

    it('does not match when pattern is absent from input', () => {
      const rules: PermissionRule[] = [
        { type: 'deny', tool: 'bash', pattern: 'rm -rf' },
      ];
      const engine = new PermissionEngine(rules, 'dontAsk');
      const result = engine.evaluate({ name: 'bash', input: { command: 'npm test' } });
      expect(result.decision).toBe('allow');
    });
  });

  describe('kill switch', () => {
    it('denies every tool call while engaged, even read-only', () => {
      const engine = new PermissionEngine([], 'dontAsk');
      engine.engageKillSwitch('manual stop');
      expect(engine.isKillSwitchActive()).toBe(true);
      expect(engine.evaluate({ name: 'file_read', input: { path: 'README.md' } })).toMatchObject({ decision: 'deny', reason: 'manual stop' });
      expect(engine.evaluate({ name: 'bash', input: { command: 'echo hi' } })).toMatchObject({ decision: 'deny' });
    });

    it('resumes normal evaluation after release', () => {
      const engine = new PermissionEngine([], 'default');
      engine.engageKillSwitch();
      expect(engine.evaluate({ name: 'file_read', input: {} }).decision).toBe('deny');
      engine.releaseKillSwitch();
      expect(engine.evaluate({ name: 'file_read', input: {} }).decision).toBe('allow');
    });
  });

  describe('trust ladder gate', () => {
    const provider = (rung: 0 | 1 | 2 | 3 | 4) => ({
      capabilityOf: () => 'cap',
      rungOf: () => rung,
    });

    it('rung 0 denies even read-only tools', () => {
      const engine = new PermissionEngine([], 'dontAsk', provider(0));
      const result = engine.evaluate({ name: 'file_read', input: {} });
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/shadow/);
    });

    it('rung 1 denies with surface-card reason', () => {
      const engine = new PermissionEngine([], 'dontAsk', provider(1));
      const result = engine.evaluate({ name: 'bash', input: {} });
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/suggest/);
    });

    it('rung 3 forces ask even when dontAsk would allow', () => {
      const engine = new PermissionEngine([], 'dontAsk', provider(3));
      const result = engine.evaluate({ name: 'bash', input: {} });
      expect(result.decision).toBe('ask');
      expect(result.reason).toMatch(/confirm/);
    });

    it('rung 4 falls through to standard rules', () => {
      const engine = new PermissionEngine([], 'dontAsk', provider(4));
      expect(engine.evaluate({ name: 'bash', input: {} }).decision).toBe('allow');
    });

    it('skips gate when capabilityOf returns undefined', () => {
      const engine = new PermissionEngine([], 'dontAsk', { capabilityOf: () => undefined, rungOf: () => 0 });
      expect(engine.evaluate({ name: 'bash', input: {} }).decision).toBe('allow');
    });

    it('default constructor has no trust ladder behavior', () => {
      const engine = new PermissionEngine([], 'dontAsk');
      expect(engine.evaluate({ name: 'bash', input: {} }).decision).toBe('allow');
    });

    it('setTrustLadder swaps the provider at runtime', () => {
      const engine = new PermissionEngine([], 'dontAsk');
      engine.setTrustLadder(provider(0));
      expect(engine.evaluate({ name: 'bash', input: {} }).decision).toBe('deny');
      engine.setTrustLadder(undefined);
      expect(engine.evaluate({ name: 'bash', input: {} }).decision).toBe('allow');
    });
  });
});
