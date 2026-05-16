// Shared in-memory Mycelium graph store.
//
// Audit item from v0.5.8 (system audit extension): before this store, every
// chat request called `createMycelialRouter(projectDir)` which did
// `loadMyceliumGraph(projectDir)` from disk, mutated its OWN in-memory copy
// across the lifetime of the chat, then wrote the whole graph back via
// `saveMyceliumGraph`. Two overlapping chats both loaded the same baseline
// and the later writer silently overwrote the earlier writer's
// reinforcements. The atomic-write + file-lock added in v0.5.2 fixed bytes
// on disk but did not address the load-then-overwrite window.
//
// This store keeps a single `MyceliumGraph` instance per project directory
// in memory. All routers built for the same projectDir share that one
// instance, so concurrent reinforce/decay/seed calls accumulate on the same
// object instead of producing divergent snapshots that overwrite each other
// at save time. Disk flushes are serialized through `withFileLock` (already
// done by `saveMyceliumGraph`) and the in-memory mutation is the source of
// truth between flushes.
//
// Lifecycle:
// - First `getSharedMyceliumGraph(dir)` triggers a one-time disk load,
//   guarded by a per-projectDir loader promise so simultaneous first calls
//   do not double-load.
// - `flushSharedMyceliumGraph(dir)` writes the in-memory graph to disk via
//   the existing `saveMyceliumGraph` helper.
// - `resetSharedMyceliumGraphForTest()` drops the cache. Tests that need a
//   clean store between cases call this in `beforeEach`/`afterEach`.

import { MyceliumGraph, loadMyceliumGraph, saveMyceliumGraph } from './graph';

interface CacheEntry {
  graph: MyceliumGraph;
}

const cache = new Map<string, CacheEntry>();
const loaders = new Map<string, Promise<MyceliumGraph>>();

/**
 * Get the singleton in-memory graph for a project. First call loads from
 * disk; subsequent calls return the cached instance. Concurrent first-call
 * waiters share one disk-load.
 */
export async function getSharedMyceliumGraph(projectDir: string): Promise<MyceliumGraph> {
  const cached = cache.get(projectDir);
  if (cached) return cached.graph;
  let loader = loaders.get(projectDir);
  if (!loader) {
    loader = loadMyceliumGraph(projectDir).then((graph) => {
      cache.set(projectDir, { graph });
      loaders.delete(projectDir);
      return graph;
    }).catch((error) => {
      loaders.delete(projectDir);
      throw error;
    });
    loaders.set(projectDir, loader);
  }
  return loader;
}

/**
 * Write the cached graph back to disk. If the project has no cached graph
 * (no `getSharedMyceliumGraph` call yet), this is a no-op — there is
 * nothing to flush.
 */
export async function flushSharedMyceliumGraph(projectDir: string): Promise<void> {
  const cached = cache.get(projectDir);
  if (!cached) return;
  await saveMyceliumGraph(projectDir, cached.graph);
}

/** Test-only: drop all cached graphs. Production code must not call this. */
export function resetSharedMyceliumGraphForTest(): void {
  cache.clear();
  loaders.clear();
}

/** Register a graph instance in the cache (idempotent overwrite). Used by
 *  routers constructed directly (CLI, tests) so subsequent
 *  `getSharedMyceliumGraph` callers see the same instance, and so
 *  `flushSharedMyceliumGraph` has something to write. */
export function registerSharedMyceliumGraph(projectDir: string, graph: MyceliumGraph): void {
  cache.set(projectDir, { graph });
}
