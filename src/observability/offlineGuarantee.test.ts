import { assessOfflineGuarantee, type OfflineToolRef } from './offlineGuarantee';
import type { ModelLocality } from './costProvenance';
import type { ToolPermissionCategory } from '../types/tool';

function tool(name: string, category: ToolPermissionCategory | undefined): OfflineToolRef {
  return { name, category };
}

function assess(modelLocality: ModelLocality, tools: OfflineToolRef[]) {
  return assessOfflineGuarantee({ modelLocality, tools });
}

describe('assessOfflineGuarantee — offline (provably local)', () => {
  it('reports offline when model is local and no tools were used', () => {
    const v = assess('local', []);
    expect(v.state).toBe('offline');
    expect(v.networkTools).toEqual([]);
    expect(v.unknownTools).toEqual([]);
    expect(v.reason).toMatch(/ran locally/);
  });

  it('reports offline when model is local and only non-network tools were used', () => {
    const v = assess('local', [tool('file_read', 'read'), tool('bash', 'shell')]);
    expect(v.state).toBe('offline');
    expect(v.networkTools).toEqual([]);
    expect(v.unknownTools).toEqual([]);
  });
});

describe('assessOfflineGuarantee — online (proven network reached)', () => {
  it('reports online when a cloud model was used', () => {
    const v = assess('cloud', [tool('file_read', 'read')]);
    expect(v.state).toBe('online');
    expect(v.reason).toMatch(/cloud model/);
  });

  it('reports online when a network tool was used, even with a local model', () => {
    const v = assess('local', [tool('web_fetch', 'network')]);
    expect(v.state).toBe('online');
    expect(v.networkTools).toEqual(['web_fetch']);
    expect(v.reason).toMatch(/web_fetch/);
  });

  it('counts a network tool regardless of success (category-only input)', () => {
    // The keystone takes category, not success — a failed web_fetch still
    // breaks the offline guarantee because the input lists it as network.
    const v = assess('local', [tool('web_fetch', 'network')]);
    expect(v.state).toBe('online');
  });

  it('online takes priority over unknown signals (network is positive proof)', () => {
    const v = assess('unknown', [tool('web_fetch', 'network'), tool('mystery', undefined)]);
    expect(v.state).toBe('online');
    expect(v.networkTools).toEqual(['web_fetch']);
  });

  it('lists both cloud model and network tools in the reason', () => {
    const v = assess('cloud', [tool('web_search', 'network')]);
    expect(v.state).toBe('online');
    expect(v.reason).toMatch(/cloud model/);
    expect(v.reason).toMatch(/web_search/);
  });

  it('dedupes repeated network tool names', () => {
    const v = assess('local', [tool('web_fetch', 'network'), tool('web_fetch', 'network')]);
    expect(v.networkTools).toEqual(['web_fetch']);
  });
});

describe('assessOfflineGuarantee — unknown (cannot prove offline)', () => {
  it('reports unknown when model locality is not recorded', () => {
    const v = assess('unknown', [tool('file_read', 'read')]);
    expect(v.state).toBe('unknown');
    expect(v.reason).toMatch(/locality not recorded/);
  });

  it('reports unknown when a used tool has no resolvable category', () => {
    const v = assess('local', [tool('some_mcp_tool', undefined)]);
    expect(v.state).toBe('unknown');
    expect(v.unknownTools).toEqual(['some_mcp_tool']);
    expect(v.reason).toMatch(/unverified tool/);
  });

  it('lists both blockers when model is unknown and a tool is unverified', () => {
    const v = assess('unknown', [tool('some_mcp_tool', undefined)]);
    expect(v.state).toBe('unknown');
    expect(v.reason).toMatch(/locality not recorded/);
    expect(v.reason).toMatch(/some_mcp_tool/);
  });

  it('dedupes repeated unknown tool names', () => {
    const v = assess('local', [tool('mystery', undefined), tool('mystery', undefined)]);
    expect(v.unknownTools).toEqual(['mystery']);
  });
});
