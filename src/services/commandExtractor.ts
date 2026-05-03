// Command Extractor — JSON-first structured command extraction and
// state transition validation for service commands.
//
// For service commands, extracts structured JSON from natural language.
// Validates the JSON before mutating service state.

export type ServiceCommandType =
  | 'add_task'
  | 'update_task'
  | 'close_task'
  | 'reopen_task'
  | 'add_note'
  | 'edit_note'
  | 'delete_note'
  | 'show_today'
  | 'show_open_tasks'
  | 'show_closed_tasks'
  | 'daily_review'
  | 'weekly_review'
  | 'set_reminder_time'
  | 'pause_reminders'
  | 'resume_reminders';

export interface ExtractedCommand {
  type: ServiceCommandType;
  title?: string;
  content?: string;
  task_id?: string;
  note_id?: string;
  due_date?: string;
  priority?: 'low' | 'normal' | 'high';
  reminder_time?: string;
  fields?: Record<string, unknown>;
}

export interface CommandExtractionResult {
  commands: ExtractedCommand[];
  raw_input: string;
  valid: boolean;
  errors: string[];
}

export interface StateTransitionEvent {
  event_id: string;
  service_id: string;
  command: ExtractedCommand;
  timestamp: string;
  success: boolean;
  error?: string;
  state_before_hash?: string;
  state_after_hash?: string;
}

// ─── Rule-based command extraction ──────────────────────────────────

interface CommandPattern {
  type: ServiceCommandType;
  pattern: RegExp;
  extract: (match: RegExpMatchArray, full: string) => Partial<ExtractedCommand>;
}

const COMMAND_PATTERNS: CommandPattern[] = [
  {
    type: 'add_task',
    pattern: /\badd\s+(?:a\s+)?task\s+(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => parseTaskFields(m[1]),
  },
  {
    type: 'close_task',
    pattern: /\bclose\s+(?:task\s+)?(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => ({ task_id: m[1].trim() }),
  },
  {
    type: 'reopen_task',
    pattern: /\breopen\s+(?:task\s+)?(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => ({ task_id: m[1].trim() }),
  },
  {
    type: 'update_task',
    pattern: /\bupdate\s+(?:task\s+)?(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => ({ task_id: m[1].trim() }),
  },
  {
    type: 'add_note',
    pattern: /\b(?:add\s+)?note\s+(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => ({ content: m[1].trim() }),
  },
  {
    type: 'edit_note',
    pattern: /\bedit\s+note\s+(\S+)\s+(.+?)(?:\s+and\s+|$)/i,
    extract: (m) => ({ note_id: m[1].trim(), content: m[2].trim() }),
  },
  {
    type: 'delete_note',
    pattern: /\bdelete\s+note\s+(\S+)/i,
    extract: (m) => ({ note_id: m[1].trim() }),
  },
  {
    type: 'show_today',
    pattern: /\b(show\s+today|today)\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'show_open_tasks',
    pattern: /\b(show\s+)?open\s+tasks\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'show_closed_tasks',
    pattern: /\b(show\s+)?closed\s+tasks\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'daily_review',
    pattern: /\bdaily\s+review\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'weekly_review',
    pattern: /\bweekly\s+review\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'set_reminder_time',
    pattern: /\bset\s+reminder\s+(?:time\s+)?(?:to\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    extract: (m) => ({ reminder_time: m[1].trim() }),
  },
  {
    type: 'pause_reminders',
    pattern: /\bpause\s+reminders\s*$/i,
    extract: () => ({}),
  },
  {
    type: 'resume_reminders',
    pattern: /\bresume\s+reminders\s*$/i,
    extract: () => ({}),
  },
];

function parseTaskFields(raw: string): Partial<ExtractedCommand> {
  const result: Partial<ExtractedCommand> = { title: raw.trim() };

  // Extract due date
  const dueMatch = raw.match(/\b(?:due|by|on|tomorrow|today)\b/i);
  if (dueMatch) {
    if (/\btomorrow\b/i.test(raw)) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      result.due_date = tomorrow.toISOString().split('T')[0];
      result.title = raw.replace(/\btomorrow\b/i, '').trim();
    } else if (/\btoday\b/i.test(raw)) {
      result.due_date = new Date().toISOString().split('T')[0];
      result.title = raw.replace(/\btoday\b/i, '').trim();
    }
    const dateMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) {
      result.due_date = dateMatch[1];
      result.title = raw.replace(dateMatch[0], '').trim();
    }
  }

  // Extract priority
  const priorityMatch = raw.match(/\b(high|low|normal)\s+priority\b/i) ?? raw.match(/\bpriority\s+(high|low|normal)\b/i);
  if (priorityMatch) {
    result.priority = priorityMatch[1].toLowerCase() as ExtractedCommand['priority'];
    result.title = (result.title ?? raw).replace(priorityMatch[0], '').trim();
  }

  // Clean up title
  result.title = (result.title ?? raw).replace(/\s{2,}/g, ' ').trim();
  return result;
}

// ─── Extractor ──────────────────────────────────────────────────────

export function extractCommands(message: string): CommandExtractionResult {
  const commands: ExtractedCommand[] = [];
  const errors: string[] = [];

  // Try to split on " and " for multi-command messages
  const segments = splitOnConjunction(message);

  for (const segment of segments) {
    let matched = false;
    for (const cp of COMMAND_PATTERNS) {
      const m = segment.match(cp.pattern);
      if (m) {
        const extracted = cp.extract(m, segment);
        commands.push({ type: cp.type, ...extracted });
        matched = true;
        break;
      }
    }
    if (!matched && segments.length === 1) {
      // Single segment with no match — try the whole message against all patterns
      // Don't error, just return empty
    }
  }

  return {
    commands,
    raw_input: message,
    valid: commands.length > 0 && errors.length === 0,
    errors,
  };
}

/** Try to parse a JSON command payload (from LLM output). */
export function parseJsonCommands(json: string): CommandExtractionResult {
  const errors: string[] = [];
  try {
    const parsed = JSON.parse(json) as { commands?: unknown[] };
    if (!parsed || !Array.isArray(parsed.commands)) {
      return { commands: [], raw_input: json, valid: false, errors: ['Expected { commands: [...] } structure.'] };
    }

    const commands: ExtractedCommand[] = [];
    for (const item of parsed.commands) {
      const validation = validateCommandShape(item);
      if (validation.valid) {
        commands.push(item as ExtractedCommand);
      } else {
        errors.push(...validation.errors);
      }
    }

    return { commands, raw_input: json, valid: commands.length > 0 && errors.length === 0, errors };
  } catch (err) {
    return { commands: [], raw_input: json, valid: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ─── Validation ─────────────────────────────────────────────────────

const VALID_COMMAND_TYPES = new Set<string>([
  'add_task', 'update_task', 'close_task', 'reopen_task',
  'add_note', 'edit_note', 'delete_note',
  'show_today', 'show_open_tasks', 'show_closed_tasks',
  'daily_review', 'weekly_review',
  'set_reminder_time', 'pause_reminders', 'resume_reminders',
]);

function validateCommandShape(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { valid: false, errors: ['Command must be an object.'] };
  }
  const cmd = value as Record<string, unknown>;
  if (!cmd.type || typeof cmd.type !== 'string') {
    errors.push('Command must have a "type" field.');
  } else if (!VALID_COMMAND_TYPES.has(cmd.type)) {
    errors.push(`Unknown command type: ${cmd.type}`);
  }

  // Type-specific validation
  if (cmd.type === 'add_task' && (!cmd.title || typeof cmd.title !== 'string')) {
    errors.push('add_task requires a "title" field.');
  }
  if (cmd.type === 'add_note' && (!cmd.content || typeof cmd.content !== 'string')) {
    errors.push('add_note requires a "content" field.');
  }
  if (cmd.type === 'close_task' && !cmd.task_id && !cmd.title) {
    errors.push('close_task requires a "task_id" or "title" field.');
  }
  if (cmd.type === 'update_task' && !cmd.task_id && !cmd.title) {
    errors.push('update_task requires a "task_id" or "title" field.');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate a command before applying it to service state. */
export function validateStateTransition(command: ExtractedCommand, serviceId: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!VALID_COMMAND_TYPES.has(command.type)) {
    errors.push(`Unknown command type: ${command.type}`);
  }

  // Mutation commands need identifiers
  if (command.type === 'close_task' && !command.task_id && !command.title) {
    errors.push('close_task needs a task identifier.');
  }
  if (command.type === 'update_task' && !command.task_id && !command.title) {
    errors.push('update_task needs a task identifier.');
  }
  if (command.type === 'reopen_task' && !command.task_id && !command.title) {
    errors.push('reopen_task needs a task identifier.');
  }
  if (command.type === 'edit_note' && !command.note_id) {
    errors.push('edit_note needs a note identifier.');
  }
  if (command.type === 'delete_note' && !command.note_id) {
    errors.push('delete_note needs a note identifier.');
  }

  return { valid: errors.length === 0, errors };
}

/** Create a state transition event for logging. */
export function createTransitionEvent(
  serviceId: string,
  command: ExtractedCommand,
  success: boolean,
  error?: string,
): StateTransitionEvent {
  return {
    event_id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    service_id: serviceId,
    command,
    timestamp: new Date().toISOString(),
    success,
    error,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function splitOnConjunction(message: string): string[] {
  // Split on " and " only when it separates command-like segments
  const parts = message.split(/\band\b(?=\s+(?:add|close|update|reopen|note|edit|delete|show|daily|weekly|set|pause|resume)\b)/i);
  return parts.map((p) => p.trim()).filter(Boolean);
}
