import { extractCommands, parseJsonCommands, validateStateTransition, createTransitionEvent } from './commandExtractor';

describe('commandExtractor', () => {
  // ─── Rule-based extraction ────────────────────────────────────
  it('extracts a single add_task command', () => {
    const result = extractCommands('add task call dentist tomorrow');
    expect(result.valid).toBe(true);
    expect(result.commands.length).toBe(1);
    expect(result.commands[0].type).toBe('add_task');
    expect(result.commands[0].title).toContain('call dentist');
    expect(result.commands[0].due_date).toBeDefined();
  });

  it('extracts multiple commands from a compound message', () => {
    const result = extractCommands('add task call dentist tomorrow and note I felt tired today');
    expect(result.commands.length).toBe(2);
    expect(result.commands[0].type).toBe('add_task');
    expect(result.commands[1].type).toBe('add_note');
    expect(result.commands[1].content).toContain('felt tired today');
  });

  it('extracts close_task command', () => {
    const result = extractCommands('close task abc123');
    expect(result.valid).toBe(true);
    expect(result.commands[0].type).toBe('close_task');
  });

  it('extracts show_today command', () => {
    const result = extractCommands('show today');
    expect(result.valid).toBe(true);
    expect(result.commands[0].type).toBe('show_today');
  });

  it('extracts pause/resume reminders', () => {
    expect(extractCommands('pause reminders').commands[0].type).toBe('pause_reminders');
    expect(extractCommands('resume reminders').commands[0].type).toBe('resume_reminders');
  });

  it('extracts daily and weekly review', () => {
    expect(extractCommands('daily review').commands[0].type).toBe('daily_review');
    expect(extractCommands('weekly review').commands[0].type).toBe('weekly_review');
  });

  // ─── JSON command parsing ────────────────────────────────────
  it('parses valid JSON commands', () => {
    const json = JSON.stringify({
      commands: [
        { type: 'add_task', title: 'Call dentist', due_date: 'tomorrow' },
        { type: 'add_note', content: 'Felt tired today' },
      ],
    });
    const result = parseJsonCommands(json);
    expect(result.valid).toBe(true);
    expect(result.commands.length).toBe(2);
  });

  it('rejects invalid JSON', () => {
    const result = parseJsonCommands('not json');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects commands with missing required fields', () => {
    const json = JSON.stringify({
      commands: [{ type: 'add_task' }], // missing title
    });
    const result = parseJsonCommands(json);
    expect(result.valid).toBe(false);
  });

  it('rejects unknown command types', () => {
    const json = JSON.stringify({
      commands: [{ type: 'launch_rockets', target: 'moon' }],
    });
    const result = parseJsonCommands(json);
    expect(result.valid).toBe(false);
  });

  // ─── State transition validation ─────────────────────────────
  it('validates state transition for add_task', () => {
    const result = validateStateTransition({ type: 'add_task', title: 'Test' }, 'bullet_journal');
    expect(result.valid).toBe(true);
  });

  it('rejects close_task without identifier', () => {
    const result = validateStateTransition({ type: 'close_task' }, 'bullet_journal');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('identifier');
  });

  it('validates before mutating state — JSON extraction validates before state mutation', () => {
    const json = JSON.stringify({
      commands: [
        { type: 'add_task', title: 'Valid task' },
        { type: 'close_task' }, // missing identifier
      ],
    });
    const result = parseJsonCommands(json);
    // The second command should fail validation
    expect(result.valid).toBe(false);
  });

  // ─── Transition event creation ────────────────────────────────
  it('creates transition events', () => {
    const event = createTransitionEvent('bullet_journal', { type: 'add_task', title: 'Test' }, true);
    expect(event.service_id).toBe('bullet_journal');
    expect(event.success).toBe(true);
    expect(event.timestamp).toBeDefined();
  });
});
