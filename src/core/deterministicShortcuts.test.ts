import { tryDeterministicShortcut, listShortcutTypes } from './deterministicShortcuts';

describe('deterministicShortcuts', () => {
  it('handles date calculation: days from now', () => {
    const result = tryDeterministicShortcut('what is 30 days from now');
    expect(result.handled).toBe(true);
    expect(result.type).toBe('date_calculation');
    expect((result.output as { result: string }).result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles date calculation: days ago', () => {
    const result = tryDeterministicShortcut('what was 7 days ago');
    expect(result.handled).toBe(true);
    expect(result.type).toBe('date_calculation');
  });

  it('handles date calculation: days between dates', () => {
    const result = tryDeterministicShortcut('how many days between 2026-01-01 and 2026-01-31');
    expect(result.handled).toBe(true);
    expect((result.output as { result: number }).result).toBe(30);
  });

  it('handles date calculation: today', () => {
    const result = tryDeterministicShortcut('what day is today');
    expect(result.handled).toBe(true);
    expect(result.type).toBe('date_calculation');
  });

  it('handles math: sum of numbers', () => {
    const result = tryDeterministicShortcut('sum of 10, 20, 30');
    expect(result.handled).toBe(true);
    expect(result.type).toBe('math_calculation');
    expect((result.output as { result: number }).result).toBe(60);
  });

  it('handles math: average', () => {
    const result = tryDeterministicShortcut('average of 10, 20, 30');
    expect(result.handled).toBe(true);
    expect((result.output as { result: number }).result).toBe(20);
  });

  it('handles math: min/max', () => {
    expect((tryDeterministicShortcut('min of 5, 3, 8').output as { result: number }).result).toBe(3);
    expect((tryDeterministicShortcut('max of 5, 3, 8').output as { result: number }).result).toBe(8);
  });

  it('handles math: median', () => {
    const result = tryDeterministicShortcut('median of 1, 3, 5, 7, 9');
    expect(result.handled).toBe(true);
    expect((result.output as { result: number }).result).toBe(5);
  });

  it('handles JSON validation', () => {
    const valid = tryDeterministicShortcut('validate json {"name":"test","value":42}');
    expect(valid.handled).toBe(true);
    expect((valid.output as { valid: boolean }).valid).toBe(true);

    const invalid = tryDeterministicShortcut('parse json {broken');
    expect(invalid.handled).toBe(true);
    expect((invalid.output as { valid: boolean }).valid).toBe(false);
  });

  it('handles sorting numbers', () => {
    const result = tryDeterministicShortcut('sort these numbers 5 3 8 1 4');
    expect(result.handled).toBe(true);
    expect((result.output as { sorted: number[] }).sorted).toEqual([1, 3, 4, 5, 8]);
  });

  it('handles sorting descending', () => {
    const result = tryDeterministicShortcut('sort these numbers largest first 5 3 8 1 4');
    expect(result.handled).toBe(true);
    expect((result.output as { sorted: number[] }).sorted).toEqual([8, 5, 4, 3, 1]);
  });

  it('handles regex email extraction', () => {
    const result = tryDeterministicShortcut('extract emails from hello test@example.com and foo@bar.com');
    expect(result.handled).toBe(true);
    expect((result.output as { matches: string[]; count: number }).matches).toContain('test@example.com');
    expect((result.output as { matches: string[]; count: number }).count).toBe(2);
  });

  it('handles unit conversion', () => {
    const result = tryDeterministicShortcut('convert 100 km to mi');
    expect(result.handled).toBe(true);
    const output = result.output as { result: number };
    expect(output.result).toBeCloseTo(62.1371, 1);
  });

  it('handles temperature conversion', () => {
    const result = tryDeterministicShortcut('convert 100 °C to °F');
    expect(result.handled).toBe(true);
    expect((result.output as { result: number }).result).toBe(212);
  });

  it('returns handled=false for non-shortcut input', () => {
    expect(tryDeterministicShortcut('explain how neural networks work').handled).toBe(false);
    expect(tryDeterministicShortcut('write a function to sort an array').handled).toBe(false);
    expect(tryDeterministicShortcut('').handled).toBe(false);
  });

  it('returns handled=false for very long input', () => {
    expect(tryDeterministicShortcut('a'.repeat(600)).handled).toBe(false);
  });

  it('lists available shortcut types', () => {
    const types = listShortcutTypes();
    expect(types).toContain('date_calculation');
    expect(types).toContain('math_calculation');
    expect(types).toContain('json_parse');
    expect(types).toContain('sort');
    expect(types).toContain('unit_conversion');
    expect(types.length).toBeGreaterThanOrEqual(5);
  });
});
