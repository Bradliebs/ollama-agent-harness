// Mycelial Context Router — generic + safety seeds
//
// Idempotent seeders that populate a MyceliumGraph with the generic
// agent/workflow/verifier/prompt template/safety nodes from the
// Network.md spec. All safety nodes and a small set of structurally
// important edges are marked `protected: true` so reinforcement decay
// and pruning leave them alone.

import type { MyceliumGraph, MyceliumNode } from './graph';

interface NodeSeed {
  id: string;
  type: MyceliumNode['type'];
  label: string;
  summary?: string;
  trust?: number;
  cost?: number;
  protected?: boolean;
  metadata?: Record<string, unknown>;
}

interface EdgeSeed {
  source: string;
  target: string;
  weight: number;
  relation?: string;
  protected?: boolean;
}

// ─── Safety nodes ───────────────────────────────────────────────────

export const SAFETY_NODES: NodeSeed[] = [
  {
    id: 'safety.dry_run_default',
    type: 'safety',
    label: 'Default to dry-run for high-impact actions',
    summary: 'Default to dry-run for irreversible, external, financial, destructive, or production-affecting actions unless explicit confirmation exists.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.no_irreversible_action_without_confirmation',
    type: 'safety',
    label: 'No irreversible action without confirmation',
    summary: 'Never perform irreversible or destructive actions without explicit confirmation.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.verify_before_execute',
    type: 'safety',
    label: 'Verify before execute',
    summary: 'Use relevant verification before executing high-impact actions.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.protect_user_preferences',
    type: 'safety',
    label: 'Protect user preferences',
    summary: 'User preferences should not be pruned or overwritten unless explicitly requested.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.protect_private_data',
    type: 'safety',
    label: 'Protect private data',
    summary: 'Do not expose or misuse private data.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.tool_error_fallback',
    type: 'safety',
    label: 'Tool error fallback',
    summary: 'If a tool fails, fall back safely and log the failure.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.no_exploration_for_high_risk_execution',
    type: 'safety',
    label: 'No exploration for high-risk execution',
    summary: 'Exploration must be near zero for high-risk execution tasks.',
    trust: 1, cost: 0, protected: true,
  },
  {
    id: 'safety.explain_route',
    type: 'safety',
    label: 'Router must explain its route',
    summary: 'The router should produce an inspectable route explanation.',
    trust: 1, cost: 0, protected: true,
  },
];

// ─── Generic agent nodes ────────────────────────────────────────────

export const GENERIC_AGENT_NODES: NodeSeed[] = [
  { id: 'agent.planner', type: 'agent', label: 'Planner agent', summary: 'Decomposes tasks and orders work.', trust: 0.7, cost: 0.2 },
  { id: 'agent.researcher', type: 'agent', label: 'Researcher agent', summary: 'Gathers external information and sources.', trust: 0.7, cost: 0.3 },
  { id: 'agent.coder', type: 'agent', label: 'Coder agent', summary: 'Writes and edits code.', trust: 0.7, cost: 0.3 },
  { id: 'agent.debugger', type: 'agent', label: 'Debugger agent', summary: 'Reproduces, isolates, and fixes failures.', trust: 0.7, cost: 0.3 },
  { id: 'agent.writer', type: 'agent', label: 'Writer agent', summary: 'Produces prose for users.', trust: 0.7, cost: 0.2 },
  { id: 'agent.critic', type: 'agent', label: 'Critic agent', summary: 'Reviews drafts and finds weaknesses.', trust: 0.7, cost: 0.2 },
  { id: 'agent.verifier', type: 'agent', label: 'Verifier agent', summary: 'Runs verification checks against output.', trust: 0.8, cost: 0.2, protected: true },
  { id: 'agent.summariser', type: 'agent', label: 'Summariser agent', summary: 'Produces compact summaries.', trust: 0.7, cost: 0.1 },
  { id: 'agent.tool_executor', type: 'agent', label: 'Tool executor agent', summary: 'Runs tool calls and returns results.', trust: 0.7, cost: 0.2 },
  { id: 'agent.context_compressor', type: 'agent', label: 'Context compressor agent', summary: 'Compacts context to fit budgets.', trust: 0.7, cost: 0.1 },
  { id: 'agent.safety_checker', type: 'agent', label: 'Safety checker agent', summary: 'Blocks unsafe actions.', trust: 0.9, cost: 0.1, protected: true },
];

// ─── Generic prompt template nodes ─────────────────────────────────

export const GENERIC_PROMPT_NODES: NodeSeed[] = [
  { id: 'prompt.deep_reasoning', type: 'prompt_template', label: 'Deep reasoning', summary: 'Extended chain-of-thought style prompt.', trust: 0.6, cost: 0.2 },
  { id: 'prompt.concise_answer', type: 'prompt_template', label: 'Concise answer', summary: 'Short direct answer prompt.', trust: 0.7, cost: 0.05 },
  { id: 'prompt.step_by_step', type: 'prompt_template', label: 'Step by step', summary: 'Break work into ordered steps.', trust: 0.7, cost: 0.1 },
  { id: 'prompt.code_patch_plan', type: 'prompt_template', label: 'Code patch plan', summary: 'Plan a code change before editing.', trust: 0.7, cost: 0.1 },
  { id: 'prompt.research_summary', type: 'prompt_template', label: 'Research summary', summary: 'Summarise sources with citations.', trust: 0.7, cost: 0.1 },
  { id: 'prompt.verification_checklist', type: 'prompt_template', label: 'Verification checklist', summary: 'Run a verification checklist.', trust: 0.8, cost: 0.05, protected: true },
  { id: 'prompt.user_friendly_explanation', type: 'prompt_template', label: 'User-friendly explanation', summary: 'Explain in plain language.', trust: 0.7, cost: 0.05 },
  { id: 'prompt.risk_review', type: 'prompt_template', label: 'Risk review', summary: 'Identify risks before acting.', trust: 0.8, cost: 0.1, protected: true },
  { id: 'prompt.creative_exploration', type: 'prompt_template', label: 'Creative exploration', summary: 'Explore creative options.', trust: 0.6, cost: 0.2 },
];

// ─── Generic workflow nodes ────────────────────────────────────────

export const GENERIC_WORKFLOW_NODES: NodeSeed[] = [
  { id: 'workflow.plan_execute_verify', type: 'workflow', label: 'Plan → Execute → Verify', trust: 0.8, cost: 0.2 },
  { id: 'workflow.research_summarise_cite', type: 'workflow', label: 'Research → Summarise → Cite', trust: 0.7, cost: 0.2 },
  { id: 'workflow.debug_reproduce_fix_test', type: 'workflow', label: 'Reproduce → Fix → Test', trust: 0.8, cost: 0.3 },
  { id: 'workflow.write_review_revise', type: 'workflow', label: 'Write → Review → Revise', trust: 0.7, cost: 0.2 },
  { id: 'workflow.tool_call_verify_report', type: 'workflow', label: 'Tool-call → Verify → Report', trust: 0.7, cost: 0.2 },
  { id: 'workflow.dry_run_then_confirm', type: 'workflow', label: 'Dry-run → Confirm', trust: 0.9, cost: 0.1, protected: true },
  { id: 'workflow.context_compress_then_answer', type: 'workflow', label: 'Compress context → Answer', trust: 0.7, cost: 0.1 },
];

// ─── Generic verifier nodes ────────────────────────────────────────

export const GENERIC_VERIFIER_NODES: NodeSeed[] = [
  { id: 'verifier.task_completion', type: 'verifier', label: 'Task completion check', summary: 'Did the response answer the request?', trust: 0.8, cost: 0.05 },
  { id: 'verifier.factuality_check', type: 'verifier', label: 'Factuality check', summary: 'Does the response contradict known facts?', trust: 0.7, cost: 0.1 },
  { id: 'verifier.source_quality_check', type: 'verifier', label: 'Source quality check', summary: 'Are cited sources reliable and recent?', trust: 0.7, cost: 0.1 },
  { id: 'verifier.code_test_check', type: 'verifier', label: 'Code test check', summary: 'Do code changes pass tests / lint / type-check?', trust: 0.9, cost: 0.2, protected: true },
  { id: 'verifier.schema_check', type: 'verifier', label: 'Schema check', summary: 'Does structured output match the expected schema?', trust: 0.8, cost: 0.05 },
  { id: 'verifier.safety_check', type: 'verifier', label: 'Safety check', summary: 'Does the action violate any protected safety rule?', trust: 1, cost: 0.05, protected: true },
  { id: 'verifier.user_preference_check', type: 'verifier', label: 'User preference check', summary: 'Does the response respect user preferences?', trust: 0.8, cost: 0.05, protected: true },
  { id: 'verifier.irreversible_action_check', type: 'verifier', label: 'Irreversible action check', summary: 'Is an irreversible action being attempted without confirmation?', trust: 1, cost: 0.05, protected: true },
];

// ─── User preference placeholder nodes ─────────────────────────────

export const USER_PREFERENCE_NODES: NodeSeed[] = [
  { id: 'preference.response_style', type: 'preference', label: 'Response style preference', trust: 0.8, cost: 0, protected: true },
  { id: 'preference.detail_level', type: 'preference', label: 'Detail level preference', trust: 0.8, cost: 0, protected: true },
  { id: 'preference.preferred_format', type: 'preference', label: 'Preferred format preference', trust: 0.8, cost: 0, protected: true },
  { id: 'preference.avoidances', type: 'preference', label: 'Things to avoid', trust: 0.8, cost: 0, protected: true },
];

// ─── Generic protected edges ───────────────────────────────────────

export const GENERIC_EDGES: EdgeSeed[] = [
  { source: 'agent.planner', target: 'agent.coder', weight: 0.7, relation: 'routes_to' },
  { source: 'agent.coder', target: 'agent.verifier', weight: 0.9, relation: 'must_verify_with', protected: true },
  { source: 'agent.debugger', target: 'verifier.code_test_check', weight: 0.8, relation: 'validated_by', protected: true },
  { source: 'agent.researcher', target: 'verifier.source_quality_check', weight: 0.8, relation: 'validated_by' },
  { source: 'agent.writer', target: 'verifier.user_preference_check', weight: 0.7, relation: 'validated_by' },
  { source: 'workflow.plan_execute_verify', target: 'agent.planner', weight: 0.8, relation: 'starts_with' },
  { source: 'workflow.plan_execute_verify', target: 'agent.verifier', weight: 0.9, relation: 'requires', protected: true },
  { source: 'workflow.dry_run_then_confirm', target: 'safety.no_irreversible_action_without_confirmation', weight: 1, relation: 'protects', protected: true },
  { source: 'safety.verify_before_execute', target: 'agent.verifier', weight: 1, relation: 'requires', protected: true },
  { source: 'safety.no_exploration_for_high_risk_execution', target: 'agent.safety_checker', weight: 1, relation: 'requires', protected: true },
  { source: 'safety.explain_route', target: 'agent.safety_checker', weight: 1, relation: 'requires', protected: true },
  { source: 'workflow.debug_reproduce_fix_test', target: 'agent.debugger', weight: 0.8, relation: 'starts_with' },
  { source: 'workflow.research_summarise_cite', target: 'agent.researcher', weight: 0.8, relation: 'starts_with' },
  { source: 'workflow.write_review_revise', target: 'agent.writer', weight: 0.8, relation: 'starts_with' },
];

// ─── Seed orchestration ────────────────────────────────────────────

export interface SeedSummary {
  nodesAdded: number;
  edgesAdded: number;
  protectedNodes: number;
  protectedEdges: number;
}

export function seedGenericGraph(graph: MyceliumGraph): SeedSummary {
  let nodesAdded = 0;
  let edgesAdded = 0;
  let protectedNodes = 0;
  let protectedEdges = 0;

  const allNodeSeeds: NodeSeed[] = [
    ...SAFETY_NODES,
    ...GENERIC_AGENT_NODES,
    ...GENERIC_PROMPT_NODES,
    ...GENERIC_WORKFLOW_NODES,
    ...GENERIC_VERIFIER_NODES,
    ...USER_PREFERENCE_NODES,
  ];

  for (const seed of allNodeSeeds) {
    if (graph.getNode(seed.id)) {
      // Existing node — make sure protection isn't downgraded.
      const existing = graph.getNode(seed.id)!;
      if (seed.protected && !existing.protected) {
        existing.protected = true;
        protectedNodes++;
      }
      continue;
    }
    graph.addNode({
      id: seed.id,
      type: seed.type,
      label: seed.label,
      trust: seed.trust ?? 0.5,
      cost: seed.cost ?? 0.1,
      protected: seed.protected,
      summary: seed.summary,
      metadata: seed.metadata,
    });
    nodesAdded++;
    if (seed.protected) protectedNodes++;
  }

  for (const seed of GENERIC_EDGES) {
    // Both endpoints must exist before we draw the edge.
    if (!graph.getNode(seed.source) || !graph.getNode(seed.target)) continue;
    const existing = graph.getEdge(seed.source, seed.target);
    if (existing) {
      if (seed.protected && !existing.protected) {
        existing.protected = true;
        protectedEdges++;
      }
      continue;
    }
    const edge = graph.addEdge(seed.source, seed.target, seed.weight, {
      relation: seed.relation,
      origin: 'seeded',
    });
    if (seed.protected) {
      edge.protected = true;
      protectedEdges++;
    }
    edgesAdded++;
  }

  return { nodesAdded, edgesAdded, protectedNodes, protectedEdges };
}
