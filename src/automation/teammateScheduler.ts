// Teammate Scheduler
//
// The "teammate" experience: the agent does work for you between sessions.
// Right now that means: produce a Daily Brief at a configured local time and
// deliver it through the channels you've opted into (file / Telegram /
// Discord webhook / Slack webhook).
//
// Design notes:
//  - One scheduler per server process. Ticks every 60s, fires when local
//    wall-clock matches the configured HH:MM on an allowed weekday.
//  - "Allowed weekday" defaults to all 7. Empty array means never run.
//  - Each delivery channel is independently optional and tolerant of
//    misconfiguration (a missing Telegram bot doesn't kill the disk write).
//  - The scheduler always saves a snapshot to .harness/documents/ so users
//    have a permanent record even when every channel fails.
//  - Last-run / next-run state is persisted into settings so a restart
//    doesn't fire two briefs back-to-back, and the UI can show "next at…".

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import { snapshotDailyBrief, type BriefSnapshot } from '../jarvis/briefScheduler';
import { recordSwallowed } from '../observability/silentFailureSink';

const DEFAULT_TICK_MS = 60_000;
const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type TeammateDay = typeof ALL_DAYS[number];

export type TeammateChannel = 'file' | 'telegram' | 'discord' | 'slack';

export interface TeammateSettings {
  enabled: boolean;
  /** Local-time HH:MM 24h (e.g. "08:00"). */
  scheduleTime: string;
  /** Days the brief should fire on. Empty array = never. */
  scheduleDays: TeammateDay[];
  /** Active delivery channels. Empty = silent (snapshot only saved to disk). */
  channels: TeammateChannel[];
  /** ISO timestamp of the most recent successful run. */
  lastRunAt: string;
  /** ISO timestamp of the next scheduled run (UI hint, not authoritative). */
  nextRunAt: string;
}

export function defaultTeammateSettings(): TeammateSettings {
  return {
    enabled: false,
    scheduleTime: '08:00',
    scheduleDays: [...ALL_DAYS],
    channels: ['file'],
    lastRunAt: '',
    nextRunAt: '',
  };
}

export interface TeammateDelivery {
  sendTelegram?: (markdown: string) => Promise<void>;
  sendDiscord?: (markdown: string) => Promise<void>;
  sendSlack?: (markdown: string) => Promise<void>;
}

export interface TeammateSchedulerOptions {
  projectDir: string;
  getSettings(): TeammateSettings;
  updateSettings(next: TeammateSettings): Promise<void> | void;
  /** Brief snapshot producer. Defaults to the jarvis snapshotDailyBrief. */
  snapshot?: (projectDir: string) => Promise<BriefSnapshot>;
  delivery?: TeammateDelivery;
  /** When true, the scheduler skips firing (used by kill switch). */
  isHalted?: () => boolean;
  tickMs?: number;
  /** Optional clock injection for tests. */
  now?: () => Date;
}

export interface TeammateRunResult {
  fired: boolean;
  reason: string;
  channelsDelivered: TeammateChannel[];
  channelsFailed: Array<{ channel: TeammateChannel; error: string }>;
  snapshotPath?: string;
}

export class TeammateScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: TeammateSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => recordSwallowed('teammateScheduler.tick', err));
    }, tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('Teammate', 'Scheduler started', {
      enabled: this.opts.getSettings().enabled,
      scheduleTime: this.opts.getSettings().scheduleTime,
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns the next scheduled fire timestamp as ISO, or '' when disabled. */
  computeNextRunAt(now: Date = this.opts.now ? this.opts.now() : new Date()): string {
    const s = this.opts.getSettings();
    if (!s.enabled || s.scheduleDays.length === 0) return '';
    const next = nextOccurrence(now, s.scheduleTime, s.scheduleDays);
    return next ? next.toISOString() : '';
  }

  /** Force a brief to run right now, regardless of schedule. */
  async runNow(): Promise<TeammateRunResult> {
    return this.runOnce({ now: this.opts.now ? this.opts.now() : new Date(), force: true });
  }

  async tick(): Promise<TeammateRunResult> {
    if (this.running) return { fired: false, reason: 'already running', channelsDelivered: [], channelsFailed: [] };
    const now = this.opts.now ? this.opts.now() : new Date();
    const s = this.opts.getSettings();
    if (!s.enabled) return { fired: false, reason: 'disabled', channelsDelivered: [], channelsFailed: [] };
    if (this.opts.isHalted && this.opts.isHalted()) {
      return { fired: false, reason: 'halted', channelsDelivered: [], channelsFailed: [] };
    }
    if (!isDueNow(now, s)) {
      return { fired: false, reason: 'not due', channelsDelivered: [], channelsFailed: [] };
    }
    if (alreadyRanForSlot(now, s)) {
      return { fired: false, reason: 'already ran for current slot', channelsDelivered: [], channelsFailed: [] };
    }
    return this.runOnce({ now, force: false });
  }

  private async runOnce({ now, force }: { now: Date; force: boolean }): Promise<TeammateRunResult> {
    this.running = true;
    try {
      const settings = this.opts.getSettings();
      const snapshotter = this.opts.snapshot ?? ((dir: string) => snapshotDailyBrief({ projectDir: dir, windowDescription: force ? 'manual run' : 'scheduled' }));
      let snap: BriefSnapshot;
      try {
        snap = await snapshotter(this.opts.projectDir);
      } catch (err) {
        logger.warn('Teammate', 'Snapshot failed', { error: err instanceof Error ? err.message : String(err) });
        return { fired: false, reason: 'snapshot failed', channelsDelivered: [], channelsFailed: [] };
      }

      const snapshotPath = await writeSnapshotToDisk(this.opts.projectDir, snap).catch((err) => {
        recordSwallowed('teammateScheduler.writeSnapshot', err);
        return undefined;
      });

      const channels = settings.channels.length > 0 ? settings.channels : ['file' as TeammateChannel];
      const delivered: TeammateChannel[] = [];
      const failed: Array<{ channel: TeammateChannel; error: string }> = [];
      const delivery = this.opts.delivery ?? {};

      for (const channel of channels) {
        if (channel === 'file') {
          if (snapshotPath) delivered.push(channel);
          else failed.push({ channel, error: 'snapshot disk write failed' });
          continue;
        }
        const sender =
          channel === 'telegram' ? delivery.sendTelegram :
          channel === 'discord' ? delivery.sendDiscord :
          channel === 'slack' ? delivery.sendSlack :
          undefined;
        if (!sender) {
          failed.push({ channel, error: `${channel} delivery not configured` });
          continue;
        }
        try {
          await sender(snap.markdown);
          delivered.push(channel);
        } catch (err) {
          failed.push({ channel, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const nextRunAt = this.computeNextRunAt(now);
      const next: TeammateSettings = {
        ...settings,
        lastRunAt: now.toISOString(),
        nextRunAt,
      };
      try { await this.opts.updateSettings(next); } catch (err) { recordSwallowed('teammateScheduler.updateSettings', err); }

      logger.info('Teammate', 'Brief delivered', {
        channels: delivered,
        failed: failed.length,
        snapshotPath: snapshotPath ?? '',
      });

      return { fired: true, reason: force ? 'manual' : 'scheduled', channelsDelivered: delivered, channelsFailed: failed, snapshotPath };
    } finally {
      this.running = false;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function isDueNow(now: Date, settings: TeammateSettings): boolean {
  if (!settings.enabled) return false;
  if (settings.scheduleDays.length === 0) return false;
  const day = ALL_DAYS[now.getDay()];
  if (!settings.scheduleDays.includes(day)) return false;
  const [hh, mm] = parseHHMM(settings.scheduleTime);
  if (hh === null || mm === null) return false;
  return now.getHours() === hh && now.getMinutes() === mm;
}

export function alreadyRanForSlot(now: Date, settings: TeammateSettings): boolean {
  if (!settings.lastRunAt) return false;
  const last = new Date(settings.lastRunAt);
  if (Number.isNaN(last.getTime())) return false;
  // Two runs in the same minute = same slot.
  return last.getFullYear() === now.getFullYear()
    && last.getMonth() === now.getMonth()
    && last.getDate() === now.getDate()
    && last.getHours() === now.getHours()
    && last.getMinutes() === now.getMinutes();
}

export function nextOccurrence(now: Date, scheduleTime: string, days: TeammateDay[]): Date | null {
  const [hh, mm] = parseHHMM(scheduleTime);
  if (hh === null || mm === null || days.length === 0) return null;
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh, mm, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue;
    const day = ALL_DAYS[candidate.getDay()];
    if (days.includes(day)) return candidate;
  }
  return null;
}

function parseHHMM(value: string): [number | null, number | null] {
  if (typeof value !== 'string') return [null, null];
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return [null, null];
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return [null, null];
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return [null, null];
  return [hh, mm];
}

async function writeSnapshotToDisk(projectDir: string, snap: BriefSnapshot): Promise<string> {
  const dir = path.join(projectDir, '.harness', 'documents');
  await fs.mkdir(dir, { recursive: true });
  const filename = `daily-brief-${snap.generatedAt.replace(/[:.]/g, '-')}.md`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, snap.markdown, 'utf-8');
  return filePath;
}

export function sanitizeTeammateSettings(value: unknown): TeammateSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const defaults = defaultTeammateSettings();
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled;
  const scheduleTime = typeof source.scheduleTime === 'string' && /^\d{1,2}:\d{2}$/.test(source.scheduleTime.trim())
    ? source.scheduleTime.trim()
    : defaults.scheduleTime;
  const days = Array.isArray(source.scheduleDays)
    ? source.scheduleDays.filter((d): d is TeammateDay => typeof d === 'string' && (ALL_DAYS as readonly string[]).includes(d))
    : defaults.scheduleDays;
  const validChannels: TeammateChannel[] = ['file', 'telegram', 'discord', 'slack'];
  const channels = Array.isArray(source.channels)
    ? Array.from(new Set(source.channels.filter((c): c is TeammateChannel => typeof c === 'string' && (validChannels as string[]).includes(c))))
    : defaults.channels;
  return {
    enabled,
    scheduleTime,
    scheduleDays: Array.from(new Set(days)),
    channels,
    lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : '',
    nextRunAt: typeof source.nextRunAt === 'string' ? source.nextRunAt : '',
  };
}
