const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { files } = require('./fixtures/app-outcome-worker.cjs');

test('real loop writes an app that compiles and calculates in desktop and mobile browsers', { timeout: 60000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness app 'fixture-"));
  const root = path.resolve(__dirname, '..');
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { PROJECT_DIR: workspace, HARNESS_ROOT: root });
  let browser;
  try {
    await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/app-outcome-worker.cjs')], { cwd: workspace, env, timeout: 15000, windowsHide: true });
    const events = JSON.parse(await fs.readFile(path.join(workspace, 'events.json'), 'utf8'));
    assert.equal(events.filter(event => event.type === 'tool_result' && event.result.success).length, 3);
    assert.ok(events.some(event => event.type === 'done' && event.reason === 'completed'));
    for (const [name, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(workspace, name), 'utf8'), content);
    await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], { cwd: workspace, env, timeout: 15000, windowsHide: true });
    const html = await fs.readFile(path.join(workspace, 'index.html'), 'utf8');
    const script = await fs.readFile(path.join(workspace, 'dist/app.js'), 'utf8');
    browser = await chromium.launch({ headless: true });
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => {
          const url = route.request().url();
          if (url === 'http://app.test/') return route.fulfill({ contentType: 'text/html', body: html });
          if (url === 'http://app.test/dist/app.js') return route.fulfill({ contentType: 'application/javascript', body: script });
          return route.abort();
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://app.test/');
        for (const [quantity, price, expected] of [['7', '3.25', '22.75'], ['0', '12', '0.00'], ['2', '0.10', '0.20']]) {
          await page.locator('#quantity').fill(quantity);
          await page.locator('#price').fill(price);
          await page.getByRole('button', { name: 'Calculate' }).click();
          assert.equal(await page.locator('#total').textContent(), expected);
        }
        await page.locator('#quantity').fill('-1');
        await page.getByRole('button', { name: 'Calculate' }).click();
        assert.equal(await page.locator('#total').textContent(), '0.20');
        assert.equal(await page.locator('form').evaluate(form => form.checkValidity()), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});