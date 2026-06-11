import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemContext } from './assembly';

describe('assembleSystemContext', () => {
  it('trims large agent memory files before injecting them into the system prompt', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-'));
    await fs.mkdir(path.join(projectDir, '.harness', 'memory'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'old note\n'.repeat(15_000) + 'latest important note', 'utf-8');

    const context = await assembleSystemContext({ systemPrompt: 'base prompt', projectDir });

    expect(context).toContain('base prompt');
    expect(context).toContain('trimmed to latest 4000 chars for prompt budget');
    expect(context).toContain('latest important note');
    expect(context.length).toBeLessThan(8_000);
  });

  it('reads an approved brain-update back into the system prompt (closes the learn loop)', async () => {
    // The review queue appends approved facts to .harness/memory/patterns.md.
    // This proves the round-trip: an approved fact re-enters the next session's
    // prompt as Agent Memory, so approving a brain-update actually teaches.
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-brain-readback-'));
    await fs.mkdir(path.join(projectDir, '.harness', 'memory'), { recursive: true });
    const fact = 'The staging API base URL is https://staging.example.test/v2';
    await fs.writeFile(
      path.join(projectDir, '.harness', 'memory', 'patterns.md'),
      `# Learned Patterns\n\n## Approved Brain Update abc123\n\n${fact}\n`,
      'utf-8',
    );

    const context = await assembleSystemContext({ systemPrompt: 'base prompt', projectDir });

    expect(context).toContain('Agent Memory: patterns.md');
    expect(context).toContain(fact);
  });

  it('keeps capped prompt sources under the baseline context budget', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-budget-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');
    await fs.mkdir(path.join(projectDir, 'forge-memory'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.harness', 'memory'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'HARNESS.md'), 'project start\n' + 'project memory line\n'.repeat(5_000) + 'project end', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'forge-memory', 'patterns.md'), 'pattern start\n' + 'pattern line\n'.repeat(5_000) + 'pattern end', 'utf-8');

    for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
      await fs.writeFile(path.join(projectDir, '.harness', 'memory', file), 'old agent memory\n'.repeat(4_000) + `${file} latest`, 'utf-8');
    }
    for (let index = 0; index < 75; index++) {
      const skillDir = path.join(skillsDir, `skill-${String(index).padStart(2, '0')}`);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Skill ${index} keeps descriptions concise for prompt budget checks\ndomain: test\n---\nFull skill content should not be injected.\n`, 'utf-8');
    }

    const context = await assembleSystemContext({ systemPrompt: 'base prompt', projectDir, skillsDir });

    expect(context).toContain('project start');
    expect(context).toContain('project end');
    expect(context).toContain('notes.md latest');
    expect(context).toContain('35 more skill(s) omitted from prompt');
    expect(context).not.toContain('skill-41');
    expect(context.length).toBeLessThan(32_768);
  });

  it('omits the trigger suffix for Anthropic-format skills that declare no triggers', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-context-triggers-'));
    const skillsDir = path.join(projectDir, '.harness', 'skills');

    const withTriggers = path.join(skillsDir, 'with-triggers');
    await fs.mkdir(withTriggers, { recursive: true });
    await fs.writeFile(path.join(withTriggers, 'SKILL.md'), [
      '---',
      'name: with-triggers',
      'description: Skill that declares triggers',
      'triggers:',
      '  - "review my code"',
      '---',
      '# With triggers',
    ].join('\n'), 'utf-8');

    const anthropicStyle = path.join(skillsDir, 'pdf-processing');
    await fs.mkdir(anthropicStyle, { recursive: true });
    await fs.writeFile(path.join(anthropicStyle, 'SKILL.md'), [
      '---',
      'name: pdf-processing',
      'description: Extract text and tables from PDF files. Use when working with PDFs.',
      '---',
      '# PDF Processing',
    ].join('\n'), 'utf-8');

    const context = await assembleSystemContext({ systemPrompt: 'base', projectDir, skillsDir });

    expect(context).toContain('• with-triggers');
    expect(context).toContain('(triggers: review my code)');
    expect(context).toContain('• pdf-processing');
    // Anthropic-format skill (no triggers field) must not carry a "(triggers: none)" noise suffix.
    expect(context).not.toMatch(/pdf-processing.*\(triggers:/);
  });

  describe('knowledge-graph recall', () => {
    it('skips when recallProjectDir or recallQuery is missing', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-recall-ctx-'));
      const context = await assembleSystemContext({ systemPrompt: 'base', projectDir });
      expect(context).not.toContain('Knowledge graph recall');
    });

    it('injects KG hits when configured', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-recall-ctx-'));
      const { upsertEntity } = await import('../jarvis/knowledgeGraph');
      await upsertEntity(projectDir, 'project', 'Atlas', { lead: 'alice' }, 'test');
      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        recallProjectDir: projectDir,
        recallQuery: 'atlas project',
      });
      expect(context).toContain('Knowledge graph recall: atlas project');
      expect(context).toContain('Atlas');
      expect(context).toMatch(/source: entity-/);
      expect(context).toMatch(/reference the source id/);
    });
  });

  describe('RAG auto-consult', () => {
    it('skips when no indexes exist', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rag-empty-'));
      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        ragProjectDir: projectDir,
        ragQuery: 'whatever',
        ragOllamaHost: 'http://localhost:1', // unreachable; backend=hash bypasses it anyway
      });
      expect(context).not.toContain('RAG recall');
    });

    it('injects top hits from a built index when query matches', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rag-hit-'));
      const corpus = path.join(projectDir, 'docs');
      await fs.mkdir(corpus, { recursive: true });
      await fs.writeFile(
        path.join(corpus, 'recipe.md'),
        'sourdough hydration ratio tips: aim for 75% hydration for an open crumb. ' +
          'bake at 230C with steam for the first 20 minutes.',
        'utf-8',
      );
      const { build } = await import('../persistence/ragIndex');
      await build(projectDir, 'docs', [corpus], { backend: 'hash', ollamaHost: 'http://localhost:1' });

      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        ragProjectDir: projectDir,
        ragQuery: 'sourdough hydration',
        ragOllamaHost: 'http://localhost:1',
      });
      expect(context).toContain('RAG recall: sourdough hydration');
      expect(context).toContain('docs#');
      expect(context).toContain('hydration');
    });
  });

  describe('memory palace summary', () => {
    it('skips when palaceProjectDir is not provided', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-palace-skip-'));
      const context = await assembleSystemContext({ systemPrompt: 'base', projectDir });
      expect(context).not.toContain('Memory palace summary');
    });

    it('injects top rooms with anchor samples when entries exist', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-palace-hit-'));
      const memDir = path.join(projectDir, '.harness', 'memory');
      await fs.mkdir(memDir, { recursive: true });
      const entries = [
        { id: 'e1', sessionId: 's1', timestamp: '2026-05-15T00:00:00Z', kind: 'message', text: 'first conversation note about deployments', tokens: ['deployments', 'conversation'] },
        { id: 'e2', sessionId: 's1', timestamp: '2026-05-16T00:00:00Z', kind: 'message', text: 'second conversation note about CI failures', tokens: ['conversation', 'failures'] },
        { id: 'e3', sessionId: 's2', timestamp: '2026-05-16T01:00:00Z', kind: 'tool_result', text: 'tool result: ran tests successfully', tokens: ['tool', 'result'] },
      ];
      await fs.writeFile(path.join(memDir, 'semantic-index.json'), JSON.stringify(entries), 'utf-8');

      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        palaceProjectDir: projectDir,
      });
      expect(context).toContain('Memory palace summary');
      expect(context).toMatch(/Conversation Gallery|Tool Workshop/);
      expect(context).toMatch(/conversation note|tool result/);
    });
  });

  describe('prior-session search', () => {
    it('skips when sessionSearchProjectDir is missing', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sess-skip-'));
      const context = await assembleSystemContext({ systemPrompt: 'base', projectDir, sessionSearchQuery: 'anything' });
      expect(context).not.toContain('Prior sessions matching');
    });

    it('injects matching prior-session hits', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sess-hit-'));
      const memDir = path.join(projectDir, '.harness', 'memory');
      await fs.mkdir(memDir, { recursive: true });
      const indexFile = {
        metadata: { rebuiltAt: '2026-05-16T00:00:00Z', sessionCount: 1, entryCount: 1, sourceUpdatedAt: '2026-05-16T00:00:00Z' },
        entries: [
          { id: 'evt1', sessionId: 'sess-abc', timestamp: '2026-05-16T00:00:00Z', role: 'user', text: 'how do i configure kubernetes ingress for tls?', tokens: ['configure', 'kubernetes', 'ingress', 'tls'] },
        ],
      };
      await fs.writeFile(path.join(memDir, 'session-search-index.json'), JSON.stringify(indexFile), 'utf-8');

      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        sessionSearchProjectDir: projectDir,
        sessionSearchQuery: 'kubernetes ingress',
      });
      expect(context).toContain('Prior sessions matching: kubernetes ingress');
      expect(context).toContain('sess-abc');
      expect(context).toContain('kubernetes ingress');
    });
  });

  describe('combined recall-section budget', () => {
    it('trims combined RAG + palace + session-search sections to the shared cap', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-recall-budget-'));
      const memDir = path.join(projectDir, '.harness', 'memory');
      await fs.mkdir(memDir, { recursive: true });

      // Stuff palace and session sections at max output, and add three large
      // RAG indexes whose combined snippets alone exceed the 4_000-char cap.
      const bigText = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars per entry
      const semanticEntries = Array.from({ length: 6 }, (_, i) => ({
        id: `e${i}`,
        sessionId: `sess-${i}`,
        timestamp: `2026-05-${10 + i}T00:00:00Z`,
        kind: 'message',
        text: bigText,
        tokens: ['lorem', 'ipsum'],
      }));
      await fs.writeFile(path.join(memDir, 'semantic-index.json'), JSON.stringify(semanticEntries), 'utf-8');

      const sessIndex = {
        metadata: { rebuiltAt: '2026-05-16T00:00:00Z', sessionCount: 3, entryCount: 3, sourceUpdatedAt: '2026-05-16T00:00:00Z' },
        entries: Array.from({ length: 3 }, (_, i) => ({
          id: `s${i}`,
          sessionId: `sess-x${i}`,
          timestamp: '2026-05-16T00:00:00Z',
          role: 'user',
          text: `lorem ipsum project query ${i} ` + bigText,
          tokens: ['lorem', 'ipsum', 'project'],
        })),
      };
      await fs.writeFile(path.join(memDir, 'session-search-index.json'), JSON.stringify(sessIndex), 'utf-8');

      // Build three RAG indexes with bulky markdown content; each gets 3 hits
      // up to 500 chars + overhead, so ~4.5KB+ before the combined cap.
      const { build } = await import('../persistence/ragIndex');
      for (let i = 0; i < 3; i += 1) {
        const corpus = path.join(projectDir, `corpus-${i}`);
        await fs.mkdir(corpus, { recursive: true });
        await fs.writeFile(path.join(corpus, 'doc.md'), `lorem ipsum corpus ${i} ${bigText}`, 'utf-8');
        await build(projectDir, `idx${i}`, [corpus], { backend: 'hash', ollamaHost: 'http://localhost:1' });
      }

      const context = await assembleSystemContext({
        systemPrompt: 'base',
        projectDir,
        palaceProjectDir: projectDir,
        sessionSearchProjectDir: projectDir,
        sessionSearchQuery: 'lorem ipsum',
        ragProjectDir: projectDir,
        ragQuery: 'lorem ipsum',
        ragOllamaHost: 'http://localhost:1',
      });

      // After cap is enforced the combined block is content.slice(-4000) plus
      // the trim-marker prefix line (~80 chars).
      expect(context).toContain('trimmed to latest 4000 chars for prompt budget');
      const markerStart = context.indexOf('...(trimmed to latest 4000');
      expect(markerStart).toBeGreaterThanOrEqual(0);
      // From the marker to end-of-context should be ≤ 4_000 chars of payload
      // plus the single marker line (~80 chars).
      const recallBlock = context.slice(markerStart);
      expect(recallBlock.length).toBeLessThan(4_200);
    });
  });
});
