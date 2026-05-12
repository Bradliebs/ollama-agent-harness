#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function main() {
  const jobSafetyPath = path.join(process.cwd(), 'dist', 'automation', 'jobSafety.js');
  if (!fs.existsSync(jobSafetyPath)) {
    throw new Error(`Missing built file: ${jobSafetyPath}. Run npm run build first.`);
  }

  const { auditAutomationJobSafety } = require(jobSafetyPath);
  const jobsPath = path.join(process.cwd(), '.harness', 'automations', 'jobs.json');
  const jobs = readJobs(jobsPath);
  const audit = auditAutomationJobSafety(jobs);
  const archiveGroups = audit.groups.filter((group) => group.status === 'archive-candidate');
  const protectedGroups = audit.groups.filter((group) => group.status === 'protected');

  console.log(JSON.stringify({
    ok: true,
    jobsPath,
    totalJobs: audit.totalJobs,
    archiveCandidateCount: audit.archiveCandidateCount,
    protectedCount: audit.protectedCount,
    archiveGroups,
    protectedGroups,
    recommendation: audit.archiveCandidateCount > 0
      ? 'Archive candidates are non-destructive recommendations only. Confirm before deleting or moving live runtime jobs.'
      : 'No known test-created automation job duplicates found.',
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

main();
