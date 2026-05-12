import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  canActAutonomously,
  ensureCapability,
  explainRung,
  getRung,
  loadTrustLadder,
  recordOutcome,
  requiresConfirmation,
  saveTrustLadder,
  type TrustLadderSnapshot,
} from './trustLadder';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-trust-'));
}

describe('trust ladder', () => {
  it('returns ask (rung 2) for unknown capabilities', () => {
    const snap: TrustLadderSnapshot = { capabilities: {}, updatedAt: new Date().toISOString() };
    expect(getRung(snap, 'file_write')).toBe(2);
    expect(canActAutonomously(snap, 'file_write')).toBe(false);
    expect(requiresConfirmation(snap, 'file_write')).toBe(false);
  });

  it('promotes after 5 accepted outcomes', () => {
    const snap: TrustLadderSnapshot = { capabilities: {}, updatedAt: new Date().toISOString() };
    ensureCapability(snap, 'grep');
    let promoted: number | undefined;
    for (let i = 0; i < 5; i++) promoted = recordOutcome(snap, 'grep', 'accepted').promoted;
    expect(promoted).toBe(3);
  });

  it('demotes after 2 rejected outcomes', () => {
    const snap: TrustLadderSnapshot = { capabilities: {}, updatedAt: new Date().toISOString() };
    snap.capabilities.email_send = { capability: 'email_send', rung: 3, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: 9999 };
    recordOutcome(snap, 'email_send', 'rejected');
    const demoted = recordOutcome(snap, 'email_send', 'rejected').demoted;
    expect(demoted).toBe(2);
  });

  it('decays a high rung after the idle window passes', () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days ago
    const snap: TrustLadderSnapshot = {
      capabilities: { bash: { capability: 'bash', rung: 4, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: 1000 * 60, lastUsedAt: old } },
      updatedAt: old,
    };
    expect(getRung(snap, 'bash')).toBe(3);
  });

  it('persists to disk and reloads with the same shape', async () => {
    const dir = await tmpDir();
    const snap = await loadTrustLadder(dir);
    ensureCapability(snap, 'web_search');
    recordOutcome(snap, 'web_search', 'accepted');
    await saveTrustLadder(dir, snap);
    const reloaded = await loadTrustLadder(dir);
    expect(reloaded.capabilities.web_search).toBeDefined();
    expect(reloaded.capabilities.web_search.acceptedStreak).toBe(1);
  });

  it('explainRung produces a readable label', () => {
    expect(explainRung(0)).toBe('0 shadow');
    expect(explainRung(4)).toBe('4 act');
  });
});
