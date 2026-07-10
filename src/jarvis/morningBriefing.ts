// Morning Briefing
//
// Produces a short, scheduled "morning briefing" snapshot: the user writes a
// plain-English instruction (e.g. "weather for London, my next 3 calendar
// events, and 3 tech headlines") and this module runs it through the model
// (with web search) and returns ready-to-deliver text.
//
// Design notes:
//  - Pure and dependency-injected: the model runner (`runChat`) and the
//    calendar source (`calendar`) are passed in. This keeps the module fully
//    unit-testable and free of server/runtime coupling.
//  - Robust by construction: it never throws. A failing model run or calendar
//    read degrades to a short fallback message so the scheduler always has
//    something to deliver.
//  - The word cap is a safety net. The prompt also asks the model to stay
//    under the cap, but a verbose model can't blow past the delivery budget.

import type { BriefSnapshot } from './briefScheduler';

export interface BriefingCalendarEvent {
  /** Event start time. */
  start: Date;
  /** Short title for the event. */
  summary: string;
  /** Optional location string. */
  location?: string;
}

/** Runs a fully-composed prompt through the model (with web tools) and returns its text. */
export type BriefingChatRunner = (prompt: string) => Promise<string>;

/** Best-effort calendar source. May return events in any time range; this module filters/sorts. */
export type BriefingCalendarSource = () => Promise<BriefingCalendarEvent[]>;

export interface MorningBriefingOptions {
  /** The user's plain-English instruction for what the briefing should contain. */
  prompt: string;
  /** Soft + hard word cap on the delivered briefing. Default 150. */
  maxWords?: number;
  /** Max calendar events to include. Default 3. */
  maxEvents?: number;
  /** Runs the prompt through the model. Required. */
  runChat: BriefingChatRunner;
  /** Optional calendar source. Omitted or failing → the briefing simply has no agenda. */
  calendar?: BriefingCalendarSource;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_MAX_WORDS = 150;
const DEFAULT_MAX_EVENTS = 3;

/**
 * Builds a morning briefing snapshot. Never throws: model or calendar failures
 * degrade to a short fallback so the caller (scheduler) can always deliver.
 */
export async function buildMorningBriefing(opts: MorningBriefingOptions): Promise<BriefSnapshot> {
  const now = opts.now ? opts.now() : new Date();
  const maxWords = clampInt(opts.maxWords, DEFAULT_MAX_WORDS, 20, 1000);
  const maxEvents = clampInt(opts.maxEvents, DEFAULT_MAX_EVENTS, 1, 20);

  const agenda = await resolveAgenda(opts.calendar, now, maxEvents);
  const composed = composeBriefingPrompt({ prompt: opts.prompt, agenda, maxWords, now });

  let body: string;
  try {
    body = (await opts.runChat(composed)).trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    body = `Briefing could not be generated this time (${reason}).`;
  }
  if (!body) body = 'Briefing came back empty this time. Try again later.';

  const markdown = capWords(body, maxWords);
  return { generatedAt: now.toISOString(), markdown };
}

/**
 * Composes the full prompt sent to the model. Exported for testing and reuse.
 */
export function composeBriefingPrompt(input: {
  prompt: string;
  agenda: string | null;
  maxWords: number;
  now: Date;
}): string {
  const { prompt, agenda, maxWords, now } = input;
  const parts: string[] = [
    `You are preparing a short morning briefing for ${formatLocalDate(now)}.`,
    `User instruction: ${prompt}`,
  ];
  if (agenda) {
    parts.push(`The user's calendar has already been fetched for you. Use exactly these events — do not invent others:\n${agenda}`);
  }
  parts.push(
    'Use the web_search and web_read tools to gather any current facts the instruction asks for (weather, news, etc.). Do not state facts you have not looked up.',
  );
  parts.push(
    `Return only the finished briefing as plain text, ready to send to the user. Keep it under ${maxWords} words. No preamble, no sign-off, no markdown headings.`,
  );
  return parts.join('\n\n');
}

async function resolveAgenda(
  source: BriefingCalendarSource | undefined,
  now: Date,
  maxEvents: number,
): Promise<string | null> {
  if (!source) return null;
  let events: BriefingCalendarEvent[];
  try {
    events = await source();
  } catch {
    // Calendar unavailable → omit the agenda rather than fail the whole briefing.
    return null;
  }
  const upcoming = events
    .filter((e) => e.start instanceof Date && !Number.isNaN(e.start.getTime()) && e.start.getTime() >= now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, maxEvents);
  if (upcoming.length === 0) return 'No upcoming events on the calendar.';
  return upcoming
    .map((e) => `- ${formatLocalTime(e.start)} ${e.summary}${e.location ? ` (${e.location})` : ''}`)
    .join('\n');
}

function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatLocalTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatLocalDate(d: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
