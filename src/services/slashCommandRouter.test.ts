/**
 * Tests for the unified slash-command router.
 */
import * as path from 'node:path';
import { routeSlashCommand, registerResearchHooks } from './slashCommandRouter';

// These tests exercise the routing logic. The heavy-lifting modules
// (buildBlueprint, writeResearchReport, etc.) have their own suites.

// Keep /research hermetic: return a fixed, offline search payload in the
// exact WebSearchTool output format (header line + two numbered results).
jest.mock('../tools/webSearchTool', () => ({
  WebSearchTool: {
    name: 'web_search',
    execute: jest.fn(async () => ({
      success: true,
      output:
        'Search results for "test subject":\n\n' +
        '1. **First Result**\n   https://example.com/a\n   Snippet A here\n\n' +
        '2. **Second Result**\n   https://example.com/b\n   Snippet B here',
    })),
  },
  WebReadTool: {
    name: 'web_read',
    execute: jest.fn(async (input: { url: string }) => ({
      success: true,
      output: `Content from ${input.url}:\n\nFull page text for ${input.url} — price £199, specs listed.`,
    })),
  },
}));

describe('slashCommandRouter', () => {
  const projectDir = path.resolve(__dirname, '..', '..');

  it('returns not-handled for plain messages', async () => {
    const r = await routeSlashCommand('hello world', projectDir);
    expect(r.handled).toBe(false);
  });

  it('/wiki with no args returns usage help', async () => {
    const r = await routeSlashCommand('/wiki', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/Usage/);
    expect(r.response).toMatch(/\/wiki/);
    expect(r.reason).toBe('wiki_usage');
  });

  it('/wiki with a non-existent path returns a clear error', async () => {
    const r = await routeSlashCommand('/wiki Z:\\does-not-exist.pdf', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/not found/i);
  });

  it('/research with no args returns usage help', async () => {
    const r = await routeSlashCommand('/research', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/Usage/);
    expect(r.reason).toBe('research_usage');
  });

  it('/research counts only real sources, not the search header', async () => {
    const r = await routeSlashCommand('/research test subject', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('research_built');
    // Two real results — the "Search results for ...:" header chunk must
    // NOT be parsed as a third bogus source.
    expect(r.eventPayload?.sources).toBe(2);
    expect(r.response).toMatch(/\*\*2\*\* sources cited/);
  });

  it('/research synthesises multiple findings when a model is wired', async () => {
    // Wire a fake model that returns structured JSON. parseSynthResult should
    // turn this into two ranked findings backed by the two mocked sources.
    const callModel = jest.fn(async (_prompt: string) =>
      JSON.stringify({
        oneLineAnswer: 'First Result is the best fit.',
        summary: 'Two candidates were compared against the question.',
        findings: [
          { label: 'Best overall', body: 'First Result wins on price.', confidence: 0.8, sources: [1] },
          { label: 'Runner-up', body: 'Second Result is a close alternative.', confidence: 0.6, sources: [2] },
        ],
      }),
    );
    registerResearchHooks({ callModel });

    const r = await routeSlashCommand('/research best option under budget', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('research_built');
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.eventPayload?.sources).toBe(2);
    // Both mocked sources have URLs, so both pages are deep-read and fed in.
    expect(r.eventPayload?.pagesRead).toBe(2);
    expect(callModel.mock.calls[0][0]).toMatch(/full page content/);
    expect(r.response).toMatch(/Read the full content/i);
    // Two model-produced findings (not the single collapsed stub finding).
    expect(r.response).toMatch(/\*\*2\*\* findings/);
    expect(r.response).toMatch(/analysed by the model/i);
  });

  it('/memory-wiki triggers the memory wiki handler', async () => {
    // Will likely produce 0 entries on a clean checkout — that's fine,
    // the important thing is it routes correctly and doesn't crash.
    const r = await routeSlashCommand('/memory-wiki', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toMatch(/memory_wiki/);
  });

  it('/kanban with no args shows the board', async () => {
    const r = await routeSlashCommand('/kanban', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/Kanban Board/);
    expect(r.reason).toBe('kanban_board');
  });

  it('/kanban move with an invalid task returns an error', async () => {
    const r = await routeSlashCommand('/kanban move nonexistent-id-999 triage', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/not found/i);
  });

  it('/kanban with gibberish args returns usage help', async () => {
    const r = await routeSlashCommand('/kanban xyzzy', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/Usage/);
  });

  it('/brief generates a brief', async () => {
    const r = await routeSlashCommand('/brief', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/Daily Brief/);
    expect(r.reason).toBe('daily_brief');
  });

  it('unrecognised /commands fall through', async () => {
    const r = await routeSlashCommand('/nonexistent', projectDir);
    expect(r.handled).toBe(false);
  });

  it('/yolo help returns usage info', async () => {
    const r = await routeSlashCommand('/yolo help', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/full-send/i);
    expect(r.response).toMatch(/dontAsk/);
    expect(r.reason).toBe('yolo_usage');
  });

  it('/yolo without hooks returns an error', async () => {
    // Hooks not registered in test — should explain that
    const r = await routeSlashCommand('/yolo', projectDir);
    expect(r.handled).toBe(true);
    expect(r.response).toMatch(/not wired/i);
  });
});
