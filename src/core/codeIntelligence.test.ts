import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildRepoGraph, analyzeImpact, summarizeRepo, saveRepoGraph, loadRepoGraph } from './codeIntelligence';

describe('codeIntelligence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-codeintel-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('builds graph from a small project', async () => {
    // Set up a mini project
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\nexport const PI = 3.14;\n');
    await fs.writeFile(path.join(srcDir, 'main.ts'), "import { add } from './utils';\nexport function run() { return add(1, 2); }\n");
    await fs.writeFile(path.join(srcDir, 'main.test.ts'), "import { run } from './main';\ntest('run', () => expect(run()).toBe(3));\n");

    const graph = await buildRepoGraph(tmpDir);
    expect(graph.nodes.size).toBe(3);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);

    // main.ts imports utils.ts
    const importEdge = graph.edges.find((e) => e.from === 'src/main.ts' && e.to === 'src/utils.ts');
    expect(importEdge).toBeDefined();
    expect(importEdge!.type).toBe('imports');

    // main.test.ts is a test file
    const testNode = graph.nodes.get('src/main.test.ts');
    expect(testNode?.isTest).toBe(true);
  });

  it('extracts exports correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'mod.ts'), 'export class Foo {}\nexport type Bar = string;\nexport const baz = 1;\nexport { Foo as default };\n');

    const graph = await buildRepoGraph(tmpDir);
    const node = graph.nodes.get('mod.ts');
    expect(node?.exports).toContain('Foo');
    expect(node?.exports).toContain('Bar');
    expect(node?.exports).toContain('baz');
  });

  it('analyzes impact of changes', async () => {
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'a.ts'), 'export const A = 1;\n');
    await fs.writeFile(path.join(srcDir, 'b.ts'), "import { A } from './a';\nexport const B = A + 1;\n");
    await fs.writeFile(path.join(srcDir, 'c.ts'), "import { B } from './b';\nexport const C = B + 1;\n");
    await fs.writeFile(path.join(srcDir, 'a.test.ts'), "import { A } from './a';\ntest('A', () => expect(A).toBe(1));\n");

    const graph = await buildRepoGraph(tmpDir);
    const impact = analyzeImpact(graph, ['src/a.ts']);

    expect(impact.direct).toContain('src/b.ts');
    expect(impact.transitive).toContain('src/c.ts');
    expect(impact.affected_tests).toContain('src/a.test.ts');
    expect(impact.risk_score).toBeGreaterThan(0);
  });

  it('summarizes repo', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.ts'), "export { run } from './run';\n");
    await fs.writeFile(path.join(tmpDir, 'run.ts'), 'export function run() {}\n');

    const graph = await buildRepoGraph(tmpDir);
    const summary = summarizeRepo(graph);
    expect(summary.total_files).toBe(2);
    expect(summary.total_edges).toBeGreaterThanOrEqual(1);
  });

  it('saves and loads graph', async () => {
    await fs.writeFile(path.join(tmpDir, 'mod.ts'), 'export const X = 1;\n');
    const graph = await buildRepoGraph(tmpDir);
    await saveRepoGraph(tmpDir, graph);

    const loaded = await loadRepoGraph(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes.size).toBe(graph.nodes.size);
  });

  it('returns null for missing graph', async () => {
    const loaded = await loadRepoGraph(tmpDir);
    expect(loaded).toBeNull();
  });

  it('ignores node_modules', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
    await fs.writeFile(path.join(tmpDir, 'index.ts'), "require('./node_modules/pkg');\n");

    const graph = await buildRepoGraph(tmpDir);
    expect(graph.nodes.has('node_modules/pkg/index.js')).toBe(false);
  });
});
