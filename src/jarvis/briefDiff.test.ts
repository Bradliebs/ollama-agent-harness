import { diffBriefs } from './briefDiff';

describe('brief diff', () => {
  it('returns no sections when briefs are identical', () => {
    const md = '## A\n- one\n- two\n## B\n- x\n';
    const result = diffBriefs(md, md);
    expect(result.sections).toEqual([]);
    expect(result.summary.sectionsChanged).toBe(0);
  });

  it('detects added and removed lines per section', () => {
    const prev = '## Status\n- pending: 2\n## Notes\n- old note\n';
    const next = '## Status\n- pending: 5\n## Notes\n- new note\n';
    const result = diffBriefs(prev, next);
    expect(result.summary.sectionsChanged).toBe(2);
    const status = result.sections.find((s) => s.section === 'Status');
    expect(status?.added).toEqual(['- pending: 5']);
    expect(status?.removed).toEqual(['- pending: 2']);
  });

  it('handles new and removed sections', () => {
    const prev = '## A\n- 1\n';
    const next = '## A\n- 1\n## B\n- 2\n';
    const result = diffBriefs(prev, next);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].section).toBe('B');
    expect(result.sections[0].added).toEqual(['- 2']);
  });

  it('groups preamble lines under _preamble', () => {
    const prev = 'intro\n## A\nbody\n';
    const next = 'intro updated\n## A\nbody\n';
    const result = diffBriefs(prev, next);
    expect(result.sections.find((s) => s.section === '_preamble')).toBeDefined();
  });
});
