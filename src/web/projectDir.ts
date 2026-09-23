// Workspace (project dir) resolution for the web server, extracted from
// server.ts.
//
// The agent must never write into the harness source tree. HARNESS_PROJECT_DIR
// wins when set. Otherwise, launching from the harness checkout redirects to
// ~/apex-workspace (created on first run); the checkout is detected by
// src/web/server.ts plus src/tools/dispatcher.ts. Tests keep cwd so fixtures
// land in the repo-local .harness.

import { existsSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ProjectDirOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homedir?: string;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
  log?: (message: string) => void;
}

export function isHarnessCheckout(dir: string, exists: (p: string) => boolean = existsSync): boolean {
  return exists(path.join(dir, 'src', 'web', 'server.ts')) && exists(path.join(dir, 'src', 'tools', 'dispatcher.ts'));
}

export function resolveProjectDir(options: ProjectDirOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.HARNESS_PROJECT_DIR) return path.resolve(env.HARNESS_PROJECT_DIR);
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  if (!isHarnessCheckout(cwd, exists)) return cwd;
  // jest sets NODE_ENV='test'; --runInBand does not set JEST_WORKER_ID.
  if (env.NODE_ENV === 'test' || env.JEST_WORKER_ID) return cwd;
  const safeDefault = path.join(options.homedir ?? os.homedir(), 'apex-workspace');
  if (!exists(safeDefault)) (options.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true })))(safeDefault);
  const log = options.log ?? console.log;
  log(`⚠️  Workspace isolation: cwd is the harness repo — redirecting to ${safeDefault}`);
  log('   Set HARNESS_PROJECT_DIR to override (e.g. your app folder).');
  return safeDefault;
}
