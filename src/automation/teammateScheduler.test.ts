import {
  TeammateScheduler,
  defaultTeammateSettings,
  sanitizeTeammateSettings,
  isDueNow,
  alreadyRanForSlot,
  nextOccurrence,
} from './teammateScheduler';
import type { TeammateSettings } from './teammateScheduler';

describe('teammateScheduler', () => {
  describe('sanitizeTeammateSettings', () => {
    it('returns defaults for invalid input', () => {
      const sanitized = sanitizeTeammateSettings(null);
      expect(sanitized).toEqual(defaultTeammateSettings());
    });

    it('rejects malformed scheduleTime and falls back to default', () => {
      const result = sanitizeTeammateSettings({ scheduleTime: 'not-a-time' });
      expect(result.scheduleTime).toBe('08:00');
    });

    it('dedupes and filters channels', () => {
      const result = sanitizeTeammateSettings({ channels: ['telegram', 'telegram', 'bogus', 'file'] });
      expect(result.channels.sort()).toEqual(['file', 'telegram']);
    });

    it('dedupes and filters scheduleDays', () => {
      const result = sanitizeTeammateSettings({ scheduleDays: ['mon', 'mon', 'xyz', 'sat'] });
      expect(result.scheduleDays.sort()).toEqual(['mon', 'sat']);
    });

    it('clamps invalid lastRunAt / nextRunAt to empty string', () => {
      const result = sanitizeTeammateSettings({ lastRunAt: 42, nextRunAt: { weird: true } });
      expect(result.lastRunAt).toBe('');
      expect(result.nextRunAt).toBe('');
    });
  });

  describe('isDueNow', () => {
    const baseSettings = (overrides: Partial<TeammateSettings> = {}): TeammateSettings => ({
      ...defaultTeammateSettings(),
      enabled: true,
      ...overrides,
    });

    it('returns true at the exact slot', () => {
      const now = new Date(2026, 4, 19, 8, 0, 0);
      expect(isDueNow(now, baseSettings({ scheduleTime: '08:00' }))).toBe(true);
    });

    it('returns false one minute before', () => {
      const now = new Date(2026, 4, 19, 7, 59, 0);
      expect(isDueNow(now, baseSettings({ scheduleTime: '08:00' }))).toBe(false);
    });

    it('returns false when the day is excluded', () => {
      const tuesday = new Date(2026, 4, 19, 8, 0, 0);
      expect(isDueNow(tuesday, baseSettings({ scheduleTime: '08:00', scheduleDays: ['mon'] }))).toBe(false);
    });

    it('returns false when disabled', () => {
      const now = new Date(2026, 4, 19, 8, 0, 0);
      expect(isDueNow(now, baseSettings({ scheduleTime: '08:00', enabled: false }))).toBe(false);
    });
  });

  describe('alreadyRanForSlot', () => {
    it('returns false when lastRunAt is empty', () => {
      const now = new Date();
      expect(alreadyRanForSlot(now, defaultTeammateSettings())).toBe(false);
    });

    it('returns true when last run was in the same minute', () => {
      const now = new Date(2026, 4, 19, 8, 0, 30);
      const settings: TeammateSettings = { ...defaultTeammateSettings(), lastRunAt: new Date(2026, 4, 19, 8, 0, 5).toISOString() };
      expect(alreadyRanForSlot(now, settings)).toBe(true);
    });

    it('returns false when last run was in a previous minute', () => {
      const now = new Date(2026, 4, 19, 8, 1, 0);
      const settings: TeammateSettings = { ...defaultTeammateSettings(), lastRunAt: new Date(2026, 4, 19, 8, 0, 0).toISOString() };
      expect(alreadyRanForSlot(now, settings)).toBe(false);
    });
  });

  describe('nextOccurrence', () => {
    it('returns the same-day slot when it has not yet passed', () => {
      const now = new Date(2026, 4, 19, 6, 0, 0); // Tuesday 06:00
      const next = nextOccurrence(now, '08:00', ['tue']);
      expect(next).not.toBeNull();
      expect(next?.getHours()).toBe(8);
      expect(next?.getDate()).toBe(19);
    });

    it('rolls forward to the next allowed day', () => {
      const now = new Date(2026, 4, 19, 10, 0, 0); // Tuesday 10:00 (past 08:00)
      const next = nextOccurrence(now, '08:00', ['wed']);
      expect(next?.getDate()).toBe(20); // Wednesday
    });

    it('returns null when no days are enabled', () => {
      const now = new Date();
      expect(nextOccurrence(now, '08:00', [])).toBeNull();
    });

    it('returns null on malformed time', () => {
      const now = new Date();
      expect(nextOccurrence(now, 'banana', ['mon'])).toBeNull();
    });
  });

  describe('TeammateScheduler runOnce', () => {
    let settings: TeammateSettings;
    const baseOpts = (overrides: Partial<{ delivery: import('./teammateScheduler').TeammateDelivery }> = {}) => ({
      projectDir: process.cwd(),
      getSettings: () => settings,
      updateSettings: (next: TeammateSettings) => { settings = next; },
      snapshot: async () => ({ generatedAt: new Date().toISOString(), markdown: '# Test brief' }),
      delivery: overrides.delivery,
    });

    const makeDelivery = () => {
      const calls: string[] = [];
      return {
        calls,
        sendTelegram: async () => { calls.push('telegram'); },
        sendDiscord: async () => { calls.push('discord'); },
        sendSlack: async () => { calls.push('slack'); },
      };
    };

    beforeEach(() => {
      settings = { ...defaultTeammateSettings(), enabled: true, channels: ['file'] };
    });

    it('delivers to all configured channels', async () => {
      const delivery = makeDelivery();
      settings = { ...settings, channels: ['file', 'telegram', 'discord'] };
      const scheduler = new TeammateScheduler(baseOpts({ delivery }));
      const result = await scheduler.runNow();
      expect(result.fired).toBe(true);
      expect(result.channelsDelivered.sort()).toEqual(['discord', 'file', 'telegram']);
      expect(delivery.calls.sort()).toEqual(['discord', 'telegram']);
    });

    it('records per-channel failures without halting other channels', async () => {
      const delivery = {
        sendTelegram: async () => { throw new Error('boom'); },
        sendDiscord: async () => { /* succeeds */ },
      };
      settings = { ...settings, channels: ['telegram', 'discord'] };
      const scheduler = new TeammateScheduler(baseOpts({ delivery }));
      const result = await scheduler.runNow();
      expect(result.fired).toBe(true);
      expect(result.channelsDelivered).toEqual(['discord']);
      expect(result.channelsFailed).toHaveLength(1);
      expect(result.channelsFailed[0].channel).toBe('telegram');
    });

    it('updates lastRunAt after a successful run', async () => {
      const scheduler = new TeammateScheduler(baseOpts());
      const before = settings.lastRunAt;
      await scheduler.runNow();
      expect(settings.lastRunAt).not.toBe(before);
      expect(settings.lastRunAt).not.toBe('');
    });
  });
});
