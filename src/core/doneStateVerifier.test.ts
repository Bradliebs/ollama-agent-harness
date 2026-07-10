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
});