import * as path from 'path';
import { promises as fs } from 'fs';
import express from 'express';

import type { Tool } from '../types';
import type { IChatClient } from '../core/chatClient';
import type { AgentDefinition } from '../agents/agentLoader';
import { BUILTIN_AGENT_ROLES, loadAgentDefinitions, writeCustomAgent } from '../agents/agentLoader';
import { runSubagent } from '../agents/subagent';

export interface AgentRoutesDeps {
  projectDir: string;
  getCurrentModel: () => string | null;
  getOllamaHost: () => string;
  refreshCustomAgentsIfStale: () => Promise<void>;
  getCachedCustomAgentsSnapshot: () => AgentDefinition[];
  createParentClient: (model: string, host: string) => IChatClient;
  getBaseTools: () => Tool[];
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;

export function createAgentRouter(deps: AgentRoutesDeps): express.Router {
  const router = express.Router();
  const {
    projectDir,
    getCurrentModel,
    getOllamaHost,
    refreshCustomAgentsIfStale,
    getCachedCustomAgentsSnapshot,
    createParentClient,
    getBaseTools,
  } = deps;

  router.get('/api/agents', async (_req, res) => {
    try {
      const customAgents = await loadAgentDefinitions(projectDir);
      const builtins = BUILTIN_AGENT_ROLES.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        role: agent.role,
        preset: agent.preset,
        personality: agent.personality,
        goal: agent.goal,
        strengths: agent.strengths,
        allowedTools: agent.allowedTools,
        systemPrompt: agent.systemPrompt,
        enabled: agent.enabled,
        filePath: '<builtin>',
        source: 'builtin',
      }));
      const customs = customAgents.map((agent) => ({ ...agent, source: 'custom' }));
      // Custom agents shadow built-ins of the same id; surface the custom one.
      const seen = new Set<string>();
      const merged: Array<Record<string, unknown>> = [];
      for (const agent of [...customs, ...builtins]) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        merged.push(agent);
      }
      res.json({ agents: merged });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/agents', async (req, res) => {
    try {
      const { id, name, description, role, model: agentModel, preset, personality, goal, systemPrompt, allowedTools } = req.body ?? {};
      if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required.' }); return; }
      if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ error: 'name is required.' }); return; }
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) { res.status(400).json({ error: 'systemPrompt is required.' }); return; }
      const filePath = await writeCustomAgent(projectDir, {
        id: id.trim(),
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        role: typeof role === 'string' ? role : undefined,
        model: typeof agentModel === 'string' ? agentModel : undefined,
        preset: typeof preset === 'string' ? preset as never : undefined,
        personality: typeof personality === 'string' ? personality : undefined,
        goal: typeof goal === 'string' ? goal : undefined,
        systemPrompt,
        allowedTools: Array.isArray(allowedTools) ? allowedTools.filter((tool: unknown): tool is string => typeof tool === 'string') : undefined,
      });
      res.json({ id: id.trim(), filePath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/agents/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!AGENT_ID_PATTERN.test(id)) { res.status(400).json({ error: 'Invalid agent id.' }); return; }
      const fp = path.join(projectDir, '.harness', 'agents', `${id}.md`);
      try {
        await fs.unlink(fp);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ENOENT') || msg.includes('no such file')) { res.status(404).json({ error: 'Agent not found.' }); return; }
        throw error;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Run an agent directly from the More->Agents UI. Mirrors the squad/concierge
  // auto-route path: same parent client, same enabled tool set (minus the
  // recursive `agent` tool), same custom-agents snapshot. The run registers
  // in /api/subagents so the global active-subagents bar shows it and the
  // existing cancel endpoint can stop it.
  router.post('/api/agents/:id/run', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!AGENT_ID_PATTERN.test(id)) { res.status(400).json({ error: 'Invalid agent id.' }); return; }
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) { res.status(400).json({ error: 'prompt is required.' }); return; }
      await refreshCustomAgentsIfStale();
      const customAgents = getCachedCustomAgentsSnapshot();
      const isKnown = customAgents.some((agent) => agent.id === id && agent.enabled)
        || BUILTIN_AGENT_ROLES.some((agent) => agent.id === id);
      if (!isKnown) { res.status(404).json({ error: 'Agent not found.' }); return; }
      const currentModel = getCurrentModel();
      if (!currentModel) {
        res.status(400).json({ error: 'No model selected. Pick a model in the Chat tab before running an agent.' });
        return;
      }
      const parentClient = createParentClient(currentModel, getOllamaHost());
      const baseTools = getBaseTools().filter((tool) => tool.name !== 'agent');
      const runId = `agent-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = await runSubagent(
        { name: id, systemPrompt: '', agentId: id, customAgents, runId },
        prompt,
        parentClient,
        baseTools,
      );
      res.json({ success: true, runId, summary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
