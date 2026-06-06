import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';
import { McpStdioClient, type McpProtocolTool, type McpToolCallResult } from './mcpClient';
import {
  globalMcpCapabilityCache,
  type CapabilityFetchResult,
  type GetToolsOptions,
} from './mcpCapabilityCache';

export interface McpConfiguredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerDefinition {
  id: string;
  catalogName?: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  tools: McpConfiguredTool[];
}

export interface McpServerStatus extends McpServerDefinition {
  running: boolean;
  pid?: number;
  startedAt?: string;
  lastExitCode?: number | null;
  lastError?: string;
}

interface RunningMcpServer {
  process: ChildProcessWithoutNullStreams;
  client: McpStdioClient;
  startedAt: string;
  lastError?: string;
}

const MCP_SERVERS_PATH = path.join('.harness', 'mcp', 'servers.json');
const MAX_STDERR_LENGTH = 4_000;
const runningServers = new Map<string, RunningMcpServer>();
const lastExitCodes = new Map<string, number | null>();

export async function listMcpServers(projectDir: string): Promise<McpServerStatus[]> {
  const definitions = await readMcpServerDefinitions(projectDir);
  return definitions.map((definition) => toStatus(definition));
}

export async function upsertMcpServer(projectDir: string, input: Record<string, unknown>): Promise<McpServerStatus> {
  const definition = sanitizeMcpServerDefinition(input);
  await withFileLock(path.join(projectDir, MCP_SERVERS_PATH), async () => {
    const definitions = await readMcpServerDefinitions(projectDir);
    const existingIndex = definitions.findIndex((item) => item.id === definition.id);
    if (existingIndex >= 0) definitions[existingIndex] = definition;
    else definitions.push(definition);
    await writeMcpServerDefinitionsUnlocked(projectDir, definitions);
  });
  return toStatus(definition);
}

export async function removeMcpServer(projectDir: string, id: string): Promise<boolean> {
  const normalizedId = normalizeMcpId(id);
  if (!normalizedId) return false;
  await stopMcpServer(normalizedId);
  // stopMcpServer only invalidates when the server was actively running.
  // Cover the case where the server exited on its own before removal.
  globalMcpCapabilityCache.invalidate(normalizedId);
  return withFileLock(path.join(projectDir, MCP_SERVERS_PATH), async () => {
    const definitions = await readMcpServerDefinitions(projectDir);
    const next = definitions.filter((item) => item.id !== normalizedId);
    if (next.length === definitions.length) return false;
    await writeMcpServerDefinitionsUnlocked(projectDir, next);
    return true;
  });
}

export async function startMcpServer(projectDir: string, id: string): Promise<McpServerStatus> {
  const definition = await findMcpServerDefinition(projectDir, id);
  if (!definition) throw new Error('MCP server not found.');
  const active = runningServers.get(definition.id);
  if (active) {
    if (!active.process.killed) {
      try { active.process.kill('SIGTERM'); } catch { /* already exiting */ }
    }
    runningServers.delete(definition.id);
  }

  const cwd = resolveMcpCwd(projectDir, definition.cwd);
  const launch = resolveMcpLaunch(definition.command, definition.args);
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: buildMcpProcessEnv(definition.env),
    windowsHide: true,
  });

  const record: RunningMcpServer = { process: child, client: new McpStdioClient(child), startedAt: new Date().toISOString() };
  runningServers.set(definition.id, record);
  lastExitCodes.delete(definition.id);

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    record.lastError = (record.lastError ? record.lastError + text : text).slice(-MAX_STDERR_LENGTH);
  });
  child.on('error', (error) => {
    record.lastError = error.message;
  });
  child.on('exit', (code) => {
    lastExitCodes.set(definition.id, code);
    runningServers.delete(definition.id);
  });

  return toStatus(definition);
}

export async function discoverMcpServerTools(projectDir: string, id: string): Promise<McpServerStatus> {
  const definition = await findMcpServerDefinition(projectDir, id);
  if (!definition) throw new Error('MCP server not found.');
  const active = runningServers.get(definition.id);
  if (!active || active.process.killed) throw new Error('MCP server is not running.');
  // Force-refresh: explicit user-driven discovery always re-fetches and
  // persists, but still populates the in-memory cache for downstream readers.
  const result = await globalMcpCapabilityCache.getTools(
    definition.id,
    () => active.client.listTools(),
    { forceRefresh: true },
  );
  await withFileLock(path.join(projectDir, MCP_SERVERS_PATH), async () => {
    const definitions = await readMcpServerDefinitions(projectDir);
    const index = definitions.findIndex((item) => item.id === definition.id);
    if (index >= 0) {
      definitions[index] = { ...definitions[index], tools: result.tools };
      await writeMcpServerDefinitionsUnlocked(projectDir, definitions);
    }
  });
  return toStatus({ ...definition, tools: result.tools });
}

/**
 * Read-through capability lookup. Prefers the in-memory cache; on miss or
 * `forceRefresh`, calls the running server's `tools/list` via the cache so
 * concurrent callers collapse to one roundtrip and transient failures fall
 * back to the last-known-good list (per {@link McpCapabilityCache}).
 *
 * If the server isn't running, falls back to the persisted on-disk tool list
 * (no roundtrip, treated as fresh-from-disk and reported as `cached: true,
 * stale: true` so callers can tell it isn't a live fetch).
 */
export async function getMcpServerCapabilities(
  projectDir: string,
  id: string,
  opts: GetToolsOptions = {},
): Promise<CapabilityFetchResult> {
  const definition = await findMcpServerDefinition(projectDir, id);
  if (!definition) throw new Error('MCP server not found.');
  const active = runningServers.get(definition.id);
  if (active && !active.process.killed) {
    return globalMcpCapabilityCache.getTools(
      definition.id,
      () => active.client.listTools(),
      opts,
    );
  }
  // Server is not running — best effort: serve whatever the on-disk definition
  // has. Marked stale because no live confirmation is available.
  const cached = globalMcpCapabilityCache.peek(definition.id);
  if (cached) {
    return {
      tools: cached.tools,
      cached: true,
      stale: true,
      fetchedAt: cached.fetchedAt,
      lastError: cached.lastError,
    };
  }
  return {
    tools: definition.tools.map(toolDefinitionToProtocol),
    cached: true,
    stale: true,
    fetchedAt: 0,
  };
}

function toolDefinitionToProtocol(tool: McpConfiguredTool): McpProtocolTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export async function invokeMcpServerTool(projectDir: string, serverId: string, toolName: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
  const definition = await findMcpServerDefinition(projectDir, serverId);
  if (!definition) throw new Error('MCP server not found.');
  if (!definition.enabled) throw new Error('MCP server is disabled.');
  const configured = definition.tools.find((tool) => tool.name === toolName);
  if (!configured) throw new Error('MCP tool is not configured. Discover tools before invocation.');
  const active = runningServers.get(definition.id);
  if (!active || active.process.killed) throw new Error('MCP server is not running.');
  return active.client.callTool(toolName, input);
}

export async function stopMcpServer(id: string): Promise<boolean> {
  const normalizedId = normalizeMcpId(id);
  const active = normalizedId ? runningServers.get(normalizedId) : undefined;
  if (!active) return false;
  const exitPromise = new Promise<void>((resolve) => {
    active.process.once('exit', () => resolve());
  });
  active.process.kill();
  runningServers.delete(normalizedId);
  globalMcpCapabilityCache.invalidate(normalizedId);
  await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
  return true;
}

export async function stopAllMcpServers(): Promise<void> {
  for (const id of Array.from(runningServers.keys())) await stopMcpServer(id);
  globalMcpCapabilityCache.clear();
}

export async function readMcpServerDefinitions(projectDir: string): Promise<McpServerDefinition[]> {
  try {
    const raw = await fs.readFile(path.join(projectDir, MCP_SERVERS_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => sanitizeMcpServerDefinition(item as Record<string, unknown>));
  } catch {
    return [];
  }
}

export function readMcpServerDefinitionsSync(projectDir: string): McpServerDefinition[] {
  try {
    const raw = fsSync.readFileSync(path.join(projectDir, MCP_SERVERS_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => sanitizeMcpServerDefinition(item as Record<string, unknown>));
  } catch {
    return [];
  }
}

async function findMcpServerDefinition(projectDir: string, id: string): Promise<McpServerDefinition | undefined> {
  const normalizedId = normalizeMcpId(id);
  if (!normalizedId) return undefined;
  return (await readMcpServerDefinitions(projectDir)).find((item) => item.id === normalizedId);
}

async function writeMcpServerDefinitions(projectDir: string, definitions: McpServerDefinition[]): Promise<void> {
  const filePath = path.join(projectDir, MCP_SERVERS_PATH);
  await withFileLock(filePath, () => writeMcpServerDefinitionsUnlocked(projectDir, definitions));
}

// Internal: write without taking the lock. Callers must already hold the
// lock for path.join(projectDir, MCP_SERVERS_PATH).
async function writeMcpServerDefinitionsUnlocked(projectDir: string, definitions: McpServerDefinition[]): Promise<void> {
  const filePath = path.join(projectDir, MCP_SERVERS_PATH);
  await atomicWriteFile(filePath, JSON.stringify(definitions, null, 2));
}

function sanitizeMcpServerDefinition(input: Record<string, unknown>): McpServerDefinition {
  const id = normalizeMcpId(input.id);
  if (!id) throw new Error('MCP server id is required and may contain only letters, numbers, dots, underscores, and dashes.');
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('MCP server command is required.');
  const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)).slice(0, 50) : [];
  const env = sanitizeStringRecord(input.env);
  return {
    id,
    catalogName: typeof input.catalogName === 'string' ? input.catalogName.trim().slice(0, 80) || undefined : undefined,
    command: command.slice(0, 260),
    args,
    cwd: typeof input.cwd === 'string' ? input.cwd.trim().slice(0, 260) || undefined : undefined,
    env,
    enabled: input.enabled !== false,
    tools: sanitizeConfiguredTools(input.tools),
  };
}

function sanitizeConfiguredTools(value: unknown): McpConfiguredTool[] {
  if (!Array.isArray(value)) return [];
  const tools: McpConfiguredTool[] = [];
  for (const item of value.slice(0, 100)) {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = normalizeMcpId(raw.name);
    if (!name) continue;
    tools.push({
      name,
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 500) || undefined : undefined,
      inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema as Record<string, unknown> : undefined,
    });
  }
  return tools;
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    const normalizedKey = key.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(normalizedKey)) continue;
    output[normalizedKey] = String(rawValue).slice(0, 2_000);
  }
  return Object.keys(output).length ? output : undefined;
}

function normalizeMcpId(value: unknown): string {
  const id = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]{1,80}$/.test(id) ? id : '';
}

function resolveMcpCwd(projectDir: string, cwd?: string): string {
  if (!cwd) return projectDir;
  const resolved = path.resolve(projectDir, cwd);
  const relative = path.relative(projectDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('MCP server cwd must stay inside the project directory.');
  return resolved;
}

function resolveCommandForPlatform(command: string): string {
  if (os.platform() !== 'win32') return command;
  if (/^(npm|npx|pnpm|yarn|uvx)$/i.test(command)) return `${command}.cmd`;
  return command;
}

function resolveMcpLaunch(command: string, args: string[]): { command: string; args: string[] } {
  const resolvedCommand = resolveCommandForPlatform(command);
  if (os.platform() !== 'win32' || !/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', [resolvedCommand, ...args].map(quoteWindowsCommandArg).join(' ')],
  };
}

function quoteWindowsCommandArg(value: string): string {
  if (/^[A-Za-z0-9_/:.=+-]+$/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function buildMcpProcessEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isValidEnvKey(key)) continue;
    if (!isValidEnvValue(value)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (!isValidEnvKey(key)) continue;
    if (!isValidEnvValue(value)) continue;
    env[key] = value;
  }
  return env;
}

function isValidEnvKey(key: string): boolean {
  return Boolean(key) && !key.includes('=') && !key.includes('\0');
}

function isValidEnvValue(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function toStatus(definition: McpServerDefinition): McpServerStatus {
  const active = runningServers.get(definition.id);
  return {
    ...definition,
    running: Boolean(active && !active.process.killed),
    pid: active?.process.pid,
    startedAt: active?.startedAt,
    lastExitCode: lastExitCodes.get(definition.id),
    lastError: active?.lastError,
  };
}
