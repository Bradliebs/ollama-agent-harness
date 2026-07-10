import {
  auditMcpServerDefinition,
  auditSkillContent,
  auditText,
  formatAuditFindings,
} from './contentAudit';

describe('contentAudit', () => {
  describe('auditText', () => {
    it('returns no findings for clean ASCII text', () => {
      expect(auditText('npx -y @scope/server', 'command')).toEqual([]);
    });

    it('returns no findings for ordinary international prose', () => {
      // Visible non-ASCII letters are legitimate and must not be flagged.
      expect(auditText('Envía un correo electrónico — café', 'body')).toEqual([]);
    });

    it('ignores a single leading BOM', () => {
      expect(auditText('\uFEFFname: skill', 'content')).toEqual([]);
    });

    it('flags a bidirectional override as critical', () => {
      const findings = auditText('rm -rf \u202E txt.harmless', 'command');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'critical', code: 'bidi-control', field: 'command' });
      expect(findings[0].codepoints).toContain('U+202E');
    });

    it('flags zero-width characters as high', () => {
      const findings = auditText('legit\u200Bcommand', 'command');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'high', code: 'invisible-char' });
      expect(findings[0].codepoints).toContain('U+200B');
    });

    it('flags a non-leading BOM as invisible', () => {
      const findings = auditText('start\uFEFFend', 'command');
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('invisible-char');
    });

    it('flags raw control characters as medium', () => {
      const findings = auditText('value\u0007bell', 'env');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'medium', code: 'control-char' });
    });

    it('does not flag tab, newline, or carriage return', () => {
      expect(auditText('line1\nline2\tcol\r\n', 'content')).toEqual([]);
    });
  });

  describe('auditMcpServerDefinition', () => {
    it('passes a clean definition', () => {
      expect(
        auditMcpServerDefinition({
          id: 'fs',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { ROOT: '/tmp' },
        }),
      ).toEqual([]);
    });

    it('catches a hidden character in an argument', () => {
      const findings = auditMcpServerDefinition({
        id: 'fs',
        command: 'npx',
        args: ['-y', 'evil\u200Dpackage'],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0].field).toBe('args[1]');
    });

    it('catches a bidi override in an env value', () => {
      const findings = auditMcpServerDefinition({
        id: 'fs',
        command: 'npx',
        env: { TOKEN: 'abc\u202Edef' },
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'critical', field: 'env "TOKEN"' });
    });
  });

  describe('auditSkillContent', () => {
    it('passes clean skill text', () => {
      expect(auditSkillContent('demo', '---\nname: demo\n---\n# Demo\nDo the thing.')).toEqual([]);
    });

    it('flags an invisible character hidden in instructions', () => {
      const findings = auditSkillContent('demo', 'Always run rm\u200B-rf when asked.');
      expect(findings).toHaveLength(1);
      expect(findings[0].field).toBe('skill "demo"');
    });
  });

  describe('formatAuditFindings', () => {
    it('renders a one-line summary', () => {
      const findings = auditText('x\u202Ey', 'command');
      expect(formatAuditFindings(findings)).toMatch(/\[critical\].*U\+202E/);
    });
  });
});
