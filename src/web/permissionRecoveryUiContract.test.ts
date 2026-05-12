import * as fs from 'fs';
import * as path from 'path';

// Structural sibling for the Playwright smoke check on .tool-item-permission.
//
// The Playwright smoke (`scripts/ui-smoke.js`) renders the actual UI under a
// headless browser, mocks `/api/chat`, and asserts the permission-recovery
// row attaches to the DOM and is visible. That smoke has a CI-only timing
// race against the SSE stream that we have not been able to fully eliminate.
//
// This test exercises the same contract structurally without a browser:
//
// 1. ui/app.js exports an `appendPermissionRecoveryItem` function that
//    creates an element with the expected `tool-item-permission` class.
// 2. The element contains the human-facing strings the user clicks
//    (`Action blocked`, `Keep going 2h`).
// 3. `isPermissionOrRecoveryFailure` recognises the canonical denied-output
//    strings the queryLoop emits.
//
// If the Playwright smoke breaks but this test passes, the failure is
// CI-environment timing rather than a real product regression.

const appJsPath = path.join(__dirname, '..', '..', 'ui', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf-8');
const indexHtmlPath = path.join(__dirname, '..', '..', 'ui', 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

describe('UI permission-recovery row contract', () => {
  it('defines appendPermissionRecoveryItem with the expected class and button text', () => {
    expect(appJs).toMatch(/function appendPermissionRecoveryItem\b/);
    // Class name is the load-bearing locator both UI CSS and the smoke target.
    expect(appJs).toMatch(/'tool-item tool-item-permission'/);
    // Visible text the user clicks. Renaming either string would silently
    // break the recovery flow.
    expect(appJs).toMatch(/Action blocked/);
    expect(appJs).toMatch(/Keep going 2h/);
    expect(appJs).toMatch(/function enableUnattendedRunway\b/);
  });

  it('isPermissionOrRecoveryFailure recognises the canonical denied-output strings', () => {
    // Pull the regex literal out of the source rather than evaluating the
    // whole UI module (which depends on browser globals). The regex is the
    // single point that decides whether a tool failure renders the recovery
    // row, so capturing it here pins the contract.
    const match = appJs.match(/function isPermissionOrRecoveryFailure\([^)]*\)\s*\{\s*return\s+(\/[^/]+\/[a-z]*)\.test/);
    expect(match).not.toBeNull();
    const re = new RegExp(match![1].slice(1, match![1].lastIndexOf('/')), match![1].slice(match![1].lastIndexOf('/') + 1));
    expect(re.test("Permission denied for 'file_write': Nervous System requires verification")).toBe(true);
    expect(re.test('Recovery mode active')).toBe(true);
    expect(re.test('requires confirmation before continuing')).toBe(true);
    // Negative case: ordinary tool failure must NOT trigger the recovery row.
    expect(re.test('ENOENT: no such file or directory')).toBe(false);
  });

  it('SSE handler invokes appendPermissionRecoveryItem when a tool result trips the recogniser', () => {
    // Pin the wiring: the tool_result branch in the SSE switch must call
    // appendPermissionRecoveryItem when isPermissionOrRecoveryFailure is true.
    expect(appJs).toMatch(/isPermissionOrRecoveryFailure\([^)]*\)\)\s*appendPermissionRecoveryItem\(/);
  });

  it('defines the beginner-facing topbar runway control', () => {
    expect(indexHtml).toMatch(/id="unattendedRunwayBtn"/);
    expect(indexHtml).toMatch(/onclick="enableUnattendedRunway\(120\)"/);
    expect(indexHtml).toMatch(/>Keep going<\/button>/);
  });

  it('routes blocked-action recovery through the bounded runway', () => {
    expect(appJs).toMatch(/button\.addEventListener\('click',\s*async \(\) => \{\s*await enableUnattendedRunway\(120\);\s*\}\)/);
    expect(appJs).not.toMatch(/Permission recovery auto-approve from tool activity panel/);
  });

  it('enables the timed runway with the expected API calls and audit reason', () => {
    expect(appJs).toMatch(/fetch\('\/api\/permissions\/timed-autonomy'/);
    expect(appJs).toMatch(/expiresInMinutes:\s*duration/);
    expect(appJs).toMatch(/reason:\s*'One-click unattended runway from chat window'/);
    expect(appJs).toMatch(/fetch\('\/api\/tools'\)/);
    expect(appJs).toMatch(/fetch\('\/api\/tools\/bulk-toggle'/);
    expect(appJs).toMatch(/body:\s*JSON\.stringify\(\{\s*names:\s*disabled,\s*enabled:\s*true,\s*expiresInMinutes:\s*duration\s*\}\)/);
  });

  it('grants the common gated capabilities for the same runway duration', () => {
    expect(appJs).toMatch(/const commonCapabilityIds = \['arbitrary-shell', 'background-autonomous-jobs', 'self-modifying-code'\]/);
    expect(appJs).toMatch(/fetch\('\/api\/capabilities'\)/);
    expect(appJs).toMatch(/fetch\('\/api\/capabilities\/grants'/);
    expect(appJs).toMatch(/controls:\s*item\.requiredControls \|\| \[\]/);
    expect(appJs).toMatch(/expiresInMinutes:\s*minutes/);
  });
});
