import type { CapabilityId, CapabilityRegistry } from './capabilityRegistry';

export type CapabilityTemplateCategory = 'personal' | 'business' | 'developer' | 'creative' | 'advanced';
export type CapabilityTemplatePriority = 'high' | 'medium' | 'low';
export type CapabilityTemplateStatus = 'ready' | 'partial' | 'blocked';

export interface CapabilityTemplate {
  id: string;
  title: string;
  category: CapabilityTemplateCategory;
  priority: CapabilityTemplatePriority;
  description: string;
  recommendedSurface: 'operating-service' | 'automation' | 'workflow' | 'document';
  requiredCapabilities: CapabilityId[];
  requiredConnectors: string[];
  optionalConnectors: string[];
  safetyControls: string[];
  evidence: string[];
  closeSteps: string[];
}

export interface ConnectorReadinessInput {
  connector: string;
  configured?: boolean;
  running?: boolean;
  hasAllowedChatIds?: boolean;
  hasAllowedChannelIds?: boolean;
  hasAllowedRecipients?: boolean;
  mode?: string;
}

export interface EvaluatedCapabilityTemplate extends CapabilityTemplate {
  status: CapabilityTemplateStatus;
  readinessScore: number;
  availableCapabilities: string[];
  missingCapabilities: string[];
  readyConnectors: string[];
  missingConnectors: string[];
  nextAction: string;
}

export const BUILTIN_CAPABILITY_TEMPLATES: CapabilityTemplate[] = [
  {
    id: 'morning-brief',
    title: 'Morning Brief',
    category: 'personal',
    priority: 'high',
    description: 'Daily calendar, inbox, web, and alert summary delivered through an approved message channel.',
    recommendedSurface: 'operating-service',
    requiredCapabilities: ['scheduler', 'email', 'calendar', 'telegram'],
    requiredConnectors: ['google', 'telegram'],
    optionalConnectors: ['slack', 'discord'],
    safetyControls: ['recipient allowlist', 'read-only mailbox scope', 'calendar read scope', 'run evidence'],
    evidence: ['source summary', 'delivery channel', 'scheduled run log'],
    closeSteps: ['Add Google mail/calendar connector', 'Enable Telegram ingress or approved outbound delivery', 'Create daily operating-service template'],
  },
  {
    id: 'meeting-notes-actions',
    title: 'Meeting Notes to Action Items',
    category: 'business',
    priority: 'high',
    description: 'Turn pasted notes or transcripts into owners, deadlines, and a reviewable follow-up document.',
    recommendedSurface: 'document',
    requiredCapabilities: ['local_files', 'ollama'],
    requiredConnectors: [],
    optionalConnectors: ['google', 'notion', 'slack'],
    safetyControls: ['draft-only external updates', 'source transcript retention', 'human review before send'],
    evidence: ['source transcript', 'extracted actions', 'document artifact'],
    closeSteps: ['Ship a reusable document/workflow template', 'Add optional task-system export behind approval'],
  },
  {
    id: 'automated-pr-review',
    title: 'Automated PR Review',
    category: 'developer',
    priority: 'high',
    description: 'Review pull requests for bugs, security risks, tests, and regressions, then prepare a structured review.',
    recommendedSurface: 'workflow',
    requiredCapabilities: ['shell', 'code_runner', 'test_runner'],
    requiredConnectors: ['github'],
    optionalConnectors: ['slack'],
    safetyControls: ['read-only repository token', 'no auto-merge', 'human review before posting comments'],
    evidence: ['diff summary', 'commands run', 'findings and severity'],
    closeSteps: ['Add GitHub connector or MCP recipe', 'Add PR diff ingestion template', 'Add optional comment posting approval'],
  },
  {
    id: 'dependency-vulnerability-scan',
    title: 'Dependency Vulnerability Scanner',
    category: 'developer',
    priority: 'high',
    description: 'Run scheduled dependency and vulnerability checks, prioritize findings, and notify through an approved channel.',
    recommendedSurface: 'automation',
    requiredCapabilities: ['scheduler', 'shell', 'test_runner'],
    requiredConnectors: [],
    optionalConnectors: ['github', 'slack', 'telegram'],
    safetyControls: ['read-only scan commands', 'bounded command allowlist', 'run evidence', 'no automatic upgrades'],
    evidence: ['package files inspected', 'scan command output', 'prioritized report'],
    closeSteps: ['Add workflow template using existing automation runner', 'Extend allowlist with dependency audit commands', 'Add notification delivery after review'],
  },
  {
    id: 'content-repurpose',
    title: 'Content Repurposing Pipeline',
    category: 'creative',
    priority: 'high',
    description: 'Convert one long-form source into platform-specific drafts and a downloadable content bundle.',
    recommendedSurface: 'document',
    requiredCapabilities: ['local_files', 'ollama'],
    requiredConnectors: [],
    optionalConnectors: ['slack', 'notion', 'github'],
    safetyControls: ['draft-only outputs', 'source attribution', 'human review before publication'],
    evidence: ['source document', 'generated variants', 'exported artifact'],
    closeSteps: ['Add a document template for repurposed outputs', 'Add optional social publishing connector behind approval'],
  },
  {
    id: 'second-brain',
    title: 'Memory-Powered Second Brain',
    category: 'advanced',
    priority: 'high',
    description: 'Save notes, links, documents, and decisions into searchable memory with provenance.',
    recommendedSurface: 'operating-service',
    requiredCapabilities: ['local_files', 'ollama', 'vector_memory'],
    requiredConnectors: [],
    optionalConnectors: ['telegram', 'slack', 'notion', 'obsidian'],
    safetyControls: ['provenance on every memory', 'reviewable promotion', 'secret redaction'],
    evidence: ['source item', 'memory entry', 'search result provenance'],
    closeSteps: ['Wire vector memory readiness to actual RAG/embedding state', 'Add message/file ingest template', 'Expose reviewable promotion queue'],
  },
];

export function evaluateCapabilityTemplates(
  registry: CapabilityRegistry,
  connectors: Record<string, ConnectorReadinessInput | undefined> = {},
  templates: CapabilityTemplate[] = BUILTIN_CAPABILITY_TEMPLATES,
): EvaluatedCapabilityTemplate[] {
  return templates.map((template) => evaluateCapabilityTemplate(registry, connectors, template));
}

export function evaluateCapabilityTemplate(
  registry: CapabilityRegistry,
  connectors: Record<string, ConnectorReadinessInput | undefined>,
  template: CapabilityTemplate,
): EvaluatedCapabilityTemplate {
  const availableCapabilities: string[] = [];
  const missingCapabilities: string[] = [];
  for (const capabilityId of template.requiredCapabilities) {
    const capability = registry.get(capabilityId);
    if (registry.has(capabilityId)) availableCapabilities.push(capability?.label ?? capabilityId);
    else missingCapabilities.push(capability?.label ?? capabilityId);
  }

  const readyConnectors = template.requiredConnectors.filter((connector) => connectorIsReady(connectors[connector]));
  const missingConnectors = template.requiredConnectors.filter((connector) => !connectorIsReady(connectors[connector]));
  const totalRequirements = template.requiredCapabilities.length + template.requiredConnectors.length;
  const metRequirements = availableCapabilities.length + readyConnectors.length;
  const readinessScore = totalRequirements === 0 ? 100 : Math.round((metRequirements / totalRequirements) * 100);
  const status = readinessScore === 100 ? 'ready' : readinessScore >= 50 ? 'partial' : 'blocked';
  const nextAction = missingCapabilities.length > 0
    ? `Enable ${missingCapabilities[0]}.`
    : missingConnectors.length > 0
      ? `Configure ${missingConnectors[0]} connector.`
      : template.closeSteps[0] ?? 'Template is ready to run.';

  return {
    ...template,
    status,
    readinessScore,
    availableCapabilities,
    missingCapabilities,
    readyConnectors,
    missingConnectors,
    nextAction,
  };
}

function connectorIsReady(connector: ConnectorReadinessInput | undefined): boolean {
  if (!connector || !connector.configured) return false;
  if (connector.connector === 'telegram') return Boolean(connector.running && connector.hasAllowedChatIds);
  if (connector.connector === 'discord') return Boolean(connector.running && connector.hasAllowedChannelIds);
  if (connector.connector === 'whatsapp') return Boolean(connector.hasAllowedRecipients);
  return true;
}

