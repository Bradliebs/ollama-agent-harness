#!/usr/bin/env node
/**
 * Code-graph indexer (spike, v0).
 *
 * Walks src/ with the TypeScript compiler API and writes a JSON graph
 * to .harness/code-graph.json with three "tables":
 *
 *   files: { path, hash, sloc }
 *   nodes: { id, kind, file, name, line, exported }
 *   edges: { src, dst, kind }   // kind: imports | contains | calls
 *
 * Schema mirrors the SQLite shape from the pitch — port is mechanical if
 * the spike earns its keep. JSON keeps zero native deps for now.
 *
 * Run: node scripts/build-code-graph.js
 *
 * Honest scope (v0):
 *   - Resolves `imports` edges via the TS resolver (real file-to-file).
 *   - Captures top-level functions, classes, class methods, exported vars.
 *   - Resolves `calls` edges only when the callee resolves to a symbol
 *     declared in this index. Method calls on inferred-type objects, dynamic
 *     requires, and re-exports are skipped — they would need a deeper
 *     traversal of the type-checker to be reliable.
 *   - Full rebuild every run. Incremental rebuild keyed on file hash is a
 *     v1 concern; the repo is small enough that a cold build is cheap.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

function listTsFiles(dir, _seen = new Set()) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function relTo(repoRoot, p) {
  return path.relative(repoRoot, p).replace(/\\/g, '/');
}

function hashFile(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex').slice(0, 16);
}

function nodeKindLabel(node) {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isVariableDeclaration(node)) return 'variable';
  return null;
}

function isExported(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function buildCodeGraph(opts = {}) {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const srcDir = opts.srcDir ?? path.join(repoRoot, 'src');
  const outDir = opts.outDir ?? path.join(repoRoot, '.harness');
  const outFile = opts.outFile ?? path.join(outDir, 'code-graph.json');
  const log = opts.log ?? (() => {});
  const rel = (p) => relTo(repoRoot, p);

  const startedAt = Date.now();
  const files = listTsFiles(srcDir);
  log(`[code-graph] scanning ${files.length} TS files under ${rel(srcDir)}/`);

  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  const tsconfig = ts.parseJsonConfigFileContent(
    ts.readConfigFile(tsconfigPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );

  const program = ts.createProgram({
    rootNames: files,
    options: { ...tsconfig.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

  const fileRows = [];
  const nodeRows = [];
  const edgeRows = [];
  const symbolToNodeId = new Map(); // ts.Symbol -> node id

  let nextId = 1;
  function newId(kind) {
    return `${kind}_${nextId++}`;
  }

  // First pass: register file + symbol nodes so calls can resolve to ids.
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const filePath = rel(sf.fileName);
    if (!filePath.startsWith('src/')) continue;

    const fileId = newId('file');
    fileRows.push({
      path: filePath,
      hash: hashFile(sf.fileName),
      sloc: sf.text.split(/\r?\n/).length,
      nodeId: fileId,
    });
    nodeRows.push({ id: fileId, kind: 'file', file: filePath, name: filePath, line: 1, exported: false });

    const visit = (node, classNodeId) => {
      const kind = nodeKindLabel(node);
      if (kind && node.name && ts.isIdentifier(node.name)) {
        const id = newId(kind);
        const exported = isExported(node) || (classNodeId !== undefined && kind === 'method');
        nodeRows.push({
          id,
          kind,
          file: filePath,
          name: node.name.text,
          line: lineOf(node, sf),
          exported,
        });
        edgeRows.push({ src: classNodeId ?? fileId, dst: id, kind: 'contains' });
        const sym = checker.getSymbolAtLocation(node.name);
        if (sym) symbolToNodeId.set(sym, id);
        if (kind === 'class') {
          ts.forEachChild(node, (child) => visit(child, id));
          return;
        }
      }
      if (kind === null || kind === 'function' || kind === 'variable') {
        ts.forEachChild(node, (child) => visit(child, classNodeId));
      }
    };
    ts.forEachChild(sf, (child) => visit(child, undefined));
  }

  // Second pass: import + call edges, now that all symbol→id mappings exist.
  const fileNodeByPath = new Map(fileRows.map((f) => [f.path, f.nodeId]));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const filePath = rel(sf.fileName);
    if (!filePath.startsWith('src/')) continue;
    const srcFileId = fileNodeByPath.get(filePath);

    // Imports.
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const resolved = ts.resolveModuleName(
          stmt.moduleSpecifier.text,
          sf.fileName,
          program.getCompilerOptions(),
          ts.sys,
        );
        const target = resolved.resolvedModule?.resolvedFileName;
        if (target) {
          const targetPath = rel(target);
          const targetId = fileNodeByPath.get(targetPath);
          if (targetId) edgeRows.push({ src: srcFileId, dst: targetId, kind: 'imports' });
        }
      }
    }

    // Calls — resolved through the type checker, walking everything.
    const enclosingStack = [];
    const visit = (node) => {
      let pushed = false;
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        if (node.name) {
          const sym = checker.getSymbolAtLocation(node.name);
          const id = sym && symbolToNodeId.get(sym);
          if (id) {
            enclosingStack.push(id);
            pushed = true;
          }
        }
      }
      if (ts.isCallExpression(node)) {
        let calleeSym = checker.getSymbolAtLocation(
          ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression,
        );
        // Imports give us the alias symbol; chase through to the real declaration.
        if (calleeSym && calleeSym.flags & ts.SymbolFlags.Alias) {
          try { calleeSym = checker.getAliasedSymbol(calleeSym); } catch { /* unresolved alias */ }
        }
        const calleeId = calleeSym && symbolToNodeId.get(calleeSym);
        const callerId = enclosingStack[enclosingStack.length - 1] ?? srcFileId;
        if (calleeId && calleeId !== callerId) {
          edgeRows.push({ src: callerId, dst: calleeId, kind: 'calls' });
        }
      }
      ts.forEachChild(node, visit);
      if (pushed) enclosingStack.pop();
    };
    ts.forEachChild(sf, visit);
  }

  // Dedupe edges (caller→callee can repeat for repeat call sites).
  const seen = new Set();
  const dedupedEdges = edgeRows.filter((e) => {
    const k = `${e.src}|${e.dst}|${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = {
    schema: 1,
    builtAt: new Date().toISOString(),
    repo: rel(repoRoot) || '.',
    counts: {
      files: fileRows.length,
      nodes: nodeRows.length,
      edges: dedupedEdges.length,
      imports: dedupedEdges.filter((e) => e.kind === 'imports').length,
      contains: dedupedEdges.filter((e) => e.kind === 'contains').length,
      calls: dedupedEdges.filter((e) => e.kind === 'calls').length,
    },
    files: fileRows,
    nodes: nodeRows,
    edges: dedupedEdges,
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  const ms = Date.now() - startedAt;
  log(`[code-graph] wrote ${rel(outFile)} (${ms}ms)`);
  log(
    `[code-graph]   files=${out.counts.files} nodes=${out.counts.nodes} ` +
      `imports=${out.counts.imports} contains=${out.counts.contains} calls=${out.counts.calls}`,
  );
  return { ...out, durationMs: ms, outFile };
}

module.exports = { buildCodeGraph, DEFAULT_REPO_ROOT };

if (require.main === module) {
  buildCodeGraph({ log: (...args) => console.log(...args) });
}
