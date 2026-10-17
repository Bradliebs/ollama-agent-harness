import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { verifyCode } from './doneStateVerifier';

describe('verifyCode', () => {
  it('runs the package test script from the project directory', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'done-state-verifier-'));
    try {
      await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
        private: true,
        scripts: { test: 'node verify.js' },
      }), 'utf-8');
      await fs.writeFile(path.join(projectDir, 'verify.js'), "console.log('verified')\n", 'utf-8');

      const result = await verifyCode({ projectDir });

      expect(result.overall).toBe('pass');
      expect(result.checks).toContainEqual(expect.objectContaining({ name: 'tests', status: 'pass' }));
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps the end of a failing run and does not pass jest-only flags to other runners', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'done-state-verifier-'));
    try {
      await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
        private: true,
        scripts: { test: 'node verify.js' },
      }), 'utf-8');
      await fs.writeFile(path.join(projectDir, 'verify.js'), [
        "for (let i = 0; i < 400; i++) console.log('noise line ' + i);",
        "console.error('args=' + JSON.stringify(process.argv.slice(2)));",
        "console.error('\\u001b[31mFAILED: 1 test\\u001b[0m');",
        'process.exit(1);',
      ].join('\n'), 'utf-8');

      const result = await verifyCode({ projectDir });
      const tests = result.checks.find((check) => check.name === 'tests');

      expect(result.overall).toBe('fail');
      expect(tests?.detail).toContain('FAILED: 1 test');
      expect(tests?.detail).toContain('args=[]');
      expect(tests?.detail).not.toContain('\u001b[');
      expect(tests?.detail?.length).toBeLessThanOrEqual(3_003);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('skips rather than fails when a project has nothing to verify', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'done-state-verifier-'));
    try {
      const result = await verifyCode({ projectDir });
      expect(result.overall).toBe('skip');
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('checks web pages written this run: inline script syntax and missing local files', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'done-state-verifier-'));
    try {
      const good = path.join(projectDir, 'good.html');
      const bad = path.join(projectDir, 'game', 'index.html');
      await fs.mkdir(path.dirname(bad));
      await fs.writeFile(path.join(projectDir, 'style.css'), 'body {}');
      await fs.writeFile(good, [
        '<link rel="stylesheet" href="style.css?v=2">',
        '<link rel="icon" href="favicon.ico">',
        '<script src="https://cdn.example.com/lib.js"></script>',
        '<script type="module">import x from "./x.js";</script>',
        '<script type="application/json">{"not": "js"</script>',
        '<script>const ok = 1;</script>',
      ].join('\n'));
      await fs.writeFile(bad, ['<html>', '<body>', '<script src="engine.js"></script>', '<script>', 'function loop() {', '  if (x {', '}', '</script>'].join('\n'));

      const passing = await verifyCode({ projectDir, quick: true, changedFiles: [good] });
      expect(passing.checks.find((c) => c.name === 'web page')).toMatchObject({ status: 'pass' });

      const failing = await verifyCode({ projectDir, quick: true, changedFiles: [good, bad, path.join(projectDir, 'notes.md')] });
      const check = failing.checks.find((c) => c.name === 'web page');
      expect(check?.status).toBe('fail');
      expect(failing.overall).toBe('fail');
      expect(check?.detail).toContain(`${path.join('game', 'index.html')}:6`);
      expect(check?.detail).toContain('refers to engine.js, which does not exist');
      expect(check?.detail).not.toContain('good.html');

      const none = await verifyCode({ projectDir, quick: true, changedFiles: [path.join(projectDir, 'notes.md')] });
      expect(none.checks.some((c) => c.name === 'web page')).toBe(false);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('skips typecheck instead of letting npx download a package when typescript is not installed', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'done-state-verifier-'));
    try {
      await fs.writeFile(path.join(projectDir, 'tsconfig.json'), '{}', 'utf-8');
      const result = await verifyCode({ projectDir, quick: true });
      expect(result.checks).toEqual([expect.objectContaining({ name: 'typecheck', status: 'skip', detail: expect.stringContaining('not installed') })]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});