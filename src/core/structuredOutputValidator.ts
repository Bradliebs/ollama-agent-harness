// Structured Output Validator — generic JSON schema validation for any model output.
//
// Extends the existing command extractor's JSON validation to cover
// all structured model outputs: tool call arguments, code generation
// metadata, analysis results, and planning outputs.

// ─── Types ──────────────────────────────────────────────────────────

export interface OutputSchema {
  /** Schema identifier for tracking. */
  id: string;
  /** Required top-level fields. */
  requiredFields?: string[];
  /** Fields that must be strings if present. */
  stringFields?: string[];
  /** Fields that must be arrays if present. */
  arrayFields?: string[];
  /** Fields that must be numbers if present. */
  numberFields?: string[];
  /** Fields that must be booleans if present. */
  booleanFields?: string[];
  /** Custom validator function. */
  custom?: (data: Record<string, unknown>) => string[];
}

export interface SchemaValidationResult {
  valid: boolean;
  schema_id: string;
  errors: string[];
  /** 0-1 score based on how many checks passed. */
  score: number;
}

// ─── Built-in schemas ───────────────────────────────────────────────

export const BUILTIN_SCHEMAS: Record<string, OutputSchema> = {
  tool_call: {
    id: 'tool_call',
    requiredFields: ['name'],
    stringFields: ['name'],
    custom: (data) => {
      const errors: string[] = [];
      if (data.name && typeof data.name === 'string' && data.name.length > 100) errors.push('Tool name exceeds 100 chars');
      return errors;
    },
  },
  service_command: {
    id: 'service_command',
    requiredFields: ['type'],
    stringFields: ['type'],
    custom: (data) => {
      const errors: string[] = [];
      const validTypes = ['add_task', 'update_task', 'close_task', 'reopen_task', 'add_note', 'edit_note', 'delete_note', 'show_today', 'show_open_tasks', 'show_closed_tasks', 'daily_review', 'weekly_review', 'set_reminder_time', 'pause_reminders', 'resume_reminders', 'show_status', 'record_observation'];
      if (data.type && typeof data.type === 'string' && !validTypes.includes(data.type)) {
        errors.push(`Unknown command type: ${data.type}. Valid: ${validTypes.join(', ')}`);
      }
      return errors;
    },
  },
  code_edit: {
    id: 'code_edit',
    requiredFields: ['path'],
    stringFields: ['path', 'old_string', 'new_string'],
    custom: (data) => {
      const errors: string[] = [];
      if (data.old_string !== undefined && data.new_string === undefined) errors.push('code_edit has old_string but no new_string');
      if (typeof data.path === 'string' && data.path.includes('..')) errors.push('Path contains traversal (..)');
      return errors;
    },
  },
  planning_output: {
    id: 'planning_output',
    requiredFields: ['steps'],
    arrayFields: ['steps'],
    custom: (data) => {
      const errors: string[] = [];
      if (Array.isArray(data.steps) && data.steps.length === 0) errors.push('Planning output has empty steps array');
      if (Array.isArray(data.steps) && data.steps.length > 50) errors.push('Planning output has > 50 steps (suspicious)');
      return errors;
    },
  },
  analysis_result: {
    id: 'analysis_result',
    requiredFields: ['summary'],
    stringFields: ['summary'],
    custom: (data) => {
      const errors: string[] = [];
      if (typeof data.summary === 'string' && data.summary.length < 10) errors.push('Analysis summary is too short (< 10 chars)');
      return errors;
    },
  },
  file_write: {
    id: 'file_write',
    requiredFields: ['path', 'content'],
    stringFields: ['path', 'content'],
    custom: (data) => {
      const errors: string[] = [];
      if (typeof data.path === 'string' && data.path.includes('..')) errors.push('Path contains traversal (..)');
      if (typeof data.content === 'string' && data.content.length > 5_000_000) errors.push('Content exceeds 5MB limit');
      return errors;
    },
  },
  bash: {
    id: 'bash',
    requiredFields: ['command'],
    stringFields: ['command'],
    custom: (data) => {
      const errors: string[] = [];
      const cmd = typeof data.command === 'string' ? data.command : '';
      if (cmd.length > 10_000) errors.push('Command exceeds 10K chars');
      // Flag common dangerous patterns
      const dangerous = ['rm -rf /', 'format c:', 'del /f /s /q c:', 'mkfs', ':(){:|:&};:'];
      for (const pattern of dangerous) {
        if (cmd.toLowerCase().includes(pattern)) errors.push(`Dangerous command pattern detected: ${pattern}`);
      }
      return errors;
    },
  },
  web_search: {
    id: 'web_search',
    requiredFields: ['query'],
    stringFields: ['query'],
    custom: (data) => {
      const errors: string[] = [];
      if (typeof data.query === 'string' && data.query.length > 500) errors.push('Search query exceeds 500 chars');
      if (typeof data.query === 'string' && data.query.length < 2) errors.push('Search query too short (< 2 chars)');
      return errors;
    },
  },
};

// ─── Validation ─────────────────────────────────────────────────────

/** Validate a parsed object against a schema. */
export function validateStructuredOutput(data: Record<string, unknown>, schema: OutputSchema): SchemaValidationResult {
  const errors: string[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  // Required fields
  if (schema.requiredFields) {
    for (const field of schema.requiredFields) {
      totalChecks++;
      if (data[field] === undefined || data[field] === null) {
        errors.push(`Missing required field: ${field}`);
      } else {
        passedChecks++;
      }
    }
  }

  // Type checks
  const typeChecks: Array<{ fields?: string[]; expected: string }> = [
    { fields: schema.stringFields, expected: 'string' },
    { fields: schema.arrayFields, expected: 'array' },
    { fields: schema.numberFields, expected: 'number' },
    { fields: schema.booleanFields, expected: 'boolean' },
  ];

  for (const { fields, expected } of typeChecks) {
    if (!fields) continue;
    for (const field of fields) {
      if (data[field] === undefined) continue; // optional field not present
      totalChecks++;
      const actual = expected === 'array' ? (Array.isArray(data[field]) ? 'array' : typeof data[field]) : typeof data[field];
      if (actual !== expected) {
        errors.push(`Field ${field} should be ${expected}, got ${actual}`);
      } else {
        passedChecks++;
      }
    }
  }

  // Custom validator
  if (schema.custom) {
    const customErrors = schema.custom(data);
    totalChecks += Math.max(1, customErrors.length);
    if (customErrors.length === 0) {
      passedChecks++;
    } else {
      errors.push(...customErrors);
    }
  }

  const score = totalChecks > 0 ? passedChecks / totalChecks : 1;

  return {
    valid: errors.length === 0,
    schema_id: schema.id,
    errors,
    score: Math.round(score * 100) / 100,
  };
}

/** Try to parse JSON from text and validate against a schema. */
export function parseAndValidate(text: string, schema: OutputSchema): { parsed: Record<string, unknown> | null; validation: SchemaValidationResult } {
  // Try to extract JSON from the text
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    return {
      parsed: null,
      validation: { valid: false, schema_id: schema.id, errors: ['No JSON found in output'], score: 0 },
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim()) as Record<string, unknown>;
    return { parsed, validation: validateStructuredOutput(parsed, schema) };
  } catch (err) {
    return {
      parsed: null,
      validation: { valid: false, schema_id: schema.id, errors: [`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`], score: 0 },
    };
  }
}

/** Auto-detect which schema to apply based on context. */
export function detectSchema(context: { toolName?: string; taskType?: string }): OutputSchema | null {
  if (context.toolName === 'file_edit') return BUILTIN_SCHEMAS.code_edit;
  if (context.toolName === 'file_write') return BUILTIN_SCHEMAS.file_write;
  if (context.toolName === 'bash') return BUILTIN_SCHEMAS.bash;
  if (context.toolName === 'web_search') return BUILTIN_SCHEMAS.web_search;
  if (context.taskType === 'plan') return BUILTIN_SCHEMAS.planning_output;
  if (context.taskType === 'summarize' || context.taskType === 'review') return BUILTIN_SCHEMAS.analysis_result;
  return null;
}
