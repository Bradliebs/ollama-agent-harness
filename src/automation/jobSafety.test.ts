import { auditAutomationJobSafety, classifyAutomationJobSafety } from './jobSafety';
import type { AutomationJob } from './jobs';

function job(input: Partial<AutomationJob> & { id: string; name: string }): AutomationJob {
  return {
    prompt: 'test',
    schedule: { kind: 'once', display: 'once', runAt: '2026-05-06T00:00:00.000Z' },
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    enabled: false,
    ...input,
  };
}

describe('automation job safety audit', () => {
  it('classifies deterministic server API test jobs as archive candidates', () => {
    const finding = classifyAutomationJobSafety(job({ id: 'test-job', name: 'smoke-lifecycle' }));

    expect(finding).toMatchObject({
      status: 'archive-candidate',
      reason: expect.stringContaining('explicit approval'),
    });
  });

  it('protects user and service jobs by default', () => {
    const finding = classifyAutomationJobSafety(job({ id: 'user-job', name: 'Bullet Journal daily check-in', enabled: true }));

    expect(finding).toMatchObject({
      status: 'protected',
      enabled: true,
    });
  });

  it('summarizes archive candidates separately from protected jobs', () => {
    const audit = auditAutomationJobSafety([
      job({ id: 'test-1', name: 'due discovery job' }),
      job({ id: 'test-2', name: 'due discovery job' }),
      job({ id: 'service-1', name: 'Site Monitor Agent: site_monitor_b4b70f75', enabled: true }),
    ]);

    expect(audit).toMatchObject({
      totalJobs: 3,
      archiveCandidateCount: 2,
      protectedCount: 1,
    });
    expect(audit.groups).toEqual([
      expect.objectContaining({ name: 'due discovery job', count: 2, status: 'archive-candidate' }),
      expect.objectContaining({ name: 'Site Monitor Agent: site_monitor_b4b70f75', count: 1, status: 'protected' }),
    ]);
  });
});
