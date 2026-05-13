// Orchestration module — barrel export.
//
// This is the main entry point for the orchestration layer. Import from
// here to access all orchestration types and functions.
//
// Usage:
//   import { OrchestrationEngine } from './orchestration';
//   const engine = new OrchestrationEngine({ projectDir: '/path/to/project' });

// Engine
export { OrchestrationEngine, type OrchestrationEngineDeps, type DecompositionResult, type RunGoalOptions, type RunGoalResult, type TaskDispatchResult, type EscalationResult } from './engine';

// Adapter
export { type Adapter, type AdapterConfig, type AdapterType, type RunContext, type RunBudget, type RunResult, type RunToolCall, type AdapterDiagnostics, registerAdapter, getAdapter, listAdapters } from './adapter';

// Adapters (built-in implementations)
export { OllamaLocalAdapter, ProcessAdapter } from './adapters';

// Company
export { type Company, type CompanyStatus, type CompanyBudget, type CreateCompanyInput, type UpdateCompanyInput, listCompanies, getCompany, createCompany, updateCompany } from './company';

// Goal
export { type Goal, type GoalStatus, type Issue, type IssueStatus, type IssuePriority, type CreateGoalInput, type UpdateGoalInput, type CreateIssueInput, type UpdateIssueInput, listGoals, getGoal, createGoal, updateGoal, computeGoalProgress, listIssues, getIssue, createIssue, updateIssue } from './goal';

// Org Chart
export { type OrgChart, type OrgNode, type OrgRole, type CreateOrgChartInput, type UpdateOrgChartInput, listOrgCharts, getOrgChart, createOrgChart, updateOrgChart } from './orgChart';

// Heartbeat actions
export { goalProgressAction, staleTaskDetectionAction, budgetEnforcementAction, companyHealthCheckAction, orchestrationHeartbeatActions } from './heartbeat';