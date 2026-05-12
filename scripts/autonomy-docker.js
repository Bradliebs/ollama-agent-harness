#!/usr/bin/env node
/**
 * scripts/autonomy-docker.js — npm wrapper for the Docker autonomy sandbox.
 *
 * What this does:
 *   1. Builds Dockerfile.autonomy if the image is missing or stale.
 *   2. Runs the container with the workspace bind-mounted at /workspace.
 *   3. Forwards every HARNESS_*, OLLAMA_*, CEREBRAS_*, GROQ_*, OPENAI_*,
 *      ANTHROPIC_*, GITHUB_*, MISTRAL_*, OPENROUTER_*, FORGE_* env var
 *      from the host into the container, so the autonomy loop sees the
 *      same configuration it would on the host.
 *   4. Streams stdout/stderr through; exits with the container's status.
 *
 * Why a wrapper instead of a one-line npm script:
 *   * Docker bind-mount paths and env-var passthrough are platform-
 *     specific. Doing this in node keeps it cross-platform.
 *   * Sensitive env values must be passed via `-e VAR` (not via the
 *     command line where they'd be visible in `ps`).
 *   * Future work (image freshness, --rebuild, --no-cache) lives here
 *     instead of bloating package.json.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const IMAGE = process.env.HARNESS_AUTONOMY_IMAGE || 'harness-autonomy';
const DOCKERFILE = path.join(__dirname, '..', 'Dockerfile.autonomy');
const WORKSPACE = path.resolve(__dirname, '..');

// Env var prefixes that MUST flow into the container.
const ENV_PREFIXES = [
  'HARNESS_',
  'FORGE_',
  'OLLAMA_',
  'CEREBRAS_',
  'GROQ_',
  'OPENAI_',
  'ANTHROPIC_',
  'GITHUB_TOKEN',
  'GITHUB_MODELS_TOKEN',
  'MISTRAL_',
  'OPENROUTER_',
];

function shouldForward(name) {
  return ENV_PREFIXES.some((p) => name === p || name.startsWith(p));
}

function checkDocker() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    console.error('Docker is not available. Install Docker Desktop / engine and ensure `docker version` works.');
    process.exit(1);
  }
}

function imageExists() {
  const r = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf-8', stdio: 'pipe' });
  return r.status === 0;
}

function buildImage() {
  console.log(`[autonomy:docker] building image ${IMAGE}…`);
  const args = ['build', '-f', DOCKERFILE, '-t', IMAGE];
  // Match host UID where possible so bind-mount writes have the right owner.
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    args.push('--build-arg', `HOST_UID=${process.getuid()}`);
    if (typeof process.getgid === 'function') args.push('--build-arg', `HOST_GID=${process.getgid()}`);
  }
  args.push(WORKSPACE);
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[autonomy:docker] image build failed.');
    process.exit(r.status ?? 1);
  }
}

function runContainer(extraArgs) {
  const envArgs = [];
  for (const name of Object.keys(process.env)) {
    if (shouldForward(name) && process.env[name] !== undefined) {
      envArgs.push('-e', `${name}=${process.env[name]}`);
    }
  }
  // Default backend to ollama if the user didn't set one (preserves existing
  // behavior). For Ollama-on-host, the container needs to reach the host.
  if (!process.env.HARNESS_HOST && (!process.env.HARNESS_BACKEND || process.env.HARNESS_BACKEND === 'ollama')) {
    // Linux uses --add-host=host.docker.internal; Docker Desktop already provides it.
    envArgs.push('-e', 'HARNESS_HOST=http://host.docker.internal:11434');
  }

  const args = [
    'run', '--rm', '-i',
    // Workspace mount. Read-write because autonomy commits per task.
    '-v', `${WORKSPACE}:/workspace`,
    // host.docker.internal needs --add-host on Linux; harmless on Win/Mac.
    '--add-host=host.docker.internal:host-gateway',
    ...envArgs,
    IMAGE,
    ...extraArgs,
  ];
  if (process.stdout.isTTY) args.splice(2, 0, '-t');

  console.log(`[autonomy:docker] starting container against image ${IMAGE}…`);
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const cliArgs = process.argv.slice(2);
const wantRebuild = cliArgs.includes('--rebuild');
const passthrough = cliArgs.filter((a) => a !== '--rebuild');

checkDocker();
if (wantRebuild || !imageExists()) buildImage();
runContainer(passthrough);
