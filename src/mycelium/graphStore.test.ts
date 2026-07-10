import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createMycelialRouter } from './router';
import { resetSharedMyceliumGraphForTest, getSharedMyceliumGraph } from './graphStore';
import { loadMyceliumGraph } from './graph';

describe('mycelium shared graph store', () => {
  afterEach(() => {
    resetSharedMyceliumGraphForTest();
  });

  it('returns the same in-memory graph instance for concurrent routers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mycelium-shared-'));

    const [a, b] = await Promise.all([
      createMycelialRouter(dir),
      createMycelialRouter(dir),
    ]);
    expect(a.getGraph()).toBe(b.getGraph());
  });

  it('survives concurrent first-load callers without double-loading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mycelium-shared-'));
    const [g1, g2, g3] = await Promise.all([
      getSharedMyceliumGraph(dir),
      getSharedMyceliumGraph(dir),
      getSharedMyceliumGraph(dir),
    ]);
    expect(g1).toBe(g2);
    expect(g2).toBe(g3);
  });

  it('concurrent seedings accumulate on the shared graph (no overwrite race)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mycelium-shared-'));

    const [a, b] = await Promise.all([
      createMycelialRouter(dir),
      createMycelialRouter(dir),
    ]);
    a.seedToolNodes([{ name: 'bash', description: 'Shell' }]);
    b.seedToolNodes([{ name: 'edit', description: 'Editor' }]);

    await a.save();
    await b.save();

    resetSharedMyceliumGraphForTest();
    const onDisk = await loadMyceliumGraph(dir);
    const ids = onDisk.listNodes().map((n) => n.id).sort();
    expect(ids).toContain('tool.bash');
    expect(ids).toContain('tool.edit');
  });
});
