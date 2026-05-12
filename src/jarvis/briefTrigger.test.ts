import { defaultBriefTriggerDefinition } from './briefTrigger';

describe('brief trigger definition', () => {
  it('returns a curl POST against /api/jarvis/brief/save by default', () => {
    const def = defaultBriefTriggerDefinition();
    expect(def.command).toBe('curl');
    expect(def.args).toContain('http://127.0.0.1:3000/api/jarvis/brief/save');
    expect(def.intervalSeconds).toBeGreaterThan(60 * 60);
  });

  it('honors custom baseUrl and interval', () => {
    const def = defaultBriefTriggerDefinition({ baseUrl: 'http://localhost:8080', intervalSeconds: 3600 });
    expect(def.args?.some((a) => a.includes('localhost:8080'))).toBe(true);
    expect(def.intervalSeconds).toBe(3600);
  });

  it('defaults to disabled', () => {
    expect(defaultBriefTriggerDefinition().enabled).toBe(false);
  });
});
