import * as fs from 'fs';
import * as path from 'path';

// Structural contract for the Jarvis Live panel render (refreshJarvisLive in
// ui/app.js). The panel is the always-visible single source of truth for the
// unified assistant surface, so a regression that dropped the profile row or
// the scheduler controls would silently hide the merge from users.
//
// Like permissionRecoveryUiContract.test.ts, this asserts the contract
// structurally (regex over the source) rather than booting a browser, because
// ui/app.js depends on DOM globals that are not available under Jest.

const appJsPath = path.join(__dirname, '..', '..', 'ui', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf-8');

describe('Jarvis Live panel render contract', () => {
  it('refreshJarvisLive reads the assistantProfile and schedulers status fields', () => {
    expect(appJs).toMatch(/async function refreshJarvisLive\(\)/);
    expect(appJs).toMatch(/status\.assistantProfile\s*\|\|\s*\{\}/);
    expect(appJs).toMatch(/status\.schedulers\s*\|\|\s*\[\]/);
  });

  it('renders the assistant-profile row with the proactive variant', () => {
    // The proactive tier must be visually distinct from the plain assistant
    // profile so an operator can tell standing autonomy is on.
    expect(appJs).toMatch(/🧩 Assistant profile/);
    expect(appJs).toMatch(/profile\.proactive\s*\?/);
    expect(appJs).toMatch(/proactive · voice \+ ambient \+ channels \+ autonomy/);
    expect(appJs).toMatch(/on · voice \+ ambient \+ channels/);
  });

  it('renders a per-scheduler Stop control wired to jarvisStopScheduler', () => {
    expect(appJs).toMatch(/🗓️ Schedulers/);
    // Running schedulers get a Stop button; idle ones render an (idle) marker.
    expect(appJs).toMatch(/onclick="jarvisStopScheduler\(/);
    expect(appJs).toMatch(/\(idle\)/);
  });

  it('jarvisStopScheduler POSTs to the per-scheduler stop endpoint and confirms first', () => {
    expect(appJs).toMatch(/async function jarvisStopScheduler\(name\)/);
    // Confirm before stopping — this halts a real subsystem.
    expect(appJs).toMatch(/jarvisStopScheduler[\s\S]*?confirmToast\(/);
    expect(appJs).toMatch(/'\/api\/jarvis\/schedulers\/'\s*\+\s*encodeURIComponent\(name\)\s*\+\s*'\/stop'/);
    // Refreshes the panel so the stopped scheduler immediately shows as idle.
    expect(appJs).toMatch(/jarvisStopScheduler[\s\S]*?refreshJarvisLive\(\)/);
  });

  it('renders a Start control for idle restartable schedulers, wired to jarvisRestartScheduler', () => {
    // Idle-but-restartable schedulers offer Start instead of the bare (idle) marker.
    expect(appJs).toMatch(/s\.restartable/);
    expect(appJs).toMatch(/onclick="jarvisRestartScheduler\(/);
  });

  it('jarvisRestartScheduler POSTs to the per-scheduler restart endpoint and refreshes', () => {
    expect(appJs).toMatch(/async function jarvisRestartScheduler\(name\)/);
    expect(appJs).toMatch(/'\/api\/jarvis\/schedulers\/'\s*\+\s*encodeURIComponent\(name\)\s*\+\s*'\/restart'/);
    expect(appJs).toMatch(/jarvisRestartScheduler[\s\S]*?refreshJarvisLive\(\)/);
  });
});
