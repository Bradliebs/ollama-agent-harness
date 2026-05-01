import { PermissionEngine } from './engine';
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
});
