import { PermissionPromptBroker } from './promptBroker';
import type { ToolCall } from '../types';

function makeCall(name = 'bash'): ToolCall {
  return { name, input: { command: 'npm test' } };
}

describe('PermissionPromptBroker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists pending prompts and resolves approvals', async () => {
    const broker = new PermissionPromptBroker();
    const result = broker.request(makeCall(), 'Needs approval');
    const prompts = broker.list();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ call: makeCall(), reason: 'Needs approval' });
    expect(broker.resolve(prompts[0].id, true)).toBe(true);
    await expect(result).resolves.toEqual({ allowed: true, reason: 'Approved by user' });
    expect(broker.list()).toEqual([]);
  });

  it('returns false when resolving an unknown prompt', () => {
    const broker = new PermissionPromptBroker();

    expect(broker.resolve('missing', true)).toBe(false);
  });

  it('clears pending prompts as denied', async () => {
    const broker = new PermissionPromptBroker();
    const result = broker.request(makeCall('file_write'));

    broker.clear();

    await expect(result).resolves.toEqual({ allowed: false, reason: 'Permission prompts cleared' });
    expect(broker.list()).toEqual([]);
  });

  it('denies prompts that time out with an actionable reason', async () => {
    jest.useFakeTimers();
    const broker = new PermissionPromptBroker(50);
    const result = broker.request(makeCall('bash'), 'Needs user input');

    jest.advanceTimersByTime(50);

    const resolved = await result;
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toContain("Permission prompt for 'bash' timed out");
    expect(resolved.reason).toContain('50ms');
    expect(resolved.reason).toContain('Needs user input');
    expect(resolved.reason).toContain('HARNESS_PERMISSION_PROMPT_TIMEOUT_MS');
    expect(broker.list()).toEqual([]);
  });
});