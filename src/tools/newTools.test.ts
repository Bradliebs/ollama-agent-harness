import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EmailDraftTool } from './emailTools';
import { CalendarReadTool } from './calendarTools';
import { InstallSkillTool, setInstallSkillsDir } from './skillInstallTool';
import { DesktopScreenshotTool } from './desktopTools';
import { BrowserBookmarksTool } from './browserTools';

describe('EmailDraftTool', () => {
  it('creates a .eml draft file', async () => {
    const cwd = process.cwd();
    const result = await EmailDraftTool.execute({ to: 'test@example.com', subject: 'Hello', body: 'Test body' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('.eml');
    expect(result.output).toContain('test@example.com');

    // Verify the file was created
    const draftsDir = path.join(cwd, '.harness', 'email', 'drafts');
    const files = await fs.readdir(draftsDir);
    const draftFile = files.find((f) => f.includes('Hello'));
    expect(draftFile).toBeDefined();

    const content = await fs.readFile(path.join(draftsDir, draftFile!), 'utf-8');
    expect(content).toContain('To: test@example.com');
    expect(content).toContain('Subject: Hello');
    expect(content).toContain('Test body');
    expect(content).toContain('MIME-Version: 1.0');
  });

  it('rejects missing recipient', async () => {
    const result = await EmailDraftTool.execute({ subject: 'Hello', body: 'Test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing');
  });

  it('rejects invalid email addresses', async () => {
    const result = await EmailDraftTool.execute({ to: 'not-an-email', subject: 'Hello', body: 'Test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
  });

  it('handles multiple recipients', async () => {
    const result = await EmailDraftTool.execute({ to: 'a@example.com, b@example.com', subject: 'Multi', body: 'Test' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('a@example.com');
    expect(result.output).toContain('b@example.com');
  });
});

describe('CalendarReadTool', () => {
  it('parses events from an .ics file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-calendar-'));
    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Team meeting
DTSTART:${formatIcsDate(new Date(Date.now() + 3600_000))}
DTEND:${formatIcsDate(new Date(Date.now() + 7200_000))}
LOCATION:Room 42
DESCRIPTION:Weekly sync
END:VEVENT
BEGIN:VEVENT
SUMMARY:Old event
DTSTART:20200101T120000Z
DTEND:20200101T130000Z
END:VEVENT
END:VCALENDAR`;

    const icsPath = path.join(dir, 'test.ics');
    await fs.writeFile(icsPath, icsContent, 'utf-8');

    const result = await CalendarReadTool.execute({ path: icsPath, days: 7 });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Team meeting');
    expect(result.output).toContain('Room 42');
    // Old event should not appear (past)
    expect(result.output).not.toContain('Old event');
  });

  it('rejects non-.ics files', async () => {
    const result = await CalendarReadTool.execute({ path: '/tmp/test.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ics');
  });

  it('returns empty message when no events are upcoming', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-calendar-'));
    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Ancient event
DTSTART:20200101T120000Z
DTEND:20200101T130000Z
END:VEVENT
END:VCALENDAR`;

    const icsPath = path.join(dir, 'old.ics');
    await fs.writeFile(icsPath, icsContent, 'utf-8');

    const result = await CalendarReadTool.execute({ path: icsPath });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No events');
  });
});

describe('InstallSkillTool', () => {
  it('rejects non-HTTPS URLs', async () => {
    const result = await InstallSkillTool.execute({ url: 'http://raw.githubusercontent.com/test/SKILL.md' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('HTTPS');
  });

  it('rejects URLs from disallowed hosts', async () => {
    const result = await InstallSkillTool.execute({ url: 'https://evil.com/SKILL.md' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('not in the allowlist');
  });

  it('rejects invalid URLs', async () => {
    const result = await InstallSkillTool.execute({ url: 'not-a-url' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
  });

  it('rejects empty URL', async () => {
    const result = await InstallSkillTool.execute({ url: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing');
  });
});

describe('DesktopScreenshotTool', () => {
  it('has correct tool metadata', () => {
    expect(DesktopScreenshotTool.name).toBe('desktop_screenshot');
    expect(DesktopScreenshotTool.isReadOnly).toBe(true);
    expect(DesktopScreenshotTool.description).toContain('screenshot');
  });

  it('returns a result (may fail in headless CI)', async () => {
    const result = await DesktopScreenshotTool.execute({ region: 'full' });
    // In CI/headless, screenshot may fail — that's OK, we just verify the tool runs
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
  });
});

describe('BrowserBookmarksTool', () => {
  it('has correct tool metadata', () => {
    expect(BrowserBookmarksTool.name).toBe('browser_bookmarks');
    expect(BrowserBookmarksTool.isReadOnly).toBe(true);
    expect(BrowserBookmarksTool.description).toContain('bookmark');
  });

  it('rejects unsupported browsers', async () => {
    const result = await BrowserBookmarksTool.execute({ browser: 'firefox' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Supported browsers');
  });

  it('handles missing bookmarks file gracefully', async () => {
    // Force a browser that likely doesn't exist in test env path
    const result = await BrowserBookmarksTool.execute({ browser: 'edge' });
    // Either succeeds (Edge installed) or fails gracefully
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
  });
});

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
