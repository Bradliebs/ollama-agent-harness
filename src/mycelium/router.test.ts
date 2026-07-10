import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MyceliumGraph, loadMyceliumGraph, saveMyceliumGraph } from './graph';
import { spreadActivation, selectRoute } from './activation';
import { reinforceRoute, weakenRoute, decayUnusedEdges, pruneDeadEdges, computeReward } from './reinforcement';
import { MycelialContextRouter, createMycelialRouter, deriveToolShortlist, toolNamesFromRoute, DEFAULT_TOOL_FLOOR } from './router';
import { resetSharedMyceliumGraphForTest } from './graphStore';

// ─── Graph store ────────────────────────────────────────────────────

describe('MyceliumGraph', () => {
  it('adds and retrieves nodes', () => {
    const graph = new MyceliumGraph();
    const node = graph.addNode({ id: 'tool.bash', type: 'tool', label: 'bash', trust: 0.5, cost: 0.3 });

    expect(node.activation).toBe(0);
    expect(graph.getNode('tool.bash')).toMatchObject({ id: 'tool.bash', type: 'tool' });
    expect(graph.listNodes('tool')).toHaveLength(1);
    expect(graph.listNodes('memory')).toHaveLength(0);
  });

  it('adds and retrieves edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'query', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'tool', trust: 0.5, cost: 0.2 });
    graph.addEdge('a', 'b', 0.8);

    expect(graph.getEdge('a', 'b')?.weight).toBe(0.8);
    expect(graph.outgoingEdges('a')).toHaveLength(1);
    expect(graph.incomingEdges('b')).toHaveLength(1);
  });

  it('deduplicates edges by taking the higher weight', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.3);
    graph.addEdge('a', 'b', 0.9);

    expect(graph.listEdges()).toHaveLength(1);
    expect(graph.getEdge('a', 'b')?.weight).toBe(0.9);
  });

  it('removes nodes and cleans up edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b');

    graph.removeNode('a');
    expect(graph.getNode('a')).toBeUndefined();
    expect(graph.listEdges()).toHaveLength(0);
  });

  it('records and lists episodes', () => {
    const graph = new MyceliumGraph();
    graph.recordEpisode('test query', ['a', 'b', 'c'], 0.85);

    const episodes = graph.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ query: 'test query', route: ['a', 'b', 'c'], reward: 0.85 });
  });

  it('serializes and deserializes', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'tool.bash', type: 'tool', label: 'bash', trust: 0.8, cost: 0.3 });
    graph.addNode({ id: 'memory.m1', type: 'memory', label: 'pattern', trust: 0.7, cost: 0.05 });
    graph.addEdge('tool.bash', 'memory.m1', 0.6);
    graph.recordEpisode('test', ['tool.bash', 'memory.m1'], 0.9);

    const json = graph.toJSON();
    const restored = MyceliumGraph.fromJSON(json);

    expect(restored.listNodes()).toHaveLength(2);
    expect(restored.listEdges()).toHaveLength(1);
    expect(restored.listEpisodes()).toHaveLength(1);
  });

  it('persists to disk and loads back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mycelium-'));
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'tool.bash', type: 'tool', label: 'bash', trust: 0.8, cost: 0.3 });
    graph.addEdge('tool.bash', 'tool.bash', 0.5);

    await saveMyceliumGraph(dir, graph);
    const loaded = await loadMyceliumGraph(dir);

    expect(loaded.listNodes()).toHaveLength(1);
    expect(loaded.listEdges()).toHaveLength(1);
  });
});

// ─── Activation ─────────────────────────────────────────────────────

describe('spreadActivation', () => {
  it('propagates activation through edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'q', type: 'query', label: 'query', trust: 1, cost: 0 });
    graph.addNode({ id: 'a', type: 'tool', label: 'tool-a', trust: 0.8, cost: 0.1 });
    graph.addNode({ id: 'b', type: 'memory', label: 'mem-b', trust: 0.7, cost: 0.05 });
    graph.addNode({ id: 'c', type: 'skill', label: 'skill-c', trust: 0.6, cost: 0.2 });
    graph.addEdge('q', 'a', 0.9);
    graph.addEdge('q', 'b', 0.3);
    graph.addEdge('a', 'c', 0.7);

    const activated = spreadActivation(graph, 'q', { hops: 2 });

    expect(activated.length).toBeGreaterThanOrEqual(3);
    expect(activated[0].id).toBe('q');
    const nodeA = activated.find((n) => n.id === 'a');
    expect(nodeA).toBeDefined();
    expect(nodeA!.activation).toBeGreaterThan(0);
    const nodeC = activated.find((n) => n.id === 'c');
    expect(nodeC).toBeDefined();
    expect(nodeC!.activation).toBeGreaterThan(0);
  });

  it('returns empty for unknown seed node', () => {
    const graph = new MyceliumGraph();
    expect(spreadActivation(graph, 'nonexistent')).toEqual([]);
  });
});

describe('selectRoute', () => {
  it('selects a compact subgraph from activated nodes', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'q', type: 'query', label: 'query', trust: 1, cost: 0 });
    graph.addNode({ id: 'a', type: 'tool', label: 'tool-a', trust: 0.8, cost: 0.1 });
    graph.addNode({ id: 'b', type: 'memory', label: 'mem-b', trust: 0.7, cost: 0.05 });
    graph.addEdge('q', 'a', 0.9);
    graph.addEdge('q', 'b', 0.3);

    const activated = spreadActivation(graph, 'q');
    const route = selectRoute(graph, activated, { maxNodes: 5, exploreRate: 0 });

    expect(route.nodes.length).toBeGreaterThanOrEqual(2);
    expect(route.nodes.length).toBeLessThanOrEqual(5);
  });
});

// ─── Reinforcement ──────────────────────────────────────────────────

describe('reinforcement', () => {
  it('strengthens edges on a successful route', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0.1 });
    graph.addEdge('a', 'b', 0.5);

    reinforceRoute(graph, ['a', 'b'], 0.9);

    expect(graph.getEdge('a', 'b')!.weight).toBeGreaterThan(0.5);
    expect(graph.getEdge('a', 'b')!.successCount).toBe(1);
    expect(graph.getNode('b')!.trust).toBeGreaterThan(0.5);
  });

  it('weakens edges on a failed route', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0.1 });
    graph.addEdge('a', 'b', 0.5);

    weakenRoute(graph, ['a', 'b'], 0.8);

    expect(graph.getEdge('a', 'b')!.weight).toBeLessThan(0.5);
    expect(graph.getEdge('a', 'b')!.failureCount).toBe(1);
  });

  it('decays all edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.5);

    decayUnusedEdges(graph, { beta: 0.1 });

    expect(graph.getEdge('a', 'b')!.weight).toBe(0.45);
  });

  it('prunes dead edges below threshold', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'weak', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'c', type: 'tool', label: 'strong', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.01);
    graph.addEdge('a', 'c', 0.8);

    pruneDeadEdges(graph, { pruneThreshold: 0.03 });

    expect(graph.getEdge('a', 'b')).toBeUndefined();
    expect(graph.getEdge('a', 'c')).toBeDefined();
  });

  it('does not prune protected edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 't', trust: 0.5, cost: 0 });
    const edge = graph.addEdge('a', 'b', 0.01);
    edge.protected = true;

    pruneDeadEdges(graph, { pruneThreshold: 0.03 });

    expect(graph.getEdge('a', 'b')).toBeDefined();
  });

  it('computes reward from input weights', () => {
    const reward = computeReward({ taskSuccess: 1, correctness: 1, usefulness: 1, costEfficiency: 1, userSatisfaction: 1, novelty: 1 });
    expect(reward).toBe(1);

    const zero = computeReward({});
    expect(zero).toBeGreaterThan(0); // defaults contribute some base reward
  });
});

// ─── Router ─────────────────────────────────────────────────────────

describe('MycelialContextRouter', () => {
  it('seeds tools, skills, and memories then routes a query', () => {
    const graph = new MyceliumGraph();
    const router = new MycelialContextRouter('/tmp', graph);

    router.seedToolNodes([
      { name: 'bash', description: 'Run shell commands', riskLevel: 'high' },
      { name: 'file_read', description: 'Read files', riskLevel: 'low' },
    ]);
    router.seedSkillNodes([
      { name: 'code-review', description: 'Review code for quality', domain: 'engineering' },
    ]);
    router.seedMemoryNodes([
      { id: 'm1', text: 'User prefers TypeScript and Jest testing' },
    ]);

    // Connect related nodes
    graph.addEdge('tool.bash', 'skill.code-review', 0.5);
    graph.addEdge('skill.code-review', 'memory.m1', 0.4);
    graph.addEdge('tool.file_read', 'skill.code-review', 0.7);

    const result = router.routeQuery('review my code for quality issues');

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.route.length).toBeGreaterThan(0);
    expect(result.contextText).toBeTruthy();
    expect(result.stats.nodes).toBeGreaterThan(0);
  });

  it('reinforces after a good response', () => {
    const graph = new MyceliumGraph();
    const router = new MycelialContextRouter('/tmp', graph);

    router.seedToolNodes([{ name: 'bash', description: 'Shell', riskLevel: 'medium' }]);
    graph.addEdge('tool.bash', 'tool.bash', 0.5);

    router.routeQuery('run a command');
    const edgeBefore = graph.listEdges().find((e) => e.source === 'tool.bash');

    router.reinforce({ taskSuccess: 1, correctness: 0.9 });

    // Route was reinforced — episodes should exist
    expect(graph.listEpisodes().length).toBeGreaterThan(0);
  });

  it('decays and prunes during maintenance', () => {
    const graph = new MyceliumGraph();
    const router = new MycelialContextRouter('/tmp', graph);

    graph.addNode({ id: 'a', type: 'tool', label: 'a', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'b', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.01);

    const result = router.decay();
    expect(result.pruned).toBeGreaterThanOrEqual(0);
  });

  it('persists and loads via createMycelialRouter', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mycelium-router-'));

    const router = await createMycelialRouter(dir);
    router.seedToolNodes([{ name: 'bash', description: 'Shell' }]);
    await router.save();

    resetSharedMyceliumGraphForTest();
    const loaded = await createMycelialRouter(dir);
    expect(loaded.getGraph().listNodes()).toHaveLength(1);
  });
});

// ─── Tool shortlisting (Phase 2) ────────────────────────────────────

describe('toolNamesFromRoute', () => {
  it('extracts only tool-type node labels', () => {
    const route = {
      nodes: [
        { type: 'tool', label: 'web_search' },
        { type: 'memory', label: 'some-memory' },
        { type: 'tool', label: 'file_read' },
      ],
    };
    expect(toolNamesFromRoute(route)).toEqual(['web_search', 'file_read']);
  });

  it('returns an empty list when no tool nodes are present', () => {
    expect(toolNamesFromRoute({ nodes: [{ type: 'memory', label: 'm' }] })).toEqual([]);
  });
});

describe('deriveToolShortlist', () => {
  const allTools = [
    { name: 'web_search' },
    { name: 'file_read' },
    { name: 'file_write' },
    { name: 'file_edit' },
    { name: 'bash' },
    { name: 'pdf_render' },
  ];

  it('returns ALL tools when routing gives no signal (escalation floor)', () => {
    expect(deriveToolShortlist([], allTools)).toEqual(allTools);
  });

  it('returns the routed subset unioned with the floor', () => {
    const keep = deriveToolShortlist(['web_search'], allTools).map((t) => t.name);
    expect(keep).toContain('web_search');
    // floor tools are always offered
    for (const f of DEFAULT_TOOL_FLOOR) {
      if (allTools.some((t) => t.name === f)) expect(keep).toContain(f);
    }
    // non-routed, non-floor tools are dropped
    expect(keep).not.toContain('pdf_render');
  });

  it('honours maxTools for the routed portion', () => {
    const keep = deriveToolShortlist(['web_search', 'bash', 'pdf_render'], allTools, {
      floor: [],
      maxTools: 1,
    }).map((t) => t.name);
    expect(keep).toEqual(['web_search']);
  });

  it('never returns empty: falls back to all tools when nothing matches', () => {
    const keep = deriveToolShortlist(['nonexistent_tool'], allTools, { floor: [] });
    expect(keep).toEqual(allTools);
  });
});
