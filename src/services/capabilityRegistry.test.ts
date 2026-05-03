import { CapabilityRegistry, createDefaultCapabilityRegistry } from './capabilityRegistry';

describe('capabilityRegistry', () => {
  it('registers and retrieves capabilities', () => {
    const registry = new CapabilityRegistry();
    registry.register('scheduler', 'Job scheduler', 'available');
    expect(registry.has('scheduler')).toBe(true);
    expect(registry.get('scheduler')?.status).toBe('available');
  });

  it('reports unavailable capabilities', () => {
    const registry = new CapabilityRegistry();
    registry.register('notifications', 'Push notifications', 'unavailable', 'Not configured.');
    expect(registry.has('notifications')).toBe(false);
    expect(registry.get('notifications')?.reason).toBe('Not configured.');
  });

  it('lists available and missing capabilities', () => {
    const registry = createDefaultCapabilityRegistry();
    expect(registry.available().length).toBeGreaterThan(0);
    expect(registry.missing().length).toBeGreaterThan(0);
  });

  it('checks required capabilities and returns missing ones', () => {
    const registry = createDefaultCapabilityRegistry();
    const missing = registry.checkRequired(['scheduler', 'notifications']);
    expect(missing.length).toBe(1);
    expect(missing[0].id).toBe('notifications');
  });

  it('formats limitation message for missing capabilities', () => {
    const registry = createDefaultCapabilityRegistry();
    const message = registry.formatLimitations(['notifications', 'email']);
    expect(message).toContain('not available');
    expect(message).toContain('Push notifications');
  });

  it('returns null limitation for fully available capabilities', () => {
    const registry = createDefaultCapabilityRegistry();
    const message = registry.formatLimitations(['scheduler', 'local_files']);
    expect(message).toBeNull();
  });

  it('scheduler is available in default registry', () => {
    const registry = createDefaultCapabilityRegistry();
    expect(registry.has('scheduler')).toBe(true);
  });

  it('checks scheduler before promising reminders', () => {
    const registry = new CapabilityRegistry();
    registry.register('scheduler', 'Scheduler', 'unavailable', 'Not running.');
    registry.register('notifications', 'Notifications', 'unavailable');
    const missing = registry.checkRequired(['scheduler', 'notifications']);
    expect(missing.length).toBe(2);
    const message = registry.formatLimitations(['scheduler', 'notifications']);
    expect(message).toContain('not available');
  });

  it('refreshes capabilities via registered checkers', async () => {
    const registry = new CapabilityRegistry();
    registry.register('ollama', 'Ollama', 'unavailable');
    registry.registerChecker('ollama', () => ({ id: 'ollama', status: 'available', reason: 'Ollama is running.' }));
    await registry.refresh('ollama');
    expect(registry.has('ollama')).toBe(true);
  });
});
