export type CapabilityTemplateStarterKind = 'document' | 'automation';
export type ConnectorOperationMode = 'read' | 'draft' | 'confirmed-write' | 'notify' | 'ingest';
export type CapabilityTemplateTriggerMode = 'manual' | 'scheduled' | 'message-ingest' | 'event';
export type CapabilityTemplateTriggerStatus = 'ready' | 'design-only' | 'blocked';

export interface CapabilityTemplateStarterArtifact {
  path: string;
  purpose: string;
}

export interface DocumentTemplateStarter {
  template: 'summary' | 'report' | 'handoff' | 'checklist';
  format: 'markdown' | 'html' | 'pdf' | 'docx';
  sourceLabel: string;
  content: string;
}

export interface AutomationTemplateStarter {
  name: string;
  prompt: string;
  schedule: string;
  scriptCommand?: string;
  requiredGrantControls: string[];
}

export interface CapabilityTemplateTriggerContract {
  mode: CapabilityTemplateTriggerMode;
  source: string;
  status: CapabilityTemplateTriggerStatus;
  requiredControls: string[];
  evidence: string[];
}

export interface CapabilityTemplateStarter {
  templateId: string;
  kind: CapabilityTemplateStarterKind;
  title: string;
  description: string;
  safetyPosture: string[];
  evidence: string[];
  artifacts: CapabilityTemplateStarterArtifact[];
  triggerContracts: CapabilityTemplateTriggerContract[];
  document?: DocumentTemplateStarter;
  automationJob?: AutomationTemplateStarter;
}

export interface ConnectorOperationContract {
  name: string;
  mode: ConnectorOperationMode;
  requiredControls: string[];
  evidence: string[];
}

export interface ConnectorContractFixture {
  connectorId: string;
  requiredOperationModes: ConnectorOperationMode[];
  requiredControls: string[];
}

export interface ConnectorContractValidationFinding {
  connectorId: string;
  code: string;
  message: string;
}

export interface ConnectorReadinessContract {
  id: string;
  label: string;
  purpose: string;
  requiredSecrets: string[];
  requiredSettings: string[];
  requiredControls: string[];
  readinessChecks: string[];
  operations: ConnectorOperationContract[];
}

export interface MessageIngressChannelPolicy {
  connector: string;
  mode: 'disabled' | 'design-only' | 'ready-after-contract';
  allowedSenderSetting: string;
  acceptedPayloads: string[];
  requiredControls: string[];
  approvalRequiredFor: string[];
  evidence: string[];
}

export interface MessageIngressPolicy {
  id: string;
  label: string;
  defaultMode: 'design-only';
  channels: MessageIngressChannelPolicy[];
}

export const BUILTIN_CAPABILITY_TEMPLATE_STARTERS: CapabilityTemplateStarter[] = [
  {
    templateId: 'meeting-notes-actions',
    kind: 'document',
    title: 'Meeting Notes to Action Items Starter',
    description: 'Document Studio payload for turning pasted meeting notes into owners, deadlines, decisions, and follow-up text.',
    safetyPosture: ['draft-only output', 'source retained locally', 'human review before external send'],
    evidence: ['source meeting notes', 'extracted action table', 'decision summary'],
    artifacts: [{ path: '.harness/documents', purpose: 'Generated markdown, HTML, PDF, or DOCX document plus metadata.' }],
    triggerContracts: [
      { mode: 'manual', source: 'Document Studio paste or upload', status: 'ready', requiredControls: ['local write target', 'human review'], evidence: ['source notes', 'generated document metadata'] },
      { mode: 'message-ingest', source: 'Telegram or Slack document upload', status: 'design-only', requiredControls: ['sender allowlist', 'secret redaction', 'approval before memory promotion'], evidence: ['sender hash', 'upload metadata', 'routing decision'] },
    ],
    document: {
      template: 'handoff',
      format: 'markdown',
      sourceLabel: 'Meeting notes',
      content: [
        'Paste meeting notes or transcript here.',
        '',
        'Required output:',
        '* Decisions made',
        '* Open questions',
        '* Action items with owner, deadline, and confidence',
        '* Follow-up message draft for human review',
      ].join('\n'),
    },
  },
  {
    templateId: 'content-repurpose',
    kind: 'document',
    title: 'Content Repurposing Starter',
    description: 'Document Studio payload for producing local draft variants from one source artifact.',
    safetyPosture: ['draft-only output', 'source attribution', 'human review before publication'],
    evidence: ['source artifact', 'generated variants', 'review notes'],
    artifacts: [{ path: '.harness/documents', purpose: 'Generated draft bundle and metadata.' }],
    triggerContracts: [
      { mode: 'manual', source: 'Document Studio source artifact', status: 'ready', requiredControls: ['local write target', 'source attribution'], evidence: ['source artifact', 'generated document metadata'] },
      { mode: 'event', source: 'New approved content artifact', status: 'design-only', requiredControls: ['artifact allowlist', 'dry-run preview', 'human review before publication'], evidence: ['artifact id', 'preview hash', 'approval result'] },
    ],
    document: {
      template: 'report',
      format: 'markdown',
      sourceLabel: 'Source content',
      content: [
        'Paste article, transcript, or notes here.',
        '',
        'Required output:',
        '* Executive summary',
        '* Short post draft',
        '* Long post draft',
        '* Email/newsletter draft',
        '* Source attribution checklist',
      ].join('\n'),
    },
  },
  {
    templateId: 'dependency-vulnerability-scan',
    kind: 'automation',
    title: 'Dependency Vulnerability Scan Starter',
    description: 'Automation job payload that runs a read-only dependency audit and asks Harness to prioritize the result.',
    safetyPosture: ['requires shell grant', 'requires background job grant', 'command allowlist enforced', 'no automatic upgrades'],
    evidence: ['automation run log', 'capability audit event', 'scan command output', 'prioritized report'],
    artifacts: [
      { path: '.harness/automations/jobs.json', purpose: 'Persisted automation job when created by the existing automation API.' },
      { path: '.harness/automations/output', purpose: 'Run prompt and script context for each execution.' },
      { path: '.harness/capabilities/audit.jsonl', purpose: 'Allowed or denied script execution audit events.' },
    ],
    triggerContracts: [
      { mode: 'scheduled', source: 'Existing automation scheduler', status: 'ready', requiredControls: ['explicit-grant', 'time-limit', 'allowlist', 'kill-switch'], evidence: ['automation run log', 'capability audit event'] },
      { mode: 'event', source: 'Package manifest or lockfile change', status: 'design-only', requiredControls: ['repository allowlist', 'read-only audit command', 'dry-run report'], evidence: ['changed package files', 'audit command output', 'routing decision'] },
    ],
    automationJob: {
      name: 'Dependency Vulnerability Scan',
      schedule: '0 9 * * 1',
      scriptCommand: 'npm audit --audit-level=moderate',
      requiredGrantControls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'],
      prompt: [
        'Review the dependency audit output.',
        'Prioritize exploitable or production-impacting findings first.',
        'Do not upgrade packages automatically.',
        'Return a concise report with severity, affected package, evidence, and recommended next validation command.',
      ].join('\n'),
    },
  },
];

export const BUILTIN_CONNECTOR_CONTRACTS: ConnectorReadinessContract[] = [
  {
    id: 'google',
    label: 'Google Mail and Calendar',
    purpose: 'Read mailbox and calendar data for briefs, then optionally draft messages or calendar changes after review.',
    requiredSecrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    requiredSettings: ['allowed account emails', 'OAuth scope allowlist'],
    requiredControls: ['explicit-grant', 'audit-log', 'redaction', 'allowlist', 'human-confirmation', 'kill-switch'],
    readinessChecks: ['OAuth token present', 'read scopes only by default', 'account allowlist configured', 'draft mode available for writes'],
    operations: [
      { name: 'mail.search', mode: 'read', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['query', 'message ids', 'redacted summary'] },
      { name: 'calendar.list', mode: 'read', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['calendar id', 'time window', 'event ids'] },
      { name: 'mail.draft', mode: 'draft', requiredControls: ['allowlist', 'redaction', 'human-confirmation', 'audit-log'], evidence: ['draft id', 'recipient allowlist match', 'preview hash'] },
    ],
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 Mail and Calendar',
    purpose: 'Read Outlook mailbox and calendar data for briefs, then optionally draft messages or calendar changes after review.',
    requiredSecrets: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    requiredSettings: ['allowed account emails', 'OAuth scope allowlist'],
    requiredControls: ['explicit-grant', 'audit-log', 'redaction', 'allowlist', 'human-confirmation', 'kill-switch'],
    readinessChecks: ['OAuth token present', 'read scopes only by default', 'account allowlist configured', 'draft mode available for writes'],
    operations: [
      { name: 'mail.search', mode: 'read', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['query', 'message ids', 'redacted summary'] },
      { name: 'calendar.list', mode: 'read', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['calendar id', 'time window', 'event ids'] },
      { name: 'mail.draft', mode: 'draft', requiredControls: ['allowlist', 'redaction', 'human-confirmation', 'audit-log'], evidence: ['draft id', 'recipient allowlist match', 'preview hash'] },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    purpose: 'Read pull request diffs and checks, then optionally prepare comments after human approval.',
    requiredSecrets: ['GITHUB_TOKEN'],
    requiredSettings: ['repository allowlist', 'read-only default scopes'],
    requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'dry-run', 'human-confirmation', 'kill-switch'],
    readinessChecks: ['token present', 'repository allowlist configured', 'comment posting disabled by default'],
    operations: [
      { name: 'pull_request.read', mode: 'read', requiredControls: ['allowlist', 'audit-log'], evidence: ['repository', 'pull request number', 'diff summary'] },
      { name: 'pull_request.comment.preview', mode: 'draft', requiredControls: ['dry-run', 'human-confirmation', 'audit-log'], evidence: ['comment body hash', 'target file', 'target line'] },
    ],
  },
  {
    id: 'notion',
    label: 'Notion',
    purpose: 'Read and draft updates to approved pages or databases for knowledge workflows.',
    requiredSecrets: ['NOTION_TOKEN'],
    requiredSettings: ['page or database allowlist'],
    requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'dry-run', 'human-confirmation', 'rollback', 'kill-switch'],
    readinessChecks: ['token present', 'workspace targets allowlisted', 'draft or preview mode available'],
    operations: [
      { name: 'page.read', mode: 'read', requiredControls: ['allowlist', 'audit-log', 'redaction'], evidence: ['page id', 'last edited time', 'source summary'] },
      { name: 'page.update.preview', mode: 'draft', requiredControls: ['dry-run', 'human-confirmation', 'rollback', 'audit-log'], evidence: ['page id', 'preview hash', 'rollback note'] },
    ],
  },
  {
    id: 'telegram',
    label: 'Telegram Ingress',
    purpose: 'Accept commands, documents, and capture requests from allowlisted chat ids.',
    requiredSecrets: ['HARNESS_TELEGRAM_BOT_TOKEN'],
    requiredSettings: ['telegramAllowedChatIds'],
    requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'],
    readinessChecks: ['bot token present', 'bot running', 'chat allowlist configured', 'approval prompts enabled for writes'],
    operations: [
      { name: 'message.ingest', mode: 'ingest', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['chat id hash', 'message type', 'routing decision'] },
      { name: 'notification.send', mode: 'notify', requiredControls: ['allowlist', 'human-confirmation', 'audit-log'], evidence: ['chat id hash', 'message preview hash'] },
    ],
  },
  {
    id: 'slack',
    label: 'Slack Ingress',
    purpose: 'Accept messages from approved workspaces and channels after a future inbound app contract exists.',
    requiredSecrets: ['HARNESS_SLACK_BOT_TOKEN', 'HARNESS_SLACK_SIGNING_SECRET'],
    requiredSettings: ['workspace allowlist', 'channel allowlist'],
    requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'],
    readinessChecks: ['signature verification configured', 'workspace allowlist configured', 'channel allowlist configured'],
    operations: [
      { name: 'message.ingest', mode: 'ingest', requiredControls: ['allowlist', 'redaction', 'audit-log'], evidence: ['workspace id hash', 'channel id hash', 'routing decision'] },
    ],
  },
];

export const BUILTIN_MESSAGE_INGRESS_POLICY: MessageIngressPolicy = {
  id: 'message-ingress-v1',
  label: 'Message Ingress Policy',
  defaultMode: 'design-only',
  channels: [
    {
      connector: 'telegram',
      mode: 'ready-after-contract',
      allowedSenderSetting: 'telegramAllowedChatIds',
      acceptedPayloads: ['text commands', 'document uploads', 'capture-to-memory requests'],
      requiredControls: ['sender allowlist', 'secret redaction', 'run evidence', 'kill switch'],
      approvalRequiredFor: ['file writes outside .harness scratch space', 'external notifications', 'automation job creation', 'memory promotion'],
      evidence: ['chat id hash', 'message id', 'payload type', 'routing decision', 'approval result'],
    },
    {
      connector: 'slack',
      mode: 'design-only',
      allowedSenderSetting: 'workspace/channel allowlist',
      acceptedPayloads: ['text commands', 'capture-to-memory requests'],
      requiredControls: ['signature verification', 'workspace allowlist', 'channel allowlist', 'secret redaction', 'run evidence', 'kill switch'],
      approvalRequiredFor: ['external posting', 'automation job creation', 'memory promotion'],
      evidence: ['workspace id hash', 'channel id hash', 'message timestamp', 'routing decision', 'approval result'],
    },
  ],
};

export const CONNECTOR_CONTRACT_FIXTURES: ConnectorContractFixture[] = [
  { connectorId: 'google', requiredOperationModes: ['read', 'draft'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'] },
  { connectorId: 'microsoft', requiredOperationModes: ['read', 'draft'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'] },
  { connectorId: 'github', requiredOperationModes: ['read', 'draft'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'dry-run', 'human-confirmation', 'kill-switch'] },
  { connectorId: 'notion', requiredOperationModes: ['read', 'draft'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'dry-run', 'human-confirmation', 'rollback', 'kill-switch'] },
  { connectorId: 'telegram', requiredOperationModes: ['ingest', 'notify'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'] },
  { connectorId: 'slack', requiredOperationModes: ['ingest'], requiredControls: ['explicit-grant', 'audit-log', 'allowlist', 'redaction', 'human-confirmation', 'kill-switch'] },
];

export function listCapabilityTemplateStarters(templateId?: string): CapabilityTemplateStarter[] {
  const starters = templateId
    ? BUILTIN_CAPABILITY_TEMPLATE_STARTERS.filter((starter) => starter.templateId === templateId)
    : BUILTIN_CAPABILITY_TEMPLATE_STARTERS;
  return starters.map(cloneStarter);
}

export function getCapabilityTemplateStarter(templateId: string): CapabilityTemplateStarter | null {
  const starter = BUILTIN_CAPABILITY_TEMPLATE_STARTERS.find((candidate) => candidate.templateId === templateId);
  return starter ? cloneStarter(starter) : null;
}

export function listConnectorReadinessContracts(): ConnectorReadinessContract[] {
  return BUILTIN_CONNECTOR_CONTRACTS.map((contract) => structuredClone(contract));
}

export function getMessageIngressPolicy(): MessageIngressPolicy {
  return structuredClone(BUILTIN_MESSAGE_INGRESS_POLICY);
}

export function listConnectorContractFixtures(): ConnectorContractFixture[] {
  return CONNECTOR_CONTRACT_FIXTURES.map((fixture) => structuredClone(fixture));
}

export function validateConnectorReadinessContracts(
  contracts: ConnectorReadinessContract[] = BUILTIN_CONNECTOR_CONTRACTS,
  fixtures: ConnectorContractFixture[] = CONNECTOR_CONTRACT_FIXTURES,
): ConnectorContractValidationFinding[] {
  const findings: ConnectorContractValidationFinding[] = [];
  for (const fixture of fixtures) {
    const contract = contracts.find((candidate) => candidate.id === fixture.connectorId);
    if (!contract) {
      findings.push({ connectorId: fixture.connectorId, code: 'missing-contract', message: 'Connector contract is missing.' });
      continue;
    }
    for (const mode of fixture.requiredOperationModes) {
      if (!contract.operations.some((operation) => operation.mode === mode)) {
        findings.push({ connectorId: fixture.connectorId, code: 'missing-operation-mode', message: `Connector contract must include a ${mode} operation.` });
      }
    }
    for (const control of fixture.requiredControls) {
      if (!contract.requiredControls.includes(control)) {
        findings.push({ connectorId: fixture.connectorId, code: 'missing-control', message: `Connector contract must require ${control}.` });
      }
    }
    for (const operation of contract.operations) {
      if (operation.evidence.length === 0) {
        findings.push({ connectorId: fixture.connectorId, code: 'missing-operation-evidence', message: `${operation.name} must declare evidence.` });
      }
      if (operation.requiredControls.length === 0) {
        findings.push({ connectorId: fixture.connectorId, code: 'missing-operation-controls', message: `${operation.name} must declare required controls.` });
      }
    }
  }
  return findings;
}

function cloneStarter(starter: CapabilityTemplateStarter): CapabilityTemplateStarter {
  return structuredClone(starter);
}
