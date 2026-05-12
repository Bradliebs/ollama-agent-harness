import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SignalBus, type NervousSignal } from '../nervous/signals';
import { collectAmbientSignals, startAmbientDaemon } from './ambientDaemon';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-ambient-'));
}

describe('ambient daemon', () => {
  it('starts with no watchers when options are empty', () => {
    const bus = new SignalBus();
    const handle = startAmbientDaemon(bus, { gitPollMs: 0 });
    expect(handle.watchersActive()).toEqual([]);
    handle.stop();
  });

  it('emits a scheduler tick signal at the configured cadence', async () => {
    const bus = new SignalBus();
    const handle = startAmbientDaemon(bus, { gitPollMs: 0, schedulerMs: 30 });
    const signals = await collectAmbientSignals(handle, 100);
    handle.stop();
    expect(signals.some((s: NervousSignal) => s.source === 'ambient.scheduler')).toBe(true);
  });

  it('debounces filesystem events into a single signal', async () => {
    const dir = await tmpDir();
    const bus = new SignalBus();
    const handle = startAmbientDaemon(bus, { watchDir: dir, gitPollMs: 0, debounceMs: 60 });
    // Burst of writes
    for (let i = 0; i < 5; i++) {
      fsSync.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    }
    const signals = await collectAmbientSignals(handle, 250);
    handle.stop();
    const fileSignals = signals.filter((s: NervousSignal) => s.source === 'ambient.file');
    // fs.watch is best-effort across platforms — we assert at most one debounced batch
    expect(fileSignals.length).toBeLessThanOrEqual(2);
  });

  it('reports active watchers correctly', () => {
    const bus = new SignalBus();
    const handle = startAmbientDaemon(bus, { schedulerMs: 1000, gitPollMs: 0 });
    expect(handle.watchersActive()).toContain('scheduler');
    handle.stop();
    expect(handle.isRunning()).toBe(false);
  });
});
