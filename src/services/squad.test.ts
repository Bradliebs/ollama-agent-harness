import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  createSquad,
  deleteSquad,
  getSquad,
  listSquads,
  planHandoff,
  routeMessage,
  updateSquad,
  type SquadDefinition,
} from './squad';

describe('squad', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-squad-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('creates and lists squads', async () => {
    const squad = await createSquad(projectDir, { id: 'eng', name: 'Engineering', leadAgentId: 'architect' });
    expect(squad.id).toBe('eng');
    expect(squad.leadAgentId).toBe('architect');
    expect(squad.autonomy).toBe('supervised');
    expect(squad.maxHandoffDepth).toBe(3);
    const list = await listSquads(projectDir);
    expect(list).toHaveLength(1);
  });

  it('rejects invalid ids and duplicates', async () => {
    await expect(createSquad(projectDir, { id: 'bad id', name: 'X', leadAgentId: 'a' })).rejects.toThrow();
    await createSquad(projectDir, { id: 'dup', name: 'X', leadAgentId: 'a' });
    await expect(createSquad(projectDir, { id: 'dup', name: 'Y', leadAgentId: 'a' })).rejects.toThrow();
  });

  it('updates and deletes squads', async () => {
    await createSquad(projectDir, { id: 's1', name: 'S1', leadAgentId: 'a' });
    const updated = await updateSquad(projectDir, 's1', { name: 'Renamed', autonomy: 'autonomous' });
    expect(updated.name).toBe('Renamed');
    expect(updated.autonomy).toBe('autonomous');
    expect(await deleteSquad(projectDir, 's1')).toBe(true);
    expect(await getSquad(projectDir, 's1')).toBeUndefined();
    expect(await deleteSquad(projectDir, 's1')).toBe(false);
  });

  it('routes by highest-priority matching rule', () => {
    const squad: SquadDefinition = {
      id: 's', name: 'S', leadAgentId: 'lead',
      roster: [], autonomy: 'supervised', maxHandoffDepth: 3, maxConcurrentAgents: 3,
      routingRules: [
        { pattern: '\\bbug\\b', agentId: 'qa', priority: 10 },
        { pattern: 'security', agentId: 'security', priority: 50 },
        { pattern: '.*', agentId: 'general', priority: 1 },
      ],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(routeMessage(squad, 'we have a security incident').agentId).toBe('security');
    expect(routeMessage(squad, 'just a bug to investigate').agentId).toBe('qa');
    expect(routeMessage(squad, 'random').agentId).toBe('general');
  });

  it('falls back to lead agent when no rule matches', () => {
    const squad: SquadDefinition = {
      id: 's', name: 'S', leadAgentId: 'lead',
      roster: [], autonomy: 'supervised', maxHandoffDepth: 3, maxConcurrentAgents: 3,
      routingRules: [{ pattern: 'never', agentId: 'someone', priority: 10 }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const result = routeMessage(squad, 'no match');
    expect(result.agentId).toBe('lead');
    expect(result.isFallback).toBe(true);
  });

  it('skips invalid regex rules without throwing', () => {
    const squad: SquadDefinition = {
      id: 's', name: 'S', leadAgentId: 'lead',
      roster: [], autonomy: 'supervised', maxHandoffDepth: 3, maxConcurrentAgents: 3,
      routingRules: [{ pattern: '[invalid', agentId: 'broken', priority: 100 }, { pattern: 'good', agentId: 'good', priority: 5 }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(routeMessage(squad, 'good message').agentId).toBe('good');
  });

  it('planHandoff blocks self-handoff and unknown agents', () => {
    const squad: SquadDefinition = {
      id: 's', name: 'S', leadAgentId: 'lead',
      roster: [{ agentId: 'a', role: 'developer', capabilities: [] }],
      autonomy: 'supervised', maxHandoffDepth: 3, maxConcurrentAgents: 3,
      routingRules: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(planHandoff(squad, 'a', 'a', 0).allowed).toBe(false);
    expect(planHandoff(squad, 'a', 'unknown', 0).allowed).toBe(false);
    expect(planHandoff(squad, 'unknown', 'lead', 0).allowed).toBe(false);
    expect(planHandoff(squad, 'a', 'lead', 0).allowed).toBe(true);
  });

  it('planHandoff blocks when depth limit would be exceeded', () => {
    const squad: SquadDefinition = {
      id: 's', name: 'S', leadAgentId: 'lead',
      roster: [{ agentId: 'a', role: 'developer', capabilities: [] }],
      autonomy: 'supervised', maxHandoffDepth: 2, maxConcurrentAgents: 3,
      routingRules: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(planHandoff(squad, 'a', 'lead', 1).allowed).toBe(true);
    expect(planHandoff(squad, 'a', 'lead', 2).allowed).toBe(false);
  });
});
