import { PermissionEngine } from './engine';
import { BUILTIN_TOOL_ENTRIES } from '../tools/registry';
import type { PermissionRule } from '../types';

describe('PermissionEngine', () => {
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
});
