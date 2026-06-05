import {
  classifyCommand,
  defaultIsReadOnlyCommand,
  FALLBACK_CLASSIFICATION,
  type InferFn,
} from './commandClassifier';

describe('defaultIsReadOnlyCommand', () => {
  it('treats known read-only leaders as read-only', () => {
    expect(defaultIsReadOnlyCommand('ls -la')).toBe(true);
    expect(defaultIsReadOnlyCommand('cat package.json')).toBe(true);
    expect(defaultIsReadOnlyCommand('git status')).toBe(true);
    expect(defaultIsReadOnlyCommand('git log --oneline')).toBe(true);
  });

  it('treats writes and unknown leaders as not read-only', () => {
    expect(defaultIsReadOnlyCommand('rm -rf build')).toBe(false);
    expect(defaultIsReadOnlyCommand('git push')).toBe(false);
    expect(defaultIsReadOnlyCommand('npm install')).toBe(false);
  });

  it('rejects read-only leaders that smuggle shell operators', () => {
    expect(defaultIsReadOnlyCommand('ls; rm -rf /')).toBe(false);
    expect(defaultIsReadOnlyCommand('cat x > y')).toBe(false);
    expect(defaultIsReadOnlyCommand('echo $(rm x)')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(defaultIsReadOnlyCommand('   ')).toBe(false);
  });
});

describe('classifyCommand', () => {
  it('takes the deterministic fast-path for read-only commands without calling the model', async () => {
    const infer = jest.fn<ReturnType<InferFn>, Parameters<InferFn>>();
    const result = await classifyCommand('git status', { infer });
    expect(infer).not.toHaveBeenCalled();
    expect(result.category).toBe('readonly');
    expect(result.suggestedPattern).toBe('git *');
    expect(result.patternRationale).toBeTruthy();
  });

  it('parses a well-formed model response', async () => {
    const infer: InferFn = async () =>
      JSON.stringify({
        explanation: 'Removes the build folder.',
        category: 'destructive',
        suggestedPattern: 'rm -rf build*',
        patternRationale: 'Only ever clears build output.',
      });
    const result = await classifyCommand('rm -rf build', { infer });
    expect(result.category).toBe('destructive');
    expect(result.explanation).toBe('Removes the build folder.');
    expect(result.suggestedPattern).toBe('rm -rf build*');
  });

  it('extracts JSON embedded in noisy model output', async () => {
    const infer: InferFn = async () =>
      'Sure! Here is the classification:\n{"explanation":"Installs deps.","category":"network","suggestedPattern":null,"patternRationale":null}\nHope that helps.';
    const result = await classifyCommand('npm install', { infer });
    expect(result.category).toBe('network');
    expect(result.explanation).toBe('Installs deps.');
    expect(result.suggestedPattern).toBeNull();
  });

  it('drops an incoherent pattern/rationale pair', async () => {
    const infer: InferFn = async () =>
      JSON.stringify({
        explanation: 'Does a thing.',
        category: 'writes',
        suggestedPattern: 'foo *',
        patternRationale: null,
      });
    const result = await classifyCommand('foo bar', { infer });
    expect(result.suggestedPattern).toBeNull();
    expect(result.patternRationale).toBeNull();
  });

  it('falls back when the model returns garbage', async () => {
    const infer: InferFn = async () => 'not json at all';
    const result = await classifyCommand('npm install', { infer });
    expect(result).toEqual(FALLBACK_CLASSIFICATION);
  });

  it('falls back when an invalid category is returned', async () => {
    const infer: InferFn = async () =>
      JSON.stringify({ explanation: 'x', category: 'banana', suggestedPattern: null, patternRationale: null });
    const result = await classifyCommand('npm install', { infer });
    expect(result).toEqual(FALLBACK_CLASSIFICATION);
  });

  it('falls back when inference throws', async () => {
    const infer: InferFn = async () => {
      throw new Error('model offline');
    };
    const result = await classifyCommand('npm install', { infer });
    expect(result).toEqual(FALLBACK_CLASSIFICATION);
  });
});
