import { getCapabilityTemplateStarter, getMessageIngressPolicy, listCapabilityTemplateStarters, listConnectorContractFixtures, listConnectorReadinessContracts, validateConnectorReadinessContracts } from './capabilityTemplateStarters';

describe('capabilityTemplateStarters', () => {
  it('returns document starters for ready local templates', () => {
    const starters = listCapabilityTemplateStarters();

    expect(starters).toEqual(expect.arrayContaining([
      expect.objectContaining({ templateId: 'meeting-notes-actions', kind: 'document' }),
      expect.objectContaining({ templateId: 'content-repurpose', kind: 'document' }),
    ]));
  });

  it('returns dependency scan automation starter with allowlisted audit command', () => {
    const starter = getCapabilityTemplateStarter('dependency-vulnerability-scan');

    expect(starter?.kind).toBe('automation');
    expect(starter?.automationJob).toMatchObject({
      name: 'Dependency Vulnerability Scan',
      scriptCommand: 'npm audit --audit-level=moderate',
    });
    expect(starter?.automationJob?.requiredGrantControls).toEqual(expect.arrayContaining(['allowlist', 'kill-switch']));
  });

  it('maps CLAW-style triggers as explicit starter contracts', () => {
    const dependencyScan = getCapabilityTemplateStarter('dependency-vulnerability-scan');
    const meetingNotes = getCapabilityTemplateStarter('meeting-notes-actions');

    expect(dependencyScan?.triggerContracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'scheduled', source: 'Existing automation scheduler', status: 'ready' }),
      expect.objectContaining({ mode: 'event', status: 'design-only', requiredControls: expect.arrayContaining(['dry-run report']) }),
    ]));
    expect(meetingNotes?.triggerContracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'message-ingest', status: 'design-only', requiredControls: expect.arrayContaining(['sender allowlist']) }),
    ]));
  });

  it('exposes connector contracts with read, draft, and ingress operations', () => {
    const contracts = listConnectorReadinessContracts();
    const github = contracts.find((contract) => contract.id === 'github');
    const telegram = contracts.find((contract) => contract.id === 'telegram');

    expect(github?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'pull_request.read', mode: 'read' })]));
    expect(telegram?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'message.ingest', mode: 'ingest' })]));
  });

  it('keeps message ingress behind sender allowlists and approval prompts', () => {
    const policy = getMessageIngressPolicy();
    const telegram = policy.channels.find((channel) => channel.connector === 'telegram');

    expect(policy.defaultMode).toBe('design-only');
    expect(telegram?.requiredControls).toEqual(expect.arrayContaining(['sender allowlist', 'kill switch']));
    expect(telegram?.approvalRequiredFor).toEqual(expect.arrayContaining(['automation job creation', 'memory promotion']));
  });

  it('validates built-in connector contracts against reusable fixtures', () => {
    expect(listConnectorContractFixtures()).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectorId: 'github', requiredOperationModes: expect.arrayContaining(['read', 'draft']) }),
    ]));
    expect(validateConnectorReadinessContracts()).toEqual([]);
  });

  it('reports missing connector contract requirements', () => {
    const findings = validateConnectorReadinessContracts([], [{ connectorId: 'github', requiredOperationModes: ['read'], requiredControls: ['audit-log'] }]);

    expect(findings).toEqual([expect.objectContaining({ connectorId: 'github', code: 'missing-contract' })]);
  });
});
