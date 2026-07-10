import express from 'express';

import { MCP_CATALOG } from '../extensibility/mcpCatalog';
import { discoverMcpServerTools, invokeMcpServerTool, listMcpServers, removeMcpServer, startMcpServer, stopMcpServer, upsertMcpServer } from '../extensibility/mcpRuntime';
import { evaluateCapabilityGrant, type CapabilityGrant } from '../permissions/capabilities';
import { appendCapabilityAuditEvent } from '../permissions/capabilityAudit';

export interface McpRoutesDeps {
  projectDir: string;
  getCapabilityGrants: () => CapabilityGrant[];
  isKillSwitchActive: () => boolean;
  ensureSettingsLoaded: () => Promise<void>;
}

function safeLocalId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id.length > 0 && /^[a-zA-Z0-9._-]+$/.test(id) ? id : null;
}

function splitShellLikeArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote === 'single') {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function parseMcpInstallCommand(install: string): { command: string; args: string[] } {
  const parts = splitShellLikeArgs(install).map((part) => part === '${PWD}' ? '.' : part);
  const command = parts[0]?.trim();
  if (!command) throw new Error('MCP catalog entry is missing an install command.');
  return { command, args: parts.slice(1) };
}

export function createMcpRouter(deps: McpRoutesDeps): express.Router {
  const { projectDir, getCapabilityGrants, isKillSwitchActive, ensureSettingsLoaded } = deps;
  const router = express.Router();

  router.get('/api/mcp/catalog', (_req, res) => {
    res.json({ catalog: MCP_CATALOG });
  });

  router.get('/api/mcp/runtime', async (_req, res) => {
    try {
      res.json({ servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/servers', async (req, res) => {
    try {
      const server = await upsertMcpServer(projectDir, req.body ?? {});
      res.json({ server, servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/from-catalog', async (req, res) => {
    try {
      const catalogName = safeLocalId(req.body?.name);
      if (!catalogName) { res.status(400).json({ error: 'Invalid MCP catalog name.' }); return; }
      const entry = MCP_CATALOG.find((item) => item.name === catalogName);
      if (!entry) { res.status(404).json({ error: 'MCP catalog entry not found.' }); return; }
      const existing = (await listMcpServers(projectDir)).find((server) => server.id === catalogName);
      if (existing && req.body?.overwrite !== true) {
        res.status(409).json({ error: 'MCP runtime server already exists. Pass overwrite=true to replace it.' });
        return;
      }
      const parsed = parseMcpInstallCommand(entry.install);
      const server = await upsertMcpServer(projectDir, {
        id: catalogName,
        catalogName: entry.name,
        command: parsed.command,
        args: parsed.args,
        env: Object.fromEntries((entry.requiresEnv || []).map((key) => [key, ''])),
        tools: [],
        enabled: true,
      });
      res.json({ server, servers: await listMcpServers(projectDir), requiresEnv: entry.requiresEnv });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/mcp/runtime/servers/:id', async (req, res) => {
    try {
      const removed = await removeMcpServer(projectDir, req.params.id);
      if (!removed) { res.status(404).json({ error: 'MCP server not found.' }); return; }
      res.json({ ok: true, servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/servers/:id/start', async (req, res) => {
    try {
      await ensureSettingsLoaded();
      const evaluation = evaluateCapabilityGrant('arbitrary-shell', getCapabilityGrants(), { killSwitchActive: isKillSwitchActive() });
      if (evaluation.decision !== 'allow') {
        res.status(403).json({ error: `MCP server start blocked by arbitrary-shell: ${evaluation.reason}`, evaluation });
        return;
      }
      const server = await startMcpServer(projectDir, req.params.id);
      await appendCapabilityAuditEvent(projectDir, { type: 'mcp_server.started', serverId: server.id, command: server.command });
      res.json({ server, servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/servers/:id/stop', async (req, res) => {
    try {
      const stopped = await stopMcpServer(req.params.id);
      await appendCapabilityAuditEvent(projectDir, { type: 'mcp_server.stopped', serverId: String(req.params.id ?? '') });
      res.json({ stopped, servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/servers/:id/discover-tools', async (req, res) => {
    try {
      if (isKillSwitchActive()) { res.status(403).json({ error: 'Kill switch is active.' }); return; }
      const server = await discoverMcpServerTools(projectDir, req.params.id);
      res.json({ server, servers: await listMcpServers(projectDir) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/mcp/runtime/servers/:id/tools/:toolName/invoke', async (req, res) => {
    try {
      if (isKillSwitchActive()) { res.status(403).json({ error: 'Kill switch is active.' }); return; }
      const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      const result = await invokeMcpServerTool(projectDir, req.params.id, req.params.toolName, input);
      res.json({ result });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
