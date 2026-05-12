import { validateStructuredOutput, parseAndValidate, detectSchema, BUILTIN_SCHEMAS } from './structuredOutputValidator';

describe('structuredOutputValidator', () => {
  it('validates tool_call schema', () => {
    const result = validateStructuredOutput({ name: 'file_read', path: '/test' }, BUILTIN_SCHEMAS.tool_call);
    expect(result.valid).toBe(true);
    expect(result.score).toBe(1);
  });

  it('rejects missing required field', () => {
    const result = validateStructuredOutput({}, BUILTIN_SCHEMAS.tool_call);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
  });

  it('validates service_command schema', () => {
    const valid = validateStructuredOutput({ type: 'add_task', title: 'test' }, BUILTIN_SCHEMAS.service_command);
    expect(valid.valid).toBe(true);

    const invalid = validateStructuredOutput({ type: 'nonexistent_command' }, BUILTIN_SCHEMAS.service_command);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors[0]).toContain('Unknown command type');
  });

  it('validates code_edit schema', () => {
    const valid = validateStructuredOutput({ path: 'src/main.ts', old_string: 'foo', new_string: 'bar' }, BUILTIN_SCHEMAS.code_edit);
    expect(valid.valid).toBe(true);

    const traversal = validateStructuredOutput({ path: '../../../etc/passwd' }, BUILTIN_SCHEMAS.code_edit);
    expect(traversal.valid).toBe(false);
    expect(traversal.errors.some((e) => e.includes('traversal'))).toBe(true);
  });

  it('validates planning_output schema', () => {
    const valid = validateStructuredOutput({ steps: ['step 1', 'step 2'] }, BUILTIN_SCHEMAS.planning_output);
    expect(valid.valid).toBe(true);

    const empty = validateStructuredOutput({ steps: [] }, BUILTIN_SCHEMAS.planning_output);
    expect(empty.valid).toBe(false);
  });

  it('validates analysis_result schema', () => {
    const valid = validateStructuredOutput({ summary: 'This is a detailed analysis of the system.' }, BUILTIN_SCHEMAS.analysis_result);
    expect(valid.valid).toBe(true);

    const tooShort = validateStructuredOutput({ summary: 'short' }, BUILTIN_SCHEMAS.analysis_result);
    expect(tooShort.valid).toBe(false);
  });

  it('checks type mismatches', () => {
    const result = validateStructuredOutput({ name: 123 }, BUILTIN_SCHEMAS.tool_call);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('should be string'))).toBe(true);
  });

  it('parseAndValidate extracts JSON from markdown', () => {
    const text = 'Here is the result:\n```json\n{"name":"test_tool"}\n```';
    const { parsed, validation } = parseAndValidate(text, BUILTIN_SCHEMAS.tool_call);
    expect(parsed).toEqual({ name: 'test_tool' });
    expect(validation.valid).toBe(true);
  });

  it('parseAndValidate handles no JSON', () => {
    const { parsed, validation } = parseAndValidate('just plain text', BUILTIN_SCHEMAS.tool_call);
    expect(parsed).toBeNull();
    expect(validation.valid).toBe(false);
  });

  it('parseAndValidate handles invalid JSON', () => {
    const { parsed, validation } = parseAndValidate('{broken json}', BUILTIN_SCHEMAS.tool_call);
    expect(parsed).toBeNull();
    expect(validation.valid).toBe(false);
  });

  it('detectSchema returns correct schema for context', () => {
    expect(detectSchema({ toolName: 'file_edit' })?.id).toBe('code_edit');
    expect(detectSchema({ taskType: 'plan' })?.id).toBe('planning_output');
    expect(detectSchema({ taskType: 'summarize' })?.id).toBe('analysis_result');
    expect(detectSchema({ taskType: 'general' })).toBeNull();
  });

  it('score reflects partial validity', () => {
    // Has name (required + string check pass) but custom check doesn't fail
    const result = validateStructuredOutput({ name: 'test' }, BUILTIN_SCHEMAS.tool_call);
    expect(result.score).toBe(1);

    // Missing required field — score < 1
    const partial = validateStructuredOutput({ extra: 'data' }, BUILTIN_SCHEMAS.tool_call);
    expect(partial.score).toBeLessThan(1);
  });
});
