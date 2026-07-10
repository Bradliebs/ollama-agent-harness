import express from 'express';
import {
  getMessageIngressPolicy,
  listConnectorContractFixtures,
  listConnectorReadinessContracts,
  validateConnectorReadinessContracts,
} from '../services/capabilityTemplateStarters';

export interface ConnectorRoutesDeps {
  getConnectorStatusSnapshot: () => Record<string, unknown>;
}

export function createConnectorRouter(deps: ConnectorRoutesDeps): express.Router {
  const { getConnectorStatusSnapshot } = deps;
  const router = express.Router();

  router.get('/api/connectors/status', (_req, res) => {
    res.json({ connectors: getConnectorStatusSnapshot() });
  });

  router.get('/api/connectors/contracts', (_req, res) => {
    try {
      const contracts = listConnectorReadinessContracts();
      res.json({
        contracts,
        fixtures: listConnectorContractFixtures(),
        findings: validateConnectorReadinessContracts(contracts),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/message-ingress/policy', (_req, res) => {
    try {
      res.json({ policy: getMessageIngressPolicy() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
