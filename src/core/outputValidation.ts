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
}

export interface CustomOutputValidationProfile extends OutputValidationProfileInfo {
  instructions: string;
  checks: CustomOutputValidationCheck[];
}

export interface OutputValidationFinding {
  code: string;
  severity: OutputValidationStatus;
  message: string;
}

export interface OutputValidationResult {
  profile: OutputValidationProfile;
  status: OutputValidationStatus;
  score: number;
  findings: OutputValidationFinding[];
  missingSections: string[];
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
  const source = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { profiles?: unknown }).profiles)
      ? (value as { profiles: unknown[] }).profiles
      : [];
  return source.map(normalizeCustomProfile).filter((profile): profile is CustomOutputValidationProfile => Boolean(profile));
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
    if (check.minLength !== undefined && content.trim().length < check.minLength) {
      findings.push({ code: check.code, severity, message: check.message });
      continue;
    }
    if (check.maxLength !== undefined && content.trim().length > check.maxLength) {
      findings.push({ code: check.code, severity, message: check.message });
      continue;
    }
    if (check.requiresAll?.some((term) => !normalized.includes(term.toLowerCase()))) {
      findings.push({ code: check.code, severity, message: check.message });
      continue;
    }
    if (check.requiresAny && check.requiresAny.length > 0 && !check.requiresAny.some((term) => normalized.includes(term.toLowerCase()))) {
      findings.push({ code: check.code, severity, message: check.message });
      continue;
    }
    if (check.forbidsAny?.some((term) => normalized.includes(term.toLowerCase()))) {
      findings.push({ code: check.code, severity, message: check.message });
    }
  }
  return completeValidationResult(profile.profile, findings, []);
}

function normalizeCustomProfile(value: unknown): CustomOutputValidationProfile | null {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const profile = String(source.profile ?? '').trim();
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(profile)) return null;
  if (OUTPUT_VALIDATION_PROFILES.some((builtIn) => builtIn.profile === profile)) return null;
  const checks = Array.isArray(source.checks)
    ? source.checks.map(normalizeCustomCheck).filter((check): check is CustomOutputValidationCheck => Boolean(check))
    : [];
  if (checks.length === 0) return null;
  return {
    profile,
    label: String(source.label ?? profile).trim().slice(0, 80) || profile,
    description: String(source.description ?? 'Custom deterministic output validation profile.').trim().slice(0, 240),
    instructions: String(source.instructions ?? 'Satisfy the custom validation checks for this response.').trim().slice(0, 1000),
    checks,
  };
}

function normalizeCustomCheck(value: unknown): CustomOutputValidationCheck | null {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const code = String(source.code ?? '').trim();
  const message = String(source.message ?? '').trim();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(code) || !message) return null;
  const severity = source.severity === 'fail' || source.severity === 'warn' || source.severity === 'pass' ? source.severity : 'warn';
  return {
    code,
    severity,
    message: message.slice(0, 240),
    requiresAny: normalizeTerms(source.requiresAny),
    requiresAll: normalizeTerms(source.requiresAll),
    forbidsAny: normalizeTerms(source.forbidsAny),
    minLength: normalizeOptionalInteger(source.minLength, 1, 200_000),
    maxLength: normalizeOptionalInteger(source.maxLength, 1, 200_000),
  };
}

function normalizeTerms(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = Array.from(new Set(value.map((term) => String(term).trim()).filter(Boolean))).slice(0, 20);
  return terms.length > 0 ? terms : undefined;
}

function normalizeOptionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
}

function completeValidationResult(
  profile: OutputValidationProfile,
  findings: OutputValidationFinding[],
  missingSections: string[],
): OutputValidationResult {
  const failCount = findings.filter((finding) => finding.severity === 'fail').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const score = Math.max(0, Math.round((1 - ((failCount * 0.15) + (warnCount * 0.05))) * 100) / 100);
  const status: OutputValidationStatus = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';
  return { profile, status, score, findings, missingSections };
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
