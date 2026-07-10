import express from 'express';

export interface ToolEntry {
  name: string;
  description: string;
  toolset: string;
  source: string;
  enabledByDefault: boolean;
  enabled: boolean;
  enabledUntil?: string;
  isReadOnly: boolean;
  riskLevel: string;
  permissionCategory: string;
  canDryRun: boolean;
}

export interface ToolStatus {
  tools: ToolEntry[];
  toolsets: Record<string, number>;
  disabled: string[];
  capabilities: { items: unknown[]; summary: unknown; coverage: unknown };
}

export interface ToggleResult {
  name: string;
  enabled: boolean;
  enabledUntil?: string;
  disabled: string[];
}

export interface BulkToggleResult {
  toggled: Array<{ name: string; enabled: boolean; enabledUntil?: string }>;
  disabled: string[];
}

export interface ToolsRouterDeps {
  getToolStatus: () => ToolStatus;
  toggleTool: (
    name: string,
    enabled: boolean | undefined,
    expiresInMinutes: number | undefined,
  ) => Promise<ToggleResult | null>;
  bulkToggleTools: (
    names: string[],
    enabled: boolean,
    expiresInMinutes: number | undefined,
  ) => Promise<BulkToggleResult>;
}

function parseExpiresInMinutes(raw: unknown): number | undefined {
  return typeof raw === 'number' && raw > 0 ? Math.min(raw, 1440) : undefined;
}

export function createToolsRouter(deps: ToolsRouterDeps): express.Router {
  const router = express.Router();

  router.get('/api/tools', (_req, res) => {
    try {
      res.json(deps.getToolStatus());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/tools/:name/toggle', async (req, res) => {
    try {
      const toolName = String(req.params.name || '').trim();
      if (!toolName) { res.status(400).json({ error: 'tool name required' }); return; }
      const enabled = req.body?.enabled === undefined ? undefined : Boolean(req.body.enabled);
      const expiresInMinutes = parseExpiresInMinutes(req.body?.expiresInMinutes);
      const result = await deps.toggleTool(toolName, enabled, expiresInMinutes);
      if (!result) { res.status(404).json({ error: 'unknown tool' }); return; }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/tools/bulk-toggle', async (req, res) => {
    try {
      const names = Array.isArray(req.body?.names) ? req.body.names.map((n: unknown) => String(n)) : [];
      const enabled = Boolean(req.body?.enabled);
      const expiresInMinutes = parseExpiresInMinutes(req.body?.expiresInMinutes);
      const result = await deps.bulkToggleTools(names, enabled, expiresInMinutes);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
