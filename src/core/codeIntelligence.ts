// Code Intelligence — repo graph builder, symbol indexer, and impact analysis.
//
// Builds a lightweight dependency graph from TypeScript/JavaScript projects
// using import/require analysis. No external dependencies (no tree-sitter,
// no LSP) — pure regex + fs scanning suitable for the harness's needs.
//
// Feeds the mycelial router with structural codebase knowledge:
// - file dependencies
// - symbol exports
// - change impact radius
// - test file associations

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

// ─── Types ──────────────────────────────────────────────────────────

export interface CodeNode {
  /** Relative path from project root. */
  filePath: string;
  /** Exported symbol names. */
  exports: string[];
  /** Relative paths this file imports from. */
  imports: string[];
  /** Size in bytes. */
  size: number;
  /** Last modified ISO timestamp. */
  lastModified: string;
  /** Is this a test file? */
  isTest: boolean;
}

export interface CodeEdge {
  from: string; // filePath
  to: string;   // filePath
  type: 'imports' | 'tests' | 're_exports';
}

export interface RepoGraph {
  nodes: Map<string, CodeNode>;
  edges: CodeEdge[];
  built_at: string;
  root: string;
}

export interface ImpactAnalysis {
  /** Files directly affected. */
  direct: string[];
  /** Files transitively affected (importers of importers). */
  transitive: string[];
  /** Test files that should run. */
  affected_tests: string[];
  /** Risk score: 0-1 (based on how many files are affected). */
  risk_score: number;
}

export interface RepoSummary {
  total_files: number;
  total_edges: number;
  total_exports: number;
  test_files: number;
  most_imported: Array<{ file: string; count: number }>;
  most_complex: Array<{ file: string; imports: number; exports: number }>;
}

// ─── Graph building ─────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__\//];
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.harness', '.next', '.nuxt']);

/**
 * Load extra ignore dirs from .harness/code-intelligence-ignore.json or
 * HARNESS_CODE_INTEL_IGNORE env var (comma-separated directory names).
 */
function getExtraIgnoreDirs(projectDir: string): Set<string> {
  const extra = new Set<string>();
  // Env var
  const envIgnore = process.env.HARNESS_CODE_INTEL_IGNORE;
  if (envIgnore) {
    for (const dir of envIgnore.split(',')) {
      const trimmed = dir.trim();
      if (trimmed) extra.add(trimmed);
    }
  }
  return extra;
}

export async function buildRepoGraph(projectDir: string, options?: { maxFiles?: number; ignoreDirs?: string[] }): Promise<RepoGraph> {
  const maxFiles = options?.maxFiles ?? 5_000;
  const nodes = new Map<string, CodeNode>();
  const edges: CodeEdge[] = [];

  const extraIgnore = getExtraIgnoreDirs(projectDir);
  if (options?.ignoreDirs) {
    for (const dir of options.ignoreDirs) extraIgnore.add(dir);
  }

  await scanDir(projectDir, projectDir, nodes, maxFiles, extraIgnore);

  // Build edges from import analysis
  for (const [filePath, node] of nodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(filePath, imp, nodes);
      if (resolved) {
        edges.push({ from: filePath, to: resolved, type: 'imports' });
      }
    }

    // Associate test files with their subjects
    if (node.isTest) {
      const subject = inferTestSubject(filePath, nodes);
      if (subject) {
        edges.push({ from: filePath, to: subject, type: 'tests' });
      }
    }
  }

  return { nodes, edges, built_at: new Date().toISOString(), root: projectDir };
}

async function scanDir(
  dir: string,
  root: string,
  nodes: Map<string, CodeNode>,
  maxFiles: number,
  extraIgnore: Set<string> = new Set(),
): Promise<void> {
  if (nodes.size >= maxFiles) return;

  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (nodes.size >= maxFiles) return;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || extraIgnore.has(entry.name)) continue;
      await scanDir(path.join(dir, entry.name), root, nodes, maxFiles, extraIgnore);
      continue;
    }

    const ext = path.extname(entry.name);
    if (!CODE_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath).split(path.sep).join('/');

    try {
      const [content, stat] = await Promise.all([
        fs.readFile(fullPath, 'utf-8'),
        fs.stat(fullPath),
      ]);

      nodes.set(relPath, {
        filePath: relPath,
        exports: extractExports(content),
        imports: extractImports(content),
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
        isTest: TEST_PATTERNS.some((p) => p.test(relPath)),
      });
    } catch { /* skip unreadable files */ }
  }
}

// ─── Import / Export extraction ─────────────────────────────────────

function extractImports(content: string): string[] {
  const imports: string[] = [];
  // ES imports: import ... from '...'
  const esImportRe = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = esImportRe.exec(content))) {
    if (m[1].startsWith('.')) imports.push(m[1]);
  }
  // Dynamic imports: import('...')
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRe.exec(content))) {
    if (m[1].startsWith('.')) imports.push(m[1]);
  }
  // CommonJS: require('...')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(content))) {
    if (m[1].startsWith('.')) imports.push(m[1]);
  }
  return [...new Set(imports)];
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  // export function/class/const/let/var/type/interface name
  const namedRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  let m;
  while ((m = namedRe.exec(content))) {
    exports.push(m[1]);
  }
  // export { name, name2 }
  const braceRe = /export\s*\{([^}]+)\}/g;
  while ((m = braceRe.exec(content))) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
    exports.push(...names);
  }
  return [...new Set(exports)];
}

// ─── Resolution ─────────────────────────────────────────────────────

function resolveImport(fromFile: string, importPath: string, nodes: Map<string, CodeNode>): string | null {
  const dir = path.dirname(fromFile);
  const resolved = path.posix.normalize(path.posix.join(dir, importPath));

  // Try exact, .ts, .js, /index.ts, /index.js
  const candidates = [
    resolved,
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '.js',
    resolved + '.jsx',
    resolved + '/index.ts',
    resolved + '/index.js',
  ];

  for (const c of candidates) {
    if (nodes.has(c)) return c;
  }
  return null;
}

function inferTestSubject(testFile: string, nodes: Map<string, CodeNode>): string | null {
  // foo.test.ts → foo.ts
  const subject = testFile
    .replace(/\.test\.[jt]sx?$/, '')
    .replace(/\.spec\.[jt]sx?$/, '');

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (nodes.has(subject + ext)) return subject + ext;
  }
  return null;
}

// ─── Impact Analysis ────────────────────────────────────────────────

/** Analyze which files are affected when the given files change. */
export function analyzeImpact(graph: RepoGraph, changedFiles: string[]): ImpactAnalysis {
  const changed = new Set(changedFiles);

  // Build reverse dependency map (who imports this file?)
  const reverseMap = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.type !== 'imports') continue;
    if (!reverseMap.has(edge.to)) reverseMap.set(edge.to, new Set());
    reverseMap.get(edge.to)!.add(edge.from);
  }

  // Direct importers
  const direct = new Set<string>();
  for (const file of changed) {
    const importers = reverseMap.get(file);
    if (importers) {
      for (const imp of importers) {
        if (!changed.has(imp)) direct.add(imp);
      }
    }
  }

  // Transitive (BFS from direct)
  const transitive = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const importers = reverseMap.get(current);
    if (!importers) continue;
    for (const imp of importers) {
      if (!changed.has(imp) && !direct.has(imp) && !transitive.has(imp)) {
        transitive.add(imp);
        queue.push(imp);
      }
    }
  }

  // Test files related to changed or affected files
  const allAffected = new Set([...changed, ...direct, ...transitive]);
  const affected_tests = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.type === 'tests' && allAffected.has(edge.to)) {
      affected_tests.add(edge.from);
    }
  }

  // Also include test files that directly import changed files
  for (const file of allAffected) {
    const node = graph.nodes.get(file);
    if (node?.isTest) affected_tests.add(file);
  }

  const totalFiles = graph.nodes.size || 1;
  const risk_score = Math.min(1, allAffected.size / totalFiles);

  return {
    direct: [...direct],
    transitive: [...transitive],
    affected_tests: [...affected_tests],
    risk_score: Math.round(risk_score * 100) / 100,
  };
}

// ─── Summary ────────────────────────────────────────────────────────

export function summarizeRepo(graph: RepoGraph): RepoSummary {
  // Count how many files import each file
  const importCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type === 'imports') {
      importCount.set(edge.to, (importCount.get(edge.to) ?? 0) + 1);
    }
  }

  const most_imported = [...importCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  const most_complex = [...graph.nodes.values()]
    .sort((a, b) => (b.imports.length + b.exports.length) - (a.imports.length + a.exports.length))
    .slice(0, 10)
    .map((n) => ({ file: n.filePath, imports: n.imports.length, exports: n.exports.length }));

  return {
    total_files: graph.nodes.size,
    total_edges: graph.edges.length,
    total_exports: [...graph.nodes.values()].reduce((sum, n) => sum + n.exports.length, 0),
    test_files: [...graph.nodes.values()].filter((n) => n.isTest).length,
    most_imported,
    most_complex,
  };
}

// ─── Persistence ────────────────────────────────────────────────────

export async function saveRepoGraph(projectDir: string, graph: RepoGraph): Promise<void> {
  const fp = path.join(projectDir, '.harness', 'code-intelligence', 'repo-graph.json');
  // Serialize Map to array for JSON
  const serialized = {
    ...graph,
    nodes: [...graph.nodes.entries()],
  };
  await withFileLock(fp, () => atomicWriteFile(fp, JSON.stringify(serialized)));
}

export async function loadRepoGraph(projectDir: string): Promise<RepoGraph | null> {
  const fp = path.join(projectDir, '.harness', 'code-intelligence', 'repo-graph.json');
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      nodes: new Map(parsed.nodes),
    };
  } catch {
    return null;
  }
}

// ─── Architecture Diagram ───────────────────────────────────────────

/** Generate a mermaid graph diagram showing top-level module clusters and key dependencies. */
export function generateArchitectureDiagram(graph: RepoGraph, maxNodes = 40): string {
  // Group files by top-level directory
  const dirGroups = new Map<string, string[]>();
  for (const [filePath] of graph.nodes) {
    const parts = filePath.split('/');
    const dir = parts.length > 1 ? parts[0] : '(root)';
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(filePath);
  }

  // Build reverse import count for ranking
  const importCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.type === 'imports') {
      importCount.set(edge.to, (importCount.get(edge.to) ?? 0) + 1);
    }
  }

  // Pick top files by import count
  const topFiles = [...importCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNodes)
    .map(([file]) => file);
  const topSet = new Set(topFiles);

  const lines: string[] = ['graph LR'];

  // Create subgraphs per directory
  const dirIndex = new Map<string, string>();
  for (const [dir, files] of dirGroups) {
    const relevant = files.filter((f) => topSet.has(f));
    if (relevant.length === 0) continue;
    const safeName = dir.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  subgraph ${safeName}["${dir}"]`);
    for (const file of relevant) {
      const nodeId = file.replace(/[^a-zA-Z0-9]/g, '_');
      const shortName = file.split('/').pop() ?? file;
      const count = importCount.get(file) ?? 0;
      lines.push(`    ${nodeId}["${shortName} (${count})"]`);
      dirIndex.set(file, nodeId);
    }
    lines.push('  end');
  }

  // Add edges between top files (deduplicated)
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type !== 'imports') continue;
    const fromId = dirIndex.get(edge.from);
    const toId = dirIndex.get(edge.to);
    if (fromId && toId && fromId !== toId) {
      const key = `${fromId}-->${toId}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }

  return lines.join('\n');
}
