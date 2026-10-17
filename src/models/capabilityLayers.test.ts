import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LoopConfig, Tool } from '../types';
import type { CapabilityProfile } from './capabilityProfile';
import { getBuiltinTools } from '../tools';
import { applyCapabilityLayers, describeLayerSpec, layersFromEnv, parseLayerSpec, rankToolsForConversation, selectToolsForLimit } from './capabilityLayers';

const tool = (name: string, description = name.replace(/_/g, ' ')): Tool => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  execute: jest.fn(),
});

// Registration order puts specialised tools first, so a ranking by order alone would pick them.
const TOOLS = [
  'calendar_read', 'email_send', 'pdf_read', 'image_analyze', 'kanban_move', 'rag_search', 'browser_navigate',
  'file_read', 'list_files', 'grep', 'file_edit', 'file_write', 'bash', 'web_search', 'web_read',
].map((name) => tool(name));

function profile(overrides: Partial<CapabilityProfile['recommended']> = {}, probedAt = new Date().toISOString()): CapabilityProfile {
  return {
    model: 'small-model',
    profileVersion: 1,
    probedAt,
    scores: { toolCalling: 0.4, jsonInTextRate: 0.2, structuredPlain: 0.7, structuredConstrained: 0.95, instructionFollowing: 0.6, planCoherence: 0.5 },
    usableContextTokens: 16000,
    detectedContextTokens: 32768,
    avgLatencyMs: 900,
    tokensSpent: 5000,
    recommended: { toolMode: 'constrained-json', maxToolsPerStep: 5, promptTier: 'compact', scaffoldLevel: 'heavy', contextBudgetTokens: 13600, ...overrides },
  } as CapabilityProfile;
}

const baseConfig = (): LoopConfig => ({ model: 'small-model', systemPrompt: 'base prompt', maxTurns: 5 });

describe('capability layers', () => {
  let projectDir: string;
  beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layers-')); });
  afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  it('reads the layers from the environment', () => {
    expect(layersFromEnv({})).toEqual({});
    expect(layersFromEnv({ HARNESS_ADAPTER_MODE: ' Profile ', HARNESS_SCAFFOLD_MODE: 'MEDIUM', HARNESS_WORKING_STATE: 'on', HARNESS_WORKING_STATE_POSITION: 'tail', HARNESS_LESSONS: 'recall' }))
      .toEqual({ adapter: true, scaffold: 'medium', workingState: 'tail', lessons: true });
    expect(layersFromEnv({ HARNESS_SCAFFOLD_MODE: 'off', HARNESS_ADAPTER_MODE: 'on' })).toEqual({});
  });

  it('validates layer specs from JSON', () => {
    expect(parseLayerSpec({ adapter: true, scaffold: 'Heavy', workingState: 'tail', lessons: false })).toEqual({ spec: { adapter: true, scaffold: 'heavy', workingState: 'tail' } });
    expect(parseLayerSpec({})).toEqual({ spec: {} });
    expect(parseLayerSpec({ scaffold: 'extreme' })).toEqual({ error: 'layers.scaffold must be light, medium, heavy or profile' });
    expect(parseLayerSpec({ temperature: 0 })).toEqual({ error: 'unknown layer(s): temperature' });
    expect(parseLayerSpec('scaffold=medium')).toEqual({ error: 'layers must be an object' });
    expect(describeLayerSpec({ adapter: true, scaffold: 'medium' })).toBe('adapter, scaffold=medium');
    expect(describeLayerSpec({})).toBe('none');
  });

  it('keeps core tools within a limit, and the conversation relevant ones', () => {
    const followUp = selectToolsForLimit(TOOLS, rankToolsForConversation(TOOLS, ['yes, do it']), 6).map((t) => t.name);
    expect(followUp).toEqual(expect.arrayContaining(['file_read', 'bash', 'grep']));
    const calendar = selectToolsForLimit(TOOLS, rankToolsForConversation(TOOLS, ['check my calendar for tomorrow', 'yes, do it']), 6).map((t) => t.name);
    expect(calendar).toEqual(expect.arrayContaining(['calendar_read', 'file_read', 'bash']));
    expect(selectToolsForLimit(TOOLS, new Map(), 100)).toHaveLength(TOOLS.length);
  });

  it('keeps reading, search and shell tools with the real tool set, even with a small limit', () => {
    const tools = getBuiltinTools();
    for (const conversation of [
      ['fix the failing test in the auth module'],
      ['write a summary of recent commits and email it to bob'],
      ['check my calendar for tomorrow', 'and email the summary to my boss', 'yes do it'],
    ]) {
      // The probe recommends 8, 5, 3 or 2 tools per step.
      const scores = rankToolsForConversation(tools, conversation);
      const pick = (limit: number) => selectToolsForLimit(tools, scores, limit).map((t) => t.name);
      expect(pick(8)).toEqual(expect.arrayContaining(['file_read', 'bash', 'file_edit', 'grep']));
      expect(pick(5)).toEqual(expect.arrayContaining(['file_read', 'bash', 'file_edit']));
      expect(pick(3)).toContain('file_read');
      expect(pick(2)).toContain('file_read');
      for (const limit of [8, 5, 3, 2]) expect(pick(limit)).toHaveLength(limit);
    }
    const coding = selectToolsForLimit(tools, rankToolsForConversation(tools, ['fix the failing test in the auth module']), 6).map((t) => t.name);
    expect(coding).toEqual(expect.arrayContaining(['file_read', 'bash', 'file_edit']));
    const email = selectToolsForLimit(tools, rankToolsForConversation(tools, ['write a summary of recent commits and email it to bob']), 6).map((t) => t.name);
    expect(email.some((name) => name.startsWith('email_'))).toBe(true);
  });

  it('applies scaffolding with a conversation-aware tool subset', async () => {
    const config = baseConfig();
    const result = await applyCapabilityLayers({ scaffold: 'heavy' }, { config, tools: TOOLS, model: 'small-model', projectDir, userMessages: ['read the calendar for tomorrow', 'ok go ahead'], loadProfile: async () => null });
    expect(config.scaffold).toMatchObject({ level: 'heavy', planTurnFirst: true, maxToolsOffered: 6 });
    expect(config.modelPlan?.toolNames).toEqual(expect.arrayContaining(['calendar_read', 'file_read']));
    expect(config.modelPlan?.toolNames).not.toContain('email_send');
    expect(result.applied).toEqual(['scaffold: heavy']);
  });

  it('leaves planning and per-step tool choice to an external planner', async () => {
    const config = baseConfig();
    await applyCapabilityLayers({ scaffold: 'heavy' }, { config, tools: TOOLS, model: 'm', projectDir, userMessages: ['x'], externalPlanner: true, loadProfile: async () => null });
    expect(config.scaffold).toMatchObject({ level: 'heavy', planTurnFirst: false, stepPrompt: false, maxToolCallsPerTurn: 1, maxToolsOffered: 0 });
    expect(config.scaffold?.systemAddendum).toContain('current step only');
    expect(config.scaffold?.systemAddendum).not.toMatch(/plan/i);
    expect(config.modelPlan).toBeUndefined();
  });

  it('uses a fresh probe profile for the adapter and profile scaffolding', async () => {
    const config = baseConfig();
    const result = await applyCapabilityLayers({ adapter: true, scaffold: 'profile' }, { config, tools: TOOLS, model: 'small-model', projectDir, userMessages: ['fix the bug'], loadProfile: async () => profile() });
    expect(config.modelPlan).toMatchObject({ toolMode: 'constrained-json' });
    expect(config.modelPlan?.toolNames).toHaveLength(5);
    expect(config.modelPlan?.toolNames).toEqual(expect.arrayContaining(['file_read', 'grep', 'file_edit']));
    expect(config.systemPrompt).toContain('Tool-call compatibility mode');
    expect(config.scaffold?.level).toBe('heavy');
    expect(result.applied).toEqual(['adapter: constrained-json tool calls, 5 tools', 'scaffold: heavy (from probe)']);
    expect(result.skipped).toEqual([]);
  });

  it('says why profile layers did nothing instead of silently skipping them', async () => {
    const missing = await applyCapabilityLayers({ adapter: true, scaffold: 'profile' }, { config: baseConfig(), tools: TOOLS, model: 'qwen3:8b', projectDir, userMessages: ['x'], loadProfile: async () => null });
    expect(missing.applied).toEqual([]);
    expect(missing.skipped).toEqual([
      'adapter: qwen3:8b has not been probed (harness probe, or Probe model in the UI)',
      'scaffold: qwen3:8b has not been probed (harness probe, or Probe model in the UI)',
    ]);
    const stale = await applyCapabilityLayers({ adapter: true }, { config: baseConfig(), tools: TOOLS, model: 'qwen3:8b', projectDir, userMessages: ['x'], loadProfile: async () => profile({}, '2020-01-01T00:00:00.000Z') });
    expect(stale.skipped).toEqual(['adapter: the probe profile for qwen3:8b is out of date; probe it again']);
  });

  it('adds working state, and treats no relevant lessons as normal rather than a skip', async () => {
    const config = baseConfig();
    const result = await applyCapabilityLayers({ workingState: 'tail', lessons: true }, { config, tools: TOOLS, model: 'm', projectDir, userMessages: ['summarise the report'] });
    expect(config.workingState).toEqual({ inject: true, position: 'tail' });
    expect(result).toEqual({ applied: ['working state (tail)'], skipped: [] });
  });

  it('changes nothing for an empty spec', async () => {
    const config = baseConfig();
    expect(await applyCapabilityLayers({}, { config, tools: TOOLS, model: 'm', projectDir, userMessages: ['x'] })).toEqual({ applied: [], skipped: [] });
    expect(config).toEqual(baseConfig());
  });
});
