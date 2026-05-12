import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendCapabilityAuditEvent, readCapabilityAuditEvents } from './capabilityAudit';

describe('capability audit', () => {
  it('appends and reads capability audit events as jsonl', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-capability-audit-'));

    await appendCapabilityAuditEvent(projectDir, { type: 'grant.created', capabilityId: 'arbitrary-shell', grantId: 'grant-1' }, new Date('2026-05-01T00:00:00.000Z'));
    await appendCapabilityAuditEvent(projectDir, { type: 'automation_script.denied', jobId: 'job-1', reason: 'missing grant' }, new Date('2026-05-01T00:01:00.000Z'));

    await expect(readCapabilityAuditEvents(projectDir)).resolves.toEqual([
      { type: 'grant.created', capabilityId: 'arbitrary-shell', grantId: 'grant-1', createdAt: '2026-05-01T00:00:00.000Z' },
      { type: 'automation_script.denied', jobId: 'job-1', reason: 'missing grant', createdAt: '2026-05-01T00:01:00.000Z' },
    ]);
  });
});
