// Service Lifecycle — state machine for agentic services.
//
// Services transition through: draft → active → paused → disabled → archived → error → needs_attention
// Each transition is validated, timestamped, and produces an event for the event store.

import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

export type ServiceLifecycleStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'disabled'
  | 'archived'
  | 'error'
  | 'needs_attention';

export interface ServiceLifecycleState {
  service_id: string;
  status: ServiceLifecycleStatus;
  previous_status?: ServiceLifecycleStatus;
  error_message?: string;
  health_check_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceTransitionResult {
  success: boolean;
  from: ServiceLifecycleStatus;
  to: ServiceLifecycleStatus;
  error?: string;
}

/** Template for creating new services from a known pattern. */
export interface ServiceTemplate {
  template_id: string;
  name: string;
  description: string;
  default_commands: string[];
  default_schedule?: string;
  default_state_schema: Record<string, string>;
}

// ─── Transition rules ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<ServiceLifecycleStatus, ServiceLifecycleStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'disabled', 'error', 'needs_attention', 'archived'],
  paused: ['active', 'disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: ['active'], // allow re-activation
  error: ['active', 'disabled', 'needs_attention', 'archived'],
  needs_attention: ['active', 'paused', 'disabled', 'archived'],
};

export function canTransition(from: ServiceLifecycleStatus, to: ServiceLifecycleStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Templates ──────────────────────────────────────────────────────

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    template_id: 'bullet_journal',
    name: 'Bullet Journal',
    description: 'Task tracking with daily/weekly reviews and reminders.',
    default_commands: ['add_task', 'close_task', 'add_note', 'show_today', 'daily_review', 'weekly_review'],
    default_schedule: '0 9 * * *',
    default_state_schema: { tasks: 'Array of tasks', notes: 'Array of notes', reviews: 'Array of review summaries' },
  },
  {
    template_id: 'habit_tracker',
    name: 'Habit Tracker',
    description: 'Track daily habits with streaks and accountability.',
    default_commands: ['log_habit', 'show_streaks', 'show_today', 'weekly_review'],
    default_schedule: '0 21 * * *',
    default_state_schema: { habits: 'Array of habit definitions', logs: 'Daily habit check-ins', streaks: 'Current streak counts' },
  },
  {
    template_id: 'project_standup',
    name: 'Project Standup',
    description: 'Daily standup summaries with blockers and progress.',
    default_commands: ['log_progress', 'add_blocker', 'resolve_blocker', 'show_status', 'daily_standup'],
    default_schedule: '0 9 * * 1-5',
    default_state_schema: { progress: 'Progress entries', blockers: 'Active blockers', standups: 'Standup summaries' },
  },
  {
    template_id: 'site_monitor',
    name: 'Site Monitor',
    description: 'Monitor a website for changes or conditions.',
    default_commands: ['show_status', 'add_note', 'record_observation', 'pause_reminders'],
    default_schedule: '0 9 * * *',
    default_state_schema: { observations: 'Timestamped findings', notes: 'User notes' },
  },
  {
    template_id: 'finance_checkin',
    name: 'Finance Check-in',
    description: 'Weekly financial review and budget tracking.',
    default_commands: ['log_expense', 'show_budget', 'weekly_review'],
    default_schedule: '0 18 * * 0',
    default_state_schema: { expenses: 'Logged expenses', budgets: 'Budget categories', reviews: 'Weekly summaries' },
  },
  {
    template_id: 'reading_tracker',
    name: 'Reading Tracker',
    description: 'Track books, articles, and reading progress.',
    default_commands: ['add_book', 'log_progress', 'finish_book', 'show_reading_list', 'show_finished'],
    default_schedule: '0 21 * * 0',
    default_state_schema: { reading_list: 'Books in progress', finished: 'Completed books', progress_logs: 'Reading sessions' },
  },
  {
    template_id: 'learning_tracker',
    name: 'Learning Tracker',
    description: 'Track courses, skills, and learning goals.',
    default_commands: ['add_goal', 'log_session', 'complete_goal', 'show_goals', 'weekly_review'],
    default_schedule: '0 20 * * 0',
    default_state_schema: { goals: 'Learning goals', sessions: 'Study sessions', completed: 'Completed goals' },
  },
];

export function getServiceTemplate(templateId: string): ServiceTemplate | undefined {
  return SERVICE_TEMPLATES.find((t) => t.template_id === templateId);
}

// ─── Lifecycle persistence ──────────────────────────────────────────

function lifecyclePath(projectDir: string, serviceId: string): string {
  return path.join(projectDir, '.harness', 'services', serviceId, 'lifecycle.json');
}

export async function getServiceLifecycle(projectDir: string, serviceId: string): Promise<ServiceLifecycleState | null> {
  try {
    const raw = await fs.readFile(lifecyclePath(projectDir, serviceId), 'utf-8');
    return JSON.parse(raw) as ServiceLifecycleState;
  } catch {
    return null;
  }
}

export async function initServiceLifecycle(
  projectDir: string,
  serviceId: string,
  initialStatus: ServiceLifecycleStatus = 'draft',
): Promise<ServiceLifecycleState> {
  const now = new Date().toISOString();
  const state: ServiceLifecycleState = {
    service_id: serviceId,
    status: initialStatus,
    created_at: now,
    updated_at: now,
  };
  const fp = lifecyclePath(projectDir, serviceId);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

export async function transitionService(
  projectDir: string,
  serviceId: string,
  targetStatus: ServiceLifecycleStatus,
  errorMessage?: string,
): Promise<ServiceTransitionResult> {
  let current = await getServiceLifecycle(projectDir, serviceId);
  if (!current) {
    current = await initServiceLifecycle(projectDir, serviceId, 'draft');
  }

  if (current.status === targetStatus) {
    return { success: true, from: current.status, to: targetStatus };
  }

  if (!canTransition(current.status, targetStatus)) {
    return {
      success: false,
      from: current.status,
      to: targetStatus,
      error: `Cannot transition from ${current.status} to ${targetStatus}`,
    };
  }

  const updated: ServiceLifecycleState = {
    ...current,
    previous_status: current.status,
    status: targetStatus,
    error_message: targetStatus === 'error' ? errorMessage : undefined,
    updated_at: new Date().toISOString(),
  };

  await fs.writeFile(lifecyclePath(projectDir, serviceId), JSON.stringify(updated, null, 2), 'utf-8');
  return { success: true, from: current.status, to: targetStatus };
}

/** Probe service health — checks that service/state files exist and are parseable. */
export async function probeServiceHealth(projectDir: string, serviceId: string): Promise<{ healthy: boolean; issues: string[] }> {
  const issues: string[] = [];
  const serviceFile = path.join(projectDir, '.harness', 'services', serviceId, 'service.json');
  const stateFile = path.join(projectDir, '.harness', 'services', serviceId, 'state.json');

  try {
    const raw = await fs.readFile(serviceFile, 'utf-8');
    JSON.parse(raw);
  } catch {
    issues.push('service.json missing or corrupt');
  }

  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    JSON.parse(raw);
  } catch {
    issues.push('state.json missing or corrupt');
  }

  const lifecycle = await getServiceLifecycle(projectDir, serviceId);
  if (lifecycle?.status === 'error') issues.push(`lifecycle in error state: ${lifecycle.error_message ?? 'unknown'}`);

  if (issues.length === 0 && lifecycle) {
    const updated: ServiceLifecycleState = { ...lifecycle, health_check_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await fs.writeFile(lifecyclePath(projectDir, serviceId), JSON.stringify(updated, null, 2), 'utf-8');
  }

  return { healthy: issues.length === 0, issues };
}
