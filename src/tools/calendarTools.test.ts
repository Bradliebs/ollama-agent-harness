import * as fs from 'fs/promises';
import * as path from 'path';
import { CalendarReadTool, CalendarWriteTool } from './calendarTools';

describe('CalendarWriteTool', () => {
  const tmpDir = path.join(process.cwd(), '.harness', 'test-calendar');
  const testFile = path.join(tmpDir, 'test.ics');

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new .ics file with an event', async () => {
    const result = await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Team standup',
      start: '2026-05-10T09:00:00',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Team standup');
    expect(result.output).toContain('Event created');

    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toContain('BEGIN:VCALENDAR');
    expect(content).toContain('BEGIN:VEVENT');
    expect(content).toContain('SUMMARY:Team standup');
    expect(content).toContain('END:VCALENDAR');
  });

  it('appends an event to an existing .ics file', async () => {
    // Create first event
    await CalendarWriteTool.execute({
      path: testFile,
      summary: 'First event',
      start: '2026-05-10T09:00:00',
    });

    // Append second event
    const result = await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Second event',
      start: '2026-05-11T14:00:00',
      location: 'Conference Room B',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toContain('SUMMARY:First event');
    expect(content).toContain('SUMMARY:Second event');
    expect(content).toContain('LOCATION:Conference Room B');
    // Should have exactly one VCALENDAR wrapper
    expect(content.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(content.match(/END:VCALENDAR/g)).toHaveLength(1);
    // Should have two VEVENTs
    expect(content.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('uses default 1-hour duration when end is omitted', async () => {
    const result = await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Quick meeting',
      start: '2026-05-10T10:00:00',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toContain('DTSTART:');
    expect(content).toContain('DTEND:');
  });

  it('includes description when provided', async () => {
    const result = await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Planning session',
      start: '2026-05-10T09:00:00',
      description: 'Discuss Q3 roadmap',
    });
    expect(result.success).toBe(true);

    const content = await fs.readFile(testFile, 'utf-8');
    expect(content).toContain('DESCRIPTION:Discuss Q3 roadmap');
  });

  it('rejects missing path', async () => {
    const result = await CalendarWriteTool.execute({
      summary: 'No path',
      start: '2026-05-10T09:00:00',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Path');
  });

  it('rejects missing summary', async () => {
    const result = await CalendarWriteTool.execute({
      path: testFile,
      start: '2026-05-10T09:00:00',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('summary');
  });

  it('rejects invalid start date', async () => {
    const result = await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Bad date',
      start: 'not-a-date',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Invalid start date');
  });

  it('rejects non-.ics files', async () => {
    const result = await CalendarWriteTool.execute({
      path: path.join(tmpDir, 'events.txt'),
      summary: 'Wrong format',
      start: '2026-05-10T09:00:00',
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('.ics');
  });
});

describe('CalendarReadTool', () => {
  const tmpDir = path.join(process.cwd(), '.harness', 'test-calendar-read');
  const testFile = path.join(tmpDir, 'read-test.ics');

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads events from a file created by CalendarWriteTool', async () => {
    // Create events using write tool
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    await CalendarWriteTool.execute({
      path: testFile,
      summary: 'Upcoming meeting',
      start: futureDate.toISOString(),
    });

    const result = await CalendarReadTool.execute({
      path: testFile,
      days: 30,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Upcoming meeting');
  });

  it('rejects missing path', async () => {
    const result = await CalendarReadTool.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain('Path');
  });

  it('rejects non-.ics file', async () => {
    const result = await CalendarReadTool.execute({ path: 'events.txt' });
    expect(result.success).toBe(false);
  });
});
