// Tests for the new mycelial router modules added per Network.md.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MyceliumGraph, loadMyceliumGraph } from './graph';
import { spreadActivation, selectRoute } from './activation';
import { decayUnusedEdges, pruneDeadEdges, weakenRoute } from './reinforcement';
import { classifyTask, getExplorationRate, isHighRiskTaskType } from './taskClassifier';
import { seedGenericGraph, SAFETY_NODES, GENERIC_VERIFIER_NODES } from './seeds';
import { buildContextPackage, buildRouteExplanation, formatRouteExplanation } from './contextPackage';
import { heuristicVerifier } from './verifier';
import { MycelialContextRouter } from './router';
import { runMyceliumCli } from './cli';

// ─── Task classifier ───────────────────────────────────────────────

describe('classifyTask', () => {
  it('routes coding queries to coding', () => {
    expect(classifyTask('Implement a function to parse JSON').type).toBe('coding');
    expect(classifyTask('refactor this module to use async/await').type).toBe('coding');
  });

  it('routes debugging queries to debugging', () => {
    expect(classifyTask('I get a stack trace when calling foo()').type).toBe('debugging');
    expect(classifyTask('Why is my failing test broken?').type).toBe('debugging');
  });

  it('routes research/planning/writing/creative correctly', () => {
    expect(classifyTask('Investigate the latest on retrieval augmented generation').type).toBe('research');
    expect(classifyTask('Build a roadmap for next quarter').type).toBe('planning');
    expect(classifyTask('Write an email to the team about the launch').type).toBe('writing');
    expect(classifyTask('Brainstorm a brand name for our new product').type).toBe('creative');
  });

  it('routes high-risk verbs to safety_critical', () => {
    const c = classifyTask('Please rm -rf the production secrets');
    expect(c.type).toBe('safety_critical');
    expect(c.highRisk).toBe(true);
    expect(c.explorationRate).toBeLessThanOrEqual(0.05);
  });

  it('routes financial execution verbs to financial_execution', () => {
    const c = classifyTask('Place an order to buy 100 shares right now');
    expect(c.type).toBe('financial_execution');
    expect(c.highRisk).toBe(true);
  });

  it('high-risk wins over coding even when both match', () => {
    const c = classifyTask('Implement a function to delete production data');
    expect(c.type).toBe('safety_critical');
    expect(c.highRisk).toBe(true);
  });

  it('defaults to general when nothing matches', () => {
    const c = classifyTask('hello');
    expect(c.type).toBe('general');
    expect(c.highRisk).toBe(false);
  });

  it('exposes per-task exploration rates', () => {
    expect(getExplorationRate('research')).toBeGreaterThan(getExplorationRate('coding'));
    expect(getExplorationRate('safety_critical')).toBeLessThan(0.05);
  });

  it('flags high-risk task types', () => {
    expect(isHighRiskTaskType('safety_critical')).toBe(true);
    expect(isHighRiskTaskType('financial_execution')).toBe(true);
    expect(isHighRiskTaskType('medical')).toBe(true);
    expect(isHighRiskTaskType('legal')).toBe(true);
    expect(isHighRiskTaskType('coding')).toBe(false);
  });
});

// ─── Seeds ─────────────────────────────────────────────────────────

describe('seedGenericGraph', () => {
  it('seeds safety, agent, prompt, workflow, verifier, and preference nodes', () => {
    const graph = new MyceliumGraph();
    const summary = seedGenericGraph(graph);

    expect(summary.nodesAdded).toBeGreaterThan(0);
    expect(summary.edgesAdded).toBeGreaterThan(0);
    // Safety nodes are protected.
    for (const n of SAFETY_NODES) {
      const node = graph.getNode(n.id);
      expect(node).toBeDefined();
      expect(node!.protected).toBe(true);
    }
    // At least the protected verifiers from spec are protected.
    expect(graph.getNode('verifier.safety_check')!.protected).toBe(true);
    expect(graph.getNode('verifier.code_test_check')!.protected).toBe(true);
  });

  it('is idempotent', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const first = graph.stats();
    seedGenericGraph(graph);
    const second = graph.stats();
    expect(second.nodes).toBe(first.nodes);
    expect(second.edges).toBe(first.edges);
  });

  it('protected edges from seeds cannot be archived by prune', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    // Force a protected edge's weight under the threshold.
    const edge = graph.getEdge('agent.coder', 'agent.verifier')!;
    edge.weight = 0.001;
    expect(edge.protected).toBe(true);
    const archived = pruneDeadEdges(graph);
    expect(archived).toBe(0);
    expect(graph.getEdge('agent.coder', 'agent.verifier')).toBeDefined();
  });

  it('seeded edges carry origin="seeded" and a relation type', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const edge = graph.getEdge('agent.coder', 'agent.verifier')!;
    expect(edge.origin).toBe('seeded');
    expect(edge.relation).toBe('must_verify_with');
  });

  it('addEdge accepts and persists optional origin + relation', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'tool.a', type: 'tool', label: 'a', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'tool.b', type: 'tool', label: 'b', trust: 0.5, cost: 0 });
    graph.addEdge('tool.a', 'tool.b', 0.4, { relation: 'sequence_learning', origin: 'sequence' });
    const e = graph.getEdge('tool.a', 'tool.b')!;
    expect(e.origin).toBe('sequence');
    expect(e.relation).toBe('sequence_learning');

    // Re-adding with no options should preserve the original tags.
    graph.addEdge('tool.a', 'tool.b', 0.6);
    const e2 = graph.getEdge('tool.a', 'tool.b')!;
    expect(e2.weight).toBe(0.6);
    expect(e2.origin).toBe('sequence');
    expect(e2.relation).toBe('sequence_learning');
  });
});

// ─── Archive (instead of hard-delete) ──────────────────────────────

describe('archive on prune', () => {
  it('moves weak edges to the archive store instead of deleting them', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'tool', label: 'a', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'b', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.01);

    const archived = pruneDeadEdges(graph);
    expect(archived).toBe(1);
    expect(graph.getEdge('a', 'b')).toBeUndefined();
    const archive = graph.listArchivedEdges();
    expect(archive).toHaveLength(1);
    expect(archive[0].edge.source).toBe('a');
    expect(archive[0].reason).toContain('below threshold');
  });

  it('does not archive protected edges even when weak', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'safety', label: 'a', trust: 1, cost: 0, protected: true });
    graph.addNode({ id: 'b', type: 'verifier', label: 'b', trust: 1, cost: 0, protected: true });
    const e = graph.addEdge('a', 'b', 0.01);
    e.protected = true;

    const archived = pruneDeadEdges(graph);
    expect(archived).toBe(0);
    expect(graph.listArchivedEdges()).toHaveLength(0);
  });

  it('protected edges respect the decay floor', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'safety', label: 'a', trust: 1, cost: 0, protected: true });
    graph.addNode({ id: 'b', type: 'verifier', label: 'b', trust: 1, cost: 0, protected: true });
    const edge = graph.addEdge('a', 'b', 0.5);
    edge.protected = true;

    // Many decay cycles must not push the protected edge below the floor.
    for (let i = 0; i < 200; i++) decayUnusedEdges(graph);
    expect(graph.getEdge('a', 'b')!.weight).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('weakenRoute does not punish protected edges', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'safety', label: 'a', trust: 1, cost: 0, protected: true });
    graph.addNode({ id: 'b', type: 'verifier', label: 'b', trust: 1, cost: 0, protected: true });
    const e = graph.addEdge('a', 'b', 0.6);
    e.protected = true;

    weakenRoute(graph, ['a', 'b'], 1);
    // Weight must not have dropped.
    expect(graph.getEdge('a', 'b')!.weight).toBeGreaterThanOrEqual(0.6);
    // Failure count must not have ticked up.
    expect(graph.getEdge('a', 'b')!.failureCount).toBe(0);
  });
});

// ─── Activation cycle prevention ───────────────────────────────────

describe('spreadActivation cycle handling', () => {
  it('does not blow up on cycles and caps activation at 1.0', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'q', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'a', type: 'tool', label: 'a', trust: 0.8, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'b', trust: 0.8, cost: 0 });
    graph.addEdge('q', 'a', 0.9);
    graph.addEdge('a', 'b', 0.9);
    graph.addEdge('b', 'a', 0.9); // back-edge
    graph.addEdge('a', 'a', 1.0); // self-loop ignored

    const activated = spreadActivation(graph, 'q', { hops: 5 });
    for (const n of activated) expect(n.activation).toBeLessThanOrEqual(1.0001);
    expect(activated.find((n) => n.id === 'a')).toBeDefined();
    expect(activated.find((n) => n.id === 'b')).toBeDefined();
  });
});

// ─── Route selector with protected required + selection reasons ────

describe('selectRoute with protected required edges', () => {
  it('always includes protected edges whose endpoints are activated', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'q', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'agent.coder', type: 'agent', label: 'coder', trust: 0.7, cost: 0.2 });
    graph.addNode({ id: 'agent.verifier', type: 'agent', label: 'verifier', trust: 0.9, cost: 0.1, protected: true });
    graph.addEdge('q', 'agent.coder', 0.9);
    const protectedEdge = graph.addEdge('agent.coder', 'agent.verifier', 0.05);
    protectedEdge.protected = true;

    const activated = spreadActivation(graph, 'q');
    const route = selectRoute(graph, activated, { maxNodes: 3, exploreRate: 0, random: () => 1 });

    expect(route.protectedRequiredEdges.length).toBeGreaterThanOrEqual(1);
    const reasons = Array.from(route.selectionReasons.values());
    expect(reasons).toContain('protected_required');
  });

  it('records exploitation vs exploration reasons', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'q', type: 'query', label: 'q', trust: 1, cost: 0 });
    graph.addNode({ id: 'a', type: 'tool', label: 'a', trust: 0.8, cost: 0 });
    graph.addEdge('q', 'a', 0.9);

    const activated = spreadActivation(graph, 'q');
    // Force exploration.
    const route = selectRoute(graph, activated, { maxNodes: 3, exploreRate: 1, random: () => 0 });
    expect(route.exploratoryEdges.length).toBeGreaterThanOrEqual(1);

    // Force exploitation.
    const route2 = selectRoute(graph, activated, { maxNodes: 3, exploreRate: 0, random: () => 1 });
    expect(route2.exploitedEdges.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Context package + explanation ─────────────────────────────────

describe('contextPackage', () => {
  it('builds a structured package grouped by node type', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    const result = router.routeQueryRich('Write a python function to compute fibonacci');

    expect(result.contextPackage.task_type).toBe('coding');
    expect(result.contextPackage.high_risk).toBe(false);
    // Verifiers / safety should be present in the package thanks to seeds.
    const allItems = [
      ...result.contextPackage.selected_agents,
      ...result.contextPackage.selected_workflows,
      ...result.contextPackage.selected_verifiers,
      ...result.contextPackage.selected_safety,
    ];
    expect(allItems.length).toBeGreaterThan(0);
    expect(result.contextPackage.dry_run).toBe(false);
  });

  it('high-risk task includes safety/verifier nodes and clamps exploration', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);

    const result = router.routeQueryRich('Please rm -rf the production data right now', { dryRun: true });
    expect(result.contextPackage.high_risk).toBe(true);
    expect(result.contextPackage.exploration_rate).toBeLessThanOrEqual(0.05);
    // At least one safety node should appear.
    expect(result.contextPackage.selected_safety.length).toBeGreaterThanOrEqual(1);
  });

  it('formats a route explanation with no thrown errors', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    const result = router.routeQueryRich('refactor this code');
    const explanation = buildRouteExplanation({
      classification: result.classification,
      route: result.selectedRoute,
      graph,
    });
    const formatted = formatRouteExplanation(explanation);
    expect(formatted).toContain('Task type: coding');
    expect(formatted).toContain('Selected route:');
  });

  it('deduplicates repeated node IDs in the ordered route', () => {
    // Build a route with multiple edges sharing a target — verifier hub.
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    const result = router.routeQueryRich('plan a research workflow');

    const ids = result.explanation.selectedRoute;
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      expect(count).toBe(1); // each node ID appears at most once
    }
  });
});

// ─── Heuristic verifier ────────────────────────────────────────────

describe('heuristicVerifier', () => {
  function makePackage(overrides: Partial<{ high_risk: boolean; dry_run: boolean }> = {}) {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    const result = router.routeQueryRich('Implement a JSON parser');
    const pkg = result.contextPackage;
    if (overrides.high_risk !== undefined) pkg.high_risk = overrides.high_risk;
    if (overrides.dry_run !== undefined) pkg.dry_run = overrides.dry_run;
    return pkg;
  }

  it('scores a normal completed run between 0 and 1', () => {
    const pkg = makePackage();
    const v = heuristicVerifier({ response: 'Here is the implementation. It parses JSON correctly.', contextPackage: pkg, toolCallCount: 2, toolSuccessCount: 2 });
    expect(v.score).toBeGreaterThan(0);
    expect(v.score).toBeLessThanOrEqual(1);
    expect(v.failedHardCheck).toBe(false);
  });

  it('penalises errored runs', () => {
    const pkg = makePackage();
    const v = heuristicVerifier({ response: '', contextPackage: pkg, errored: true });
    expect(v.score).toBeLessThan(0.6);
  });

  it('rewards refusing a high-risk action', () => {
    const pkg = makePackage({ high_risk: true });
    const v = heuristicVerifier({ response: 'I cannot do that.', contextPackage: pkg, refused: true });
    expect(v.components.safety).toBe(1);
  });

  it('flags high-risk actions executed without dry-run', () => {
    const pkg = makePackage({ high_risk: true, dry_run: false });
    const v = heuristicVerifier({
      response: 'Done. I deleted the production database for you.',
      contextPackage: pkg,
    });
    expect(v.failedHardCheck).toBe(true);
    expect(v.components.safety).toBeLessThan(0.5);
  });

  it('uses real outputValidationScore over heuristic verifier_coverage', () => {
    const pkg = makePackage();
    const v = heuristicVerifier({
      response: 'Implementation done.',
      contextPackage: pkg,
      realSignals: { outputValidationScore: 0.95, outputValidationStatus: 'pass' },
    });
    expect(v.components.verifier_coverage).toBeCloseTo(0.95, 2);
    expect(v.appliedVerifiers).toContain('verifier.task_completion');
    expect(v.notes.some((n) => n.includes('Output validation'))).toBe(true);
  });

  it('treats output validation status="fail" as a hard check failure', () => {
    const pkg = makePackage();
    const v = heuristicVerifier({
      response: 'Implementation done.',
      contextPackage: pkg,
      realSignals: { outputValidationScore: 0.3, outputValidationStatus: 'fail' },
    });
    expect(v.failedHardCheck).toBe(true);
  });

  it('uses test pass/fail counts to drive task_completion', () => {
    const pkg = makePackage();
    const v = heuristicVerifier({
      response: 'Tests run.',
      contextPackage: pkg,
      realSignals: { testPasses: 9, testFailures: 1 },
    });
    expect(v.components.task_completion).toBeCloseTo(0.9, 2);
    expect(v.appliedVerifiers).toContain('verifier.code_test_check');
  });

  it('penalises lint errors and schema check failures', () => {
    const pkg = makePackage();
    const baseline = heuristicVerifier({ response: 'OK.', contextPackage: pkg, realSignals: { outputValidationScore: 0.9, outputValidationStatus: 'pass' } });
    const lintBad = heuristicVerifier({ response: 'OK.', contextPackage: pkg, realSignals: { outputValidationScore: 0.9, outputValidationStatus: 'pass', lintErrors: 5 } });
    expect(lintBad.components.verifier_coverage).toBeLessThan(baseline.components.verifier_coverage);

    const schemaFail = heuristicVerifier({ response: 'OK.', contextPackage: pkg, realSignals: { schemaCheckPass: false } });
    expect(schemaFail.components.verifier_coverage).toBeLessThanOrEqual(0.3);
    expect(schemaFail.appliedVerifiers).toContain('verifier.schema_check');
  });

  it('per-tool success ratios pull tool_reliability down to the worst tool', () => {
    const pkg = makePackage();
    const baseline = heuristicVerifier({ response: 'OK.', contextPackage: pkg, toolCallCount: 10, toolSuccessCount: 10 });
    expect(baseline.components.tool_reliability).toBe(1);

    const withSilentWebFailure = heuristicVerifier({
      response: 'OK.',
      contextPackage: pkg,
      toolCallCount: 10,
      toolSuccessCount: 10,
      realSignals: { toolSuccessRatios: { web_fetch: 0.2 } },
    });
    expect(withSilentWebFailure.components.tool_reliability).toBe(0.2);
    expect(withSilentWebFailure.notes.some((n) => n.includes('web_fetch'))).toBe(true);
  });
});

// ─── Router routeQueryRich + dry-run ───────────────────────────────

describe('MycelialContextRouter.routeQueryRich', () => {
  it('produces classification, package, and explanation', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    const r = router.routeQueryRich('Investigate the latest research on diffusion models');
    expect(r.classification.type).toBe('research');
    expect(r.contextPackage.user_query).toContain('diffusion models');
    expect(r.explanation.taskType).toBe('research');
    expect(router.getLastClassification()?.type).toBe('research');
    expect(router.formatLastExplanation()).toContain('Task type: research');
  });

  it('high-risk routing clamps exploration to near zero', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph, { exploreRate: 1 });
    const r = router.routeQueryRich('rm -rf production now', { dryRun: true });
    // Per safety: exploration must be near zero on high-risk tasks.
    expect(r.classification.explorationRate).toBeLessThanOrEqual(0.05);
    // No exploratory edges should have been chosen.
    expect(r.selectedRoute.exploratoryEdges.length).toBe(0);
  });
});

// ─── CLI ───────────────────────────────────────────────────────────

describe('mycelium CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycelium-cli-'));
  });

  afterEach(async () => {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('init creates the graph file', async () => {
    const r = await runMyceliumCli({ projectDir: dir, args: ['init'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Mycelium graph initialised');
  });

  it('seed populates generic nodes idempotently', async () => {
    const r1 = await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    expect(r1.exitCode).toBe(0);
    const stats1 = (await loadMyceliumGraph(dir)).stats();
    expect(stats1.nodes).toBeGreaterThan(0);

    const r2 = await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    expect(r2.exitCode).toBe(0);
    const stats2 = (await loadMyceliumGraph(dir)).stats();
    expect(stats2.nodes).toBe(stats1.nodes);
  });

  it('route --dry-run does not mutate the graph', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const before = (await loadMyceliumGraph(dir)).stats();
    const r = await runMyceliumCli({ projectDir: dir, args: ['route', '--query', 'Investigate diffusion models', '--dry-run'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('[DRY RUN]');
    const after = (await loadMyceliumGraph(dir)).stats();
    // Dry run must not record an episode either.
    expect(after.episodes).toBe(before.episodes);
  });

  it('classify prints a verdict for high-risk queries', async () => {
    const r = await runMyceliumCli({ projectDir: dir, args: ['classify', '--query', 'Place an order to buy 100 shares now'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('financial_execution');
    expect(r.output).toContain('high_risk:         true');
  });

  it('status prints counts after seeding', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const r = await runMyceliumCli({ projectDir: dir, args: ['status'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('protected nodes:');
    expect(r.output).toContain('archived edges:');
  });

  it('router-status is an alias for status', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const r = await runMyceliumCli({ projectDir: dir, args: ['router-status'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Mycelium router status');
  });

  it('show-node and show-edges print details for a known node', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const r = await runMyceliumCli({ projectDir: dir, args: ['show-node', 'agent.verifier'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Node agent.verifier');

    const r2 = await runMyceliumCli({ projectDir: dir, args: ['show-edges', 'agent.verifier'] });
    expect(r2.exitCode).toBe(0);
    expect(r2.output).toContain('Edges for agent.verifier');
  });

  it('export writes a JSON file', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const target = path.join(dir, 'export.json');
    const r = await runMyceliumCli({ projectDir: dir, args: ['export', target] });
    expect(r.exitCode).toBe(0);
    const text = await fs.readFile(target, 'utf-8');
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it('prune --dry-run lists candidates without mutating', async () => {
    // Seed the generic graph, then push one edge below threshold to give
    // prune --dry-run something to find.
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const { loadMyceliumGraph, saveMyceliumGraph } = await import('./graph');
    const graph = await loadMyceliumGraph(dir);
    graph.addNode({ id: 'tool.weak', type: 'tool', label: 'weak', trust: 0.1, cost: 0 });
    graph.addNode({ id: 'tool.target', type: 'tool', label: 'target', trust: 0.1, cost: 0 });
    graph.addEdge('tool.weak', 'tool.target', 0.01);
    await saveMyceliumGraph(dir, graph);
    const beforeStats = (await loadMyceliumGraph(dir)).stats();

    const r = await runMyceliumCli({ projectDir: dir, args: ['prune', '--dry-run'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('[DRY RUN]');
    expect(r.output).toContain('tool.weak -> tool.target');

    // Graph must be unchanged after a dry-run.
    const afterStats = (await loadMyceliumGraph(dir)).stats();
    expect(afterStats.edges).toBe(beforeStats.edges);
    expect(afterStats.archivedEdges).toBe(beforeStats.archivedEdges);
  });

  it('decay --dry-run previews next weights without mutating', async () => {
    await runMyceliumCli({ projectDir: dir, args: ['seed'] });
    const { loadMyceliumGraph, saveMyceliumGraph } = await import('./graph');
    const graph = await loadMyceliumGraph(dir);
    // Add an edge that would cross the prune threshold after one decay cycle.
    graph.addNode({ id: 'tool.about-to-die', type: 'tool', label: 'dying', trust: 0.1, cost: 0 });
    graph.addNode({ id: 'tool.dst', type: 'tool', label: 'dst', trust: 0.1, cost: 0 });
    graph.addEdge('tool.about-to-die', 'tool.dst', 0.031); // 0.031 * 0.98 = 0.0304 > 0.03 — should NOT be archivable
    graph.addEdge('tool.about-to-die', 'tool.about-to-die', 0.025); // already below; will stay below
    await saveMyceliumGraph(dir, graph);
    const beforeWeights = (await loadMyceliumGraph(dir)).listEdges().map((e) => e.weight);

    const r = await runMyceliumCli({ projectDir: dir, args: ['decay', '--dry-run'] });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('[DRY RUN]');
    expect(r.output).toContain('beta=0.02');

    // Weights must be unchanged on disk.
    const afterWeights = (await loadMyceliumGraph(dir)).listEdges().map((e) => e.weight);
    expect(afterWeights).toEqual(beforeWeights);
  });
});

// ─── Block tracking ────────────────────────────────────────────────

describe('graph.markRouteBlocked + episode block flag', () => {
  it('bumps blockedCount + lastBlockedAt for each edge along the route', () => {
    const graph = new MyceliumGraph();
    graph.addNode({ id: 'a', type: 'tool', label: 'a', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'b', type: 'tool', label: 'b', trust: 0.5, cost: 0 });
    graph.addNode({ id: 'c', type: 'tool', label: 'c', trust: 0.5, cost: 0 });
    graph.addEdge('a', 'b', 0.5);
    graph.addEdge('b', 'c', 0.5);

    const touched = graph.markRouteBlocked(['a', 'b', 'c']);
    expect(touched).toBe(2);
    expect(graph.getEdge('a', 'b')!.blockedCount).toBe(1);
    expect(graph.getEdge('b', 'c')!.blockedCount).toBe(1);
    expect(graph.getEdge('a', 'b')!.lastBlockedAt).toBeTruthy();

    graph.markRouteBlocked(['a', 'b', 'c']);
    expect(graph.getEdge('a', 'b')!.blockedCount).toBe(2);
  });

  it('records episode with blocked=true and propagates appliedVerifiers', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    router.routeQueryRich('Implement a JSON parser');

    router.reinforce(
      { taskSuccess: 0.2, correctness: 0.1, usefulness: 0.1, costEfficiency: 0.5, userSatisfaction: 0.1 },
      { blocked: true, blockReason: 'output_validation:fail', appliedVerifiers: ['verifier.task_completion'] },
    );

    const last = graph.listEpisodes(1)[0];
    expect(last.blocked).toBe(true);
    expect(last.blockReason).toBe('output_validation:fail');
    expect(last.appliedVerifiers).toContain('verifier.task_completion');
  });

  it('does not reinforce a blocked route even when the score would normally pass', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    router.routeQueryRich('Implement a JSON parser');

    // High reward components but blocked=true should still weaken the route.
    const beforeWeights = graph.listEdges().map((e) => ({ src: e.source, tgt: e.target, w: e.weight }));
    router.reinforce(
      { taskSuccess: 1, correctness: 1, usefulness: 1, costEfficiency: 1, userSatisfaction: 1 },
      { blocked: true, blockReason: 'verifier_hard_check' },
    );
    // Find an unprotected edge that was on the route; its weight should not have grown.
    const lastRoute = router.getLastRoute();
    let foundUnprotected = false;
    for (let i = 0; i < lastRoute.length - 1; i++) {
      const before = beforeWeights.find((b) => b.src === lastRoute[i] && b.tgt === lastRoute[i + 1]);
      const edge = graph.getEdge(lastRoute[i], lastRoute[i + 1]);
      if (before && edge && !edge.protected) {
        foundUnprotected = true;
        expect(edge.weight).toBeLessThanOrEqual(before.w);
      }
    }
    // Either we found at least one unprotected edge to verify, OR the route
    // contained only protected edges (which is also valid behaviour).
    if (!foundUnprotected) expect(graph.listProtectedEdges().length).toBeGreaterThan(0);
  });

  it('applyUserFeedback records a fresh episode tagged with the vote', () => {
    const graph = new MyceliumGraph();
    seedGenericGraph(graph);
    const router = new MycelialContextRouter('/tmp', graph);
    router.routeQueryRich('Plan a workflow with verifier and agent steps');

    // Down-vote.
    const result = router.applyUserFeedback('down', 'unhelpful');
    expect(result.applied).toBe(true);
    const last = graph.listEpisodes(1)[0];
    expect((last as { userFeedback?: string }).userFeedback).toBe('down');
    expect(last.reward).toBeLessThan(0.6); // down-vote drives lower reward

    // Up-vote should produce a higher-reward episode.
    router.applyUserFeedback('up');
    const upEp = graph.listEpisodes(1)[0];
    expect((upEp as { userFeedback?: string }).userFeedback).toBe('up');
    expect(upEp.reward).toBeGreaterThan(last.reward);
  });

  it('applyUserFeedback returns applied=false when no route exists', () => {
    const graph = new MyceliumGraph();
    const router = new MycelialContextRouter('/tmp', graph);
    const result = router.applyUserFeedback('up');
    expect(result.applied).toBe(false);
  });
});
