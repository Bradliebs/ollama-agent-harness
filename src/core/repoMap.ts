// Repo Map — lightweight persistent snapshot of a project's structure.
//
// Captures the things the agent needs to know *before* it starts working:
//   - detected language / framework stack
//   - package manager
//   - test, check, and build commands
//   - paths the agent must never touch
//   - known entry points and key directories
//
// Deliberately lightweight: no AST, no import graph — just filesystem
// probing + package.json parsing. Builds in < 100 ms for typical projects.
// Persisted to <projectDir>/.harness/repo-map.json so repeated runs do not
// re-scan unless the map is stale (default staleness threshold: 24 h).

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

export interface RepoMap {
  /** Schema version for forward-compatible evolution. */
  version: number;
  /** Absolute path to the project root that was scanned. */
  root: string;
  /** Detected framework / language identifiers, e.g. ["typescript","node"]. */
  frameworks: string[];
  /** Detected package manager, e.g. "npm", "yarn", "pnpm", "pip", "cargo". */
  packageManager?: string;
  /** Shell command to run the test suite, e.g. "npm test". */
  testCommand?: string;
  /** Shell command to run type-check / lint, e.g. "npm run typecheck". */
  checkCommand?: string;
  /** Shell command to build the project, e.g. "npm run build". */
  buildCommand?: string;
  /**
   * Relative paths (from root) the agent must never edit.
   * May include glob-style patterns such as "dist/**" or "*.lock".
   */
  doNotEdit: string[];
  /** Relative paths of detected entry-point files. */
  entryPoints: string[];
  /** Key subdirectory names present in the project root. */
  keyDirs: string[];
  /** Detected config / manifest file names at the project root. */
  configFiles: string[];
  /** ISO 8601 timestamp when this map was built. */
  builtAt: string;
  /**
   * Optional hand-written notes appended by the caller.
   * Surfaced verbatim in the system prompt block.
   */
  notes?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const REPO_MAP_FILENAME = 'repo-map.json';
const HARNESS_DIR = '.harness';

/** Default staleness threshold: 24 hours. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ALWAYS_DO_NOT_EDIT = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.harness',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Pipfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
];

const KEY_DIR_NAMES = new Set([
  'src', 'lib', 'app', 'core', 'api', 'server',
  'client', 'ui', 'web', 'frontend', 'backend',
  'tests', 'test', 'spec', '__tests__',
  'docs', 'scripts', 'tools', 'utils', 'config',
  'integrations', 'services', 'types', 'models',
  'middleware', 'helpers', 'hooks', 'components',
]);

// ─── Build ──────────────────────────────────────────────────────────

/**
 * Scan `projectDir` and produce a `RepoMap`.
 * This is the main entry point for building a map from scratch.
 */
export async function buildRepoMap(projectDir: string): Promise<RepoMap> {
  const root = path.resolve(projectDir);
  const entries = await safeReaddir(root);

  const frameworks: string[] = [];
  const configFiles: string[] = [];
  const keyDirs: string[] = [];

  // ── Detect config files ────────────────────────────────────────────
  const configFileNames = new Set([
    'package.json', 'tsconfig.json', 'jsconfig.json',
    'jest.config.js', 'jest.config.ts', 'jest.config.mjs',
    'vite.config.ts', 'vite.config.js',
    'webpack.config.js', 'rollup.config.js',
    '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml',
    '.prettierrc', '.prettierrc.json',
    'babel.config.js', 'babel.config.json',
    'Makefile', 'makefile',
    'requirements.txt', 'setup.py', 'setup.cfg', 'pyproject.toml', 'Pipfile',
    'go.mod',
    'Cargo.toml',
    'pom.xml', 'build.gradle', 'build.gradle.kts',
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    '.env.example',
  ]);

  for (const entry of entries) {
    if (configFileNames.has(entry.name)) {
      configFiles.push(entry.name);
    }
    if (entry.isDirectory() && KEY_DIR_NAMES.has(entry.name)) {
      keyDirs.push(entry.name);
    }
  }

  // ── Detect framework / language ─────────────────────────────────────
  const hasFile = (name: string) => configFiles.includes(name);
  const hasTsConfig = hasFile('tsconfig.json') || hasFile('jsconfig.json');
  const hasPkg = hasFile('package.json');
  const hasPython = hasFile('requirements.txt') || hasFile('setup.py') || hasFile('pyproject.toml') || hasFile('Pipfile');
  const hasGo = hasFile('go.mod');
  const hasRust = hasFile('Cargo.toml');
  const hasJava = hasFile('pom.xml') || hasFile('build.gradle') || hasFile('build.gradle.kts');

  if (hasTsConfig) frameworks.push('typescript');
  if (hasPkg && !hasTsConfig) frameworks.push('javascript');
  if (hasPkg) frameworks.push('node');
  if (hasPython) frameworks.push('python');
  if (hasGo) frameworks.push('go');
  if (hasRust) frameworks.push('rust');
  if (hasJava) frameworks.push('java');
  if (frameworks.length === 0) frameworks.push('unknown');

  // ── Package manager ─────────────────────────────────────────────────
  const lockFiles: Record<string, string> = {
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'package-lock.json': 'npm',
    Pipfile: 'pipenv',
    'requirements.txt': 'pip',
    'pyproject.toml': 'poetry',
    'go.mod': 'go',
    'Cargo.toml': 'cargo',
  };
  let packageManager: string | undefined;
  for (const entry of entries) {
    if (lockFiles[entry.name]) {
      packageManager = lockFiles[entry.name];
      break;
    }
  }

  // ── Extract commands from package.json ──────────────────────────────
  let testCommand: string | undefined;
  let checkCommand: string | undefined;
  let buildCommand: string | undefined;

  if (hasPkg) {
    const pkg = await readJson<Record<string, unknown>>(path.join(root, 'package.json'));
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
    testCommand = scripts['test'] ? `npm test` : undefined;
    // Prefer explicit typecheck script, fall back to tsc
    checkCommand = scripts['typecheck'] ? `npm run typecheck`
      : scripts['type-check'] ? `npm run type-check`
      : scripts['lint'] ? `npm run lint`
      : hasTsConfig ? `npx tsc --noEmit`
      : undefined;
    buildCommand = scripts['build'] ? `npm run build` : undefined;
  }

  if (hasPython && !testCommand) {
    testCommand = 'pytest';
  }
  if (hasGo && !testCommand) {
    testCommand = 'go test ./...';
  }
  if (hasRust && !testCommand) {
    testCommand = 'cargo test';
  }

  // ── Entry points ─────────────────────────────────────────────────────
  const entryPointCandidates = [
    'src/index.ts', 'src/main.ts', 'src/index.js', 'src/main.js',
    'src/app.ts', 'src/app.js',
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'main.py', 'app.py', '__main__.py',
    'cmd/main.go', 'main.go',
    'src/main.rs', 'main.rs',
  ];
  const entryPoints: string[] = [];
  for (const candidate of entryPointCandidates) {
    if (fs.existsSync(path.join(root, candidate))) {
      entryPoints.push(candidate);
    }
  }

  // ── Do-not-edit paths ─────────────────────────────────────────────────
  const doNotEdit = [...ALWAYS_DO_NOT_EDIT].filter(p =>
    fs.existsSync(path.join(root, p)) || p.includes('*')
  );

  return {
    version: SCHEMA_VERSION,
    root,
    frameworks,
    packageManager,
    testCommand,
    checkCommand,
    buildCommand,
    doNotEdit,
    entryPoints,
    keyDirs: keyDirs.sort(),
    configFiles: configFiles.sort(),
    builtAt: new Date().toISOString(),
  };
}

// ─── Persistence ────────────────────────────────────────────────────

/** Save a repo map to `<projectDir>/.harness/repo-map.json`. */
export async function saveRepoMap(repoMap: RepoMap, projectDir: string): Promise<void> {
  const harnessDir = path.join(path.resolve(projectDir), HARNESS_DIR);
  await fsp.mkdir(harnessDir, { recursive: true });
  const filePath = path.join(harnessDir, REPO_MAP_FILENAME);
  await fsp.writeFile(filePath, JSON.stringify(repoMap, null, 2), 'utf8');
}

/**
 * Load a previously-saved repo map from `<projectDir>/.harness/repo-map.json`.
 * Returns `undefined` if the file does not exist or cannot be parsed.
 */
export async function loadRepoMap(projectDir: string): Promise<RepoMap | undefined> {
  const filePath = path.join(path.resolve(projectDir), HARNESS_DIR, REPO_MAP_FILENAME);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RepoMap;
    if (parsed.version !== SCHEMA_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Load map from disk; build and save a fresh one if absent or stale.
 * This is the recommended high-level entry point for callers that want
 * caching behaviour.
 */
export async function getOrBuildRepoMap(
  projectDir: string,
  opts: { maxAgeMs?: number } = {},
): Promise<RepoMap> {
  const existing = await loadRepoMap(projectDir);
  if (existing && !isStale(existing, opts.maxAgeMs)) {
    return existing;
  }
  const fresh = await buildRepoMap(projectDir);
  await saveRepoMap(fresh, projectDir);
  return fresh;
}

// ─── Staleness ──────────────────────────────────────────────────────

/** Returns true when the map is older than `maxAgeMs` (default 24 h). */
export function isStale(repoMap: RepoMap, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  const ageMs = Date.now() - new Date(repoMap.builtAt).getTime();
  return ageMs > maxAgeMs;
}

// ─── System prompt rendering ─────────────────────────────────────────

/**
 * Render a concise Markdown block for injection into the agent system prompt.
 * Kept compact so it doesn't crowd out the real task context.
 */
export function renderRepoMapBlock(map: RepoMap): string {
  const lines: string[] = ['## Project Snapshot'];

  lines.push(`- **Root:** \`${map.root}\``);
  lines.push(`- **Stack:** ${map.frameworks.join(', ')}`);
  if (map.packageManager) {
    lines.push(`- **Package manager:** ${map.packageManager}`);
  }
  if (map.testCommand) {
    lines.push(`- **Test command:** \`${map.testCommand}\``);
  }
  if (map.checkCommand) {
    lines.push(`- **Check command:** \`${map.checkCommand}\``);
  }
  if (map.buildCommand) {
    lines.push(`- **Build command:** \`${map.buildCommand}\``);
  }
  if (map.entryPoints.length > 0) {
    lines.push(`- **Entry points:** ${map.entryPoints.map(p => `\`${p}\``).join(', ')}`);
  }
  if (map.keyDirs.length > 0) {
    lines.push(`- **Key dirs:** ${map.keyDirs.map(d => `\`${d}/\``).join(', ')}`);
  }
  if (map.doNotEdit.length > 0) {
    lines.push(`- **Do not edit:** ${map.doNotEdit.map(p => `\`${p}\``).join(', ')}`);
  }
  if (map.notes) {
    lines.push('');
    lines.push(`> ${map.notes.replace(/\n/g, '\n> ')}`);
  }

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
