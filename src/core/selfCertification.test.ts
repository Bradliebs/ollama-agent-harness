import { detectSelfCertification, type SelfCertificationFinding } from './outputValidation';

describe('detectSelfCertification', () => {
  it('returns empty for text with no claims', () => {
    const findings = detectSelfCertification('Here is the weather forecast for today.', ['web_read']);
    expect(findings).toHaveLength(0);
  });

  it('detects "email sent" without email tool', () => {
    const findings = detectSelfCertification('✅ Email alert sent to your inbox!', []);
    expect(findings).toHaveLength(1);
    expect(findings[0].claimType).toBe('notification_sent');
    expect(findings[0].hasEvidence).toBe(false);
  });

  it('does not flag "email sent" when telegram_notify was called', () => {
    const findings = detectSelfCertification('✅ Email alert sent to your inbox!', ['telegram_notify']);
    expect(findings).toHaveLength(0);
  });

  it('detects "scheduled 3 daily alerts" without file_write', () => {
    const findings = detectSelfCertification('I scheduled 3 daily automation jobs for you.', []);
    expect(findings).toHaveLength(1);
    expect(findings[0].claimType).toBe('automation_scheduled');
  });

  it('does not flag scheduling when bash was used', () => {
    const findings = detectSelfCertification('I scheduled 3 daily automation jobs for you.', ['bash']);
    expect(findings).toHaveLength(0);
  });

  it('detects "test passed" without bash tool as a fail severity', () => {
    const findings = detectSelfCertification('All tests passed and the build succeeded.', []);
    expect(findings).toHaveLength(1);
    expect(findings[0].claimType).toBe('validation_passed');
    expect(findings[0].severity).toBe('fail');
  });

  it('does not flag "test passed" when bash was used', () => {
    const findings = detectSelfCertification('All tests passed and the build succeeded.', ['bash']);
    expect(findings).toHaveLength(0);
  });

  it('detects "deployed to production" without evidence', () => {
    const findings = detectSelfCertification('Successfully deployed to production server.', []);
    expect(findings).toHaveLength(1);
    expect(findings[0].claimType).toBe('deployment');
  });

  it('returns empty for short text', () => {
    const findings = detectSelfCertification('Done.', []);
    expect(findings).toHaveLength(0);
  });

  it('detects multiple claims in one response', () => {
    const findings = detectSelfCertification(
      'I sent an email notification, scheduled 3 daily alerts, and all tests passed.',
      [],
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});
