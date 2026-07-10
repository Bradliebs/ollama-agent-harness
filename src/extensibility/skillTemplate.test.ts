import { expandSkillTemplateVars } from './skillTemplate';

describe('expandSkillTemplateVars', () => {
  it('expands ${HARNESS_SKILL_DIR}', () => {
    const out = expandSkillTemplateVars('Files live in ${HARNESS_SKILL_DIR}/scripts.', {
      skillDir: '/proj/.harness/skills/demo',
    });
    expect(out).toBe('Files live in /proj/.harness/skills/demo/scripts.');
  });

  it('expands ${HARNESS_PROJECT_DIR}', () => {
    const out = expandSkillTemplateVars('Root is ${HARNESS_PROJECT_DIR}.', {
      projectDir: '/proj',
    });
    expect(out).toBe('Root is /proj.');
  });

  it('replaces every occurrence of a token', () => {
    const out = expandSkillTemplateVars('${HARNESS_SKILL_DIR} and ${HARNESS_SKILL_DIR}', {
      skillDir: '/a',
    });
    expect(out).toBe('/a and /a');
  });

  it('leaves unknown ${...} tokens untouched', () => {
    const input = 'Shell var ${HOME} and ${FOO_BAR} stay verbatim.';
    expect(expandSkillTemplateVars(input, { skillDir: '/a', projectDir: '/b' })).toBe(input);
  });

  it('leaves a known token untouched when its value is unavailable', () => {
    const input = 'Dir: ${HARNESS_SKILL_DIR}';
    expect(expandSkillTemplateVars(input, {})).toBe(input);
  });

  it('is byte-identical when content has no ${ sequence', () => {
    const input = 'Plain skill body with no tokens at all.';
    expect(expandSkillTemplateVars(input, { skillDir: '/a', projectDir: '/b' })).toBe(input);
  });

  it('does not corrupt shell template literals in code examples', () => {
    const input = 'Run: echo "${PATH}" and ${1:-default}';
    expect(expandSkillTemplateVars(input, { skillDir: '/a' })).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(expandSkillTemplateVars('', { skillDir: '/a' })).toBe('');
  });
});
