import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createAutomationJob, listAutomationJobs, updateAutomationJob, type AutomationJob } from '../automation/jobs';

export type AgenticMode = 'build' | 'operate';

export interface AgenticModeClassification {
  mode: AgenticMode;
  reason: string;
  matchedTriggers: string[];
}

export interface AgenticServiceDefinition {
  service_id: string;
  service_name: string;
  mode: 'operate';
  purpose: string;
  persistent_state_schema: Record<string, unknown>;
  supported_commands: string[];
  schedules: Array<Record<string, unknown>>;
  reminder_rules: string[];
  notification_templates: Record<string, string>;
  state_transition_rules: string[];
  review_rules: string[];
  close_archive_rules: string[];
  user_interaction_examples: string[];
  safety_confirmation_rules: string[];
  storage_location: string;
  enable_disable_controls: string[];
  automation_job_id?: string;
  created_at: string;
  updated_at: string;
}

export interface BulletJournalTask {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'closed';
  priority: 'low' | 'normal' | 'high';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  tags: string[];
  notes: string[];
}

export interface BulletJournalNote {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  linked_task_id: string | null;
}

export interface BulletJournalState {
  service_id: 'bullet_journal';
  mode: 'operate';
  tasks: BulletJournalTask[];
  notes: BulletJournalNote[];
  daily_logs: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
  closed_tasks: BulletJournalTask[];
  reminders: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  reminder_time: string;
  reminders_paused: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface GenericOperateState {
  service_id: string;
  mode: 'operate';
  observations: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  enabled: boolean;
  reminders_paused: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoredAgenticService {
  service: AgenticServiceDefinition;
  state: BulletJournalState | GenericOperateState | Record<string, unknown>;
}

export interface AgenticServicesExport {
  version: 1;
  exported_at: string;
  source: 'ollama-agent-harness';
  services: StoredAgenticService[];
}

export interface ImportAgenticServicesResult {
  imported: string[];
  skipped: string[];
}

export interface OperateServiceResult {
  handled: boolean;
  response: string;
  classification: AgenticModeClassification;
  service?: AgenticServiceDefinition;
  state?: BulletJournalState | GenericOperateState;
  schedule?: AutomationJob | null;
  capabilityLimitations?: string | null;
}

export interface OperateHandlerOptions {
  /** Returns a human-readable limitation message for missing capabilities, or null. */
  checkCapabilities?: (required: string[]) => string | null;
}

const OPERATE_TRIGGERS = [
  'send me reminders',
  'send me a reminder',
  'send me telegram reminder',
  'telegram reminder',
  'remind me',
  'remind me daily',
  'check in with me',
  'keep track of',
  'let me add tasks',
  'let me update tasks',
  'update for me',
  'let me close tasks',
  'add notes',
  'manage this for me',
  'keep me honest',
  'follow up',
  'monitor this',
  'notify me',
  'ask me every morning',
  'review this each day',
  'keep a log',
];

const BULLET_JOURNAL_COMMANDS = [
  'add_task',
  'update_task',
  'close_task',
  'reopen_task',
  'add_note',
  'edit_note',
  'delete_note',
  'show_today',
  'show_open_tasks',
  'show_closed_tasks',
  'daily_review',
  'weekly_review',
  'set_reminder_time',
  'pause_reminders',
  'resume_reminders',
];

export function classifyAgenticMode(message: string): AgenticModeClassification {
  const lower = message.toLowerCase();
  if (looksLikeExternalBulletJournalTaskRequest(lower)) {
    return { mode: 'build', reason: 'Request targets an existing bullet journal rather than an operating service command.', matchedTriggers: [] };
  }
  const matchedTriggers = OPERATE_TRIGGERS.filter((trigger) => lower.includes(trigger));
  if (matchedTriggers.length > 0 && !explicitlyRequestsSoftwareBuild(lower)) {
    return { mode: 'operate', reason: 'Request asks for ongoing service behavior.', matchedTriggers };
  }
  if (looksLikeBulletJournalServiceRequest(lower) && !explicitlyRequestsSoftwareBuild(lower)) {
    return { mode: 'operate', reason: 'Request asks for a bullet journal operating service.', matchedTriggers: ['bullet journal'] };
  }
  if (/\b(check|scan|visit|look at|watch)\b[\s\S]{0,200}\b(daily|every day|each day|every morning)\b/.test(lower) && !explicitlyRequestsSoftwareBuild(lower)) {
    return { mode: 'operate', reason: 'Request asks for a recurring check.', matchedTriggers: ['recurring check'] };
  }
  if (looksLikeAgenticSearchRequest(lower) && !explicitlyRequestsSoftwareBuild(lower)) {
    return { mode: 'operate', reason: 'Request asks for ongoing search or availability monitoring.', matchedTriggers: ['agentic search'] };
  }
  if (looksLikeBulletJournalCommand(lower)) {
    return { mode: 'operate', reason: 'Request matches a bullet journal service command.', matchedTriggers: ['bullet journal command'] };
  }
  if (looksLikeGenericOperateCommand(lower)) {
    return { mode: 'operate', reason: 'Request matches an operating service command.', matchedTriggers: ['operating service command'] };
  }
  return { mode: 'build', reason: 'No ongoing service trigger detected.', matchedTriggers: [] };
}

export async function handleOperateModeRequest(projectDir: string, message: string, now = new Date(), options?: OperateHandlerOptions): Promise<OperateServiceResult> {
  const classification = classifyAgenticMode(message);
  if (classification.mode !== 'operate') return { handled: false, response: '', classification };
  const checkCaps = options?.checkCapabilities;
  const genericCommand = parseGenericOperateCommand(message);
  if (genericCommand && !isBulletJournalRequest(message)) {
    const commandResult = await applyGenericOperateCommand(projectDir, genericCommand, now);
    return { handled: true, response: commandResult.response, classification, service: commandResult.service, state: commandResult.state, schedule: commandResult.schedule };
  }
  if (!isBulletJournalRequest(message)) {
    const result = await createOrUpdateGenericOperateService(projectDir, message, now);
    const limitations = checkCaps ? checkCaps(['scheduler', 'notifications']) : null;
    return {
      handled: true,
      response: [
        `${result.service.service_name} is set up.`,
        result.schedule ? `I will check it every day at 09:00.` : 'Operating service state can be created, but proactive reminders require a scheduler/automation capability.',
        limitations ? limitations : '',
        'You can ask for status, add notes, pause reminders, or resume reminders.',
        `Current state: ${result.state.observations.length} observation(s), ${result.state.notes.length} note(s).`,
      ].filter(Boolean).join(' '),
      classification,
      service: result.service,
      state: result.state,
      schedule: result.schedule,
      capabilityLimitations: limitations,
    };
  }

  const command = parseBulletJournalCommand(message);
  if (command) {
    const commandResult = await applyBulletJournalCommand(projectDir, command, now);
    return { handled: true, response: commandResult.response, classification, service: commandResult.service, state: commandResult.state, schedule: commandResult.schedule };
  }

  const result = await createOrUpdateBulletJournalService(projectDir, { reminderTime: parseReminderTime(message) ?? '09:00' }, now);
  const limitations = checkCaps ? checkCaps(['scheduler', 'notifications']) : null;
  const scheduleText = result.schedule
    ? `I will check in every day at ${result.state.reminder_time}.`
    : 'Operating service state can be created, but proactive reminders require a scheduler/automation capability.';
  return {
    handled: true,
    response: [
      'Your Bullet Journal agent is set up.',
      scheduleText,
      limitations ? limitations : '',
      'You can say: add task..., close task..., update task..., add note..., show today, show open tasks, show closed tasks, daily review, weekly review, pause reminders, or resume reminders.',
      `Current state: ${openTasks(result.state).length} open task(s), ${result.state.closed_tasks.length} closed task(s), ${result.state.notes.length} note(s).`,
    ].filter(Boolean).join(' '),
    classification,
    service: result.service,
    state: result.state,
    schedule: result.schedule,
    capabilityLimitations: limitations,
  };
}

export async function createOrUpdateBulletJournalService(projectDir: string, input: { reminderTime?: string } = {}, now = new Date()): Promise<{ service: AgenticServiceDefinition; state: BulletJournalState; schedule: AutomationJob | null }> {
  const storageDir = bulletJournalDir(projectDir);
  const state = await loadBulletJournalState(projectDir, now);
  state.reminder_time = normalizeReminderTime(input.reminderTime) ?? state.reminder_time;
  state.updated_at = now.toISOString();
  const service = await loadBulletJournalDefinition(projectDir, now);
  service.updated_at = now.toISOString();
  service.storage_location = path.relative(projectDir, storageDir).split(path.sep).join('/');
  const schedule = await ensureBulletJournalSchedule(projectDir, service, state.reminder_time, now);
  service.automation_job_id = schedule?.id;
  service.schedules = [{ id: 'daily_check_in', type: 'cron', expression: dailyCron(state.reminder_time), enabled: !state.reminders_paused && state.enabled, automation_job_id: schedule?.id ?? null }];
  await saveBulletJournalDefinition(projectDir, service);
  await saveBulletJournalState(projectDir, state);
  return { service, state, schedule };
}

export async function listAgenticServices(projectDir: string): Promise<StoredAgenticService[]> {
  let entries: Array<import('fs').Dirent> = [];
  try {
    entries = await fs.readdir(servicesDir(projectDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const services: StoredAgenticService[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stored = await getAgenticService(projectDir, entry.name);
    if (stored) services.push(stored);
  }
  services.sort((a, b) => b.service.updated_at.localeCompare(a.service.updated_at));
  return services;
}

export async function getAgenticService(projectDir: string, serviceId: string): Promise<StoredAgenticService | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(serviceId)) return null;
  const servicePath = path.join(servicesDir(projectDir), serviceId, 'service.json');
  const statePath = path.join(servicesDir(projectDir), serviceId, 'state.json');
  try {
    const [serviceRaw, stateRaw] = await Promise.all([fs.readFile(servicePath, 'utf-8'), fs.readFile(statePath, 'utf-8')]);
    return { service: JSON.parse(serviceRaw) as AgenticServiceDefinition, state: JSON.parse(stateRaw) as StoredAgenticService['state'] };
  } catch {
    return null;
  }
}

export async function exportAgenticServices(projectDir: string, serviceIds?: string[], now = new Date()): Promise<AgenticServicesExport> {
  const requestedIds = serviceIds?.map((id) => id.trim()).filter(Boolean);
  const services = requestedIds && requestedIds.length > 0
    ? (await Promise.all(requestedIds.map((id) => getAgenticService(projectDir, id)))).filter((item): item is StoredAgenticService => Boolean(item))
    : await listAgenticServices(projectDir);
  return { version: 1, exported_at: now.toISOString(), source: 'ollama-agent-harness', services };
}

export async function importAgenticServices(projectDir: string, payload: unknown, options: { overwrite?: boolean } = {}, now = new Date()): Promise<ImportAgenticServicesResult> {
  const source = typeof payload === 'object' && payload !== null ? payload as Partial<AgenticServicesExport> : {};
  if (source.version !== 1 || !Array.isArray(source.services)) throw new Error('Invalid operating services export payload.');
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const item of source.services) {
    if (!isStoredAgenticService(item)) throw new Error('Invalid operating service entry.');
    const serviceId = item.service.service_id;
    if (!/^[a-zA-Z0-9._-]+$/.test(serviceId)) throw new Error(`Invalid service id: ${serviceId}`);
    const existing = await getAgenticService(projectDir, serviceId);
    if (existing && !options.overwrite) {
      skipped.push(serviceId);
      continue;
    }
    const service: AgenticServiceDefinition = { ...item.service, storage_location: `.harness/services/${serviceId}` };
    delete service.automation_job_id;
    const state = typeof item.state === 'object' && item.state !== null ? { ...item.state, service_id: serviceId, mode: 'operate' } as StoredAgenticService['state'] : item.state;
    const dir = path.join(servicesDir(projectDir), serviceId);
    service.schedules = (service.schedules || []).map((entry) => ({ ...entry, automation_job_id: null, enabled: serviceStateEnabled(state) }));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify(service, null, 2), 'utf-8');
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
    if (serviceStateEnabled(state)) {
      const schedule = serviceId === 'bullet_journal'
        ? await ensureBulletJournalSchedule(projectDir, service, typeof (state as Partial<BulletJournalState>).reminder_time === 'string' ? (state as Partial<BulletJournalState>).reminder_time! : '09:00', now)
        : await ensureGenericOperateSchedule(projectDir, service, service.purpose, extractUrl(service.purpose), now);
      service.automation_job_id = schedule?.id;
      service.schedules = (service.schedules || []).map((entry) => ({ ...entry, automation_job_id: schedule?.id ?? null, enabled: Boolean(schedule) }));
      service.updated_at = now.toISOString();
      await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify(service, null, 2), 'utf-8');
    }
    imported.push(serviceId);
  }
  return { imported, skipped };
}

function serviceStateEnabled(state: StoredAgenticService['state']): boolean {
  const source = state as Partial<BulletJournalState | GenericOperateState>;
  return source.enabled !== false && source.reminders_paused !== true;
}

function isStoredAgenticService(value: unknown): value is StoredAgenticService {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<StoredAgenticService>;
  const service = item.service as Partial<AgenticServiceDefinition> | undefined;
  return typeof service?.service_id === 'string'
    && typeof service.service_name === 'string'
    && service.mode === 'operate'
    && typeof service.purpose === 'string'
    && typeof item.state === 'object'
    && item.state !== null;
}

export async function createOrUpdateGenericOperateService(projectDir: string, request: string, now = new Date()): Promise<{ service: AgenticServiceDefinition; state: GenericOperateState; schedule: AutomationJob | null }> {
  const siteUrl = extractUrl(request);
  const serviceId = siteUrl ? `site_monitor_${shortHash(siteUrl)}` : `operate_${slugify(request).slice(0, 42) || shortHash(request)}`;
  const dir = path.join(servicesDir(projectDir), serviceId);
  const storageLocation = path.relative(projectDir, dir).split(path.sep).join('/');
  const existing = await getAgenticService(projectDir, serviceId);
  const createdAt = existing?.service.created_at ?? now.toISOString();
  const state = normalizeGenericOperateState(existing?.state, serviceId, now, createdAt);
  const purpose = siteUrl
    ? `Check ${siteUrl} daily and report whether the requested condition appears true: ${request}`
    : request;
  const service: AgenticServiceDefinition = {
    service_id: serviceId,
    service_name: siteUrl ? 'Site Monitor Agent' : 'Operating Service Agent',
    mode: 'operate',
    purpose,
    persistent_state_schema: {
      observations: 'Timestamped findings from each proactive check.',
      tasks: 'Service-owned follow-up items managed by the agent.',
      notes: 'User or agent notes attached to the service.',
      reminders: 'Reminder and schedule metadata.',
      reviews: 'Periodic summaries of findings and unresolved items.',
    },
    supported_commands: ['show_status', 'add_note', 'record_observation', 'pause_reminders', 'resume_reminders', 'daily_review', 'close_item'],
    schedules: [{ id: 'daily_check', type: 'cron', expression: '0 9 * * *', enabled: state.enabled && !state.reminders_paused }],
    reminder_rules: ['Check once per day at the configured time.', 'Record an observation.', 'Notify the user with concise status and next action when the condition changes or needs attention.'],
    notification_templates: {
      daily_check: siteUrl
        ? `Daily site check for ${siteUrl}: summarize whether the requested condition appears true, cite the observed signal, and ask if I should keep monitoring or change criteria.`
        : 'Daily service check: summarize current status, observations, and any needed follow-up.',
    },
    state_transition_rules: ['record_observation appends timestamped findings.', 'add_note creates a timestamped note.', 'pause_reminders disables scheduled checks.', 'resume_reminders enables scheduled checks.', 'close_item marks service-owned follow-up items closed.'],
    review_rules: ['Daily checks append observations.', 'Weekly review summarizes changes, unresolved items, and recurring themes.'],
    close_archive_rules: ['Closed items remain in state for auditability.', 'Archive only after explicit user request.'],
    user_interaction_examples: siteUrl
      ? [`check ${siteUrl} daily to see if a room is free`, 'show status', 'pause reminders', 'resume reminders']
      : ['monitor this daily', 'show status', 'add note ...', 'pause reminders'],
    safety_confirmation_rules: ['Ask before taking external action beyond checking and reporting.', 'Do not book, purchase, submit forms, or contact third parties without explicit confirmation.'],
    storage_location: storageLocation,
    enable_disable_controls: ['pause_reminders', 'resume_reminders'],
    created_at: createdAt,
    updated_at: now.toISOString(),
  };
  const schedule = await ensureGenericOperateSchedule(projectDir, service, request, siteUrl, now);
  service.automation_job_id = schedule?.id;
  service.schedules = [{ id: 'daily_check', type: 'cron', expression: '0 9 * * *', enabled: state.enabled && !state.reminders_paused, automation_job_id: schedule?.id ?? null }];
  state.updated_at = now.toISOString();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify(service, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  return { service, state, schedule };
}

async function applyBulletJournalCommand(projectDir: string, command: BulletJournalCommand, now: Date): Promise<{ response: string; service: AgenticServiceDefinition; state: BulletJournalState; schedule: AutomationJob | null }> {
  const setup = await createOrUpdateBulletJournalService(projectDir, {}, now);
  const state = setup.state;
  let response = '';
  if (command.name === 'add_task') {
    const parsedTask = parseTaskDetails(command.title);
    const task: BulletJournalTask = {
      id: `task_${now.getTime().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
      title: parsedTask.title,
      description: command.description ?? '',
      status: 'open',
      priority: command.priority ?? parsedTask.priority ?? 'normal',
      due_date: command.dueDate ?? parsedTask.dueDate ?? null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      closed_at: null,
      tags: command.tags ?? parsedTask.tags,
      notes: [],
    };
    state.tasks.push(task);
    response = `Added task ${task.id}: ${task.title}.`;
  } else if (command.name === 'add_note') {
    const note: BulletJournalNote = { id: `note_${now.getTime().toString(36)}_${crypto.randomBytes(2).toString('hex')}`, content: command.content, created_at: now.toISOString(), updated_at: now.toISOString(), tags: command.tags ?? [], linked_task_id: command.linkedTaskId ?? null };
    state.notes.push(note);
    if (note.linked_task_id) {
      const linked = state.tasks.find((task) => task.id === note.linked_task_id);
      if (linked) linked.notes.push(note.id);
    }
    response = `Added note ${note.id}.`;
  } else if (command.name === 'update_task') {
    const task = state.tasks.find((candidate) => candidate.id === command.selector || candidate.title.toLowerCase() === command.selector.toLowerCase());
    if (!task) response = `I could not find a task matching "${command.selector}".`;
    else {
      const parsedTask = command.title ? parseTaskDetails(command.title) : null;
      task.title = parsedTask?.title ?? command.title ?? task.title;
      task.description = command.description ?? task.description;
      task.priority = command.priority ?? parsedTask?.priority ?? task.priority;
      task.due_date = command.dueDate !== undefined ? command.dueDate : parsedTask?.dueDate ?? task.due_date;
      if (parsedTask?.tags.length) task.tags = Array.from(new Set([...task.tags, ...parsedTask.tags]));
      task.updated_at = now.toISOString();
      response = `Updated task ${task.id}: ${task.title}.`;
    }
  } else if (command.name === 'close_task') {
    const task = findTask(state, command.selector);
    if (!task) response = `I could not find an open task matching "${command.selector}".`;
    else {
      task.status = 'closed';
      task.updated_at = now.toISOString();
      task.closed_at = now.toISOString();
      if (!state.closed_tasks.some((closed) => closed.id === task.id)) state.closed_tasks.push({ ...task });
      response = `Closed task ${task.id}: ${task.title}.`;
    }
  } else if (command.name === 'reopen_task') {
    const task = state.tasks.find((candidate) => candidate.id === command.selector || candidate.title.toLowerCase() === command.selector.toLowerCase());
    if (!task) response = `I could not find a task matching "${command.selector}".`;
    else {
      task.status = 'open';
      task.updated_at = now.toISOString();
      task.closed_at = null;
      state.closed_tasks = state.closed_tasks.filter((closed) => closed.id !== task.id);
      response = `Reopened task ${task.id}: ${task.title}.`;
    }
  } else if (command.name === 'show_today') {
    response = formatDailyCheckIn(state, now);
  } else if (command.name === 'show_open_tasks') {
    response = formatTaskList('Open tasks', openTasks(state));
  } else if (command.name === 'show_closed_tasks') {
    response = formatTaskList('Closed tasks', state.closed_tasks);
  } else if (command.name === 'daily_review') {
    const entry = { id: `daily_${now.toISOString().slice(0, 10)}`, created_at: now.toISOString(), open_tasks: openTasks(state).length, closed_tasks: state.closed_tasks.length, notes: state.notes.length };
    state.daily_logs.push(entry);
    response = `Daily review saved: ${openTasks(state).length} open task(s), ${state.closed_tasks.length} closed task(s), ${state.notes.length} note(s).`;
  } else if (command.name === 'weekly_review') {
    const entry = { id: `weekly_${now.getTime().toString(36)}`, created_at: now.toISOString(), completed_tasks: state.closed_tasks.length, open_tasks: openTasks(state).length, recurring_themes: summarizeTags(state) };
    state.reviews.push(entry);
    response = `Weekly review saved: ${state.closed_tasks.length} completed task(s), ${openTasks(state).length} open task(s).`;
  } else if (command.name === 'edit_note') {
    const note = state.notes.find((candidate) => candidate.id === command.noteId);
    if (!note) response = `I could not find note ${command.noteId}.`;
    else {
      note.content = command.content;
      note.updated_at = now.toISOString();
      response = `Updated note ${note.id}.`;
    }
  } else if (command.name === 'delete_note') {
    const before = state.notes.length;
    state.notes = state.notes.filter((note) => note.id !== command.noteId);
    response = state.notes.length === before ? `I could not find note ${command.noteId}.` : `Deleted note ${command.noteId}.`;
  } else if (command.name === 'set_reminder_time') {
    state.reminder_time = command.time;
    const updated = await createOrUpdateBulletJournalService(projectDir, { reminderTime: command.time }, now);
    response = `Reminder time set to ${updated.state.reminder_time}.`;
    return { response, service: updated.service, state: updated.state, schedule: updated.schedule };
  } else if (command.name === 'pause_reminders' || command.name === 'resume_reminders') {
    state.reminders_paused = command.name === 'pause_reminders';
    state.enabled = command.name !== 'pause_reminders';
    if (setup.schedule) await updateAutomationJob(projectDir, setup.schedule.id, { enabled: !state.reminders_paused }, now);
    response = state.reminders_paused ? 'Bullet Journal reminders are paused.' : 'Bullet Journal reminders are resumed.';
  }
  state.updated_at = now.toISOString();
  await saveBulletJournalState(projectDir, state);
  return { response: `${response} Current state: ${openTasks(state).length} open task(s), ${state.closed_tasks.length} closed task(s), ${state.notes.length} note(s).`, service: setup.service, state, schedule: setup.schedule };
}

type BulletJournalCommand =
  | { name: 'add_task'; title: string; description?: string; priority?: BulletJournalTask['priority']; dueDate?: string | null; tags?: string[] }
  | { name: 'add_note'; content: string; linkedTaskId?: string | null; tags?: string[] }
  | { name: 'update_task'; selector: string; title?: string; description?: string; priority?: BulletJournalTask['priority']; dueDate?: string | null }
  | { name: 'edit_note'; noteId: string; content: string }
  | { name: 'delete_note'; noteId: string }
  | { name: 'close_task' | 'reopen_task'; selector: string }
  | { name: 'show_today' | 'show_open_tasks' | 'show_closed_tasks' | 'daily_review' | 'weekly_review' | 'pause_reminders' | 'resume_reminders' }
  | { name: 'set_reminder_time'; time: string };

type GenericOperateCommand =
  | { name: 'show_status'; target?: string }
  | { name: 'add_note'; content: string; target?: string }
  | { name: 'record_observation'; content: string; target?: string }
  | { name: 'pause_reminders' | 'resume_reminders'; target?: string };

function parseBulletJournalCommand(message: string): BulletJournalCommand | null {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const addTask = trimmed.match(/^add(?: a)? task[:\s]+(.+)$/i);
  if (addTask) return { name: 'add_task', title: addTask[1].trim() };
  const closeTask = trimmed.match(/^close(?: task)?[:\s]+(.+)$/i);
  if (closeTask) return { name: 'close_task', selector: closeTask[1].trim() };
  const reopenTask = trimmed.match(/^reopen(?: task)?[:\s]+(.+)$/i);
  if (reopenTask) return { name: 'reopen_task', selector: reopenTask[1].trim() };
  const updateTask = trimmed.match(/^update(?: task)?\s+([^:]+):\s*(.+)$/i);
  if (updateTask) return { name: 'update_task', selector: updateTask[1].trim(), title: updateTask[2].trim() };
  const note = trimmed.match(/^(?:add )?note[:\s]+(.+)$/i);
  if (note) return { name: 'add_note', content: note[1].trim() };
  const editNote = trimmed.match(/^edit note\s+(\S+)[:\s]+(.+)$/i);
  if (editNote) return { name: 'edit_note', noteId: editNote[1].trim(), content: editNote[2].trim() };
  const deleteNote = trimmed.match(/^delete note\s+(\S+)$/i);
  if (deleteNote) return { name: 'delete_note', noteId: deleteNote[1].trim() };
  const reminderTime = parseReminderTime(trimmed);
  if (/set reminder time|remind me at|check in at/i.test(trimmed) && reminderTime) return { name: 'set_reminder_time', time: reminderTime };
  if (lower === 'show today' || lower === 'today' || lower === 'daily check-in') return { name: 'show_today' };
  if (lower === 'show open tasks' || lower === 'open tasks') return { name: 'show_open_tasks' };
  if (lower === 'show closed tasks' || lower === 'closed tasks') return { name: 'show_closed_tasks' };
  if (lower === 'daily review') return { name: 'daily_review' };
  if (lower === 'weekly review') return { name: 'weekly_review' };
  if (lower === 'pause reminders') return { name: 'pause_reminders' };
  if (lower === 'resume reminders') return { name: 'resume_reminders' };
  return null;
}

async function applyGenericOperateCommand(projectDir: string, command: GenericOperateCommand, now: Date): Promise<{ response: string; service?: AgenticServiceDefinition; state?: GenericOperateState; schedule: AutomationJob | null }> {
  const serviceRecord = await findGenericOperateService(projectDir, command.target);
  if (serviceRecord.status === 'missing') return { response: 'No generic operating service is configured yet.', schedule: null };
  if (serviceRecord.status === 'ambiguous') return { response: `Multiple generic operating services are configured. Target one with its service id, URL, or service name: ${serviceRecord.services.map((item) => item.service.service_id).join(', ')}.`, schedule: null };
  const service = serviceRecord.service;
  const state = normalizeGenericOperateState(serviceRecord.state, service.service_id, now, service.created_at);
  let response = '';
  let schedule: AutomationJob | null = null;
  if (command.name === 'show_status') {
    response = formatGenericOperateStatus(service, state);
  } else if (command.name === 'add_note') {
    const note: Record<string, unknown> = { id: `note_${now.getTime().toString(36)}_${crypto.randomBytes(2).toString('hex')}`, content: command.content, created_at: now.toISOString(), updated_at: now.toISOString() };
    state.notes.push(note);
    response = `Added note ${note.id}.`;
  } else if (command.name === 'record_observation') {
    const observation: Record<string, unknown> = { id: `obs_${now.getTime().toString(36)}_${crypto.randomBytes(2).toString('hex')}`, content: command.content, created_at: now.toISOString() };
    state.observations.push(observation);
    response = `Recorded observation ${observation.id}.`;
  } else if (command.name === 'pause_reminders' || command.name === 'resume_reminders') {
    state.reminders_paused = command.name === 'pause_reminders';
    state.enabled = command.name !== 'pause_reminders';
    if (service.automation_job_id) schedule = await updateAutomationJob(projectDir, service.automation_job_id, { enabled: state.enabled }, now);
    response = state.enabled ? `${service.service_name} reminders are resumed.` : `${service.service_name} reminders are paused.`;
  }
  service.updated_at = now.toISOString();
  service.schedules = (service.schedules || []).map((entry) => ({ ...entry, enabled: state.enabled && !state.reminders_paused }));
  state.updated_at = now.toISOString();
  await saveGenericOperateService(projectDir, service, state);
  return { response: `${response} ${formatGenericOperateCounts(state)}`, service, state, schedule };
}

function parseGenericOperateCommand(message: string): GenericOperateCommand | null {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const status = trimmed.match(/^(?:show status|status)(?:\s+(?:for|of)\s+(.+))?$/i);
  if (status) return { name: 'show_status', target: normalizeGenericCommandTarget(status[1]) };
  const scopedNote = trimmed.match(/^(?:site monitor|operating service)(?:\s+(.+?))?\s+add note[:\s]+(.+)$/i);
  if (scopedNote) return { name: 'add_note', target: normalizeGenericCommandTarget(scopedNote[1]), content: scopedNote[2].trim() };
  const note = trimmed.match(/^add note(?:\s+(?:to|for)\s+(.+?))?[:\s]+(.+)$/i);
  if (note) return { name: 'add_note', target: normalizeGenericCommandTarget(note[1]), content: note[2].trim() };
  const observation = trimmed.match(/^(?:(?:site monitor|operating service)(?:\s+(.+?))?\s+)?(?:record observation|observed)[:\s]+(.+)$/i);
  if (observation) return { name: 'record_observation', target: normalizeGenericCommandTarget(observation[1]), content: observation[2].trim() };
  const reminders = trimmed.match(/^(?:(?:site monitor|operating service)(?:\s+(.+?))?\s+)?(pause|resume) reminders$/i);
  if (reminders) return { name: reminders[2].toLowerCase() === 'pause' ? 'pause_reminders' : 'resume_reminders', target: normalizeGenericCommandTarget(reminders[1]) };
  return null;
}

function normalizeGenericCommandTarget(value: string | undefined): string | undefined {
  const target = value?.trim();
  if (!target) return undefined;
  if (/^(site monitor|operating service)$/i.test(target)) return undefined;
  return target;
}

type GenericServiceLookup =
  | { status: 'found'; service: AgenticServiceDefinition; state: StoredAgenticService['state'] }
  | { status: 'missing' }
  | { status: 'ambiguous'; services: StoredAgenticService[] };

async function findGenericOperateService(projectDir: string, target?: string): Promise<GenericServiceLookup> {
  const services = await listAgenticServices(projectDir);
  const genericServices = services.filter((item) => item.service.service_id !== 'bullet_journal');
  if (genericServices.length === 0) return { status: 'missing' };
  if (target) {
    const matches = genericServices.filter((item) => genericServiceMatchesTarget(item.service, target));
    if (matches.length === 1) return { status: 'found', service: matches[0].service, state: matches[0].state };
    if (matches.length > 1) return { status: 'ambiguous', services: matches };
    return { status: 'missing' };
  }
  if (genericServices.length === 1) return { status: 'found', service: genericServices[0].service, state: genericServices[0].state };
  return { status: 'ambiguous', services: genericServices };
}

function genericServiceMatchesTarget(service: AgenticServiceDefinition, target: string): boolean {
  const normalizedTarget = target.trim().toLowerCase();
  const url = extractUrl(target);
  const urlServiceId = url ? `site_monitor_${shortHash(url)}` : null;
  return service.service_id.toLowerCase() === normalizedTarget
    || service.service_name.toLowerCase() === normalizedTarget
    || service.storage_location.toLowerCase().endsWith(`/${normalizedTarget}`)
    || (urlServiceId !== null && service.service_id === urlServiceId)
    || (url !== null && service.purpose.toLowerCase().includes(url.toLowerCase()))
    || service.purpose.toLowerCase().includes(normalizedTarget);
}

async function saveGenericOperateService(projectDir: string, service: AgenticServiceDefinition, state: GenericOperateState): Promise<void> {
  const dir = path.join(servicesDir(projectDir), service.service_id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify(service, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

function formatGenericOperateStatus(service: AgenticServiceDefinition, state: GenericOperateState): string {
  const status = state.enabled && !state.reminders_paused ? 'enabled' : 'paused';
  return `${service.service_name} is ${status}. ${formatGenericOperateCounts(state)}`;
}

function formatGenericOperateCounts(state: GenericOperateState): string {
  return `Current state: ${state.observations.length} observation(s), ${state.notes.length} note(s), ${state.tasks.length} task(s).`;
}

async function ensureGenericOperateSchedule(projectDir: string, service: AgenticServiceDefinition, request: string, siteUrl: string | null, now: Date): Promise<AutomationJob | null> {
  const prompt = [
    `service_id: ${service.service_id}`,
    'mode: operate',
    `Purpose: ${service.purpose}`,
    siteUrl ? `Check this site: ${siteUrl}` : '',
    `Original user request: ${request}`,
    `Read and update service state at ${service.storage_location}/state.json.`,
    'Act as an operational service: check, record observations, and notify with a concise status. Do not build an app, UI, markdown task file, or code project unless the user explicitly asks for software.',
  ].filter(Boolean).join('\n');
  const jobs = await listAutomationJobs(projectDir);
  const existing = jobs.find((job) => job.id === service.automation_job_id) ?? jobs.find((job) => job.name === `${service.service_name}: ${service.service_id}`);
  const input = { name: `${service.service_name}: ${service.service_id}`, prompt, schedule: '0 9 * * *' };
  if (existing) return updateAutomationJob(projectDir, existing.id, { ...input, enabled: true }, now);
  return createAutomationJob(projectDir, input, now);
}

function normalizeGenericOperateState(raw: unknown, serviceId: string, now: Date, createdAt: string): GenericOperateState {
  const source = typeof raw === 'object' && raw !== null ? raw as Partial<GenericOperateState> : {};
  return {
    service_id: serviceId,
    mode: 'operate',
    observations: Array.isArray(source.observations) ? source.observations : [],
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    notes: Array.isArray(source.notes) ? source.notes : [],
    reminders: Array.isArray(source.reminders) ? source.reminders : [],
    reviews: Array.isArray(source.reviews) ? source.reviews : [],
    enabled: source.enabled !== false,
    reminders_paused: source.reminders_paused === true,
    created_at: typeof source.created_at === 'string' ? source.created_at : createdAt,
    updated_at: now.toISOString(),
  };
}

async function loadBulletJournalDefinition(projectDir: string, now: Date): Promise<AgenticServiceDefinition> {
  try {
    const parsed = JSON.parse(await fs.readFile(bulletJournalDefinitionPath(projectDir), 'utf-8')) as AgenticServiceDefinition;
    return parsed;
  } catch {
    const storageLocation = path.relative(projectDir, bulletJournalDir(projectDir)).split(path.sep).join('/');
    return {
      service_id: 'bullet_journal',
      service_name: 'Bullet Journal Agent',
      mode: 'operate',
      purpose: 'Maintain a persistent bullet journal with tasks, notes, reminders, daily logs, collections, and reviews.',
      persistent_state_schema: {
        tasks: ['id', 'title', 'description', 'status', 'priority', 'due_date', 'created_at', 'updated_at', 'closed_at', 'tags', 'notes'],
        notes: ['id', 'content', 'created_at', 'updated_at', 'tags', 'linked_task_id'],
        daily_logs: 'Timestamped daily review entries.',
        collections: 'Named groups of related tasks or notes.',
        closed_tasks: 'Closed task snapshots.',
        reminders: 'Reminder rules and schedule metadata.',
        reviews: 'Daily and weekly review summaries.',
      },
      supported_commands: BULLET_JOURNAL_COMMANDS,
      schedules: [],
      reminder_rules: [
        'Send/check in once per day at the configured time.',
        'Show open tasks due today.',
        'Show overdue tasks.',
        'Ask what to add, update, close, or note.',
        'Summarise yesterday unresolved tasks if relevant.',
      ],
      notification_templates: {
        daily_check_in: 'Good morning. Here\'s your bullet journal check-in:\nOpen today:\n1. ...\nOverdue:\n1. ...\nWant to add, update, close anything, or add a note?',
      },
      state_transition_rules: [
        'add_task creates an open task.',
        'update_task modifies fields.',
        'close_task sets status = closed and closed_at timestamp.',
        'reopen_task sets status = open.',
        'add_note creates a timestamped note.',
        'linked notes can attach to tasks.',
        'daily_review writes a daily_log entry.',
        'weekly_review summarises completed/open tasks and recurring themes.',
      ],
      review_rules: ['Daily review writes daily_logs.', 'Weekly review summarises completed/open tasks and recurring themes.'],
      close_archive_rules: ['Closed tasks remain in tasks with status=closed and are mirrored in closed_tasks.', 'Archived records are retained unless explicitly deleted.'],
      user_interaction_examples: ['add task pay invoice', 'close task task_abc123', 'add note Remember to call Sam', 'show today', 'weekly review'],
      safety_confirmation_rules: ['Ask for confirmation before deleting notes or clearing large sections of state.', 'Do not expose private journal state outside the local harness response unless the user asks.'],
      storage_location: storageLocation,
      enable_disable_controls: ['pause_reminders', 'resume_reminders'],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }
}

async function loadBulletJournalState(projectDir: string, now: Date): Promise<BulletJournalState> {
  try {
    const parsed = JSON.parse(await fs.readFile(bulletJournalStatePath(projectDir), 'utf-8')) as BulletJournalState;
    return {
      ...emptyBulletJournalState(now),
      ...parsed,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      daily_logs: Array.isArray(parsed.daily_logs) ? parsed.daily_logs : [],
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      closed_tasks: Array.isArray(parsed.closed_tasks) ? parsed.closed_tasks : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
    };
  } catch {
    return emptyBulletJournalState(now);
  }
}

function emptyBulletJournalState(now: Date): BulletJournalState {
  return {
    service_id: 'bullet_journal',
    mode: 'operate',
    tasks: [],
    notes: [],
    daily_logs: [],
    collections: [],
    closed_tasks: [],
    reminders: [],
    reviews: [],
    reminder_time: '09:00',
    reminders_paused: false,
    enabled: true,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

async function ensureBulletJournalSchedule(projectDir: string, service: AgenticServiceDefinition, reminderTime: string, now: Date): Promise<AutomationJob | null> {
  const schedule = dailyCron(reminderTime);
  const prompt = [
    'service_id: bullet_journal',
    'mode: operate',
    'Send the daily bullet journal check-in using this exact format:',
    'Good morning. Here\'s your bullet journal check-in:',
    'Open today:',
    '1. ...',
    'Overdue:',
    '1. ...',
    'Want to add, update, close anything, or add a note?',
    `Read service state from ${service.storage_location}/state.json before composing the check-in.`,
  ].join('\n');
  const jobs = await listAutomationJobs(projectDir);
  const existing = jobs.find((job) => job.id === service.automation_job_id) ?? jobs.find((job) => job.name === 'Bullet Journal daily check-in');
  if (existing) return updateAutomationJob(projectDir, existing.id, { name: 'Bullet Journal daily check-in', prompt, schedule, enabled: true }, now);
  return createAutomationJob(projectDir, { name: 'Bullet Journal daily check-in', prompt, schedule }, now);
}

async function saveBulletJournalDefinition(projectDir: string, service: AgenticServiceDefinition): Promise<void> {
  await fs.mkdir(bulletJournalDir(projectDir), { recursive: true });
  await fs.writeFile(bulletJournalDefinitionPath(projectDir), JSON.stringify(service, null, 2), 'utf-8');
}

async function saveBulletJournalState(projectDir: string, state: BulletJournalState): Promise<void> {
  await fs.mkdir(bulletJournalDir(projectDir), { recursive: true });
  await fs.writeFile(bulletJournalStatePath(projectDir), JSON.stringify(state, null, 2), 'utf-8');
}

function isBulletJournalRequest(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('bullet journal') || lower.includes('bullet proof journal') || looksLikeBulletJournalCommand(lower);
}

function looksLikeBulletJournalServiceRequest(lower: string): boolean {
  return (lower.includes('bullet journal') || lower.includes('bullet proof journal')) && (lower.includes('service') || lower.includes('agent') || lower.includes('remind') || lower.includes('keep track') || lower.includes('manage') || lower.includes('update for me') || lower.includes('keep me honest'));
}

function looksLikeBulletJournalCommand(lower: string): boolean {
  return /^(add( a)? task|update( task)?|close( task)?|reopen( task)?|note|add note|edit note|delete note|show today|today|daily check-in|show open tasks|open tasks|show closed tasks|closed tasks|daily review|weekly review|set reminder time|pause reminders|resume reminders)\b/.test(lower.trim());
}

function looksLikeExternalBulletJournalTaskRequest(lower: string): boolean {
  return /^(add(?: a)? task|close(?: task)?|complete(?: task)?|update(?: task)?|reopen(?: task)?)\b/.test(lower.trim())
    && /\b(to|in|into)\s+(my|the)?\s*bullet journal\b/.test(lower);
}

function looksLikeGenericOperateCommand(lower: string): boolean {
  return /^(show status|status|site monitor\b|operating service\b|add note (to|for) .+|record observation|observed)\b/.test(lower.trim());
}

function looksLikeAgenticSearchRequest(lower: string): boolean {
  const text = lower.trim();
  return /\b(look for|find|search for|watch for|monitor for|check for)\b[\s\S]{0,120}\b(book|books|room|rooms|appointment|appointments|slot|slots|availability|stock|tickets?)\b/.test(text)
    && /\b(for me|daily|every day|each day|every morning|when|until|available|opens?|appears?|comes? up|in stock|free)\b/.test(text);
}

function explicitlyRequestsSoftwareBuild(lower: string): boolean {
  return /\b(build|code|develop|implement|scaffold|create|make|generate|write)\b.{0,60}\b(app|application|ui|dashboard|website|site|software|codebase|project|component|page|document|template|artifact)\b/.test(lower);
}

function parseReminderTime(message: string): string | null {
  const match = message.match(/(?:at|time\s+to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function parseTaskDetails(rawTitle: string): { title: string; priority?: BulletJournalTask['priority']; dueDate?: string; tags: string[] } {
  let title = rawTitle.trim();
  let priority: BulletJournalTask['priority'] | undefined;
  let dueDate: string | undefined;
  const tags = Array.from(title.matchAll(/#([a-zA-Z0-9_-]+)/g)).map((match) => match[1]);
  title = title.replace(/\s*#[a-zA-Z0-9_-]+/g, '').trim();
  const dueMatch = title.match(/\b(?:due|by)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (dueMatch) {
    dueDate = dueMatch[1];
    title = title.replace(dueMatch[0], '').trim();
  }
  const priorityMatch = title.match(/\bpriority\s+(high|normal|low)\b/i) ?? title.match(/\b(high|normal|low)\s+priority\b/i);
  if (priorityMatch) {
    priority = priorityMatch[1].toLowerCase() as BulletJournalTask['priority'];
    title = title.replace(priorityMatch[0], '').trim();
  }
  return { title: title.replace(/\s{2,}/g, ' ') || rawTitle.trim(), priority, dueDate, tags };
}

function extractUrl(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s)]+/i);
  if (!match) return null;
  try {
    return new URL(match[0]).toString();
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/https?:\/\/[^\s)]+/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function normalizeReminderTime(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function dailyCron(reminderTime: string): string {
  const normalized = normalizeReminderTime(reminderTime) ?? '09:00';
  const [hour, minute] = normalized.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function openTasks(state: BulletJournalState): BulletJournalTask[] {
  return state.tasks.filter((task) => task.status !== 'closed');
}

function findTask(state: BulletJournalState, selector: string): BulletJournalTask | undefined {
  const lower = selector.toLowerCase();
  return openTasks(state).find((task) => task.id === selector || task.title.toLowerCase() === lower || task.title.toLowerCase().includes(lower));
}

function formatDailyCheckIn(state: BulletJournalState, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const dueToday = openTasks(state).filter((task) => task.due_date === today || !task.due_date);
  const overdue = openTasks(state).filter((task) => task.due_date && task.due_date < today);
  return [
    'Good morning. Here\'s your bullet journal check-in:',
    'Open today:',
    numberedTasks(dueToday),
    'Overdue:',
    numberedTasks(overdue),
    'Want to add, update, close anything, or add a note?',
  ].join('\n');
}

function formatTaskList(title: string, tasks: BulletJournalTask[]): string {
  return `${title}:\n${numberedTasks(tasks)}`;
}

function numberedTasks(tasks: BulletJournalTask[]): string {
  if (tasks.length === 0) return 'None.';
  return tasks.map((task, index) => `${index + 1}. ${task.title} (${task.id})`).join('\n');
}

function summarizeTags(state: BulletJournalState): string[] {
  const counts = new Map<string, number>();
  for (const item of [...state.tasks, ...state.notes]) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);
}

function bulletJournalDir(projectDir: string): string {
  return path.join(servicesDir(projectDir), 'bullet_journal');
}

function servicesDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'services');
}

function bulletJournalDefinitionPath(projectDir: string): string {
  return path.join(bulletJournalDir(projectDir), 'service.json');
}

function bulletJournalStatePath(projectDir: string): string {
  return path.join(bulletJournalDir(projectDir), 'state.json');
}
