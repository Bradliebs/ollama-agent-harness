import * as fs from 'fs/promises';
import * as path from 'path';

export type CapabilityAuditEventType = 'grant.created' | 'grant.revoked' | 'grant.expired' | 'automation_script.allowed' | 'automation_script.denied';

export interface CapabilityAuditEvent {
  type: CapabilityAuditEventType;
  capabilityId?: string;
  grantId?: string;
  jobId?: string;
  reason?: string;
  command?: string;
  presetId?: string;
  createdAt?: string;
}

export async function appendCapabilityAuditEvent(projectDir: string, event: CapabilityAuditEvent, now = new Date()): Promise<void> {
  const filePath = capabilityAuditPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify({ ...event, createdAt: event.createdAt ?? now.toISOString() }) + '\n', 'utf-8');
}

export async function readCapabilityAuditEvents(projectDir: string): Promise<CapabilityAuditEvent[]> {
  try {
    const raw = await fs.readFile(capabilityAuditPath(projectDir), 'utf-8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CapabilityAuditEvent);
  } catch {
    return [];
  }
}

function capabilityAuditPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'capabilities', 'audit.jsonl');
}
