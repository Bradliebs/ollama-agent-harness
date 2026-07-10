import { redactSecrets, redact } from './secretRedactor';

describe('redactSecrets', () => {
  it('returns the input unchanged when there are no secrets', () => {
    const { result, count } = redactSecrets('just a normal sentence with no secrets');
    expect(result).toBe('just a normal sentence with no secrets');
    expect(count).toBe(0);
  });

  it('redacts a classic GitHub PAT', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const { result, count } = redactSecrets(`token is ${token} ok`);
    expect(result).toBe('token is [REDACTED:github-pat] ok');
    expect(count).toBe(1);
  });

  it('redacts a fine-grained GitHub PAT before the generic family', () => {
    const token = `github_pat_${'a'.repeat(22)}_${'b'.repeat(59)}`;
    const { result } = redactSecrets(token);
    expect(result).toBe('[REDACTED:github-fine-grained]');
  });

  it('redacts an OpenAI key', () => {
    const key = 'sk-' + 'A'.repeat(40);
    const { result } = redactSecrets(key);
    expect(result).toBe('[REDACTED:openai-key]');
  });

  it('redacts an Anthropic key before the generic sk- pattern', () => {
    const key = 'sk-ant-' + 'a'.repeat(95);
    const { result } = redactSecrets(key);
    expect(result).toBe('[REDACTED:anthropic-key]');
  });

  it('redacts an AWS access key', () => {
    const { result } = redactSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(result).toBe('[REDACTED:aws-access-key]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123DEF';
    const { result } = redactSecrets(jwt);
    expect(result).toBe('[REDACTED:jwt]');
  });

  it('redacts a Slack token', () => {
    const { result } = redactSecrets('xoxb-123456789012-abcdefghij');
    expect(result).toBe('[REDACTED:slack-token]');
  });

  it('counts and redacts multiple distinct secrets in one string', () => {
    const text = `gh ghp_${'a'.repeat(36)} and aws AKIAIOSFODNN7EXAMPLE`;
    const { result, count } = redactSecrets(text);
    expect(count).toBe(2);
    expect(result).toContain('[REDACTED:github-pat]');
    expect(result).toContain('[REDACTED:aws-access-key]');
  });

  it('redact() returns only the scrubbed string', () => {
    const key = 'sk-' + 'A'.repeat(40);
    expect(redact(`key ${key}`)).toBe('key [REDACTED:openai-key]');
  });
});
