// Runtime registry — tracks which optional jarvis adapters have been wired up.
//
// Voice STT/TTS/wake-word and inbound channel pollers all live behind null
// adapters by default. This registry lets the status endpoint and UI report
// "Voice ready" vs "Install Whisper recipe" without hardcoding which
// modules look at the registry directly. Persists to
// `.harness/jarvis/runtime.json` so registrations survive server restart.

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

export type RuntimeFeature = 'voice_stt' | 'voice_tts' | 'voice_wake' | 'inbound_slack' | 'inbound_telegram' | 'inbound_email';

const installed = new Map<RuntimeFeature, { adapterName: string; installedAt: string }>();

export function markRuntimeInstalled(feature: RuntimeFeature, adapterName: string): void {
  installed.set(feature, { adapterName, installedAt: new Date().toISOString() });
}

export function clearRuntimeRegistry(): void {
  installed.clear();
}

export function isFeatureReady(feature: RuntimeFeature): boolean {
  return installed.has(feature);
}

export interface RuntimeRegistryStatus {
  voice: { stt: boolean; tts: boolean; wake: boolean; sttAdapter?: string; ttsAdapter?: string; wakeAdapter?: string };
  inbound: { slack: boolean; telegram: boolean; email: boolean };
}

export function getRuntimeRegistryStatus(): RuntimeRegistryStatus {
  return {
    voice: {
      stt: isFeatureReady('voice_stt'),
      tts: isFeatureReady('voice_tts'),
      wake: isFeatureReady('voice_wake'),
      sttAdapter: installed.get('voice_stt')?.adapterName,
      ttsAdapter: installed.get('voice_tts')?.adapterName,
      wakeAdapter: installed.get('voice_wake')?.adapterName,
    },
    inbound: {
      slack: isFeatureReady('inbound_slack'),
      telegram: isFeatureReady('inbound_telegram'),
      email: isFeatureReady('inbound_email'),
    },
  };
}

function registryPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'jarvis', 'runtime.json');
}

export async function saveRuntimeRegistry(projectDir: string): Promise<void> {
  const filePath = registryPath(projectDir);
  await withFileLock(filePath, async () => {
    // Snapshot inside the lock so a concurrent markRuntimeInstalled call
    // can't shift entries between the snapshot read and the write.
    const snapshot: Record<string, { adapterName: string; installedAt: string }> = {};
    for (const [k, v] of installed.entries()) snapshot[k] = v;
    await atomicWriteFile(filePath, JSON.stringify(snapshot, null, 2));
  });
}

export async function loadRuntimeRegistry(projectDir: string): Promise<void> {
  try {
    const raw = await fs.readFile(registryPath(projectDir), 'utf-8');
    const data = JSON.parse(raw) as Record<string, { adapterName: string; installedAt: string }>;
    installed.clear();
    for (const [k, v] of Object.entries(data)) {
      installed.set(k as RuntimeFeature, v);
    }
  } catch {
    // No file yet — fine.
  }
}
