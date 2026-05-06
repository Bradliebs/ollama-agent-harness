#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function main() {
  const apply = process.argv.includes('--apply');
  const jobSafetyPath = path.join(process.cwd(), 'dist', 'automation', 'jobSafety.js');
  if (!fs.existsSync(jobSafetyPath)) {
    throw new Error(`Missing built file: ${jobSafetyPath}. Run npm run build first.`);
  }

  const { auditAutomationJobSafety } = require(jobSafetyPath);
  const jobsPath = path.join(process.cwd(), '.harness', 'automations', 'jobs.json');
  const jobs = readJobs(jobsPath);
  const audit = auditAutomationJobSafety(jobs);
  const archiveIds = new Set(audit.archiveCandidates.map((job) => job.id));
  const keptJobs = jobs.filter((job) => !archiveIds.has(job.id));
  const archivedJobs = jobs.filter((job) => archiveIds.has(job.id));
  const archivePath = path.join(process.cwd(), '.harness', 'automations', 'archive', `test-created-jobs-${timestamp()}.json`);

  if (apply && archivedJobs.length > 0) {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, JSON.stringify({ archivedAt: new Date().toISOString(), reason: 'Known test-created automation jobs', jobs: archivedJobs }, null, 2) + '\n', 'utf-8');
    fs.writeFileSync(jobsPath, JSON.stringify({ jobs: keptJobs }, null, 2) + '\n', 'utf-8');
  }

  console.log(JSON.stringify({
    ok: true,
    applied: apply,
    jobsPath,
    archivePath: apply && archivedJobs.length > 0 ? archivePath : null,
    archivedCount: archivedJobs.length,
    keptCount: keptJobs.length,
    protectedCount: audit.protectedCount,
    archiveGroups: audit.groups.filter((group) => group.status === 'archive-candidate'),
    protectedGroups: audit.groups.filter((group) => group.status === 'protected'),
    recommendation: apply
      ? 'Known test-created automation jobs were archived and removed from active jobs.json.'
      : 'Dry run only. Re-run with -- --apply to archive known test-created jobs.',
  }, null, 2));
}

function readJobs(jobsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

main();
