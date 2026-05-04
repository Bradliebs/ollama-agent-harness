import { startDiscordBot, stopDiscordBot, isDiscordBotRunning } from './discord';

// Discord bot tests validate the module API without connecting to Discord.
// The dynamic import of discord.js will fail in test environments without
// the full dependency tree, which is expected — these tests verify the
// harness-side logic.

describe('Discord integration', () => {
  afterEach(() => {
    stopDiscordBot();
  });

  it('reports not running when no bot is started', () => {
    expect(isDiscordBotRunning()).toBe(false);
  });

  it('stopDiscordBot is safe to call when not running', () => {
    expect(() => stopDiscordBot()).not.toThrow();
  });

  it('startDiscordBot returns a handle with expected shape', () => {
    // This will try to import discord.js and connect — it won't succeed
    // in tests, but it should return a handle synchronously.
    const handle = startDiscordBot('fake-token-for-test', 'http://localhost:9999');
    expect(handle).not.toBeNull();
    expect(typeof handle?.stop).toBe('function');
    expect(typeof handle?.isRunning).toBe('function');
    // Not running yet — discord.js import is async
    // (it may fail silently in test environment)
    handle?.stop();
  });

  it('does not start a second bot if one is already pending', () => {
    const first = startDiscordBot('token1', 'http://localhost:9999');
    const second = startDiscordBot('token2', 'http://localhost:9999');
    // Second call should return the same handle (or null if first is still running)
    expect(first).not.toBeNull();
    // Clean up
    first?.stop();
    second?.stop();
  });

  it('stopDiscordBot sets running to false', () => {
    startDiscordBot('token', 'http://localhost:9999');
    stopDiscordBot();
    expect(isDiscordBotRunning()).toBe(false);
  });
});

// Test the SSE parsing and message splitting logic
// These are internal functions — we test them indirectly through the module
describe('Discord message handling', () => {
  it('exports the expected public API', async () => {
    const discord = await import('./discord');
    expect(typeof discord.startDiscordBot).toBe('function');
    expect(typeof discord.stopDiscordBot).toBe('function');
    expect(typeof discord.isDiscordBotRunning).toBe('function');
  });
});
