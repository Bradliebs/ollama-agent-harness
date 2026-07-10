import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ListAgentsTool,
  DeleteAgentTool,
  CreateSquadTool,
  UpdateSquadTool,
  DeleteSquadTool,
  SquadRouteTool,
} from './agentManagementTools';
import { writeCustomAgent } from '../agents/agentLoader';

describe('agentManagementTools', () => {
  let tempDir: string;
  let originalProjectDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgmt-'));
    originalProjectDir = process.env.HARNESS_PROJECT_DIR;
    process.env.HARNESS_PROJECT_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalProjectDir === undefined) delete process.env.HARNESS_PROJECT_DIR;
    else process.env.HARNESS_PROJECT_DIR = originalProjectDir;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('ListAgentsTool', () => {
    it('lists built-in roles when no custom agents exist', async () => {
      const result = await ListAgentsTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('builtin');
    });

    it('surfaces a newly-created custom agent', async () => {
      await writeCustomAgent(tempDir, {
        id: 'finance-bot',
        name: 'Finance Bot',
        description: 'Reviews ledgers.',
        systemPrompt: 'You review ledgers.',
      });
      const result = await ListAgentsTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('finance-bot');
      expect(result.output).toContain('Finance Bot');
    });
  });

  describe('DeleteAgentTool', () => {
    it('refuses to delete built-in roles', async () => {
      const result = await DeleteAgentTool.execute({ id: 'developer' });
      expect(result.success).toBe(false);
      expect(result.output).toContain('built-in');
    });

    it('deletes a custom agent', async () => {
      await writeCustomAgent(tempDir, {
        id: 'temp-bot',
        name: 'Temp Bot',
        description: 'Temporary.',
        systemPrompt: 'Temp.',
      });
      const result = await DeleteAgentTool.execute({ id: 'temp-bot' });
      expect(result.success).toBe(true);
      // Idempotent next call returns failure with a clear reason.
      const second = await DeleteAgentTool.execute({ id: 'temp-bot' });
      expect(second.success).toBe(false);
    });

    it('rejects malformed ids', async () => {
      const result = await DeleteAgentTool.execute({ id: '../etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.output).toContain('Invalid');
    });
  });

  describe('CreateSquadTool', () => {
    it('refuses when lead_agent_id is unknown', async () => {
      const result = await CreateSquadTool.execute({
        name: 'Phantom Squad',
        lead_agent_id: 'does-not-exist',
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain('does not match');
    });

    it('creates a squad pointing at a built-in lead', async () => {
      const result = await CreateSquadTool.execute({
        name: 'Builtin Squad',
        lead_agent_id: 'developer',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Builtin Squad');
    });

    it('validates routing-rule regex up front', async () => {
      const result = await CreateSquadTool.execute({
        name: 'Bad Regex Squad',
        lead_agent_id: 'developer',
        routing_rules: [{ pattern: '[unterminated', agent_id: 'developer' }],
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain('Invalid regex');
    });
  });

  describe('SquadRouteTool', () => {
    it('routes a matching message to the configured agent', async () => {
      await CreateSquadTool.execute({
        id: 'route-squad',
        name: 'Route Squad',
        lead_agent_id: 'developer',
        routing_rules: [{ pattern: '^bug', agent_id: 'developer', priority: 10 }],
      });
      const result = await SquadRouteTool.execute({ squad_id: 'route-squad', message: 'bug in the login flow' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('developer');
    });

    it('returns a clear error when the squad does not exist', async () => {
      const result = await SquadRouteTool.execute({ squad_id: 'ghost', message: 'hi' });
      expect(result.success).toBe(false);
      expect(result.output).toContain('not found');
    });
  });

  describe('UpdateSquadTool', () => {
    it('patches an existing squad and rejects bad regex', async () => {
      await CreateSquadTool.execute({
        id: 'update-squad',
        name: 'Update Squad',
        lead_agent_id: 'developer',
      });
      const ok = await UpdateSquadTool.execute({ squad_id: 'update-squad', description: 'New description.' });
      expect(ok.success).toBe(true);
      const bad = await UpdateSquadTool.execute({
        squad_id: 'update-squad',
        routing_rules: [{ pattern: '[oops', agent_id: 'developer' }],
      });
      expect(bad.success).toBe(false);
      expect(bad.output).toContain('Invalid regex');
    });
  });

  describe('DeleteSquadTool', () => {
    it('removes the squad and is then a no-op', async () => {
      await CreateSquadTool.execute({
        id: 'delete-squad',
        name: 'Delete Squad',
        lead_agent_id: 'developer',
      });
      const ok = await DeleteSquadTool.execute({ squad_id: 'delete-squad' });
      expect(ok.success).toBe(true);
      const again = await DeleteSquadTool.execute({ squad_id: 'delete-squad' });
      expect(again.success).toBe(false);
    });
  });
});

