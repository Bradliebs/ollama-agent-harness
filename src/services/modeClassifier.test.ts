import { classifyMode } from './modeClassifier';
import type { HarnessMode } from './modeClassifier';

describe('modeClassifier', () => {
  // ─── OPERATE mode ─────────────────────────────────────────────
  it('classifies bullet journal request as operate', () => {
    const result = classifyMode('Create me a bullet journal where you send me daily reminders, I can add, update, close tasks and add notes');
    expect(result.mode).toBe('operate');
  });

  it('classifies reminder requests as operate', () => {
    expect(classifyMode('send me reminders every morning').mode).toBe('operate');
    expect(classifyMode('remind me daily to check tasks').mode).toBe('operate');
    expect(classifyMode('check in with me every day').mode).toBe('operate');
  });

  it('classifies task management requests as operate', () => {
    expect(classifyMode('keep track of my tasks and let me add notes').mode).toBe('operate');
    expect(classifyMode('let me add tasks and close tasks').mode).toBe('operate');
    expect(classifyMode('manage this for me').mode).toBe('operate');
  });

  it('classifies monitoring requests as operate', () => {
    expect(classifyMode('monitor this service and notify me if it breaks').mode).toBe('operate');
    expect(classifyMode('follow up with me weekly').mode).toBe('operate');
    expect(classifyMode('ask me every morning what I need to do').mode).toBe('operate');
  });

  // ─── BUILD mode ───────────────────────────────────────────────
  it('classifies explicit build requests as build', () => {
    expect(classifyMode('build an app that tracks my tasks').mode).toBe('build');
    expect(classifyMode('create a dashboard for sales data').mode).toBe('build');
    expect(classifyMode('write a script that processes CSV files').mode).toBe('build');
  });

  it('does not trigger build for ongoing service requests', () => {
    const result = classifyMode('send me daily reminders and let me update tasks');
    expect(result.mode).not.toBe('build');
  });

  it('suppresses operate in favour of build when software is explicitly requested', () => {
    const result = classifyMode('build an app that sends me daily reminders');
    expect(result.mode).toBe('build');
    expect(result.suppressedModes).toContain('operate');
  });

  // ─── AUTOMATE mode ───────────────────────────────────────────
  it('classifies automation requests as automate', () => {
    expect(classifyMode('automate the deployment pipeline').mode).toBe('automate');
    expect(classifyMode('schedule a workflow to run every night').mode).toBe('automate');
    expect(classifyMode('create a cron job for nightly backups').mode).toBe('automate');
  });

  // ─── RESEARCH mode ───────────────────────────────────────────
  it('classifies research requests as research', () => {
    expect(classifyMode('research the best database for this project').mode).toBe('research');
    expect(classifyMode('investigate why the test suite is slow').mode).toBe('research');
    expect(classifyMode('compare React vs Vue for this project').mode).toBe('research');
  });

  // ─── MAINTAIN mode ───────────────────────────────────────────
  it('classifies maintenance requests as maintain', () => {
    expect(classifyMode('maintain the server health checks').mode).toBe('maintain');
    expect(classifyMode('watch for errors in the production logs').mode).toBe('maintain');
    expect(classifyMode('alert me if the service goes down').mode).toBe('maintain');
  });

  // ─── CHAT mode ────────────────────────────────────────────────
  it('classifies questions as chat', () => {
    expect(classifyMode('what is the capital of France?').mode).toBe('chat');
    expect(classifyMode('how does async/await work?').mode).toBe('chat');
    expect(classifyMode('explain the difference between var and let').mode).toBe('chat');
  });

  it('defaults to chat for unrecognised input', () => {
    expect(classifyMode('hello there').mode).toBe('chat');
    expect(classifyMode('thanks').mode).toBe('chat');
  });

  // ─── Confidence ───────────────────────────────────────────────
  it('returns higher confidence when multiple patterns match the same mode', () => {
    const result = classifyMode('send me reminders and keep track of my tasks and notify me');
    expect(result.mode).toBe('operate');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  // ─── Suppression ─────────────────────────────────────────────
  it('does not suppress build when no operate triggers exist', () => {
    const result = classifyMode('build a REST API');
    expect(result.suppressedModes).toHaveLength(0);
  });

  // ─── All 6 modes are reachable ────────────────────────────────
  it('can classify all six modes', () => {
    const modes = new Set<HarnessMode>();
    modes.add(classifyMode('what time is it?').mode);
    modes.add(classifyMode('build a CLI tool').mode);
    modes.add(classifyMode('send me reminders every morning').mode);
    modes.add(classifyMode('automate the nightly ETL').mode);
    modes.add(classifyMode('research the state of the art in LLMs').mode);
    modes.add(classifyMode('maintain the server health checks').mode);
    expect(modes.size).toBe(6);
  });
});
