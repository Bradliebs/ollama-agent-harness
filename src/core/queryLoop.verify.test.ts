import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { resolveVerifyEnabled } from './queryLoop';

describe('resolveVerifyEnabled', () => {
  const original = process.env.HARNESS_VERIFY;
  let codeDir: string;
  let bareDir: string;

  beforeAll(() => {
    codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-code-'));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bare-'));
    fs.writeFileSync(path.join(codeDir, 'package.json'), '{}', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(codeDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.HARNESS_VERIFY;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.HARNESS_VERIFY;
    else process.env.HARNESS_VERIFY = original;
  });

  it('auto-enables for a directory with package.json', () => {
    expect(resolveVerifyEnabled(undefined, codeDir)).toBe(true);
  });

  it('stays off for a directory without package.json', () => {
    expect(resolveVerifyEnabled(undefined, bareDir)).toBe(false);
  });

  it('stays off when no cwd is supplied (shared-loop default)', () => {
    expect(resolveVerifyEnabled(undefined)).toBe(false);
  });

  it('honours explicit enabled=false over auto-detect', () => {
    expect(resolveVerifyEnabled(false, codeDir)).toBe(false);
  });

  it('honours explicit enabled=true over auto-detect', () => {
    expect(resolveVerifyEnabled(true, bareDir)).toBe(true);
  });

  it('lets HARNESS_VERIFY=0 force off even when explicitly enabled', () => {
    process.env.HARNESS_VERIFY = '0';
    expect(resolveVerifyEnabled(true, codeDir)).toBe(false);
  });

  it('lets HARNESS_VERIFY=1 force on even in a non-code directory', () => {
    process.env.HARNESS_VERIFY = '1';
    expect(resolveVerifyEnabled(false, bareDir)).toBe(true);
  });

  it('treats off/on string aliases as overrides', () => {
    process.env.HARNESS_VERIFY = 'off';
    expect(resolveVerifyEnabled(undefined, codeDir)).toBe(false);
    process.env.HARNESS_VERIFY = 'on';
    expect(resolveVerifyEnabled(undefined, bareDir)).toBe(true);
  });
});
