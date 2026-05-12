// Ambient Sensor Daemon — watches the local environment and emits NervousSignal
// events when something interesting happens. The user does not have to ask;
// the harness notices.
//
// Built-in watchers (all opt-in via start options):
//
//   * file watcher       — fs.watch on a directory, debounced, emits per change
//   * git poll watcher   — `git status --porcelain` every N ms, emits when state shifts
//   * scheduler watcher  — wakes on a fixed cadence so other engines can react to time
//
// The daemon does NOT take actions. It only emits signals onto a SignalBus.
// The Predictive Engine and Mission Control consume those signals and decide
// (according to the Trust Ladder) whether to surface, propose, or act.
//
// Storage: zero. The daemon is purely event-driven; durable history lives in
// the SignalBus rolling log and the Knowledge Graph if a consumer ingests it.
//
// Cross-platform note: Node `fs.watch` is best-effort on macOS/Linux/Windows.
// We debounce and de-dup to absorb the noisy bursts. For production-grade
// recursive watching, swap to `chokidar` in a follow-up — kept stdlib-only
// for now to honor the no-new-deps constraint.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { createSignal, type NervousSignal, type SignalBus } from '../nervous/signals';

export interface AmbientWatcherOptions {
  /** Watch this directory for filesystem changes. */
  watchDir?: string;
  /** Glob-ish path filter; signals are emitted only when filename matches one of these substrings. */
  fileFilters?: string[];
  /** Poll git status every N ms. Set to 0 to disable. */
  gitPollMs?: number;
  /** Tick the scheduler every N ms. Set to 0 to disable. */
  schedulerMs?: number;
  /** Project working directory (defaults to process.cwd()). */
  projectDir?: string;
  /** Debounce window in ms for filesystem events. */
  debounceMs?: number;
}

export interface AmbientDaemonHandle {
  stop: () => void;
  emitter: EventEmitter;
  isRunning: () => boolean;
  watchersActive: () => string[];
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_GIT_POLL_MS = 5_000;

export function startAmbientDaemon(bus: SignalBus, options: AmbientWatcherOptions = {}): AmbientDaemonHandle {
  const emitter = new EventEmitter();
  const projectDir = options.projectDir ?? process.cwd();
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const active: string[] = [];
  let stopped = false;

  // ─── File watcher ───────────────────────────────────────────────
  let fileWatcher: fs.FSWatcher | null = null;
  let fileTimer: NodeJS.Timeout | null = null;
  const pendingFiles = new Set<string>();
  if (options.watchDir) {
    try {
      fileWatcher = fs.watch(options.watchDir, { recursive: true }, (_event, filename) => {
        if (!filename || stopped) return;
        const name = filename.toString();
        if (options.fileFilters && !options.fileFilters.some((f) => name.includes(f))) return;
        pendingFiles.add(name);
        if (fileTimer) clearTimeout(fileTimer);
        fileTimer = setTimeout(() => {
          const batch = Array.from(pendingFiles);
          pendingFiles.clear();
          if (batch.length === 0) return;
          const sig = createSignal('USER_INTENT', 'ambient.file', 'low', `Files changed: ${batch.slice(0, 5).join(', ')}${batch.length > 5 ? ` (+${batch.length - 5})` : ''}`);
          sig.metadata = { files: batch, watchDir: options.watchDir };
          bus.publish(sig);
          emitter.emit('signal', sig);
        }, debounceMs);
      });
      active.push('file');
    } catch (err) {
      const sig = createSignal('TOOL_ERROR', 'ambient.file', 'medium', `File watcher failed to start: ${(err as Error).message}`);
      bus.publish(sig);
    }
  }

  // ─── Git poll watcher ───────────────────────────────────────────
  let gitTimer: NodeJS.Timeout | null = null;
  let lastGitState: string | null = null;
  const gitPollMs = options.gitPollMs ?? DEFAULT_GIT_POLL_MS;
  if (gitPollMs > 0) {
    const pollGit = () => {
      if (stopped) return;
      const proc = spawn('git', ['status', '--porcelain'], { cwd: projectDir });
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      proc.on('close', () => {
        if (stopped) return;
        const trimmed = buf.trim();
        if (lastGitState !== null && trimmed !== lastGitState) {
          const dirty = trimmed.length > 0;
          const sig = createSignal(
            dirty ? 'USER_INTENT' : 'TOOL_SUCCESS',
            'ambient.git',
            'low',
            dirty ? 'Git working tree changed' : 'Git working tree clean',
          );
          sig.metadata = { porcelain: trimmed.split('\n').slice(0, 20) };
          bus.publish(sig);
          emitter.emit('signal', sig);
        }
        lastGitState = trimmed;
      });
      proc.on('error', () => { /* git not present — silent */ });
    };
    pollGit();
    gitTimer = setInterval(pollGit, gitPollMs);
    if (typeof gitTimer.unref === 'function') gitTimer.unref();
    active.push('git');
  }

  // ─── Scheduler tick ─────────────────────────────────────────────
  let schedulerTimer: NodeJS.Timeout | null = null;
  if (options.schedulerMs && options.schedulerMs > 0) {
    schedulerTimer = setInterval(() => {
      if (stopped) return;
      const sig = createSignal('USER_INTENT', 'ambient.scheduler', 'info', 'Scheduler tick');
      sig.metadata = { tickAt: new Date().toISOString() };
      bus.publish(sig);
      emitter.emit('signal', sig);
    }, options.schedulerMs);
    if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
    active.push('scheduler');
  }

  return {
    stop(): void {
      stopped = true;
      if (fileWatcher) { try { fileWatcher.close(); } catch { /* noop */ } }
      if (fileTimer) clearTimeout(fileTimer);
      if (gitTimer) clearInterval(gitTimer);
      if (schedulerTimer) clearInterval(schedulerTimer);
    },
    emitter,
    isRunning: () => !stopped,
    watchersActive: () => [...active],
  };
}

/** Helper for tests: collect all signals emitted in a window. */
export function collectAmbientSignals(handle: AmbientDaemonHandle, windowMs: number): Promise<NervousSignal[]> {
  return new Promise((resolve) => {
    const out: NervousSignal[] = [];
    const onSignal = (s: NervousSignal) => out.push(s);
    handle.emitter.on('signal', onSignal);
    setTimeout(() => {
      handle.emitter.off('signal', onSignal);
      resolve(out);
    }, windowMs);
  });
}
