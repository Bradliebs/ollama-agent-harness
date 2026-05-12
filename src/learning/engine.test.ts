import {
  startNewSession,
  trackToolUsage,
  detectPatterns,
  reflectOnSession,
  consolidateMemory,
  getEvolvedPrompt,
  getUnpromotedPatterns,
  onSessionEnd,
} from './engine';

describe('learning engine', () => {
  it('startNewSession returns a session id and resets state', () => {
    const id = startNewSession();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('trackToolUsage does not throw', async () => {
    startNewSession();
    await expect(
      trackToolUsage('file_read', { path: 'test.ts' }, true, 50),
    ).resolves.not.toThrow();
  });

  it('reflectOnSession returns a reflection with correct structure', async () => {
    startNewSession();
    await trackToolUsage('file_read', { path: 'a.ts' }, true, 10);
    await trackToolUsage('file_write', { path: 'b.ts' }, true, 20);
    await trackToolUsage('bash', { command: 'echo hi' }, false, 5);
    const reflection = await reflectOnSession();
    expect(reflection.sessionId).toBeTruthy();
    expect(reflection.toolsUsed).toEqual(expect.arrayContaining(['file_read', 'file_write', 'bash']));
    expect(reflection.successRate).toBeCloseTo(2 / 3, 1);
    expect(Array.isArray(reflection.insights)).toBe(true);
    expect(Array.isArray(reflection.suggestedImprovements)).toBe(true);
  });

  it('reflectOnSession detects high failure rate', async () => {
    startNewSession();
    for (let i = 0; i < 5; i++) {
      await trackToolUsage('bash', { command: 'fail' }, false, 1);
    }
    const reflection = await reflectOnSession();
    expect(reflection.successRate).toBe(0);
    expect(reflection.insights.some((i) => i.includes('Low success rate'))).toBe(true);
    expect(reflection.suggestedImprovements.some((i) => i.includes('bash'))).toBe(true);
  });

  it('reflectOnSession detects perfect success', async () => {
    startNewSession();
    for (let i = 0; i < 6; i++) {
      await trackToolUsage('file_read', { path: `f${i}.ts` }, true, 5);
    }
    const reflection = await reflectOnSession();
    expect(reflection.successRate).toBe(1);
    expect(reflection.insights.some((i) => i.includes('Perfect success rate'))).toBe(true);
  });

  it('detectPatterns returns an array and does not throw on fresh state', async () => {
    const patterns = await detectPatterns();
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('getUnpromotedPatterns returns an array', async () => {
    const patterns = await getUnpromotedPatterns();
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('consolidateMemory returns a string', async () => {
    const result = await consolidateMemory();
    expect(typeof result).toBe('string');
  });

  it('getEvolvedPrompt returns at least the base prompt', async () => {
    const base = 'You are a helpful assistant.';
    const result = await getEvolvedPrompt(base);
    expect(result).toContain(base);
  });

  it('onSessionEnd returns reflection and patterns', async () => {
    startNewSession();
    await trackToolUsage('file_read', { path: 'test.ts' }, true, 10);
    const result = await onSessionEnd();
    expect(result.reflection).toBeDefined();
    expect(result.reflection.sessionId).toBeTruthy();
    expect(Array.isArray(result.newPatterns)).toBe(true);
  });
});
