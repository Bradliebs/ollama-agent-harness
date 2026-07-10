/**
 * Tests for morningPriority store + parser, plus the daily-brief integration.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getPriorityForToday,
  listRecentPriorities,
  loadMorningPriorityInputs,
  markPromptShown,
  parsePrioritySetCommand,
  setPriorityForToday,
  todayDate,
} from './morningPriority';
import { composeDailyBrief, type BriefInputs } from '../jarvis/dailyBrief';

function emptyBriefInputs(extra: Partial<BriefInputs> = {}): BriefInputs {
  return {
    asOf: '2026-05-23',
    windowDescription: 'since yesterday at 18:00',
    ambientSignals: [],
    pendingLearningCandidates: [],
    predictiveSuggestions: [],
    knowledgeGraph: { records: 0, entities: 0, edges: 0, facts: 0 } as BriefInputs['knowledgeGraph'],
    trustLadder: { capabilities: {} } as BriefInputs['trustLadder'],
    ...extra,
  };
}

describe('parsePrioritySetCommand', () => {
  it.each([
    ['priority: deploy v2 to prod', 'deploy v2 to prod'],
    ['Priority: ship the wiki', 'ship the wiki'],
    ['/priority finish the brief', 'finish the brief'],
    ['top priority: call the bank', 'call the bank'],
    ['TOP PRIORITY:   trim whitespace   ', 'trim whitespace'],
  ])('parses %p', (input, expected) => {
    expect(parsePrioritySetCommand(input)).toBe(expected);
  });

  it.each([
    'hello there',
    'priority is high but no colon and no body',
    '/priorityalsono',
    '',
  ])('rejects %p', (input) => {
    expect(parsePrioritySetCommand(input)).toBeNull();
  });
});

describe('morningPriority store', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'mp-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('sets, reads, and overwrites today\'s priority', async () => {
    const date = new Date('2026-05-23T09:00:00Z');
    await setPriorityForToday(workDir, 'deploy v2', date);
    const first = await getPriorityForToday(workDir, date);
    expect(first?.answer).toBe('deploy v2');
    expect(first?.setAt).toBeDefined();

    await setPriorityForToday(workDir, 'rollback v2', new Date('2026-05-23T14:00:00Z'));
    const second = await getPriorityForToday(workDir, date);
    expect(second?.answer).toBe('rollback v2');
  });

  it('markPromptShown records askedAt without clobbering existing answer', async () => {
    const date = new Date('2026-05-23T09:00:00Z');
    await setPriorityForToday(workDir, 'ship the wiki', date);
    await markPromptShown(workDir, date);
    const state = await getPriorityForToday(workDir, date);
    expect(state?.answer).toBe('ship the wiki');
    expect(state?.askedAt).toBeDefined();
  });

  it('listRecentPriorities returns newest-first up to the limit', async () => {
    await setPriorityForToday(workDir, 'A', new Date('2026-05-21T09:00:00Z'));
    await setPriorityForToday(workDir, 'B', new Date('2026-05-22T09:00:00Z'));
    await setPriorityForToday(workDir, 'C', new Date('2026-05-23T09:00:00Z'));
    const recent = await listRecentPriorities(workDir, 2);
    expect(recent.map((p) => p.answer)).toEqual(['C', 'B']);
  });

  it('todayDate returns YYYY-MM-DD', () => {
    expect(todayDate(new Date('2026-05-23T09:00:00Z'))).toMatch(/^2026-05-2[23]$/);
  });
});

describe('loadMorningPriorityInputs', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'mp-load-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('returns null when no priorities have ever been set', async () => {
    const result = await loadMorningPriorityInputs(workDir, new Date('2026-05-23T09:00:00Z'));
    expect(result).toBeNull();
  });

  it('returns today\'s answer plus recent priorities (excluding today)', async () => {
    await setPriorityForToday(workDir, 'yesterday-thing', new Date('2026-05-22T09:00:00Z'));
    await setPriorityForToday(workDir, 'today-thing', new Date('2026-05-23T09:00:00Z'));
    const result = await loadMorningPriorityInputs(workDir, new Date('2026-05-23T10:00:00Z'));
    expect(result?.forDate).toMatch(/^2026-05-2[23]$/);
    expect(result?.answer).toBe('today-thing');
    expect(result?.recentPriorities?.map((p) => p.answer)).toEqual(['yesterday-thing']);
  });
});

describe('composeDailyBrief — morningPriority integration', () => {
  it('renders the morning-priority block when answer is present', () => {
    const brief = composeDailyBrief(emptyBriefInputs({
      morningPriority: {
        forDate: '2026-05-23',
        answer: 'ship the wiki',
        recentPriorities: [
          { date: '2026-05-22', answer: 'fix the autonomy guard' },
        ],
      },
    }));
    expect(brief).toMatch(/🌅 Top priority for 2026-05-23/);
    expect(brief).toMatch(/> \*\*ship the wiki\*\*/);
    expect(brief).toMatch(/<details><summary>Recent priorities<\/summary>/);
    expect(brief).toMatch(/fix the autonomy guard/);
  });

  it('renders the "not set yet" hint when no answer present', () => {
    const brief = composeDailyBrief(emptyBriefInputs({
      morningPriority: { forDate: '2026-05-23' },
    }));
    expect(brief).toMatch(/Not set yet/);
    expect(brief).toMatch(/priority: <your top thing>/);
  });

  it('omits the morning-priority block when input is absent', () => {
    const brief = composeDailyBrief(emptyBriefInputs());
    expect(brief).not.toMatch(/Top priority for/);
  });
});

describe('scripts/morning-priority.js (the trigger file exists)', () => {
  it('the trigger script is present', () => {
    expect(existsSync(join(__dirname, '..', '..', 'scripts', 'morning-priority.js'))).toBe(true);
  });
});
