import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

// ─── Calendar read tool ─────────────────────────────────────────────
//
// Reads .ics (iCalendar) files and returns upcoming events. Read-only —
// does not modify calendar data.
//
// Capability: calendar-editing (gated, but this tool is read-only)
// Risk: low — reads local .ics files only

const MAX_ICS_SIZE = 5_000_000;

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

export const CalendarReadTool: Tool = {
  name: 'calendar_read',
  description: 'Read events from a local .ics (iCalendar) file. Returns upcoming events with dates, times, and descriptions. Read-only — does not modify the calendar. Requires calendar-editing capability grant.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a .ics file (absolute or project-relative)' },
      days: { type: 'number', description: 'Show events within this many days from now (default 30)' },
      limit: { type: 'number', description: 'Maximum events to return (default 20)' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = String(input.path ?? '').trim();
    if (!rawPath) return { success: false, output: 'Path to .ics file is required.', error: 'missing path' };

    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    if (!filePath.toLowerCase().endsWith('.ics')) {
      return { success: false, output: 'File must have a .ics extension.', error: 'not ics' };
    }

    const days = Math.min(365, Math.max(1, Number(input.days) || 30));
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_ICS_SIZE) {
        return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_ICS_SIZE}).`, error: 'too large' };
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const events = parseIcsEvents(content);
      const now = new Date();
      const cutoff = new Date(now.getTime() + days * 24 * 60 * 60_000);

      const upcoming = events
        .filter((e) => {
          const start = new Date(e.start);
          return start >= now && start <= cutoff;
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
        .slice(0, limit);

      if (upcoming.length === 0) {
        return { success: true, output: `No events found within the next ${days} days in ${path.basename(filePath)}.` };
      }

      const output = upcoming.map((e) => {
        const start = new Date(e.start);
        const lines = [
          `📅 ${e.summary}`,
          `   ${start.toLocaleDateString()} ${start.toLocaleTimeString()}${e.end ? ` — ${new Date(e.end).toLocaleTimeString()}` : ''}`,
        ];
        if (e.location) lines.push(`   📍 ${e.location}`);
        if (e.description) lines.push(`   ${e.description.slice(0, 200)}`);
        return lines.join('\n');
      }).join('\n\n');

      return {
        success: true,
        output: `Found ${upcoming.length} event(s) in the next ${days} days (${events.length} total in file):\n\n${output}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read calendar: ${msg}`, error: msg };
    }
  },
};

function parseIcsEvents(content: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const blocks = content.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0] || '';
    const summary = extractIcsField(block, 'SUMMARY');
    const dtstart = extractIcsField(block, 'DTSTART');
    const dtend = extractIcsField(block, 'DTEND');
    const location = extractIcsField(block, 'LOCATION');
    const description = extractIcsField(block, 'DESCRIPTION');

    if (summary && dtstart) {
      events.push({
        summary,
        start: parseIcsDate(dtstart),
        end: dtend ? parseIcsDate(dtend) : '',
        location: location || undefined,
        description: description ? unescapeIcs(description) : undefined,
      });
    }
  }

  return events;
}

function extractIcsField(block: string, field: string): string | null {
  // Handle both simple fields and those with parameters (e.g., DTSTART;VALUE=DATE:20260501)
  const regex = new RegExp(`^${field}(?:;[^:]*)?:(.*)`, 'm');
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

function parseIcsDate(value: string): string {
  // Handle formats: 20260501T120000Z, 20260501T120000, 20260501
  const cleaned = value.replace(/[^0-9TZ]/g, '');
  if (cleaned.length >= 15) {
    // Full datetime: 20260501T120000Z
    const year = cleaned.slice(0, 4);
    const month = cleaned.slice(4, 6);
    const day = cleaned.slice(6, 8);
    const hour = cleaned.slice(9, 11);
    const min = cleaned.slice(11, 13);
    const sec = cleaned.slice(13, 15);
    const isUtc = cleaned.endsWith('Z');
    return `${year}-${month}-${day}T${hour}:${min}:${sec}${isUtc ? 'Z' : ''}`;
  }
  if (cleaned.length >= 8) {
    // Date only: 20260501
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T00:00:00`;
  }
  return value;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\')
    .replace(/\\;/g, ';');
}
