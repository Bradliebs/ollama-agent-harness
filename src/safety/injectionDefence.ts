// Prompt injection defence — runtime scanner for user inputs.
//
// Runs deterministic pattern matching against incoming messages to detect
// common prompt injection techniques *before* they reach the model. No
// model calls — pure regex + heuristics so it adds < 1 ms of latency.
//
// Design choices:
//   - False-negative friendly: it is better to miss a subtle injection
//     than to block a legitimate request. The model's own alignment is
//     the primary defence; this layer is a tripwire.
//   - Three modes: `off`, `flag`, `block`.
//     • off   — pass-through, no scanning
//     • flag  — scan and annotate the message but allow it through
//     • block — reject the message entirely when a high-confidence
//               pattern matches
//   - Returns a detailed result so callers can log, surface warnings,
//     or gate further processing.

// ─── Types ──────────────────────────────────────────────────────────

export type InjectionDefenceMode = 'off' | 'flag' | 'block';

export type InjectionCategory =
  | 'role_override'       // "ignore previous instructions"
  | 'system_prompt_leak'  // "print your system prompt"
  | 'instruction_insert'  // tries to inject a new system/user message boundary
  | 'encoding_bypass'     // base64 / rot13 / hex encoding tricks
  | 'jailbreak'           // known jailbreak templates (DAN, etc.)
  | 'tool_abuse'          // instructs the agent to call dangerous tools
  | 'data_exfiltration';  // asks the agent to send data externally

export interface InjectionMatch {
  /** Which pattern triggered. */
  patternId: string;
  category: InjectionCategory;
  /** 0.0–1.0. Patterns ≥ 0.7 are high-confidence. */
  confidence: number;
  /** The substring that matched (trimmed to 120 chars). */
  matchedText: string;
}

export interface InjectionScanResult {
  /** Whether the message was scanned (false when mode = off). */
  scanned: boolean;
  /** Whether any patterns matched. */
  flagged: boolean;
  /** Whether the message should be blocked (only true when mode = block AND high-confidence match). */
  blocked: boolean;
  /** All matched patterns. */
  matches: InjectionMatch[];
  /** Summary string suitable for logging. */
  summary: string;
}

export interface InjectionDefenceOptions {
  mode?: InjectionDefenceMode;
  /** Confidence threshold for blocking (only in `block` mode). Default 0.7. */
  blockThreshold?: number;
  /** Extra patterns the caller wants to add on top of the built-in set. */
  extraPatterns?: InjectionPattern[];
}

export interface InjectionPattern {
  id: string;
  category: InjectionCategory;
  pattern: RegExp;
  confidence: number;
}

// ─── Built-in patterns ──────────────────────────────────────────────

const BUILTIN_PATTERNS: InjectionPattern[] = [
  // ── Role override ─────────────────────────────────────────────────
  {
    id: 'role.ignore_instructions',
    category: 'role_override',
    pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior|earlier|preceding)\s+(?:instructions?|rules?|guidelines?|directions?|constraints?)/i,
    confidence: 0.9,
  },
  {
    id: 'role.new_instructions',
    category: 'role_override',
    pattern: /(?:your\s+)?new\s+(?:instructions?|rules?|guidelines?|role)\s+(?:are|is|:|follow)/i,
    confidence: 0.85,
  },
  {
    id: 'role.you_are_now',
    category: 'role_override',
    pattern: /you\s+are\s+now\s+(?:a|an|the)\s+(?:different|new|uncensored|unrestricted|evil)/i,
    confidence: 0.85,
  },
  {
    id: 'role.forget_everything',
    category: 'role_override',
    pattern: /forget\s+(?:all|everything)\s+(?:you\s+)?(?:know|learned|were\s+told|about)/i,
    confidence: 0.8,
  },
  {
    id: 'role.act_as_if',
    category: 'role_override',
    pattern: /(?:act|behave|respond|pretend)\s+as\s+if\s+(?:you\s+)?(?:have|had|were)\s+no\s+(?:restrictions?|limits?|rules?|safety|filters?|guardrails?)/i,
    confidence: 0.85,
  },

  // ── System prompt leak ────────────────────────────────────────────
  {
    id: 'leak.print_system_prompt',
    category: 'system_prompt_leak',
    pattern: /(?:print|show|reveal|display|output|repeat|echo|dump|give\s+me)\s+(?:your\s+)?(?:entire\s+|full\s+|complete\s+)?(?:system\s+(?:prompt|message|instructions?)|initial\s+(?:prompt|instructions?))/i,
    confidence: 0.85,
  },
  {
    id: 'leak.what_is_system_prompt',
    category: 'system_prompt_leak',
    pattern: /what\s+(?:is|are|was|were)\s+(?:your\s+)?(?:system\s+(?:prompt|message|instructions?)|initial\s+(?:prompt|instructions?)|hidden\s+instructions?)/i,
    confidence: 0.7,
  },
  {
    id: 'leak.verbatim',
    category: 'system_prompt_leak',
    pattern: /(?:verbatim|word\s+for\s+word|exactly\s+as\s+written)\s+.*(?:system|prompt|instructions?)/i,
    confidence: 0.8,
  },

  // ── Instruction insertion ─────────────────────────────────────────
  {
    id: 'insert.fake_system',
    category: 'instruction_insert',
    pattern: /\[?\s*(?:SYSTEM|ADMIN|DEVELOPER|ROOT)\s*[:\]]\s*/i,
    confidence: 0.75,
  },
  {
    id: 'insert.end_of_prompt',
    category: 'instruction_insert',
    pattern: /---\s*(?:END|STOP)\s+(?:OF\s+)?(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?)\s*---/i,
    confidence: 0.9,
  },
  {
    id: 'insert.override_marker',
    category: 'instruction_insert',
    pattern: /(?:###\s*)?(?:OVERRIDE|OVERWRITE|SUPERSEDE|REPLACE)\s*(?:ALL|PREVIOUS|PRIOR)?\s*(?:INSTRUCTIONS?|RULES?|SYSTEM)/i,
    confidence: 0.85,
  },

  // ── Encoding bypass ───────────────────────────────────────────────
  {
    id: 'encoding.base64_instruction',
    category: 'encoding_bypass',
    pattern: /(?:decode|interpret|execute|follow|run)\s+(?:this\s+)?(?:base64|b64|encoded|rot13|hex)/i,
    confidence: 0.75,
  },

  // ── Jailbreak templates ───────────────────────────────────────────
  {
    id: 'jailbreak.dan',
    category: 'jailbreak',
    pattern: /\bDAN\b.*(?:do\s+anything\s+now|jailbr[eo]ak|unrestricted|no\s+(?:rules?|limits?|restrictions?))/i,
    confidence: 0.9,
  },
  {
    id: 'jailbreak.developer_mode',
    category: 'jailbreak',
    pattern: /(?:developer|dev|sudo|admin|root|maintenance)\s+mode\s+(?:enabled|activated|on|engaged)/i,
    confidence: 0.8,
  },
  {
    id: 'jailbreak.hypothetical',
    category: 'jailbreak',
    pattern: /(?:hypothetical(?:ly)?|in\s+(?:a\s+)?fiction(?:al)?|imagine|pretend)\s+.*(?:no\s+(?:rules?|restrictions?|safety)|could\s+do\s+anything|unrestricted)/i,
    confidence: 0.7,
  },

  // ── Tool abuse ────────────────────────────────────────────────────
  {
    id: 'tool.rm_rf',
    category: 'tool_abuse',
    pattern: /(?:rm\s+-rf\s+\/|del\s+\/s\s+\/q\s+c:\\|format\s+c:|rmdir\s+\/s\s+\/q)/i,
    confidence: 0.95,
  },
  {
    id: 'tool.curl_pipe_bash',
    category: 'tool_abuse',
    pattern: /curl\s+.*\|\s*(?:bash|sh|zsh|powershell|cmd)/i,
    confidence: 0.9,
  },
  {
    id: 'tool.reverse_shell',
    category: 'tool_abuse',
    pattern: /(?:reverse\s+shell|nc\s+-[el]|ncat\s+.*-e|bash\s+-i\s+>.*\/dev\/tcp)/i,
    confidence: 0.95,
  },

  // ── Data exfiltration ─────────────────────────────────────────────
  {
    id: 'exfil.send_to_url',
    category: 'data_exfiltration',
    pattern: /(?:send|post|upload|exfiltrate|forward|transmit)\s+(?:all\s+)?(?:the\s+)?(?:data|code|files?|secrets?|keys?|credentials?|tokens?|passwords?)\s+(?:to|at)\s+(?:https?:\/\/|ftp:\/\/)/i,
    confidence: 0.85,
  },
  {
    id: 'exfil.env_secrets',
    category: 'data_exfiltration',
    pattern: /(?:read|print|show|display|cat|type|echo)\s+(?:the\s+)?(?:\.env|\.env\.local|\.env\.production|secrets?\.json|credentials?\.json|\.aws\/credentials)/i,
    confidence: 0.8,
  },
];

// ─── Scanner ─────────────────────────────────────────────────────────

/**
 * Normalize a message to reduce unicode bypass techniques:
 * - Strips zero-width and invisible characters
 * - Normalizes unicode to NFC form
 * - Collapses repeated whitespace
 */
function normalizeForScanning(message: string): string {
  // Remove zero-width and invisible unicode chars
  // eslint-disable-next-line no-control-regex
  let normalized = message.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD\u034F\u115F\u1160\u17B4\u17B5\u3164\uFFA0]/g, '');
  // Normalize unicode (handles composed/decomposed forms)
  normalized = normalized.normalize('NFC');
  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized;
}

/**
 * Scan a user message for prompt injection patterns.
 * Returns a result object with all matches, flags, and a summary.
 */
export function scanForInjection(
  message: string,
  options: InjectionDefenceOptions = {},
): InjectionScanResult {
  const mode = options.mode ?? 'flag';
  const blockThreshold = options.blockThreshold ?? 0.7;

  if (mode === 'off') {
    return { scanned: false, flagged: false, blocked: false, matches: [], summary: '' };
  }

  // Normalize before scanning to resist unicode bypass techniques
  const normalizedMessage = normalizeForScanning(message);

  const patterns = [...BUILTIN_PATTERNS, ...(options.extraPatterns ?? [])];
  const matches: InjectionMatch[] = [];

  for (const { id, category, pattern, confidence } of patterns) {
    // Clone the regex to avoid mutating shared lastIndex on module-level constants
    const re = new RegExp(pattern.source, pattern.flags);
    const m = re.exec(normalizedMessage);
    if (m) {
      matches.push({
        patternId: id,
        category,
        confidence,
        matchedText: m[0].slice(0, 120),
      });
    }
  }

  const flagged = matches.length > 0;
  const highConfidence = matches.filter((m) => m.confidence >= blockThreshold);
  const blocked = mode === 'block' && highConfidence.length > 0;

  const summary = flagged
    ? `Injection scan: ${matches.length} pattern(s) matched [${matches.map((m) => m.patternId).join(', ')}].${blocked ? ' BLOCKED.' : ''}`
    : 'Injection scan: clean.';

  return { scanned: true, flagged, blocked, matches, summary };
}

/**
 * Sanitize a message by stripping known injection markers.
 * Best-effort mitigation — removes fake system/admin message boundaries.
 */
export function sanitizeMessage(message: string): string {
  let result = message;
  result = result.replace(/\[?\s*(?:SYSTEM|ADMIN|DEVELOPER|ROOT)\s*[:\]]\s*/gi, '');
  result = result.replace(/---\s*(?:END|STOP)\s+(?:OF\s+)?(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?)\s*---/gi, '');
  result = result.replace(/(?:###\s*)?(?:OVERRIDE|OVERWRITE|SUPERSEDE|REPLACE)\s*(?:ALL|PREVIOUS|PRIOR)?\s*(?:INSTRUCTIONS?|RULES?|SYSTEM)/gi, '');
  return result.trim();
}
