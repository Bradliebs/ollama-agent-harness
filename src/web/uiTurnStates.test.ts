import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const turnStates = require(path.join(root, 'ui', 'turnStates.js')) as {
  classifyTurn: (outcome: { stopped?: boolean; failed?: boolean; doneReason?: string; hasText?: boolean }) => string | null;
  describeDetail: (state: string, doneReason?: string) => string;
};
const identityHealth = require(path.join(root, 'ui', 'identityHealth.js')) as {
  describe: (health: Record<string, unknown>) => { level: string; label: string; title: string } | null;
};

describe('ui turn states', () => {
  it('classifies how a turn ended', () => {
    expect(turnStates.classifyTurn({ hasText: true, doneReason: 'completed' })).toBeNull();
    expect(turnStates.classifyTurn({ stopped: true, failed: true, hasText: false })).toBe('cancelled');
    expect(turnStates.classifyTurn({ failed: true, hasText: true })).toBe('failed');
    expect(turnStates.classifyTurn({ doneReason: 'inactivity_timeout', hasText: true })).toBe('interrupted');
    expect(turnStates.classifyTurn({ doneReason: 'aborted', hasText: false })).toBe('interrupted');
    expect(turnStates.classifyTurn({ doneReason: 'completed', hasText: false })).toBe('empty');
  });

  it('explains an inactivity timeout specifically', () => {
    expect(turnStates.describeDetail('interrupted', 'inactivity_timeout')).toMatch(/stopped responding/);
  });
});

describe('ui identity health badge', () => {
  it('shows nothing for a healthy persona with no proposal', () => {
    expect(identityHealth.describe({ issue: null, proposalPending: false })).toBeNull();
  });

  it('escalates placeholder and missing personas as errors', () => {
    expect(identityHealth.describe({ issue: 'placeholder' })).toMatchObject({ level: 'error' });
    expect(identityHealth.describe({ issue: 'missing' })).toMatchObject({ level: 'error' });
  });

  it('warns about stale proposals and informs about fresh ones', () => {
    expect(identityHealth.describe({ issue: null, proposalPending: true, proposalStale: true })).toMatchObject({ level: 'warning', label: 'Outdated persona proposal' });
    expect(identityHealth.describe({ issue: null, proposalPending: true, proposalStale: false })).toMatchObject({ level: 'info' });
  });
});

describe('ui wiring for turn states and identity health', () => {
  const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf-8');
  const appJs = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf-8');
  const identityRoutes = fs.readFileSync(path.join(root, 'src', 'web', 'identityRoutes.ts'), 'utf-8');

  it('loads both modules before app.js', () => {
    const appIdx = indexHtml.indexOf('src="./app.js');
    expect(indexHtml.indexOf('src="./turnStates.js')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('src="./identityHealth.js')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('src="./turnStates.js')).toBeLessThan(appIdx);
    expect(indexHtml.indexOf('src="./identityHealth.js')).toBeLessThan(appIdx);
  });

  it('marks unfinished turns and interrupted chats with a Retry strip', () => {
    expect(appJs).toContain('classifyTurn({ stopped: responseStopped, failed: responseFailed, doneReason, hasText: Boolean(assistantText) })');
    expect(appJs).toContain("appendTurnState(lastEl, 'interrupted'");
    expect(appJs).toContain('function retryLastPrompt()');
  });

  it('serves the identity health endpoint', () => {
    expect(identityRoutes).toContain("router.get('/api/identity/health'");
  });
});
