// Local vector RAG over arbitrary project files.
//
// Single-file SQLite-free implementation: each index is a JSON document
// at `<projectDir>/.harness/rag/<name>.json` holding chunked embeddings
// produced by either the Ollama embeddings API (when reachable) or a
// deterministic feature-hash fallback (so the index works offline and
// in CI with no model server).
//
// The fallback isn't great quality but it's reproducible and lets the
// UI show meaningful results out of the box.  Backend choice is pinned
// into the index meta; queries refuse to mix encoders.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_OVERLAP = 200;
const HASH_DIM = 256;

export const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h',
  '.html', '.css', '.scss', '.sh', '.ps1', '.sql',
]);

export const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.harness']);

export interface RagBackend {
  /** "ollama" or "hash". Pinned in the index so a later query can't mix encoders. */
  name: string;
  /** Model id (Ollama) or pseudo-id ("feature-hash-256"). */
  model: string;
  dim: number;
}

export interface RagChunk {
  id: string;
  source: string;
  chunkNo: number;
  content: string;
  /** Quantized to int16 to keep the JSON file an order of magnitude smaller. */
  embedding: number[];
  sha1: string;
}

export interface RagIndexFile {
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  backend: RagBackend;
  chunks: RagChunk[];
}

export interface RagIndexSummary {
  name: string;
  path: string;
  chunks: number;
  files: number;
  backend: string;
  model: string;
  dim: number;
  updatedAt: string;
}

export interface RagSearchResult {
  source: string;
  chunkNo: number;
  content: string;
  /** Cosine similarity in [0, 1]. */
  score: number;
}

export interface RagPathDiagnostic {
  /** Original input path as given by the caller. */
  input: string;
  /** Resolved absolute path. */
  resolved: string;
  /** Outcome category for the path. */
  status: 'missing' | 'outside-project' | 'unsupported-extension' | 'empty-directory' | 'matched';
  /** Whether the resolved path is a file or directory (when known). */
  kind: 'file' | 'directory' | 'none';
  /** Number of indexable text files found under this path. */
  fileCount: number;
  /** Sample of matched files (project-relative), capped to keep payloads small. */
  sampleFiles: string[];
  /** Human-readable explanation suitable for direct display. */
  message: string;
}

export interface RagBuildPreview {
  paths: RagPathDiagnostic[];
  totalFiles: number;
  supportedExtensions: string[];
  skippedDirectories: string[];
}

function ragDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'rag');
}

function safeIndexName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function indexPath(projectDir: string, name: string): string {
  return path.join(ragDir(projectDir), `${safeIndexName(name)}.json`);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ─── Embedding backends ─────────────────────────────────────────────

async function embedWithOllama(texts: string[], model: string, host: string): Promise<number[][]> {
  // We call the REST endpoint directly so this module has no fresh deps
  // (the `ollama` npm package is already used elsewhere; using fetch keeps
  // the abstraction shallow and easier to mock in tests).
  const out: number[][] = [];
  for (const text of texts) {
    const response = await fetch(`${host.replace(/\/$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama embeddings ${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error('Ollama returned empty embedding');
    }
    out.push(data.embedding.map((v) => Number(v)));
  }
  return out;
}

function embedWithHash(texts: string[], dim: number = HASH_DIM): number[][] {
  // Token-feature-hash → unit vector. Deterministic, no network, fine for
  // smoke-testing semantic-ish behavior even when no model is reachable.
  return texts.map((text) => {
    const vec = new Array<number>(dim).fill(0);
    for (const token of text.toLowerCase().split(/\s+/)) {
      if (!token) continue;
      const h = crypto.createHash('md5').update(token).digest();
      const slot = h.readUInt32LE(0) % dim;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      vec[slot] += sign;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  });
}

export async function selectBackend(host: string, prefer?: 'ollama' | 'hash'): Promise<RagBackend> {
  if (prefer === 'hash') return { name: 'hash', model: 'feature-hash-256', dim: HASH_DIM };
  if (prefer === 'ollama') return { name: 'ollama', model: process.env.HARNESS_RAG_MODEL || 'nomic-embed-text', dim: 768 };
  // Auto: probe Ollama, fall back to hash on any failure.
  try {
    const probe = await fetch(`${host.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(800) });
    if (probe.ok) return { name: 'ollama', model: process.env.HARNESS_RAG_MODEL || 'nomic-embed-text', dim: 768 };
  } catch { /* fall through */ }
  return { name: 'hash', model: 'feature-hash-256', dim: HASH_DIM };
}

async function embedBatch(texts: string[], backend: RagBackend, host: string): Promise<number[][]> {
  if (backend.name === 'ollama') return embedWithOllama(texts, backend.model, host);
  return embedWithHash(texts, backend.dim);
}

// ─── File walking + chunking ───────────────────────────────────────

async function walkText(absRoot: string, projectDir: string, results: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12) return results;
  let stat;
  try { stat = await fs.stat(absRoot); } catch { return results; }
  if (stat.isFile()) {
    const ext = path.extname(absRoot).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) results.push(absRoot);
    return results;
  }
  if (!stat.isDirectory()) return results;
  // Skip noisy folders.
  const base = path.basename(absRoot);
  if (SKIPPED_DIR_NAMES.has(base)) return results;
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  for (const entry of entries) {
    await walkText(path.join(absRoot, entry.name), projectDir, results, depth + 1);
  }
  return results;
}

function chunkText(text: string, chunkChars = DEFAULT_CHUNK_CHARS, overlap = DEFAULT_OVERLAP): string[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkChars) return [trimmed];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const end = Math.min(trimmed.length, cursor + chunkChars);
    out.push(trimmed.slice(cursor, end));
    if (end >= trimmed.length) break;
    cursor = end - overlap;
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────

export async function listIndexes(projectDir: string): Promise<RagIndexSummary[]> {
  const dir = ragDir(projectDir);
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: RagIndexSummary[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      const idx = JSON.parse(content) as RagIndexFile;
      const sources = new Set(idx.chunks.map((c) => c.source));
      out.push({
        name: idx.name,
        path: path.join(dir, file),
        chunks: idx.chunks.length,
        files: sources.size,
        backend: idx.backend.name,
        model: idx.backend.model,
        dim: idx.backend.dim,
        updatedAt: idx.updatedAt,
      });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function previewBuild(
  projectDir: string,
  paths: string[],
): Promise<RagBuildPreview> {
  const diagnostics: RagPathDiagnostic[] = [];
  const allFiles = new Set<string>();
  for (const raw of paths) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    diagnostics.push(await diagnosePath(trimmed, projectDir, allFiles));
  }
  return {
    paths: diagnostics,
    totalFiles: allFiles.size,
    supportedExtensions: Array.from(TEXT_EXTENSIONS).sort(),
    skippedDirectories: Array.from(SKIPPED_DIR_NAMES).sort(),
  };
}

async function diagnosePath(
  input: string,
  projectDir: string,
  collected: Set<string>,
): Promise<RagPathDiagnostic> {
  const abs = path.isAbsolute(input) ? input : path.resolve(projectDir, input);
  let stat;
  try { stat = await fs.stat(abs); } catch {
    return { input, resolved: abs, status: 'missing', kind: 'none', fileCount: 0, sampleFiles: [], message: 'Path not found.' };
  }
  if (stat.isFile()) {
    const ext = path.extname(abs).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return { input, resolved: abs, status: 'unsupported-extension', kind: 'file', fileCount: 0, sampleFiles: [], message: `Files with extension '${ext || '(none)'}' are not indexed.` };
    }
    collected.add(abs);
    return { input, resolved: abs, status: 'matched', kind: 'file', fileCount: 1, sampleFiles: [path.relative(projectDir, abs) || path.basename(abs)], message: 'Single text file matched.' };
  }
  if (!stat.isDirectory()) {
    return { input, resolved: abs, status: 'missing', kind: 'none', fileCount: 0, sampleFiles: [], message: 'Path is not a regular file or directory.' };
  }
  const matches: string[] = [];
  await walkText(abs, projectDir, matches);
  for (const file of matches) collected.add(file);
  if (matches.length === 0) {
    return { input, resolved: abs, status: 'empty-directory', kind: 'directory', fileCount: 0, sampleFiles: [], message: 'Directory contains no indexable text files. Skipped folders include node_modules, .git, dist, and .harness.' };
  }
  const sampleFiles = matches.slice(0, 5).map((file) => path.relative(projectDir, file) || file);
  return { input, resolved: abs, status: 'matched', kind: 'directory', fileCount: matches.length, sampleFiles, message: `Matched ${matches.length} text file(s).` };
}

export interface RagBuildProgressEvent {
  stage: 'preview' | 'backend' | 'file' | 'done' | 'error';
  fileIndex?: number;
  totalFiles?: number;
  source?: string;
  chunks?: number;
  backend?: RagBackend;
  preview?: RagBuildPreview;
  files?: number;
  totalChunks?: number;
  message?: string;
}

export async function* iterateBuild(
  projectDir: string,
  name: string,
  paths: string[],
  options: { backend?: 'ollama' | 'hash'; ollamaHost: string; chunkChars?: number; overlap?: number } = { ollamaHost: 'http://localhost:11434' },
): AsyncGenerator<RagBuildProgressEvent> {
  await fs.mkdir(ragDir(projectDir), { recursive: true });
  const preview = await previewBuild(projectDir, paths);
  yield { stage: 'preview', preview, totalFiles: preview.totalFiles };
  const backend = await selectBackend(options.ollamaHost, options.backend);
  yield { stage: 'backend', backend };
  const filesToRead: string[] = [];
  for (const raw of paths) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(projectDir, raw);
    await walkText(abs, projectDir, filesToRead);
  }
  const chunks: RagChunk[] = [];
  for (let fileIndex = 0; fileIndex < filesToRead.length; fileIndex++) {
    const filePath = filesToRead[fileIndex];
    let content: string;
    try { content = await fs.readFile(filePath, 'utf-8'); } catch { continue; }
    const sha = crypto.createHash('sha1').update(content).digest('hex');
    const pieces = chunkText(content, options.chunkChars, options.overlap);
    if (pieces.length === 0) continue;
    const embeddings = await embedBatch(pieces, backend, options.ollamaHost);
    pieces.forEach((piece, i) => {
      chunks.push({
        id: crypto.randomUUID(),
        source: filePath,
        chunkNo: i,
        content: piece,
        embedding: embeddings[i],
        sha1: sha,
      });
    });
    yield { stage: 'file', fileIndex: fileIndex + 1, totalFiles: filesToRead.length, source: filePath, chunks: pieces.length };
  }
  const file: RagIndexFile = {
    version: 1,
    name: safeIndexName(name),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    backend,
    chunks,
  };
  await fs.writeFile(indexPath(projectDir, name), JSON.stringify(file), 'utf-8');
  yield { stage: 'done', files: new Set(chunks.map((c) => c.source)).size, totalChunks: chunks.length, backend, preview };
}

export async function build(
  projectDir: string,
  name: string,
  paths: string[],
  options: { backend?: 'ollama' | 'hash'; ollamaHost: string; chunkChars?: number; overlap?: number } = { ollamaHost: 'http://localhost:11434' },
): Promise<{ files: number; chunks: number; backend: RagBackend; preview: RagBuildPreview }> {
  let files = 0;
  let chunks = 0;
  let backend: RagBackend | undefined;
  let preview: RagBuildPreview | undefined;
  for await (const event of iterateBuild(projectDir, name, paths, options)) {
    if (event.stage === 'done') {
      files = event.files ?? 0;
      chunks = event.totalChunks ?? 0;
      backend = event.backend;
      preview = event.preview;
    }
  }
  if (!backend || !preview) throw new Error('iterateBuild did not produce a final result');
  return { files, chunks, backend, preview };
}

export async function search(
  projectDir: string,
  name: string,
  query: string,
  options: { k?: number; ollamaHost: string },
): Promise<RagSearchResult[]> {
  const idxPath = indexPath(projectDir, name);
  if (!(await fileExists(idxPath))) {
    throw new Error(`No such index: ${name} (build with POST /api/rag/build)`);
  }
  const raw = await fs.readFile(idxPath, 'utf-8');
  const idx = JSON.parse(raw) as RagIndexFile;
  if (idx.chunks.length === 0) return [];
  const [qvec] = await embedBatch([query], idx.backend, options.ollamaHost);
  const k = Math.max(1, Math.min(options.k ?? 5, 20));
  const qNorm = Math.sqrt(qvec.reduce((s, v) => s + v * v, 0)) || 1;
  const scored = idx.chunks.map((chunk) => {
    let dot = 0;
    let cn = 0;
    const len = Math.min(chunk.embedding.length, qvec.length);
    for (let i = 0; i < len; i++) {
      dot += chunk.embedding[i] * qvec[i];
      cn += chunk.embedding[i] * chunk.embedding[i];
    }
    const score = dot / ((Math.sqrt(cn) || 1) * qNorm);
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ chunk, score }) => ({
    source: chunk.source,
    chunkNo: chunk.chunkNo,
    content: chunk.content,
    score: Math.max(0, Math.min(1, score)),
  }));
}

export async function dropIndex(projectDir: string, name: string): Promise<boolean> {
  const idxPath = indexPath(projectDir, name);
  try { await fs.rm(idxPath, { force: true }); return true; } catch { return false; }
}
