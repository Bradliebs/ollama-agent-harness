import { describe, expect, it } from '@jest/globals';
import { renderTemplate, renderTemplateDetailed } from './template';

describe('renderTemplate', () => {
  it('returns the template unchanged when no placeholders are present', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text');
    expect(renderTemplate('plain text')).toBe('plain text');
  });

  it('substitutes {{key}} placeholders from a flat context', () => {
    expect(renderTemplate('hello {{name}}', { name: 'world' })).toBe('hello world');
    expect(renderTemplate('a={{a}} b={{b}}', { a: '1', b: '2' })).toBe('a=1 b=2');
  });

  it('tolerates whitespace inside placeholders', () => {
    expect(renderTemplate('hi {{ name }}', { name: 'x' })).toBe('hi x');
    expect(renderTemplate('hi {{   name   }}', { name: 'y' })).toBe('hi y');
  });

  it('leaves unresolved placeholders in place and reports them', () => {
    const { output, unresolved } = renderTemplateDetailed('hi {{name}} {{missing}}', { name: 'x' });
    expect(output).toBe('hi x {{missing}}');
    expect(unresolved).toEqual(['missing']);
  });

  it('stringifies numbers, booleans, arrays, and objects', () => {
    expect(renderTemplate('n={{n}}', { n: 42 })).toBe('n=42');
    expect(renderTemplate('b={{b}}', { b: true })).toBe('b=true');
    expect(renderTemplate('a={{a}}', { a: [1, 2] })).toBe('a=[1,2]');
    expect(renderTemplate('o={{o}}', { o: { x: 1 } })).toBe('o={"x":1}');
  });

  it('renders empty string for null/undefined explicit bindings', () => {
    expect(renderTemplate('x={{x}}', { x: null })).toBe('x=');
    expect(renderTemplate('x={{x}}', { x: undefined })).toBe('x=');
  });

  it('does not treat hyphens/underscores in keys as ends', () => {
    expect(renderTemplate('a={{my-key}} b={{my_key}}', { 'my-key': '1', 'my_key': '2' })).toBe('a=1 b=2');
  });

  it('does not substitute keys not present on context (vs. present-but-undefined)', () => {
    const { unresolved } = renderTemplateDetailed('{{a}}', {});
    expect(unresolved).toEqual(['a']);
  });

  it('handles {{#if}} blocks: keeps body when truthy, drops when falsy or missing', () => {
    const tmpl = 'before{{#if show}}MID{{/if}}after';
    expect(renderTemplate(tmpl, { show: true })).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, { show: 'yes' })).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, { show: 1 })).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, { show: [1] })).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, { show: false })).toBe('beforeafter');
    expect(renderTemplate(tmpl, { show: '' })).toBe('beforeafter');
    expect(renderTemplate(tmpl, { show: 0 })).toBe('beforeafter');
    expect(renderTemplate(tmpl, { show: [] })).toBe('beforeafter');
    expect(renderTemplate(tmpl, {})).toBe('beforeafter');
  });

  it('handles {{#unless}} blocks: keeps body when falsy or missing, drops when truthy', () => {
    const tmpl = 'before{{#unless show}}MID{{/unless}}after';
    expect(renderTemplate(tmpl, { show: false })).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, {})).toBe('beforeMIDafter');
    expect(renderTemplate(tmpl, { show: true })).toBe('beforeafter');
    expect(renderTemplate(tmpl, { show: 'yes' })).toBe('beforeafter');
  });

  it('substitutes inside a kept block body', () => {
    const tmpl = '{{#if show}}hi {{name}}{{/if}}';
    expect(renderTemplate(tmpl, { show: true, name: 'world' })).toBe('hi world');
    expect(renderTemplate(tmpl, { show: false, name: 'world' })).toBe('');
  });

  it('handles two non-nested blocks in one template', () => {
    const tmpl = '[{{#if a}}A{{/if}}][{{#unless b}}NB{{/unless}}]';
    expect(renderTemplate(tmpl, { a: true, b: false })).toBe('[A][NB]');
    expect(renderTemplate(tmpl, { a: false, b: true })).toBe('[][]');
  });

  it('preserves unrelated braces and JSON-like text outside placeholders', () => {
    const tmpl = '{ "key": "{{value}}" } and { plain }';
    expect(renderTemplate(tmpl, { value: 'v' })).toBe('{ "key": "v" } and { plain }');
  });

  it('does not loop indefinitely on degenerate input', () => {
    const start = Date.now();
    const out = renderTemplate('{{a}}{{b}}{{c}}', {});
    expect(out).toBe('{{a}}{{b}}{{c}}');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('handles empty / non-string input defensively', () => {
    expect(renderTemplate('', { a: '1' })).toBe('');
    expect(renderTemplateDetailed('', {}).unresolved).toEqual([]);
  });
});
