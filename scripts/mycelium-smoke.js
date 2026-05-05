#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const providedTargetUrl = process.argv[2] || process.env.HARNESS_UI_URL || '';
const targetUrl = providedTargetUrl || 'http://127.0.0.1:4301/';
const graphFile = path.join(process.cwd(), '.harness', 'mycelium', 'graph.json');

async function main() {
  const originalGraph = await readExistingGraph();
  let cleanupServer = async () => {};
  try {
    await writeSeedGraph();
    cleanupServer = await ensureTargetServer();

    const graph = await fetchJson('/api/mycelium');
    // The server seeds default safety/agent/workflow nodes on startup, so
    // the live graph contains the 4 smoke nodes plus the auto-seeded set.
    // Assert presence of the seeded shape rather than exact counts.
    const expectedSeedIds = ['query.smoke', 'tool.smoke', 'verifier.smoke', 'safety.smoke'];
    const nodeIds = new Set((graph.nodes || []).map((n) => n.id));
    for (const id of expectedSeedIds) {
      assert(nodeIds.has(id), `seeded node ${id} was not returned (got ${graph.stats?.nodes} nodes total)`);
    }
    assert((graph.stats?.edges ?? 0) >= 3, `expected at least 3 seeded edges, got ${graph.stats?.edges}`);
    assert((graph.stats?.episodes ?? 0) >= 1, `expected at least 1 seeded episode, got ${graph.stats?.episodes}`);
    assert(Array.isArray(graph.nodes) && graph.nodes.some((node) => node.id === 'query.smoke'), 'seeded query node was not returned');
    assert(Array.isArray(graph.edges) && graph.edges.some((edge) => edge.blockedCount === 2), 'blocked route edge was not returned');
    assert(Array.isArray(graph.episodes) && graph.episodes.some((ep) => ep.blocked === true), 'blocked episode was not returned');

    const lastRoute = await fetchJson('/api/mycelium/last-route');
    assert(lastRoute.episode?.query === 'smoke route inspection', 'last route query did not match seed');
    assert(lastRoute.episode?.blocked === true, 'last route did not preserve blocked=true');
    assert(lastRoute.episode?.blockReason === 'output_validation:fail', 'last route block reason did not match seed');
    assert(Array.isArray(lastRoute.nodes) && lastRoute.nodes.length === 4, 'last route did not hydrate route nodes');
    assert(Array.isArray(lastRoute.edges) && lastRoute.edges.length === 3, 'last route did not hydrate route edges');
    assert(lastRoute.episode?.selectionReasons?.['query.smoke->tool.smoke'] === 'exploitation', 'selection reasons were not returned');
    assert(lastRoute.episode?.rewardComponents?.final === 0.24, 'reward components were not returned');
    assert(Array.isArray(lastRoute.episode?.appliedVerifiers) && lastRoute.episode.appliedVerifiers.includes('verifier.task_completion'), 'applied verifiers were not returned');

    const feedback = await fetchJson('/api/mycelium/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: 'neutral', note: 'mycelium smoke feedback' }),
    });
    assert(feedback.applied === true, 'mycelium feedback was not applied to the seeded route');

    console.log(JSON.stringify({ ok: true, url: targetUrl, checks: ['graph-data', 'last-route', 'feedback'] }, null, 2));
  } finally {
    await cleanupServer();
    await restoreGraph(originalGraph);
  }
}

async function readExistingGraph() {
  try {
    return { existed: true, content: await fs.readFile(graphFile, 'utf-8') };
  } catch {
    return { existed: false, content: '' };
  }
}

async function writeSeedGraph() {
  await fs.mkdir(path.dirname(graphFile), { recursive: true });
  await fs.writeFile(graphFile, JSON.stringify(createSeedGraph(), null, 2), 'utf-8');
}

async function restoreGraph(originalGraph) {
  if (originalGraph.existed) {
    await fs.mkdir(path.dirname(graphFile), { recursive: true });
    await fs.writeFile(graphFile, originalGraph.content, 'utf-8');
    return;
  }
  await fs.rm(graphFile, { force: true });
}

function createSeedGraph() {
  const timestamp = new Date('2026-05-02T00:00:00.000Z').toISOString();
  const route = ['query.smoke', 'tool.smoke', 'verifier.smoke', 'safety.smoke'];
  return {
    nodes: [
      { id: 'query.smoke', type: 'query', label: 'Smoke route query', trust: 0.9, cost: 0.1, activation: 0 },
      { id: 'tool.smoke', type: 'tool', label: 'Smoke tool', trust: 0.8, cost: 0.2, activation: 0 },
      { id: 'verifier.smoke', type: 'verifier', label: 'Smoke verifier', trust: 1, cost: 0.1, activation: 0, protected: true },
      { id: 'safety.smoke', type: 'safety', label: 'Smoke safety', trust: 1, cost: 0.1, activation: 0, protected: true },
    ],
    edges: [
      { source: 'query.smoke', target: 'tool.smoke', weight: 0.74, successCount: 2, failureCount: 1, totalReward: 1.4, lastUsed: timestamp, protected: false, relation: 'routes_to', origin: 'manual', blockedCount: 2, lastBlockedAt: timestamp },
      { source: 'tool.smoke', target: 'verifier.smoke', weight: 0.82, successCount: 2, failureCount: 1, totalReward: 1.4, lastUsed: timestamp, protected: true, relation: 'must_verify_with', origin: 'manual' },
      { source: 'verifier.smoke', target: 'safety.smoke', weight: 0.9, successCount: 2, failureCount: 0, totalReward: 1.8, lastUsed: timestamp, protected: true, relation: 'safety_gate', origin: 'manual' },
    ],
    episodes: [
      {
        id: 'smoke-episode',
        query: 'smoke route inspection',
        route,
        reward: 0.24,
        timestamp,
        taskType: 'coding',
        selectionReasons: {
          'query.smoke->tool.smoke': 'exploitation',
          'tool.smoke->verifier.smoke': 'verifier_required',
          'verifier.smoke->safety.smoke': 'safety_required',
        },
        rewardComponents: { taskSuccess: 0.2, correctness: 0.1, usefulness: 0.3, costEfficiency: 0.7, userSatisfaction: 0.2, final: 0.24 },
        dryRun: false,
        blocked: true,
        blockReason: 'output_validation:fail',
        appliedVerifiers: ['verifier.task_completion'],
      },
    ],
    archivedEdges: [],
  };
}

async function ensureTargetServer() {
  if (await canReachTarget()) return async () => {};
  if (providedTargetUrl) {
    throw new Error(`Unable to reach ${targetUrl}. Start the Harness web server first, or omit the URL to let smoke:mycelium start a local server.`);
  }

  const url = new URL(targetUrl);
  const serverArgs = fsSync.existsSync('dist/web/server.js')
    ? ['dist/web/server.js']
    : ['-r', 'ts-node/register', 'src/web/server.ts'];
  const server = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PORT: url.port || '4301', NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputChunks = [];
  const collectOutput = (chunk) => {
    outputChunks.push(chunk.toString());
    while (outputChunks.join('').length > 8000) outputChunks.shift();
  };
  const getOutput = () => outputChunks.join('');
  server.stdout.on('data', collectOutput);
  server.stderr.on('data', collectOutput);

  try {
    await waitForTarget(server, getOutput);
  } catch (error) {
    await stopStartedServer(server, getOutput);
    throw error;
  }
  return () => stopStartedServer(server, getOutput);
}

async function canReachTarget() {
  try {
    const response = await fetch(targetUrl, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTarget(server, getOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (server.exitCode !== null) {
      throw new Error(`Unable to start Harness web server for Mycelium smoke.\n${getOutput()}`);
    }
    if (await canReachTarget()) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for Harness web server at ${targetUrl}.\n${getOutput()}`);
}

async function stopStartedServer(server, getOutput) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill();
  const exited = await waitForExit(server, 5000);
  if (!exited) console.warn(`Timed out waiting for temporary Harness web server to exit.\n${getOutput()}`);
}

function waitForExit(server, timeoutMs) {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    server.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function fetchJson(routePath, options) {
  const response = await fetch(new URL(routePath, targetUrl), options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${routePath} returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${routePath} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});