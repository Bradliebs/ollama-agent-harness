import { mergeLadders } from './ladderImport';
import type { TrustLadderSnapshot } from './trustLadder';

function snap(entries: Record<string, number>): TrustLadderSnapshot {
  const capabilities: Record<string, { capability: string; rung: 0 | 1 | 2 | 3 | 4; acceptedStreak: number; rejectedStreak: number; decayAfterMs: number }> = {};
  for (const [k, rung] of Object.entries(entries)) {
    capabilities[k] = { capability: k, rung: rung as 0 | 1 | 2 | 3 | 4, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: 999_999_999 };
  }
  return { capabilities, updatedAt: '' };
}

describe('ladder import / merge', () => {
  it('max-rung-wins promotes when incoming is higher', () => {
    const { merged, stats } = mergeLadders(snap({ bash: 2 }), snap({ bash: 4 }), 'max-rung-wins');
    expect(merged.capabilities.bash.rung).toBe(4);
    expect(stats.promoted).toContain('bash');
  });

  it('max-rung-wins keeps local when incoming is lower', () => {
    const { merged, stats } = mergeLadders(snap({ bash: 4 }), snap({ bash: 2 }), 'max-rung-wins');
    expect(merged.capabilities.bash.rung).toBe(4);
    expect(stats.unchanged).toContain('bash');
  });

  it('last-wins overrides regardless of direction', () => {
    const { merged, stats } = mergeLadders(snap({ bash: 4 }), snap({ bash: 1 }), 'last-wins');
    expect(merged.capabilities.bash.rung).toBe(1);
    expect(stats.demoted).toContain('bash');
  });

  it('adds capabilities not present locally', () => {
    const { merged, stats } = mergeLadders(snap({ bash: 2 }), snap({ web: 3 }));
    expect(merged.capabilities.web.rung).toBe(3);
    expect(stats.added).toContain('web');
  });

  it('resets streaks on rung change', () => {
    const local = snap({ bash: 2 });
    local.capabilities.bash.acceptedStreak = 4;
    const { merged } = mergeLadders(local, snap({ bash: 3 }));
    expect(merged.capabilities.bash.acceptedStreak).toBe(0);
  });
});
