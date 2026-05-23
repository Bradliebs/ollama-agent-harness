/**
 * Tests for the unified slash-command router.
 */
import * as path from 'node:path';
import { routeSlashCommand } from './slashCommandRouter';

// These tests exercise the routing logic. The heavy-lifting modules
// (buildBlueprint, writeResearchReport, etc.) have their own suites.

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
