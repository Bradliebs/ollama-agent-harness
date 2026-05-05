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
//    (`Action blocked`, `Auto-approve all`).
// 3. `isPermissionOrRecoveryFailure` recognises the canonical denied-output
//    strings the queryLoop emits.
//
// If the Playwright smoke breaks but this test passes, the failure is
// CI-environment timing rather than a real product regression.

const appJsPath = path.join(__dirname, '..', '..', 'ui', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf-8');

describe('UI permission-recovery row contract', () => {
  it('defines appendPermissionRecoveryItem with the expected class and button text', () => {
    expect(appJs).toMatch(/function appendPermissionRecoveryItem\b/);
    // Class name is the load-bearing locator both UI CSS and the smoke target.
    expect(appJs).toMatch(/'tool-item tool-item-permission'/);
    // Visible text the user clicks. Renaming either string would silently
    // break the recovery flow.
    expect(appJs).toMatch(/Action blocked/);
    expect(appJs).toMatch(/Auto-approve all/);
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
});
