#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENABLE_FLAG = 'HARNESS_RUN_DEPENDENCY_AUDIT_SMOKE';

async function main() {
  if (!truthy(process.env[ENABLE_FLAG])) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: `Set ${ENABLE_FLAG}=1 to run the live dependency audit smoke.` }, null, 2));
    return;
  }

  const runnerPath = path.join(process.cwd(), 'dist', 'automation', 'runner.js');
  const capabilitiesPath = path.join(process.cwd(), 'dist', 'permissions', 'capabilities.js');
  const auditPath = path.join(process.cwd(), 'dist', 'permissions', 'capabilityAudit.js');
  const starterPath = path.join(process.cwd(), 'dist', 'services', 'capabilityTemplateStarters.js');
  for (const requiredPath of [runnerPath, capabilitiesPath, auditPath, starterPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing built file: ${requiredPath}. Run npm run build first.`);
  }

  const { prepareAutomationRun } = require(runnerPath);
  const { createCapabilityGrant } = require(capabilitiesPath);
  const { readCapabilityAuditEvents } = require(auditPath);
  const { getCapabilityTemplateStarter } = require(starterPath);
  const starter = getCapabilityTemplateStarter('dependency-vulnerability-scan');
  if (!starter?.automationJob?.scriptCommand) throw new Error('Dependency vulnerability scan starter is missing an automation command.');

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dependency-audit-smoke-'));
  fs.copyFileSync(path.join(process.cwd(), 'package.json'), path.join(projectDir, 'package.json'));
  fs.copyFileSync(path.join(process.cwd(), 'package-lock.json'), path.join(projectDir, 'package-lock.json'));

  const now = new Date();
  const grants = [
    createCapabilityGrant({ id: 'smoke-shell', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'], now, expiresInMinutes: 10 }).grant,
    createCapabilityGrant({ id: 'smoke-background', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'], now, expiresInMinutes: 10 }).grant,
  ].filter(Boolean);

  const job = {
    id: 'dependency-vulnerability-scan-smoke',
    name: starter.automationJob.name,
    prompt: starter.automationJob.prompt,
    schedule: { kind: 'once', display: 'smoke', runAt: now.toISOString() },
    enabled: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    scriptCommand: starter.automationJob.scriptCommand,
  };

  try {
    const run = await prepareAutomationRun(projectDir, job, now, { grants, now });
    const events = await readCapabilityAuditEvents(projectDir);
    const allowed = events.find((event) => event.type === 'automation_script.allowed' && event.command === starter.automationJob.scriptCommand);
    if (!allowed) throw new Error('Dependency audit smoke did not record an allowed automation_script audit event.');
    if (/Script blocked by/i.test(run.scriptOutput)) throw new Error(`Dependency audit smoke was blocked:\n${run.scriptOutput}`);
    console.log(JSON.stringify({
      ok: true,
      skipped: false,
      command: starter.automationJob.scriptCommand,
      presetId: allowed.presetId,
      outputBytes: run.scriptOutput.length,
      outputPath: run.outputPath,
    }, null, 2));
  } finally {
    if (!truthy(process.env.HARNESS_KEEP_DEPENDENCY_AUDIT_SMOKE)) fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
