import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { clearRuntimeRegistry, getRuntimeRegistryStatus, isFeatureReady, loadRuntimeRegistry, markRuntimeInstalled, saveRuntimeRegistry } from './runtimeRegistry';

describe('runtime registry', () => {
  beforeEach(() => clearRuntimeRegistry());

  it('reports nothing installed by default', () => {
    const status = getRuntimeRegistryStatus();
    expect(status.voice.stt).toBe(false);
    expect(status.inbound.slack).toBe(false);
  });

  it('marks features installed', () => {
    markRuntimeInstalled('voice_stt', 'whisper-cpp');
    expect(isFeatureReady('voice_stt')).toBe(true);
    expect(getRuntimeRegistryStatus().voice.sttAdapter).toBe('whisper-cpp');
  });

  it('clearRuntimeRegistry resets state', () => {
    markRuntimeInstalled('inbound_slack', 'slack-bot');
    clearRuntimeRegistry();
    expect(isFeatureReady('inbound_slack')).toBe(false);
  });

  it('round-trips through save/load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runtime-'));
    markRuntimeInstalled('voice_tts', 'piper');
    await saveRuntimeRegistry(dir);
    clearRuntimeRegistry();
    expect(isFeatureReady('voice_tts')).toBe(false);
    await loadRuntimeRegistry(dir);
    expect(isFeatureReady('voice_tts')).toBe(true);
    expect(getRuntimeRegistryStatus().voice.ttsAdapter).toBe('piper');
  });

  it('loadRuntimeRegistry tolerates a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runtime-'));
    await loadRuntimeRegistry(dir);
    expect(getRuntimeRegistryStatus().voice.stt).toBe(false);
  });
});
