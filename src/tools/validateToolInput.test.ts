import { validateToolInput } from './validateToolInput';
import type { Tool } from '../types';

function makeTool(parameters: Record<string, unknown>): Tool {
  return {
    name: 'demo',
    description: 'demo tool',
    parameters,
    isReadOnly: true,
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

describe('validateToolInput', () => {
  it('passes when all required parameters are present', () => {
    const tool = makeTool({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    const r = validateToolInput(tool, { path: '/tmp/x' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags a missing required parameter', () => {
    const tool = makeTool({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    const r = validateToolInput(tool, {});
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(["Missing required parameter 'path'."]);
  });

  it('treats an explicit undefined value as missing', () => {
    const tool = makeTool({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    const r = validateToolInput(tool, { path: undefined });
    expect(r.valid).toBe(false);
  });

  it('lists every missing required parameter', () => {
    const tool = makeTool({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    });
    const r = validateToolInput(tool, {});
    expect(r.errors).toHaveLength(2);
  });

  it('allows extra/unknown keys', () => {
    const tool = makeTool({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    const r = validateToolInput(tool, { path: '/tmp/x', extra: 1 });
    expect(r.valid).toBe(true);
  });

  it('does not type-check present values', () => {
    const tool = makeTool({ type: 'object', properties: { count: { type: 'number' } }, required: ['count'] });
    const r = validateToolInput(tool, { count: '3' });
    expect(r.valid).toBe(true);
  });

  it('is a no-op when there is no required list', () => {
    const tool = makeTool({ type: 'object', properties: { path: { type: 'string' } } });
    expect(validateToolInput(tool, {}).valid).toBe(true);
  });

  it('is a no-op for a non-object schema', () => {
    const tool = makeTool({ type: 'string' });
    expect(validateToolInput(tool, {}).valid).toBe(true);
  });

  it('is a no-op for an empty/absent schema', () => {
    const tool = makeTool({});
    expect(validateToolInput(tool, {}).valid).toBe(true);
  });
});
