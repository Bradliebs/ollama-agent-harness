import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { setProjectRoot } from '../tools/pathResolution';

const CREDENTIAL_ENV_NAMES = [
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'DEEPINFRA_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_MODELS_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'REPLICATE_API_TOKEN',
  'SAMBANOVA_API_KEY',
  'TOGETHER_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

export const serverTestSourceRoot = process.cwd();
export const serverTestProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-server-test-'));

const originalProjectDir = process.env.HARNESS_PROJECT_DIR;
const originalCredentials = new Map<string, string | undefined>(
  CREDENTIAL_ENV_NAMES.map((name) => [name, process.env[name]]),
);

fs.copyFileSync(
  path.join(serverTestSourceRoot, 'package.json'),
  path.join(serverTestProjectDir, 'package.json'),
);
fs.copyFileSync(
  path.join(serverTestSourceRoot, 'README.md'),
  path.join(serverTestProjectDir, 'README.md'),
);
const plannerSkillDir = path.join(serverTestProjectDir, '.github', 'skills', 'planner');
fs.mkdirSync(plannerSkillDir, { recursive: true });
fs.copyFileSync(
  path.join(serverTestSourceRoot, '.github', 'skills', 'planner', 'SKILL.md'),
  path.join(plannerSkillDir, 'SKILL.md'),
);
fs.writeFileSync(
  path.join(serverTestProjectDir, 'IMPLEMENTATION_PLAN.md'),
  [
    '# Implementation Plan',
    '',
    '- [ ] fixture-pending-task - Pending fixture task',
    '  - anchor: src/web/server.ts',
    '- [x] fixture-completed-task - Completed fixture task',
    '  - anchor: src/web/server.test.ts',
    '',
  ].join('\n'),
  'utf-8',
);
execFileSync('git', ['init', '--quiet', serverTestProjectDir], { stdio: 'ignore' });

process.env.HARNESS_PROJECT_DIR = serverTestProjectDir;
for (const name of CREDENTIAL_ENV_NAMES) delete process.env[name];
process.chdir(serverTestProjectDir);

export async function cleanupServerTestWorkspace(): Promise<void> {
  process.chdir(serverTestSourceRoot);
  setProjectRoot(serverTestSourceRoot);
  if (originalProjectDir === undefined) delete process.env.HARNESS_PROJECT_DIR;
  else process.env.HARNESS_PROJECT_DIR = originalProjectDir;
  for (const [name, value] of originalCredentials) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.promises.rm(serverTestProjectDir, { recursive: true, force: true });
}