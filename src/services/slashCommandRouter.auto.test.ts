/**
 * Tests for the `/auto` autonomous lead-agent slash command.
 */
import { routeSlashCommand, registerLeadAgentHooks, type LeadAgentRunSummary } from './slashCommandRouter';

const projectDir = process.cwd();

describe('/auto slash command', () => {
  it('returns usage info for `/auto help`', async () => {
    const r = await routeSlashCommand('/auto help', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('auto_usage');
    expect(r.response).toMatch(/autonomous lead agent/i);
  });

  it('returns usage info for bare `/auto`', async () => {
    const r = await routeSlashCommand('/auto', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('auto_usage');
  });

  it('errors clearly when hooks are not wired', async () => {
    const r = await routeSlashCommand('/auto build a thing', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('auto_error');
    expect(r.response).toMatch(/not wired/i);
  });

  it('runs the lead agent and summarises the outcome once wired', async () => {
    const summary: LeadAgentRunSummary = {
      status: 'completed',
      finalOutput: 'built the API',
      attempts: 2,
      capabilityGaps: [],
    };
    const run = jest.fn(async () => summary);
    registerLeadAgentHooks({ run });

    const r = await routeSlashCommand('/auto build a todo API', projectDir);
    expect(run).toHaveBeenCalledWith('build a todo API');
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('auto_done');
    expect(r.response).toMatch(/completed/i);
    expect(r.response).toContain('built the API');
    expect(r.response).toMatch(/2 attempt/);
  });

  it('surfaces capability gaps in the summary', async () => {
    registerLeadAgentHooks({
      run: async () => ({
        status: 'completed_with_failures',
        finalOutput: '',
        attempts: 1,
        capabilityGaps: [{ need: 'browser', reason: 'needed a browser tool' }],
      }),
    });
    const r = await routeSlashCommand('/auto scrape a site', projectDir);
    expect(r.response).toMatch(/capability gaps/i);
    expect(r.response).toContain('browser');
  });

  it('reports a failed run without throwing', async () => {
    registerLeadAgentHooks({ run: async () => { throw new Error('model offline'); } });
    const r = await routeSlashCommand('/auto do something', projectDir);
    expect(r.handled).toBe(true);
    expect(r.reason).toBe('auto_error');
    expect(r.response).toMatch(/model offline/);
  });
});
