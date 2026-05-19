export type BuiltInOutputValidationProfile = 'oracle-prime' | 'factual-answer' | 'coding-answer' | 'tool-result-summary';
export type OutputValidationProfile = BuiltInOutputValidationProfile | string;
export type OutputValidationStatus = 'pass' | 'warn' | 'fail';

export interface OutputValidationProfileInfo {
  profile: string;
  label: string;
  description: string;
}

export interface CustomOutputValidationCheck {
  code: string;
  severity?: OutputValidationStatus;
  message: string;
  requiresAny?: string[];
  requiresAll?: string[];
  forbidsAny?: string[];
  minLength?: number;
  maxLength?: number;
  scorePenalty?: number;
}

export interface CustomOutputValidationProfile extends OutputValidationProfileInfo {
  instructions: string;
  checks: CustomOutputValidationCheck[];
  warnBelowScore?: number;
  failBelowScore?: number;
}

export interface CustomOutputValidationProfileError {
  path: string;
  message: string;
}

export interface CustomOutputValidationProfileValidation {
  profiles: CustomOutputValidationProfile[];
  errors: CustomOutputValidationProfileError[];
}

export interface OutputValidationFinding {
  code: string;
  severity: OutputValidationStatus;
  message: string;
  scorePenalty?: number;
  suggestion?: string;
}

export interface OutputValidationResult {
  profile: OutputValidationProfile;
  status: OutputValidationStatus;
  score: number;
  findings: OutputValidationFinding[];
  missingSections: string[];
}

export interface OutputValidationProfileTemplate extends CustomOutputValidationProfile {
  examples: {
    good: string;
    bad: string;
  };
}

const ORACLE_REQUIRED_SECTIONS = [
  'REFRAME',
  'TRANSPARENCY LOG',
  'KEY VARIABLES',
  'SCENARIO MAP',
  'CAUSAL CHAIN',
  'COUNTERFACTUAL PIVOT',
  'CRITICAL UNCERTAINTIES',
  'CONCLUSION / ACTION',
  'CONFIDENCE',
  'ORACLE EVOLUTION',
  'SESSION STATE',
];

const TRANSPARENCY_RULES = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'Steelman First',
  'Domain Boundary',
  'Confidence Discipline',
  'Underdetermination Honesty',
  'Update Without Ego',
];

export const OUTPUT_VALIDATION_PROFILES: OutputValidationProfileInfo[] = [
  { profile: 'oracle-prime', label: 'Oracle Prime', description: 'Full reasoning contract with scenarios, transparency, confidence, and session state.' },
  { profile: 'factual-answer', label: 'Factual Answer', description: 'Checks direct factual answers for evidence, uncertainty, and non-placeholder content.' },
  { profile: 'coding-answer', label: 'Coding Answer', description: 'Checks engineering summaries for touched files, validation, and concrete change language.' },
  { profile: 'tool-result-summary', label: 'Tool Result Summary', description: 'Checks command/tool summaries for outcome, evidence, and concise status.' },
];

export const OUTPUT_VALIDATION_PROFILE_TEMPLATES: OutputValidationProfileTemplate[] = [
  {
    profile: 'beginner-factual-summary',
    label: 'Beginner Factual Summary',
    description: 'Requires source/evidence language, uncertainty, and a useful answer length.',
    instructions: 'Answer directly, mention the source or evidence basis, and state confidence or uncertainty when facts may change.',
    warnBelowScore: 0.85,
    failBelowScore: 0.6,
    checks: [
      { code: 'missing-evidence', severity: 'warn', message: 'Mention the source or evidence basis.', requiresAny: ['source', 'according to', 'based on', 'evidence', 'reported', 'data'], scorePenalty: 0.15 },
      { code: 'missing-uncertainty', severity: 'warn', message: 'State confidence or uncertainty.', requiresAny: ['confidence', 'uncertain', 'likely', 'may', 'might', 'as of', 'today', 'latest'], scorePenalty: 0.15 },
      { code: 'too-short', severity: 'fail', message: 'Provide enough detail to be useful.', minLength: 80, scorePenalty: 0.25 },
    ],
    examples: {
      good: 'Based on Met Office data found today, Bracknell is likely cloudy, with some uncertainty around later showers.',
      bad: 'It will be cloudy.',
    },
  },
  {
    profile: 'beginner-code-summary',
    label: 'Beginner Code Summary',
    description: 'Requires changed files, what changed, and validation status.',
    instructions: 'Summarize what changed, name the files or areas touched, and state validation performed or why it was not run.',
    warnBelowScore: 0.85,
    failBelowScore: 0.6,
    checks: [
      { code: 'missing-change', severity: 'fail', message: 'Summarize a concrete change.', requiresAny: ['changed', 'added', 'updated', 'fixed', 'implemented', 'removed'], scorePenalty: 0.25 },
      { code: 'missing-validation', severity: 'warn', message: 'Mention validation or tests.', requiresAny: ['test', 'typecheck', 'build', 'lint', 'smoke', 'validated', 'not run'], scorePenalty: 0.15 },
      { code: 'missing-file', severity: 'warn', message: 'Mention a file or code area.', requiresAny: ['.ts', '.js', '.json', '.md', '.html', '.css', 'src/', 'ui/', 'scripts/'], scorePenalty: 0.1 },
    ],
    examples: {
      good: 'Updated src/web/server.ts and ui/app.js, then ran npm test and npm run typecheck successfully.',
      bad: 'Done.',
    },
  },
  {
    profile: 'release-readiness',
    label: 'Release Readiness',
    description: 'Requires release version, asset, validation, and provenance language.',
    instructions: 'State the release version, asset or package, validation status, and provenance or digest details.',
    warnBelowScore: 0.85,
    failBelowScore: 0.65,
    checks: [
      { code: 'missing-release', severity: 'fail', message: 'Mention the release.', requiresAny: ['release', 'version', 'tag'], scorePenalty: 0.25 },
      { code: 'missing-asset', severity: 'warn', message: 'Mention the release asset or package.', requiresAny: ['asset', 'zip', 'package', 'archive'], scorePenalty: 0.15 },
      { code: 'missing-provenance', severity: 'warn', message: 'Mention provenance, commit, digest, or SHA-256.', requiresAny: ['provenance', 'commit', 'digest', 'sha-256', 'sha256'], scorePenalty: 0.15 },
      { code: 'missing-validation', severity: 'fail', message: 'Mention validation status.', requiresAny: ['passed', 'failed', 'validation', 'ci', 'smoke'], scorePenalty: 0.25 },
    ],
    examples: {
      good: 'Release v0.1.12 passed CI and smoke checks. Asset ollama-agent-harness-v0.1.12.zip was published with SHA-256 provenance.',
      bad: 'The release is ready.',
    },
  },
  {
    profile: 'decision-brief',
    label: 'Decision Brief',
    description: 'Requires recommendation, alternatives, risk, and confidence.',
    instructions: 'Give a clear recommendation, name alternatives, state key risks, and include confidence.',
    warnBelowScore: 0.85,
    failBelowScore: 0.6,
    checks: [
      { code: 'missing-recommendation', severity: 'fail', message: 'Give a recommendation or conclusion.', requiresAny: ['recommend', 'conclusion', 'decision', 'choose'], scorePenalty: 0.25 },
      { code: 'missing-alternatives', severity: 'warn', message: 'Mention alternatives or options.', requiresAny: ['alternative', 'option', 'instead', 'tradeoff'], scorePenalty: 0.15 },
      { code: 'missing-risk', severity: 'warn', message: 'Mention risk or uncertainty.', requiresAny: ['risk', 'uncertain', 'unknown', 'confidence', 'assumption'], scorePenalty: 0.15 },
    ],
    examples: {
      good: 'Recommendation: choose option A. The main alternative is option B. Risk is migration complexity, so confidence is Medium.',
      bad: 'Option A is best.',
    },
  },
];

export interface OutputValidationProfileSuggestion {
  profile: BuiltInOutputValidationProfile;
  matched: boolean;
}

/**
 * Optional hints the caller can pass to disambiguate profile selection when
 * upstream classifiers (e.g. the mode classifier) already know the user's
 * intent. Keeps the suggester from re-deriving intent from a regex table that
 * is easy to fool with stray file paths or language keywords inside an
 * otherwise-analytical prompt.
 */
export interface OutputValidationProfileSuggestionOptions {
  /**
   * Intent hint from a higher-level classifier. When set to `'research'` or
   * `'maintain'` the suggester routes to the analytical profile regardless of
   * incidental code/factual keywords appearing in the prompt body.
   */
  modeHint?: 'chat' | 'build' | 'operate' | 'automate' | 'research' | 'maintain';
}

// Research/analysis intent. Kept narrow so it does not poach prompts that only
// happen to use one of these words in passing — anchored verbs at the start of
// a clause, plus the phrases the mode classifier uses for its own research
// rule. Acts as a defensive guard for callers that do not pass a modeHint.
const RESEARCH_INTENT_PATTERN = /(^|[.!?\n]\s*)(research|investigate|look up|find out|analyse|analyze)\b|\b(pros and cons|trade-?offs?|state of the art|literature review|what are the options|compare\s+\w+\s+(to|vs|against))\b/;

export function describeOutputValidationProfileSuggestion(
  input: string,
  fallback: OutputValidationProfile = 'oracle-prime',
  options: OutputValidationProfileSuggestionOptions = {},
): OutputValidationProfileSuggestion {
  const text = input.toLowerCase();
  const trimmed = text.trim();
  const fallbackProfile: BuiltInOutputValidationProfile = isBuiltInProfile(fallback) ? fallback : 'oracle-prime';
  // Very short or vague prompts carry no signal; do not infer coding/tooling intent from them.
  if (trimmed.length < 12 || /^(you decide|whatever|anything|surprise me|up to you|your choice|idk|dunno)\b/.test(trimmed)) {
    return { profile: fallbackProfile, matched: false };
  }
  // Authoritative mode hint wins over any keyword heuristic. RESEARCH/MAINTAIN
  // prompts produce analytical prose, not code-change summaries, so they must
  // not be graded against the coding-answer rubric even when the prompt body
  // mentions file paths, language names, or function/class.
  if (options.modeHint === 'research' || options.modeHint === 'maintain') {
    return { profile: 'oracle-prime', matched: true };
  }
  // Defensive guard for callers that do not pass a modeHint: if the prompt
  // carries a clear research/analysis intent, route to the analytical profile
  // before the code-signal regex has a chance to claim it.
  if (RESEARCH_INTENT_PATTERN.test(text)) return { profile: 'oracle-prime', matched: true };
  if (/\b(stdout|stderr|exit code|tool result|terminal output|command output|stack trace)\b/.test(text)) return { profile: 'tool-result-summary', matched: true };
  if (/\b(code|coding|implement|implemented|implementing|refactor|debug|typecheck|unit test|pull request|commit|typescript|javascript|python|\.ts|\.tsx|\.js|\.jsx|\.py|npm|yarn|pnpm|jest|eslint|compile|compiler|stack trace|function|class|method|api endpoint)\b/.test(text)) return { profile: 'coding-answer', matched: true };
  if (/\b(weather|today|current|latest|news|price|stock|who is|what is|when is|where is|source|according to|factual)\b/.test(text)) return { profile: 'factual-answer', matched: true };
  if (/\b(decision|strategy|risk|scenario|tradeoff|alternative|recommend|confidence|uncertainty|forecast|plan)\b/.test(text)) return { profile: 'oracle-prime', matched: true };
  return { profile: fallbackProfile, matched: false };
}

export function suggestOutputValidationProfile(
  input: string,
  fallback: OutputValidationProfile = 'oracle-prime',
  options: OutputValidationProfileSuggestionOptions = {},
): BuiltInOutputValidationProfile {
  return describeOutputValidationProfileSuggestion(input, fallback, options).profile;
}

export function validateOutput(
  content: string,
  profile: OutputValidationProfile = 'oracle-prime',
  customProfiles: CustomOutputValidationProfile[] = [],
): OutputValidationResult {
  const customProfile = customProfiles.find((candidate) => candidate.profile === profile);
  if (customProfile) return validateCustomOutput(content, customProfile);
  switch (profile) {
    case 'factual-answer':
      return validateFactualAnswer(content, profile);
    case 'coding-answer':
      return validateCodingAnswer(content, profile);
    case 'tool-result-summary':
      return validateToolResultSummary(content, profile);
    case 'oracle-prime':
    default:
      return validateOraclePrimeOutput(content, profile);
  }
}

export function parseOutputValidationProfile(value: unknown, customProfiles: CustomOutputValidationProfile[] = []): OutputValidationProfile | undefined {
  const candidate = String(value ?? '').trim();
  return OUTPUT_VALIDATION_PROFILES.some((profile) => profile.profile === candidate) || customProfiles.some((profile) => profile.profile === candidate)
    ? candidate as OutputValidationProfile
    : undefined;
}

export function getOutputValidationInstructions(profile: OutputValidationProfile, customProfiles: CustomOutputValidationProfile[] = []): string {
  const customProfile = customProfiles.find((candidate) => candidate.profile === profile);
  if (customProfile) return `Output validation profile: ${customProfile.profile}. ${customProfile.instructions}`;
  switch (profile) {
    case 'factual-answer':
      return 'Output validation profile: factual-answer. Give a direct answer, include the evidence or source basis used, and state uncertainty when facts may be incomplete or time-sensitive.';
    case 'coding-answer':
      return 'Output validation profile: coding-answer. Summarize the concrete code changes, name touched files when relevant, and state validation performed or why validation was not run.';
    case 'tool-result-summary':
      return 'Output validation profile: tool-result-summary. Summarize the tool or command outcome, include key output evidence, and clearly state success, warning, or failure.';
    case 'oracle-prime':
    default:
      return 'Output validation profile: oracle-prime. Format the final answer with these sections: REFRAME, TRANSPARENCY LOG, KEY VARIABLES, SCENARIO MAP, CAUSAL CHAIN, COUNTERFACTUAL PIVOT, CRITICAL UNCERTAINTIES, CONCLUSION / ACTION, CONFIDENCE, ORACLE EVOLUTION, and SESSION STATE.';
  }
}

export function withOutputValidationInstructions(systemPrompt: string, profile: OutputValidationProfile, customProfiles: CustomOutputValidationProfile[] = []): string {
  const marker = '--- Output Validation Contract ---';
  if (systemPrompt.includes(marker)) return systemPrompt;
  return `${systemPrompt}\n\n${marker}\n${getOutputValidationInstructions(profile, customProfiles)}`;
}

export function normalizeCustomOutputValidationProfiles(value: unknown): CustomOutputValidationProfile[] {
  return validateCustomOutputValidationProfiles(value).profiles;
}

export function validateCustomOutputValidationProfiles(value: unknown): CustomOutputValidationProfileValidation {
  const errors: CustomOutputValidationProfileError[] = [];
  const source = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { profiles?: unknown }).profiles)
      ? (value as { profiles: unknown[] }).profiles
      : [];
  if (!Array.isArray(value) && !(typeof value === 'object' && value !== null && Array.isArray((value as { profiles?: unknown }).profiles))) {
    errors.push({ path: 'profiles', message: 'Expected an array of profiles or an object with a profiles array.' });
  }
  const seen = new Set<string>();
  const profiles: CustomOutputValidationProfile[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const profile = normalizeCustomProfile(source[index], `profiles[${index}]`, errors);
    if (!profile) continue;
    if (seen.has(profile.profile)) {
      errors.push({ path: `profiles[${index}].profile`, message: `Duplicate custom profile id: ${profile.profile}.` });
      continue;
    }
    seen.add(profile.profile);
    profiles.push(profile);
  }
  return { profiles, errors };
}

function validateOraclePrimeOutput(content: string, profile: OutputValidationProfile): OutputValidationResult {
  const findings: OutputValidationFinding[] = [];
  const missingSections = ORACLE_REQUIRED_SECTIONS.filter((section) => !hasSection(content, section));

  for (const section of missingSections) {
    findings.push({ code: 'missing-section', severity: 'fail', message: `Missing required section: ${section}` });
  }

  const reframe = sectionContent(content, 'REFRAME');
  if (reframe && !/\[(DECISION|ANALYSIS)\]/.test(reframe)) {
    findings.push({ code: 'missing-reframe-label', severity: 'fail', message: 'REFRAME must include [DECISION] or [ANALYSIS].' });
  }

  const transparency = sectionContent(content, 'TRANSPARENCY LOG');
  if (transparency) {
    for (const rule of TRANSPARENCY_RULES) {
      if (!new RegExp(escapeRegExp(rule), 'i').test(transparency)) {
        findings.push({ code: 'missing-transparency-rule', severity: 'warn', message: `Transparency log omits ${rule}.` });
      }
    }
    if (!/\[(TRIGGERED|BYPASSED: [^\]]{1,40}|MISSED)\]/.test(transparency)) {
      findings.push({ code: 'invalid-transparency-status', severity: 'warn', message: 'Transparency log should mark each audited rule as triggered, bypassed, or missed.' });
    }
  }

  const scenario = sectionContent(content, 'SCENARIO MAP');
  if (scenario) {
    for (const label of ['Base', 'Bull', 'Bear', 'Black Swan']) {
      if (!new RegExp(escapeRegExp(label), 'i').test(scenario)) {
        findings.push({ code: 'missing-scenario', severity: 'fail', message: `Scenario map omits ${label}.` });
      }
    }
    const weights = [...scenario.matchAll(/(\d{1,3})\s*%/g)].map((match) => Number(match[1]));
    if (weights.length >= 4) {
      const total = weights.slice(0, 4).reduce((sum, value) => sum + value, 0);
      if (total < 90 || total > 110) {
        findings.push({ code: 'scenario-weight-sum', severity: 'warn', message: `First four scenario weights sum to ${total}%, expected roughly 100%.` });
      }
    } else {
      findings.push({ code: 'missing-scenario-weights', severity: 'warn', message: 'Scenario map should include probability weights.' });
    }
  }

  const confidence = sectionContent(content, 'CONFIDENCE');
  if (confidence && !/\b(High|Medium|Low)\b/.test(confidence)) {
    findings.push({ code: 'missing-confidence-rating', severity: 'fail', message: 'CONFIDENCE must state High, Medium, or Low.' });
  }

  const uncertainties = sectionContent(content, 'CRITICAL UNCERTAINTIES');
  if (uncertainties && !/\[(DATA|MODEL|VARIANCE|MOTIVATED|RIVAL)\]/.test(uncertainties)) {
    findings.push({ code: 'missing-uncertainty-class', severity: 'warn', message: 'Critical uncertainties should use at least one required uncertainty class.' });
  }

  const evolution = sectionContent(content, 'ORACLE EVOLUTION');
  if (evolution) {
    for (const field of ['DRIFT', 'GAP', 'PATCH']) {
      if (!new RegExp('`?' + escapeRegExp(field) + '`?\\s*:', 'i').test(evolution)) {
        findings.push({ code: 'missing-evolution-field', severity: 'fail', message: `ORACLE EVOLUTION omits ${field}.` });
      }
    }
  }

  const session = sectionContent(content, 'SESSION STATE');
  if (session) {
    for (const field of ['EVIDENCE REGISTER', 'WEIGHT LOG', 'ACTIVE MODE', 'STYLE NOTES']) {
      if (!new RegExp(escapeRegExp(field), 'i').test(session)) {
        findings.push({ code: 'missing-session-field', severity: 'fail', message: `SESSION STATE omits ${field}.` });
      }
    }
  }

  return completeValidationResult(profile, findings, missingSections);
}

function validateFactualAnswer(content: string, profile: OutputValidationProfile): OutputValidationResult {
  const findings: OutputValidationFinding[] = [];
  const normalized = content.trim();
  if (normalized.length < 20) {
    findings.push({ code: 'too-short', severity: 'fail', message: 'Factual answer is too short to be useful.' });
  }
  if (/\b(lorem ipsum|todo|tbd|placeholder)\b/i.test(normalized)) {
    findings.push({ code: 'placeholder-content', severity: 'fail', message: 'Factual answer contains placeholder content.' });
  }
  if (!/\b(source|according to|based on|from|evidence|observed|found|reported|data)\b/i.test(normalized)) {
    findings.push({ code: 'missing-evidence-basis', severity: 'warn', message: 'Factual answer should mention its evidence or source basis.' });
  }
  if (!/\b(confidence|uncertain|likely|may|might|current|as of|today|latest|unknown)\b/i.test(normalized)) {
    findings.push({ code: 'missing-uncertainty', severity: 'warn', message: 'Factual answer should state confidence or uncertainty when facts may change.' });
  }
  return completeValidationResult(profile, findings, []);
}

function validateCodingAnswer(content: string, profile: OutputValidationProfile): OutputValidationResult {
  const findings: OutputValidationFinding[] = [];
  const normalized = content.trim();
  if (!/\b(changed|added|updated|fixed|implemented|removed|refactored)\b/i.test(normalized)) {
    findings.push({ code: 'missing-change-summary', severity: 'fail', message: 'Coding answer should summarize concrete changes.' });
  }
  if (!/\b[\w./-]+\.(ts|tsx|js|jsx|json|md|py|ps1|cs|rs|go|java|css|html|yml|yaml)\b/i.test(normalized)) {
    findings.push({ code: 'missing-file-reference', severity: 'warn', message: 'Coding answer should reference changed files when applicable.' });
  }
  if (!/\b(test|tests|typecheck|build|lint|smoke|validated|validation|not run)\b/i.test(normalized)) {
    findings.push({ code: 'missing-validation-summary', severity: 'warn', message: 'Coding answer should state validation performed or why it was not run.' });
  }
  return completeValidationResult(profile, findings, []);
}

function validateToolResultSummary(content: string, profile: OutputValidationProfile): OutputValidationResult {
  const findings: OutputValidationFinding[] = [];
  const normalized = content.trim();
  if (normalized.length < 10) {
    findings.push({ code: 'too-short', severity: 'fail', message: 'Tool result summary is too short.' });
  }
  if (!/\b(pass|passed|success|succeeded|ok|complete|completed|fail|failed|error|warning|warn|exit code|not found)\b/i.test(normalized)) {
    findings.push({ code: 'missing-outcome', severity: 'fail', message: 'Tool result summary should state the outcome.' });
  }
  if (!/\b(output|result|reported|showed|returned|stdout|stderr|command|log|evidence)\b/i.test(normalized)) {
    findings.push({ code: 'missing-output-evidence', severity: 'warn', message: 'Tool result summary should include key output evidence.' });
  }
  return completeValidationResult(profile, findings, []);
}

function validateCustomOutput(content: string, profile: CustomOutputValidationProfile): OutputValidationResult {
  const findings: OutputValidationFinding[] = [];
  const normalized = content.toLowerCase();
  for (const check of profile.checks) {
    const severity = check.severity ?? 'warn';
    const finding = { code: check.code, severity, message: check.message, scorePenalty: check.scorePenalty };
    if (check.minLength !== undefined && content.trim().length < check.minLength) {
      findings.push(finding);
      continue;
    }
    if (check.maxLength !== undefined && content.trim().length > check.maxLength) {
      findings.push(finding);
      continue;
    }
    if (check.requiresAll?.some((term) => !normalized.includes(term.toLowerCase()))) {
      findings.push(finding);
      continue;
    }
    if (check.requiresAny && check.requiresAny.length > 0 && !check.requiresAny.some((term) => normalized.includes(term.toLowerCase()))) {
      findings.push(finding);
      continue;
    }
    if (check.forbidsAny?.some((term) => normalized.includes(term.toLowerCase()))) {
      findings.push(finding);
    }
  }
  return completeValidationResult(profile.profile, findings, [], { warnBelowScore: profile.warnBelowScore, failBelowScore: profile.failBelowScore });
}

function normalizeCustomProfile(value: unknown, path: string, errors: CustomOutputValidationProfileError[]): CustomOutputValidationProfile | null {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const profile = String(source.profile ?? '').trim();
  if (source !== value) errors.push({ path, message: 'Profile must be an object.' });
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(profile)) errors.push({ path: `${path}.profile`, message: 'Profile id must start with a lowercase letter and contain 3-64 lowercase letters, numbers, dots, underscores, or hyphens.' });
  if (OUTPUT_VALIDATION_PROFILES.some((builtIn) => builtIn.profile === profile)) errors.push({ path: `${path}.profile`, message: `Custom profile id cannot replace built-in profile: ${profile}.` });
  const checks = Array.isArray(source.checks)
    ? source.checks.map((check, index) => normalizeCustomCheck(check, `${path}.checks[${index}]`, errors)).filter((check): check is CustomOutputValidationCheck => Boolean(check))
    : [];
  if (!Array.isArray(source.checks)) errors.push({ path: `${path}.checks`, message: 'Checks must be an array.' });
  if (checks.length === 0) errors.push({ path: `${path}.checks`, message: 'At least one valid check is required.' });
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(profile) || OUTPUT_VALIDATION_PROFILES.some((builtIn) => builtIn.profile === profile) || checks.length === 0) return null;
  return {
    profile,
    label: String(source.label ?? profile).trim().slice(0, 80) || profile,
    description: String(source.description ?? 'Custom deterministic output validation profile.').trim().slice(0, 240),
    instructions: String(source.instructions ?? 'Satisfy the custom validation checks for this response.').trim().slice(0, 1000),
    checks,
    warnBelowScore: normalizeOptionalNumber(source.warnBelowScore, 0, 1, `${path}.warnBelowScore`, errors),
    failBelowScore: normalizeOptionalNumber(source.failBelowScore, 0, 1, `${path}.failBelowScore`, errors),
  };
}

function normalizeCustomCheck(value: unknown, path: string, errors: CustomOutputValidationProfileError[]): CustomOutputValidationCheck | null {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const code = String(source.code ?? '').trim();
  const message = String(source.message ?? '').trim();
  if (source !== value) errors.push({ path, message: 'Check must be an object.' });
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(code)) errors.push({ path: `${path}.code`, message: 'Check code must start with a lowercase letter and contain 2-64 lowercase letters, numbers, dots, underscores, or hyphens.' });
  if (!message) errors.push({ path: `${path}.message`, message: 'Check message is required.' });
  if (source.severity !== undefined && source.severity !== 'fail' && source.severity !== 'warn' && source.severity !== 'pass') errors.push({ path: `${path}.severity`, message: 'Severity must be pass, warn, or fail.' });
  const requiresAny = normalizeTerms(source.requiresAny, `${path}.requiresAny`, errors);
  const requiresAll = normalizeTerms(source.requiresAll, `${path}.requiresAll`, errors);
  const forbidsAny = normalizeTerms(source.forbidsAny, `${path}.forbidsAny`, errors);
  const minLength = normalizeOptionalInteger(source.minLength, 1, 200_000, `${path}.minLength`, errors);
  const maxLength = normalizeOptionalInteger(source.maxLength, 1, 200_000, `${path}.maxLength`, errors);
  const scorePenalty = normalizeOptionalNumber(source.scorePenalty, 0, 1, `${path}.scorePenalty`, errors);
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(code) || !message) return null;
  const severity = source.severity === 'fail' || source.severity === 'warn' || source.severity === 'pass' ? source.severity : 'warn';
  return {
    code,
    severity,
    message: message.slice(0, 240),
    requiresAny,
    requiresAll,
    forbidsAny,
    minLength,
    maxLength,
    scorePenalty,
  };
}

function normalizeTerms(value: unknown, path: string, errors: CustomOutputValidationProfileError[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'Expected an array of terms.' });
    return undefined;
  }
  if (value.some((term) => typeof term !== 'string')) errors.push({ path, message: 'Terms must be strings.' });
  const terms = Array.from(new Set(value.map((term) => String(term).trim()).filter(Boolean))).slice(0, 20);
  return terms.length > 0 ? terms : undefined;
}

function normalizeOptionalInteger(value: unknown, min: number, max: number, path: string, errors: CustomOutputValidationProfileError[]): number | undefined {
  if (value === undefined) return undefined;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) {
    errors.push({ path, message: `Expected a number from ${min} to ${max}.` });
    return undefined;
  }
  if (number < min || number > max) errors.push({ path, message: `Expected a number from ${min} to ${max}.` });
  return Math.min(max, Math.max(min, number));
}

function normalizeOptionalNumber(value: unknown, min: number, max: number, path: string, errors: CustomOutputValidationProfileError[]): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push({ path, message: `Expected a number from ${min} to ${max}.` });
    return undefined;
  }
  if (number < min || number > max) errors.push({ path, message: `Expected a number from ${min} to ${max}.` });
  return Math.min(max, Math.max(min, Math.round(number * 100) / 100));
}

function completeValidationResult(
  profile: OutputValidationProfile,
  findings: OutputValidationFinding[],
  missingSections: string[],
  thresholds: { warnBelowScore?: number; failBelowScore?: number } = {},
): OutputValidationResult {
  const failCount = findings.filter((finding) => finding.severity === 'fail').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const penalty = findings.reduce((sum, finding) => sum + (finding.scorePenalty ?? (finding.severity === 'fail' ? 0.15 : finding.severity === 'warn' ? 0.05 : 0)), 0);
  const score = Math.max(0, Math.round((1 - penalty) * 100) / 100);
  let status: OutputValidationStatus = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';
  if (thresholds.failBelowScore !== undefined && score < thresholds.failBelowScore) status = 'fail';
  else if (status === 'pass' && thresholds.warnBelowScore !== undefined && score < thresholds.warnBelowScore) status = 'warn';
  return { profile, status, score, findings: findings.map(withFindingSuggestion), missingSections };
}

function withFindingSuggestion(finding: OutputValidationFinding): OutputValidationFinding {
  if (finding.suggestion) return finding;
  return { ...finding, suggestion: suggestionForFinding(finding) };
}

function suggestionForFinding(finding: OutputValidationFinding): string {
  if (finding.code.includes('evidence') || finding.code.includes('source')) return 'Add the source, evidence basis, or tool result you used.';
  if (finding.code.includes('uncertainty') || finding.code.includes('confidence')) return 'State confidence, uncertainty, or what could change the answer.';
  if (finding.code.includes('validation') || finding.code.includes('tests')) return 'Mention the tests, build, smoke check, or why validation was not run.';
  if (finding.code.includes('file')) return 'Name the changed file, folder, or code area.';
  if (finding.code.includes('release') || finding.code.includes('asset') || finding.code.includes('provenance')) return 'Include the release version, asset name, commit, or SHA-256 digest.';
  if (finding.code.includes('scenario')) return 'Add Base, Bull, Bear, and Black Swan scenarios with rough percentages.';
  if (finding.code.includes('section')) return 'Add the missing section heading and a concise answer under it.';
  if (finding.code.includes('recommendation')) return 'State the recommended option or decision clearly.';
  if (finding.code.includes('alternative')) return 'Name at least one alternative or tradeoff.';
  if (finding.code.includes('risk')) return 'Add the main risk, assumption, or uncertainty.';
  if (finding.code.includes('short')) return 'Add enough detail for a reader to act on the answer.';
  return 'Revise the answer to satisfy this check.';
}

function isBuiltInProfile(profile: OutputValidationProfile): profile is BuiltInOutputValidationProfile {
  return OUTPUT_VALIDATION_PROFILES.some((candidate) => candidate.profile === profile);
}

function hasSection(content: string, section: string): boolean {
  return sectionHeadingLines(content).some((heading) => heading.section === section);
}

function sectionContent(content: string, section: string): string {
  const headings = sectionHeadingLines(content);
  const heading = headings.find((candidate) => candidate.section === section);
  if (!heading) return '';
  const nextHeading = headings.find((candidate) => candidate.start > heading.start);
  return content.slice(heading.contentStart, nextHeading?.start ?? content.length).trim();
}

function sectionHeadingLines(content: string): Array<{ section: string; start: number; contentStart: number }> {
  const headings: Array<{ section: string; start: number; contentStart: number }> = [];
  let offset = 0;
  for (const line of content.split(/\r?\n/)) {
    const section = ORACLE_REQUIRED_SECTIONS.find((candidate) => isSectionHeading(line, candidate));
    if (section) headings.push({ section, start: offset, contentStart: offset + line.length + 1 });
    offset += line.length + 1;
  }
  return headings;
}

function isSectionHeading(line: string, section: string): boolean {
  const index = line.toUpperCase().indexOf(section.toUpperCase());
  if (index < 0) return false;
  const before = line.slice(0, index);
  const after = line.slice(index + section.length).trimStart();
  if (/[A-Za-z0-9]/.test(before)) return false;
  if (/^[A-Za-z0-9]/.test(after)) return false;
  if (after.startsWith(':')) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
