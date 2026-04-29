import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendSubagentRoutingMetric, listSubagentRoutingMetrics, resolveSubagentConfig, type SubagentConfig } from './subagent';

describe('subagent presets', () => {
  it('resolves preset config with routed model defaults', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      preset: 'explore',
      routingPolicy: { smallModel: 'tiny', defaultModel: 'base' },
    };

    const resolved = resolveSubagentConfig(config, 'inspect files');

    expect(resolved).toMatchObject({ name: 'explore', model: 'tiny', maxTurns: 6 });
    expect(resolved.routingDecision).toMatchObject({ tier: 'small', model: 'tiny' });
    expect(resolved.systemPrompt).toContain('read-only exploration helper');
  });

  it('preserves explicit model and prompt overrides', () => {
    const config: SubagentConfig = {
      name: 'custom',
      systemPrompt: 'custom prompt',
      model: 'explicit',
      preset: 'explore',
      routingPolicy: { smallModel: 'tiny' },
    };

    const resolved = resolveSubagentConfig(config, 'inspect files');

    expect(resolved).toMatchObject({ name: 'custom', systemPrompt: 'custom prompt', model: 'explicit' });
  });

  it('appends subagent routing metrics as JSONL', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-subagent-metrics-'));

    const filePath = await appendSubagentRoutingMetric(projectDir, {
      timestamp: '2026-04-29T00:00:00.000Z',
      name: 'explore',
      preset: 'explore',
      model: 'tiny',
      tier: 'small',
      escalated: false,
      reasons: ['bounded low-risk helper task'],
      success: true,
      durationMs: 5,
      outputChars: 12,
    });

    expect(await fs.readFile(filePath, 'utf-8')).toContain('bounded low-risk helper task');
    await expect(listSubagentRoutingMetrics(projectDir)).resolves.toEqual([expect.objectContaining({ model: 'tiny' })]);
  });
});