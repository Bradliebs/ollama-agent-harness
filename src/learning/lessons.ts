// Episodic lessons: what went wrong in earlier runs, derived from the run log
// (persistence/runLog.ts) without a model call, and recalled into similar
// later tasks.
//
// Lessons have to earn their place. Each time one is recalled, the next run
// is checked for the same failure: a lesson that keeps failing to prevent it
// is retired, and lessons that are not seen again go stale.

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { readRunEvents, type RunEvent } from '../persistence/runLog';
import { recordSkillOutcome } from '../extensibility/skillUsage';

export type LessonKind = 'blocked_source' | 'stuck' | 'unsupported_claims' | 'budget';

export interface Lesson {
  /** Stable key: "blocked:<domain>" or "<kind>:<task hash>". */
  id: string;
  kind: LessonKind;
  /** One line, rendered into the prompt when recalled. */
  text: string;
  /** Content words of the originating task, for similarity. */
  terms: string[];
  /** For blocked_source: the domain. */
  domain?: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  runIds: string[];
  recalled: number;
  helped: number;
  failedAgain: number;
  /** Why the lesson stopped being recalled, if it did. */
  retired?: string;
}

export interface LessonStore {
  version: 1;
  lessons: Lesson[];
}

export interface RunOutcome {
  runId: string;
  task: string;
  doneReason: string;
  /** Completed without being stuck, over budget or left with unsupported claims. */
  success: boolean;
  stuckSummary?: string;
  budgetExceeded: boolean;
  /** Undefined when no research verdict was recorded (nothing to judge). */
  unsupportedFigures?: string[];
  blockedDomains: Array<{ domain: string; status: string }>;
  skillsUsed: string[];
  recalledLessons: string[];
}

export type LessonsMode = 'off' | 'record' | 'recall';

const MAX_LESSONS = 300;
const BLOCKED_FRESH_DAYS = 30;
const LESSON_FRESH_DAYS = 120;
const SIMILARITY_THRESHOLD = 0.25;
const MAX_RENDER_CHARS = 900;
const WEB_READ_TOOLS = new Set(['web_read', 'web_fetch', 'browser_read', 'browser_navigate']);
const BLOCKED_PATTERN = /HTTP\s+(401|403|407|429|451|503)\b|\b(401|403|429)\b.*(forbidden|denied|blocked|too many)|forbidden|access denied|captcha|blocked by|bot protection/i;
const RESEARCH_CUE = /\b(price|prices|cost|buy|deal|cheapest|review|reviews|compare|best|news|latest|current|search|find|look up|research|stock|shop)\b/i;
const STOPWORDS = new Set('the and for with that this what which from have has are was were you your can could would should about into over than then them they their there here when where how why who will just also some any all out not but get give find tell show need want like make please current latest best more most much many very'.split(' '));

export function resolveLessonsMode(env = process.env.HARNESS_LESSONS): LessonsMode {
  const value = env?.trim().toLowerCase();
  if (value === 'off' || value === '0' || value === 'false') return 'off';
  if (value === 'recall' || value === 'on') return 'recall';
  return 'record';
}

export function taskTerms(text: string): string[] {
  const words = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[a-z0-9£$€][a-z0-9£$€.+-]{2,}/g) ?? [];
  return [...new Set(words.map((word) => word.replace(/[.+-]+$/, '')).filter((word) => word.length >= 3 && !STOPWORDS.has(word)))].slice(0, 30);
}

function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((term) => setB.has(term)).length;
  return shared / (new Set([...a, ...b]).size);
}

function taskKey(terms: string[]): string {
  return createHash('sha1').update([...terms].sort().slice(0, 12).join(' ')).digest('hex').slice(0, 10);
}

function shortTask(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

function domainOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** What happened in one recorded run, from its events alone. */
export function deriveRunOutcome(runId: string, events: readonly RunEvent[]): RunOutcome {
  const start = events.find((event) => event.kind === 'run_start');
  const end = [...events].reverse().find((event) => event.kind === 'run_end');
  const firstRequest = events.findIndex((event) => event.kind === 'model_request');
  const opening = (firstRequest >= 0 ? events.slice(0, firstRequest) : events)
    .filter((event) => event.kind === 'messages' || event.kind === 'compaction')
    .flatMap((event) => (Array.isArray(event.data.messages) ? event.data.messages : []))
    .map(asRecord)
    .filter((message): message is Record<string, unknown> => Boolean(message) && message?.role === 'user' && typeof message?.content === 'string');
  const task = String(opening[opening.length - 1]?.content ?? '');
  const doneReason = String(end?.data.reason ?? 'incomplete');

  const supervisorEvents = events.filter((event) => event.kind === 'supervisor');
  const askedHuman = supervisorEvents.filter((event) => event.data.stage === 'ask_human');
  const stuck = doneReason === 'stuck_needs_human' || askedHuman.length > 0;
  const stuckSummary = stuck ? String((askedHuman[askedHuman.length - 1] ?? supervisorEvents[supervisorEvents.length - 1])?.data.summary ?? '') : undefined;
  const budgetExceeded = doneReason === 'budget_synthesized' || supervisorEvents.some((event) => event.data.event === 'budget_exceeded');

  const verdicts = events.filter((event) => event.kind === 'verdict' && event.data.check === 'research_claims');
  const lastVerdict = verdicts[verdicts.length - 1];
  const unsupportedFigures = lastVerdict
    ? (Array.isArray(lastVerdict.data.unsupported) ? lastVerdict.data.unsupported : [])
      .flatMap((entry) => (Array.isArray(asRecord(entry)?.missing) ? asRecord(entry)?.missing as unknown[] : []))
      .map(String)
    : undefined;

  const callsByStep = new Map<string, Record<string, unknown>>();
  const skillsUsed = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    if (event.stepId) callsByStep.set(event.stepId, event.data);
    const input = asRecord(event.data.input);
    if (event.data.name === 'skill' && typeof input?.name === 'string') skillsUsed.add(input.name);
  }
  const blocked = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'tool_result' || event.data.success !== false || !WEB_READ_TOOLS.has(String(event.data.name))) continue;
    const text = `${String(event.data.output ?? '')} ${String(event.data.error ?? '')}`;
    if (!BLOCKED_PATTERN.test(text)) continue;
    const call = event.stepId ? callsByStep.get(event.stepId) : undefined;
    const domain = domainOf(asRecord(call?.input)?.url);
    if (!domain) continue;
    const status = text.match(/\b(401|403|407|429|451|503)\b/)?.[1];
    blocked.set(domain, status ? `HTTP ${status}` : 'blocked');
  }

  const recalled = asRecord(start?.data)?.lessons;
  return {
    runId,
    task,
    doneReason,
    success: doneReason === 'completed' && !stuck && !budgetExceeded && (unsupportedFigures?.length ?? 0) === 0,
    ...(stuckSummary !== undefined ? { stuckSummary } : {}),
    budgetExceeded,
    ...(unsupportedFigures ? { unsupportedFigures } : {}),
    blockedDomains: [...blocked].map(([domain, status]) => ({ domain, status })),
    skillsUsed: [...skillsUsed],
    recalledLessons: Array.isArray(recalled) ? recalled.map(String) : [],
  };
}

/** New lessons a run teaches, before merging into the store. */
export function deriveLessons(outcome: RunOutcome, now = new Date()): Lesson[] {
  const iso = now.toISOString();
  const terms = taskTerms(outcome.task);
  const key = taskKey(terms);
  const make = (id: string, kind: LessonKind, text: string, extra: Partial<Lesson> = {}): Lesson => ({
    id, kind, text, terms, firstSeen: iso, lastSeen: iso, occurrences: 1, runIds: [outcome.runId], recalled: 0, helped: 0, failedAgain: 0, ...extra,
  });
  const lessons: Lesson[] = outcome.blockedDomains.map(({ domain, status }) => make(
    `blocked:${domain}`,
    'blocked_source',
    `${domain} refused automated reading (${status})`,
    { domain, terms: taskTerms(domain.replace(/\./g, ' ')) },
  ));
  if (!outcome.task.trim()) return lessons;
  const about = `A similar request ("${shortTask(outcome.task)}")`;
  if (outcome.stuckSummary !== undefined) {
    const detail = outcome.stuckSummary.replace(/^Recent attempts without new results:\s*/i, '').slice(0, 220);
    lessons.push(make(`stuck:${key}`, 'stuck', `${about} got stuck repeating ${detail || 'the same steps'}. Change approach early instead.`));
  }
  if (outcome.unsupportedFigures && outcome.unsupportedFigures.length > 0) {
    const figures = [...new Set(outcome.unsupportedFigures)].slice(0, 5).join(', ');
    lessons.push(make(`unsupported:${key}`, 'unsupported_claims', `${about} stated figures no page supported (${figures}). Read a source for each figure, or say it is unverified.`));
  }
  if (outcome.budgetExceeded) {
    lessons.push(make(`budget:${key}`, 'budget', `${about} ran out of budget before finishing. Plan the searches first and stop once the question is answered.`));
  }
  return lessons;
}

/** Did a recalled lesson prevent its failure in this run? Undefined = nothing to judge. */
function lessonHelped(lesson: Lesson, outcome: RunOutcome): boolean | undefined {
  switch (lesson.kind) {
    case 'blocked_source':
      return !outcome.blockedDomains.some((entry) => entry.domain === lesson.domain);
    case 'stuck':
      return outcome.stuckSummary === undefined;
    case 'budget':
      return !outcome.budgetExceeded;
    case 'unsupported_claims':
      return outcome.unsupportedFigures ? outcome.unsupportedFigures.length === 0 : undefined;
  }
}

/** Score recalled lessons against the run, then merge what it taught. Pure. */
export function applyRunOutcome(store: LessonStore, outcome: RunOutcome, now = new Date()): { store: LessonStore; added: Lesson[] } {
  const lessons = store.lessons.map((lesson) => ({ ...lesson, runIds: [...lesson.runIds], terms: [...lesson.terms] }));
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  for (const id of new Set(outcome.recalledLessons)) {
    const lesson = byId.get(id);
    if (!lesson) continue;
    lesson.recalled += 1;
    const helped = lessonHelped(lesson, outcome);
    if (helped === true) lesson.helped += 1;
    if (helped === false) lesson.failedAgain += 1;
    if (!lesson.retired && lesson.failedAgain >= 2 && lesson.failedAgain > lesson.helped) {
      lesson.retired = `recalled ${lesson.recalled} times; the same failure happened again ${lesson.failedAgain} times`;
    }
  }
  const added: Lesson[] = [];
  for (const fresh of deriveLessons(outcome, now)) {
    const existing = byId.get(fresh.id);
    if (existing) {
      existing.lastSeen = fresh.lastSeen;
      existing.occurrences += 1;
      existing.text = fresh.text;
      existing.runIds = [...existing.runIds.filter((runId) => runId !== outcome.runId), outcome.runId].slice(-5);
      continue;
    }
    lessons.push(fresh);
    byId.set(fresh.id, fresh);
    added.push(fresh);
  }
  lessons.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  return { store: { version: 1, lessons: lessons.slice(0, MAX_LESSONS) }, added };
}

function isFresh(lesson: Lesson, now: Date): boolean {
  const days = (now.getTime() - Date.parse(lesson.lastSeen)) / 86_400_000;
  return days <= (lesson.kind === 'blocked_source' ? BLOCKED_FRESH_DAYS : LESSON_FRESH_DAYS);
}

/** Lessons worth recalling for a new task: fresh, not retired, and relevant. */
export function recallLessons(store: LessonStore, task: string, now = new Date(), max = 4): Lesson[] {
  if (!task.trim()) return [];
  const live = store.lessons.filter((lesson) => !lesson.retired && isFresh(lesson, now));
  const terms = taskTerms(task);
  const lower = task.toLowerCase();
  const research = RESEARCH_CUE.test(task);
  const blocked = live
    .filter((lesson) => lesson.kind === 'blocked_source' && lesson.domain)
    .filter((lesson) => research || lower.includes(String(lesson.domain).split('.')[0]))
    .slice(0, 3);
  const similar = live
    .filter((lesson) => lesson.kind !== 'blocked_source')
    .map((lesson) => ({ lesson, score: similarity(terms, lesson.terms) }))
    .filter((entry) => entry.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score || Date.parse(b.lesson.lastSeen) - Date.parse(a.lesson.lastSeen))
    .slice(0, 2)
    .map((entry) => entry.lesson);
  return [...blocked, ...similar].slice(0, max);
}

/** Prompt block for recalled lessons, labelled as coming from run history. */
export function renderLessons(lessons: Lesson[]): string {
  if (lessons.length === 0) return '';
  const blocked = lessons.filter((lesson) => lesson.kind === 'blocked_source');
  const lines = [
    ...(blocked.length > 0 ? [`- Sites that recently refused automated reading: ${blocked.map((lesson) => lesson.text.replace(' refused automated reading ', ' ')).join(', ')}. Prefer other sources for them.`] : []),
    ...lessons.filter((lesson) => lesson.kind !== 'blocked_source').map((lesson) => `- ${lesson.text}`),
  ];
  const block = ['## Lessons from earlier runs', 'These come from your own run history, not from the user. Use them only where they fit this request.', ...lines].join('\n');
  return block.length > MAX_RENDER_CHARS ? `${block.slice(0, MAX_RENDER_CHARS - 1)}…` : block;
}

function storePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'learning', 'lessons.json');
}

export async function loadLessons(projectDir: string): Promise<LessonStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(projectDir), 'utf-8')) as LessonStore;
    return parsed.version === 1 && Array.isArray(parsed.lessons) ? parsed : { version: 1, lessons: [] };
  } catch {
    return { version: 1, lessons: [] };
  }
}

/**
 * Learn from a finished run: score the lessons it recalled, add the lessons
 * it teaches, and record the outcome for each skill it used. Replays are
 * skipped because they are not real work.
 */
export async function learnFromRun(projectDir: string, runId: string, now = new Date()): Promise<{ outcome: RunOutcome; added: Lesson[] } | null> {
  if (runId.startsWith('replay-')) return null;
  const events = await readRunEvents(projectDir, runId);
  if (!events.some((event) => event.kind === 'run_end')) return null;
  const outcome = deriveRunOutcome(runId, events);
  const file = storePath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const added = await withFileLock(file, async () => {
    const result = applyRunOutcome(await loadLessons(projectDir), outcome, now);
    await atomicWriteFile(file, JSON.stringify(result.store, null, 2), { encoding: 'utf-8' });
    return result.added;
  });
  const skillSucceeded = outcome.doneReason === 'completed' && outcome.stuckSummary === undefined && !outcome.budgetExceeded;
  for (const skill of outcome.skillsUsed) await recordSkillOutcome(projectDir, skill, skillSucceeded, now);
  return { outcome, added };
}
