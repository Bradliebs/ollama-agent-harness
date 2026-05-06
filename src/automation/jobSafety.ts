import type { AutomationJob } from './jobs';

export type AutomationJobSafetyStatus = 'archive-candidate' | 'protected';

export interface AutomationJobSafetyFinding {
  id: string;
  name: string;
  status: AutomationJobSafetyStatus;
  reason: string;
  enabled: boolean;
  lastRunAt?: string;
  updatedAt: string;
}

export interface AutomationJobSafetyGroup {
  name: string;
  count: number;
  status: AutomationJobSafetyStatus;
  reason: string;
}

export interface AutomationJobSafetyAudit {
  totalJobs: number;
  archiveCandidateCount: number;
  protectedCount: number;
  groups: AutomationJobSafetyGroup[];
  archiveCandidates: AutomationJobSafetyFinding[];
  protectedJobs: AutomationJobSafetyFinding[];
}

const TEST_CREATED_JOB_NAMES = new Set([
  'due discovery job',
  'evidence run job',
  'lifecycle-test-job',
  'smoke-lifecycle',
]);

export function auditAutomationJobSafety(jobs: AutomationJob[]): AutomationJobSafetyAudit {
  const findings = jobs.map(classifyAutomationJobSafety);
  const archiveCandidates = findings.filter((finding) => finding.status === 'archive-candidate');
  const protectedJobs = findings.filter((finding) => finding.status === 'protected');
  return {
    totalJobs: findings.length,
    archiveCandidateCount: archiveCandidates.length,
    protectedCount: protectedJobs.length,
    groups: groupSafetyFindings(findings),
    archiveCandidates,
    protectedJobs,
  };
}

export function classifyAutomationJobSafety(job: AutomationJob): AutomationJobSafetyFinding {
  if (TEST_CREATED_JOB_NAMES.has(job.name)) {
    return {
      id: job.id,
      name: job.name,
      status: 'archive-candidate',
      reason: 'Matches deterministic server API test job names; safe to archive only after explicit approval.',
      enabled: job.enabled,
      lastRunAt: job.lastRunAt,
      updatedAt: job.updatedAt,
    };
  }

  return {
    id: job.id,
    name: job.name,
    status: 'protected',
    reason: 'Does not match known test-created automation job names.',
    enabled: job.enabled,
    lastRunAt: job.lastRunAt,
    updatedAt: job.updatedAt,
  };
}

function groupSafetyFindings(findings: AutomationJobSafetyFinding[]): AutomationJobSafetyGroup[] {
  const groups = new Map<string, AutomationJobSafetyFinding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.name) || [];
    group.push(finding);
    groups.set(finding.name, group);
  }

  return Array.from(groups.entries())
    .map(([name, group]) => ({
      name,
      count: group.length,
      status: group.every((finding) => finding.status === 'archive-candidate') ? 'archive-candidate' as const : 'protected' as const,
      reason: group[0]?.reason || 'No findings.',
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}
