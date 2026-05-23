import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadBeforeWriteGate } from './readBeforeWriteGate';
import { ToolDispatcher } from './dispatcher';
import type { Tool, ToolResult } from '../types';

// ─── Unit tests for ReadBeforeWriteGate ──────────────────────────────

describe('ReadBeforeWriteGate', () => {
  it('allows a write after a read of the same path', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    gate.recordRead('/project/src/risk.ts');
    const check = gate.checkWrite('/project/src/risk.ts', 'file_edit');
    expect(check.allowed).toBe(true);
    expect(check.wasRead).toBe(true);
  });

  it('blocks a write to an unread existing file in enforce mode', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    const check = gate.checkWrite('/project/src/risk.ts', 'file_edit');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('file_read required');
  });

  it('allows writing a new file in enforce mode (file does not exist)', () => {
    const tmpDir = os.tmpdir();
    const newPath = path.join(tmpDir, `rbw-new-${Date.now()}.ts`);
    const gate = new ReadBeforeWriteGate({ mode: 'enforce', allowNewFiles: true });
    const check = gate.checkWrite(newPath, 'file_write');
    expect(check.allowed).toBe(true);
    expect(check.isNewFile).toBe(true);
  });

  it('blocks new file creation when allowNewFiles is false', () => {
    const tmpDir = os.tmpdir();
    const newPath = path.join(tmpDir, `rbw-new-${Date.now()}.ts`);
    const gate = new ReadBeforeWriteGate({ mode: 'enforce', allowNewFiles: false });
    const check = gate.checkWrite(newPath, 'file_write');
    expect(check.allowed).toBe(false);
  });

  it('warns but allows in warn mode', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gate = new ReadBeforeWriteGate({ mode: 'warn' });
    const check = gate.checkWrite('/project/src/risk.ts', 'file_edit');
    expect(check.allowed).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ReadBeforeWriteGate'));
    stderrSpy.mockRestore();
  });

  it('passes through without side-effects in off mode', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gate = new ReadBeforeWriteGate({ mode: 'off' });
    const result = gate.gateTool('file_edit', { path: '/project/src/risk.ts' });
    expect(result.allowed).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('honours explicit path exemptions', () => {
    const exemptPath = path.resolve('/project/logs/run.log');
    const gate = new ReadBeforeWriteGate({ mode: 'enforce', exemptPaths: [exemptPath] });
    const check = gate.checkWrite(exemptPath, 'file_write');
    expect(check.allowed).toBe(true);
    expect(check.isExempt).toBe(true);
  });

  it('records violations', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'warn' });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    gate.checkWrite('/project/src/risk.ts', 'file_edit');
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0].path).toBe('/project/src/risk.ts');
    jest.restoreAllMocks();
  });

  it('gateTool records reads and allows subsequent writes', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    // Simulate reading via gateTool
    gate.gateTool('file_read', { path: '/project/src/risk.ts' });
    // Now write should pass
    const result = gate.gateTool('file_edit', { path: '/project/src/risk.ts' });
    expect(result.allowed).toBe(true);
  });

  it('gateTool blocks write when path was never read', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    const result = gate.gateTool('file_edit', { path: '/project/src/risk.ts' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('file_read required');
  });

  it('readPaths returns normalized absolute paths', () => {
    const gate = new ReadBeforeWriteGate();
    gate.recordRead('src/risk.ts');
    expect(gate.readPaths[0]).toBe(path.resolve('src/risk.ts'));
  });

  it('reset clears ledger and violations', () => {
    const gate = new ReadBeforeWriteGate({ mode: 'warn' });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    gate.recordRead('/project/src/risk.ts');
    gate.checkWrite('/project/src/foo.ts', 'file_edit');
    gate.reset();
    expect(gate.readCount).toBe(0);
    expect(gate.violations).toHaveLength(0);
    jest.restoreAllMocks();
  });
});

// ─── Integration with ToolDispatcher ─────────────────────────────────

function makeTool(name: string, isReadOnly: boolean, handler?: (input: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute: handler ?? (async () => ({ success: true, output: `${name} executed` })),
  };
}

describe('ReadBeforeWriteGate + ToolDispatcher integration', () => {
  let tmpDir: string;
  let existingFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbw-'));
    existingFile = path.join(tmpDir, 'existing.ts');
    fs.writeFileSync(existingFile, 'const x = 1;');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatcher blocks file_edit when gate is in enforce mode and file was not read', async () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    const writeTool = makeTool('file_edit', false);
    const dispatcher = new ToolDispatcher([writeTool]);

    const results = await dispatcher.dispatch(
      [{ name: 'file_edit', input: { path: existingFile } }],
      undefined,
      undefined,
      { readBeforeWriteGate: gate },
    );

    expect(results[0].result.success).toBe(false);
    expect(results[0].result.output).toContain('Read-before-write gate blocked');
  });

  it('dispatcher allows file_edit after file_read in same batch', async () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce' });
    const readTool  = makeTool('file_read',  true);
    const writeTool = makeTool('file_edit', false);
    const dispatcher = new ToolDispatcher([readTool, writeTool]);

    // First dispatch: read
    await dispatcher.dispatch(
      [{ name: 'file_read', input: { path: existingFile } }],
      undefined,
      undefined,
      { readBeforeWriteGate: gate },
    );

    // Second dispatch: write (should now be allowed)
    const results = await dispatcher.dispatch(
      [{ name: 'file_edit', input: { path: existingFile } }],
      undefined,
      undefined,
      { readBeforeWriteGate: gate },
    );

    expect(results[0].result.success).toBe(true);
  });

  it('dispatcher allows file_write to a brand-new file without prior read', async () => {
    const gate = new ReadBeforeWriteGate({ mode: 'enforce', allowNewFiles: true });
    const newFilePath = path.join(tmpDir, 'brand-new.ts');
    const writeTool = makeTool('file_write', false);
    const dispatcher = new ToolDispatcher([writeTool]);

    const results = await dispatcher.dispatch(
      [{ name: 'file_write', input: { path: newFilePath } }],
      undefined,
      undefined,
      { readBeforeWriteGate: gate },
    );

    expect(results[0].result.success).toBe(true);
  });

  it('dispatcher passes through unchanged when no gate is set', async () => {
    const writeTool = makeTool('file_edit', false);
    const dispatcher = new ToolDispatcher([writeTool]);

    const results = await dispatcher.dispatch(
      [{ name: 'file_edit', input: { path: existingFile } }],
    );

    expect(results[0].result.success).toBe(true);
  });
});
