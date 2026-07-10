import { buildMorningBriefing, composeBriefingPrompt, type BriefingCalendarEvent } from './morningBriefing';

const fixedNow = () => new Date('2026-05-06T06:30:00');

describe('buildMorningBriefing', () => {
  it('returns a snapshot whose generatedAt reflects the injected clock', async () => {
    const snap = await buildMorningBriefing({
      prompt: 'weather and news',
      runChat: async () => 'All clear.',
      now: fixedNow,
    });
    expect(snap.generatedAt).toBe(new Date('2026-05-06T06:30:00').toISOString());
    expect(snap.markdown).toBe('All clear.');
  });

  it('passes the composed prompt (with instruction) to runChat', async () => {
    let seen = '';
    await buildMorningBriefing({
      prompt: 'London weather plus 3 tech headlines',
      runChat: async (p) => { seen = p; return 'ok'; },
      now: fixedNow,
    });
    expect(seen).toContain('London weather plus 3 tech headlines');
    expect(seen).toContain('web_search');
    expect(seen).toContain('under 150 words');
  });

  it('enforces the word cap as a safety net and appends an ellipsis', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const snap = await buildMorningBriefing({
      prompt: 'x',
      maxWords: 20,
      runChat: async () => longBody,
      now: fixedNow,
    });
    const words = snap.markdown.replace('…', '').split(/\s+/).filter(Boolean);
    expect(words).toHaveLength(20);
    expect(snap.markdown.endsWith('…')).toBe(true);
  });

  it('does not truncate output already within the cap', async () => {
    const snap = await buildMorningBriefing({
      prompt: 'x',
      maxWords: 50,
      runChat: async () => 'short and sweet',
      now: fixedNow,
    });
    expect(snap.markdown).toBe('short and sweet');
  });

  it('omits the agenda block entirely when no calendar source is given', async () => {
    let seen = '';
    await buildMorningBriefing({
      prompt: 'news only',
      runChat: async (p) => { seen = p; return 'ok'; },
      now: fixedNow,
    });
    expect(seen).not.toContain('calendar has already been fetched');
  });

  it('includes upcoming events, sorted and limited to maxEvents', async () => {
    const events: BriefingCalendarEvent[] = [
      { start: new Date('2026-05-06T14:00:00'), summary: 'Afternoon sync' },
      { start: new Date('2026-05-06T09:00:00'), summary: 'Standup' },
      { start: new Date('2026-05-06T11:00:00'), summary: 'Design review', location: 'Room 2' },
      { start: new Date('2026-05-06T16:00:00'), summary: 'One too many' },
    ];
    let seen = '';
    await buildMorningBriefing({
      prompt: 'my day',
      maxEvents: 3,
      calendar: async () => events,
      runChat: async (p) => { seen = p; return 'ok'; },
      now: fixedNow,
    });
    expect(seen).toContain('09:00 Standup');
    expect(seen).toContain('11:00 Design review (Room 2)');
    expect(seen).toContain('14:00 Afternoon sync');
    expect(seen).not.toContain('One too many');
    // Ordering: Standup before Design review before Afternoon sync.
    expect(seen.indexOf('Standup')).toBeLessThan(seen.indexOf('Design review'));
    expect(seen.indexOf('Design review')).toBeLessThan(seen.indexOf('Afternoon sync'));
  });

  it('drops events that have already started', async () => {
    const events: BriefingCalendarEvent[] = [
      { start: new Date('2026-05-06T05:00:00'), summary: 'Already happened' },
      { start: new Date('2026-05-06T09:00:00'), summary: 'Still upcoming' },
    ];
    let seen = '';
    await buildMorningBriefing({
      prompt: 'my day',
      calendar: async () => events,
      runChat: async (p) => { seen = p; return 'ok'; },
      now: fixedNow,
    });
    expect(seen).toContain('Still upcoming');
    expect(seen).not.toContain('Already happened');
  });

  it('notes an empty agenda when the calendar returns no upcoming events', async () => {
    let seen = '';
    await buildMorningBriefing({
      prompt: 'my day',
      calendar: async () => [],
      runChat: async (p) => { seen = p; return 'ok'; },
      now: fixedNow,
    });
    expect(seen).toContain('No upcoming events on the calendar.');
  });

  it('degrades gracefully (still produces a briefing) when the calendar source throws', async () => {
    let seen = '';
    const snap = await buildMorningBriefing({
      prompt: 'my day',
      calendar: async () => { throw new Error('ics read failed'); },
      runChat: async (p) => { seen = p; return 'delivered anyway'; },
      now: fixedNow,
    });
    expect(seen).not.toContain('calendar has already been fetched');
    expect(snap.markdown).toBe('delivered anyway');
  });

  it('never throws when the model run fails — returns a fallback message', async () => {
    const snap = await buildMorningBriefing({
      prompt: 'x',
      runChat: async () => { throw new Error('ollama unreachable'); },
      now: fixedNow,
    });
    expect(snap.markdown).toContain('could not be generated');
    expect(snap.markdown).toContain('ollama unreachable');
  });

  it('returns a fallback when the model produces empty output', async () => {
    const snap = await buildMorningBriefing({
      prompt: 'x',
      runChat: async () => '   ',
      now: fixedNow,
    });
    expect(snap.markdown).toContain('came back empty');
  });
});

describe('composeBriefingPrompt', () => {
  it('includes the date, instruction, and word cap', () => {
    const out = composeBriefingPrompt({
      prompt: 'weather',
      agenda: null,
      maxWords: 120,
      now: new Date('2026-05-06T06:30:00'),
    });
    expect(out).toContain('Wednesday, 6 May 2026');
    expect(out).toContain('User instruction: weather');
    expect(out).toContain('under 120 words');
  });
});
