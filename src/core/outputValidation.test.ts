import { getOutputValidationInstructions, normalizeCustomOutputValidationProfiles, parseOutputValidationProfile, validateOutput, withOutputValidationInstructions } from './outputValidation';

const validOracleOutput = `🔍 **REFRAME** — [ANALYSIS] The question is whether strict output contracts improve reasoning quality.

🔧 **TRANSPARENCY LOG**
P1: [BYPASSED: no statistic]
P2: [TRIGGERED]
P3: [BYPASSED: no cascade]
P4: [TRIGGERED]
P5: [BYPASSED: no preference]
Steelman First: [TRIGGERED]
Domain Boundary: [TRIGGERED]
Confidence Discipline: [TRIGGERED]
Underdetermination Honesty: [TRIGGERED]
Update Without Ego: [TRIGGERED]

📊 **KEY VARIABLES**
1. Fit to task
2. Validation cost
3. False confidence risk

🔮 **SCENARIO MAP**
Base 55%: Optional validation is useful. Signals: adoption rises; defect reports fall.
Bull 20%: Profiles become reusable. Signals: teams add profiles; evals improve.
Bear 20%: Too much ceremony. Signals: users disable it; response length grows.
Black Swan 5%: Bad validators reject good work. Signals: false fails spike; users lose trust.

⚙️ **CAUSAL CHAIN**
A profile creates explicit obligations, which makes omissions visible. A second-order effect is that users can compare failures across sessions.

🔬 **COUNTERFACTUAL PIVOT**
If validator false positives rise above 25%, the Base Case flips to Bear.

⚠️ **CRITICAL UNCERTAINTIES**
[DATA] Actual false-positive rate.
[MODEL] Whether section checks correlate with quality.
[RIVAL] Better prompts may produce the same improvement.

✅ **CONCLUSION / ACTION**
Use this as an optional profile, not a default mode.

📌 **CONFIDENCE**
Medium. The implementation is deterministic, but quality correlation needs measured data.

**⚙️ ORACLE EVOLUTION**
\`DRIFT\`: Added a product-fit lens.
\`GAP\`: No measured false-positive rate yet.
\`PATCH\`: Track validation failures by profile.

SESSION STATE
EVIDENCE REGISTER: Optional validation was requested.
WEIGHT LOG: Base Case increased because implementation can be optional.
ACTIVE MODE(S): RED TEAM, COUNTERFACTUAL
STYLE NOTES: Concise, direct.
`;

describe('output validation', () => {
  it('passes an Oracle Prime response that includes the required contract', () => {
    const result = validateOutput(validOracleOutput, 'oracle-prime');

    expect(result.status).toBe('pass');
    expect(result.score).toBe(1);
    expect(result.missingSections).toEqual([]);
  });

  it('fails when required Oracle Prime sections are missing', () => {
    const result = validateOutput('Short answer with no structure.', 'oracle-prime');

    expect(result.status).toBe('fail');
    expect(result.missingSections).toEqual(expect.arrayContaining(['REFRAME', 'SCENARIO MAP', 'SESSION STATE']));
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-section' })]));
  });

  it('warns when scenario weights do not roughly sum to 100 percent', () => {
    const result = validateOutput(validOracleOutput.replace('Black Swan 5%', 'Black Swan 40%'), 'oracle-prime');

    expect(result.status).toBe('warn');
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'scenario-weight-sum' })]));
  });

  it('validates factual answers with evidence and uncertainty', () => {
    const result = validateOutput('Based on Met Office data found today, Bracknell is likely cloudy with some uncertainty around later showers.', 'factual-answer');

    expect(result.status).toBe('pass');
  });

  it('warns when factual answers omit evidence and uncertainty', () => {
    const result = validateOutput('Bracknell will be cloudy with light rain later in the day.', 'factual-answer');

    expect(result.status).toBe('warn');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-evidence-basis' }),
      expect.objectContaining({ code: 'missing-uncertainty' }),
    ]));
  });

  it('validates coding answers with files and validation', () => {
    const result = validateOutput('Implemented validation profiles in src/core/outputValidation.ts and ran npm test plus npm run typecheck.', 'coding-answer');

    expect(result.status).toBe('pass');
  });

  it('validates tool result summaries with outcome and output evidence', () => {
    const result = validateOutput('Command completed successfully with exit code 0; output reported 24 passing test suites.', 'tool-result-summary');

    expect(result.status).toBe('pass');
  });

  it('parses supported profiles and rejects unknown profiles', () => {
    expect(parseOutputValidationProfile('coding-answer')).toBe('coding-answer');
    expect(parseOutputValidationProfile('unknown')).toBeUndefined();
  });

  it('adds profile-specific prompt instructions once', () => {
    const prompt = withOutputValidationInstructions('Base prompt.', 'coding-answer');

    expect(prompt).toContain(getOutputValidationInstructions('coding-answer'));
    expect(withOutputValidationInstructions(prompt, 'coding-answer')).toBe(prompt);
  });

  it('normalizes and validates custom output profiles', () => {
    const customProfiles = normalizeCustomOutputValidationProfiles({
      profiles: [{
        profile: 'brief-release-note',
        label: 'Brief Release Note',
        description: 'Requires validation and release language.',
        instructions: 'Mention validation and release outcome in a concise summary.',
        checks: [
          { code: 'missing-validation', severity: 'fail', message: 'Mention validation.', requiresAny: ['validation', 'tests'] },
          { code: 'missing-release', severity: 'warn', message: 'Mention release outcome.', requiresAll: ['release'] },
          { code: 'too-long', severity: 'warn', message: 'Keep it concise.', maxLength: 120 },
        ],
      }],
    });

    expect(parseOutputValidationProfile('brief-release-note', customProfiles)).toBe('brief-release-note');
    expect(validateOutput('Validation passed and the release was published.', 'brief-release-note', customProfiles)).toMatchObject({ status: 'pass', score: 1 });
    expect(validateOutput('Release was published.', 'brief-release-note', customProfiles)).toMatchObject({ status: 'fail' });
  });

  it('uses custom profile instructions in prompt pairing', () => {
    const customProfiles = normalizeCustomOutputValidationProfiles([{ profile: 'brief-summary', instructions: 'Mention outcome and evidence.', checks: [{ code: 'has-outcome', message: 'Needs outcome.', requiresAny: ['passed'] }] }]);

    expect(withOutputValidationInstructions('Base prompt.', 'brief-summary', customProfiles)).toContain('Mention outcome and evidence.');
  });
});
