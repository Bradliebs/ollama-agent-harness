import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { classifyAgenticMode, handleOperateModeRequest, type BulletJournalState, type GenericOperateState } from './agenticServiceMode';
import { executeDueJobs, listAutomationJobs } from '../automation/jobs';

describe('agentic service mode', () => {
  it('classifies ongoing service requests as operate mode unless software is explicit', () => {
    expect(classifyAgenticMode('Remind me daily to review my tasks')).toMatchObject({ mode: 'operate' });
    expect(classifyAgenticMode('Build an app that reminds me daily')).toMatchObject({ mode: 'build' });
    expect(classifyAgenticMode('Generate a document template that reminds me daily')).toMatchObject({ mode: 'build' });
  });

  it('classifies explicit ongoing service trigger phrases as operate mode', () => {
    const triggers = [
      'send me reminders about my invoices',
      'remind me daily to review my plan',
      'check in with me about open tasks',
      'keep track of room availability',
      'let me add tasks to this service',
      'let me update tasks in this service',
      'let me close tasks when done',
      'add notes to the running log',
      'manage this for me over time',
      'follow up with me tomorrow',
      'monitor this account daily',
      'notify me when status changes',
      'ask me every morning what changed',
      'review this each day',
      'keep a log of observations',
    ];

    for (const trigger of triggers) {
      expect(classifyAgenticMode(trigger)).toMatchObject({ mode: 'operate' });
    }
  });

  it('creates a persisted bullet journal service and daily automation schedule', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-service-mode-'));

    const result = await handleOperateModeRequest(projectDir, 'Create a bullet journal agent and remind me daily at 9am', new Date('2026-05-03T08:00:00.000Z'));

    expect(result.handled).toBe(true);
    expect(result.response).toContain('Your Bullet Journal agent is set up.');
    expect(result.service).toMatchObject({ service_id: 'bullet_journal', mode: 'operate' });
    expect(result.state).toMatchObject({ service_id: 'bullet_journal', tasks: [], notes: [], reminder_time: '09:00' });

    const serviceRaw = await fs.readFile(path.join(projectDir, '.harness', 'services', 'bullet_journal', 'service.json'), 'utf-8');
    const stateRaw = await fs.readFile(path.join(projectDir, '.harness', 'services', 'bullet_journal', 'state.json'), 'utf-8');
    expect(JSON.parse(serviceRaw)).toMatchObject({ service_id: 'bullet_journal', supported_commands: expect.arrayContaining(['add_task', 'weekly_review']) });
    expect(JSON.parse(stateRaw)).toMatchObject({ service_id: 'bullet_journal', tasks: [] });

    await expect(listAutomationJobs(projectDir)).resolves.toEqual([
      expect.objectContaining({ name: 'Bullet Journal daily check-in', schedule: expect.objectContaining({ kind: 'cron', expr: '0 9 * * *' }) }),
    ]);
  });

  it('persists the complete bullet journal operating service definition', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-service-definition-'));
    await handleOperateModeRequest(projectDir, 'Create a bullet journal agent and remind me daily at 9am', new Date('2026-05-03T08:00:00.000Z'));

    const service = JSON.parse(await fs.readFile(path.join(projectDir, '.harness', 'services', 'bullet_journal', 'service.json'), 'utf-8')) as Record<string, unknown>;

    expect(service).toMatchObject({
      service_id: 'bullet_journal',
      service_name: 'Bullet Journal Agent',
      mode: 'operate',
      purpose: expect.stringContaining('persistent bullet journal'),
      storage_location: '.harness/services/bullet_journal',
      automation_job_id: expect.any(String),
    });
    expect(service).toEqual(expect.objectContaining({
      persistent_state_schema: expect.any(Object),
      supported_commands: expect.arrayContaining(['add_task', 'update_task', 'close_task', 'reopen_task', 'add_note', 'edit_note', 'delete_note', 'show_today', 'show_open_tasks', 'show_closed_tasks', 'daily_review', 'weekly_review', 'set_reminder_time', 'pause_reminders', 'resume_reminders']),
      schedules: expect.arrayContaining([expect.objectContaining({ id: 'daily_check_in', expression: '0 9 * * *' })]),
      reminder_rules: expect.arrayContaining(['Send/check in once per day at the configured time.', 'Show open tasks due today.', 'Show overdue tasks.', 'Ask what to add, update, close, or note.']),
      state_transition_rules: expect.arrayContaining(['add_task creates an open task.', 'close_task sets status = closed and closed_at timestamp.', 'weekly_review summarises completed/open tasks and recurring themes.']),
      review_rules: expect.arrayContaining(['Daily review writes daily_logs.', 'Weekly review summarises completed/open tasks and recurring themes.']),
      close_archive_rules: expect.arrayContaining(['Closed tasks remain in tasks with status=closed and are mirrored in closed_tasks.']),
      user_interaction_examples: expect.arrayContaining(['add task pay invoice', 'show today', 'weekly review']),
      safety_confirmation_rules: expect.arrayContaining(['Ask for confirmation before deleting notes or clearing large sections of state.']),
      enable_disable_controls: expect.arrayContaining(['pause_reminders', 'resume_reminders']),
    }));
    expect((service.notification_templates as Record<string, string>).daily_check_in).toBe('Good morning. Here\'s your bullet journal check-in:\nOpen today:\n1. ...\nOverdue:\n1. ...\nWant to add, update, close anything, or add a note?');
    expect((service.persistent_state_schema as Record<string, unknown>).tasks).toEqual(['id', 'title', 'description', 'status', 'priority', 'due_date', 'created_at', 'updated_at', 'closed_at', 'tags', 'notes']);
    expect((service.persistent_state_schema as Record<string, unknown>).notes).toEqual(['id', 'content', 'created_at', 'updated_at', 'tags', 'linked_task_id']);
  });

  it('mutates existing bullet journal state through service commands', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-service-command-'));
    await handleOperateModeRequest(projectDir, 'Create a bullet journal service and remind me daily', new Date('2026-05-03T08:00:00.000Z'));

    const addResult = await handleOperateModeRequest(projectDir, 'add task Pay rent', new Date('2026-05-03T08:01:00.000Z'));
    expect(addResult.response).toContain('Added task');
    expect(addResult.state?.tasks).toEqual([expect.objectContaining({ title: 'Pay rent', status: 'open' })]);

    const closeResult = await handleOperateModeRequest(projectDir, 'close task Pay rent', new Date('2026-05-03T08:02:00.000Z'));
    expect(closeResult.response).toContain('Closed task');

    const state = JSON.parse(await fs.readFile(path.join(projectDir, '.harness', 'services', 'bullet_journal', 'state.json'), 'utf-8')) as BulletJournalState;
    expect(state.tasks[0]).toMatchObject({ title: 'Pay rent', status: 'closed', closed_at: '2026-05-03T08:02:00.000Z' });
    expect(state.closed_tasks).toEqual([expect.objectContaining({ title: 'Pay rent', status: 'closed' })]);
  });

  it('captures task due dates, priorities, and tags without using markdown task files', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-service-task-fields-'));

    const result = await handleOperateModeRequest(projectDir, 'add task Pay rent due 2026-05-05 priority high #home', new Date('2026-05-03T08:01:00.000Z'));

    expect(result.state?.tasks).toEqual([expect.objectContaining({ title: 'Pay rent', due_date: '2026-05-05', priority: 'high', tags: ['home'] })]);
    const updateResult = await handleOperateModeRequest(projectDir, 'update task Pay rent: Pay rent now priority low #finance', new Date('2026-05-03T08:02:00.000Z'));
    expect(updateResult.state?.tasks).toEqual([expect.objectContaining({ title: 'Pay rent now', due_date: '2026-05-05', priority: 'low', tags: ['home', 'finance'] })]);
    await expect(fs.readdir(projectDir)).resolves.not.toContain('tasks.md');
  });

  it('creates a generic daily site monitor as an operating service', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-site-monitor-'));

    const result = await handleOperateModeRequest(projectDir, 'check https://example.com/rooms daily to see if a room is free', new Date('2026-05-03T08:00:00.000Z'));

    expect(result.handled).toBe(true);
    expect(result.service).toMatchObject({ service_name: 'Site Monitor Agent', mode: 'operate' });
    expect(result.service?.purpose).toContain('https://example.com/rooms');
    expect(result.response).toContain('is set up');
    await expect(listAutomationJobs(projectDir)).resolves.toEqual([
      expect.objectContaining({ name: expect.stringContaining('Site Monitor Agent'), prompt: expect.stringContaining('Do not build an app, UI, markdown task file, or code project') }),
    ]);
  });

  it('executes site monitor schedules through automation runner output', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-site-monitor-run-'));
    const request = 'check https://example.com/rooms daily to see if a room is free';
    const setup = await handleOperateModeRequest(projectDir, request, new Date('2026-05-03T08:00:00.000Z'));

    const results = await executeDueJobs(projectDir, {}, new Date('2026-05-03T09:00:00.000Z'));

    expect(results).toHaveLength(1);
    expect(results[0].name).toContain('Site Monitor Agent');
    const output = await fs.readFile(results[0].run.outputPath, 'utf-8');
    expect(output).toContain(setup.service!.storage_location + '/state.json');
    expect(output).toContain(request);
    expect(output).toContain('Do not build an app, UI, markdown task file, or code project');
  });

  it('mutates generic operating service state through deterministic commands', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-site-monitor-command-'));
    await handleOperateModeRequest(projectDir, 'check https://example.com/rooms daily to see if a room is free', new Date('2026-05-03T08:00:00.000Z'));

    const note = await handleOperateModeRequest(projectDir, 'site monitor add note Prefer rooms with projectors', new Date('2026-05-03T08:01:00.000Z'));
    expect(note.response).toContain('Added note');
    expect(note.state?.notes).toEqual([expect.objectContaining({ content: 'Prefer rooms with projectors' })]);

    const observation = await handleOperateModeRequest(projectDir, 'record observation no rooms free today', new Date('2026-05-03T08:02:00.000Z'));
    expect(observation.response).toContain('Recorded observation');
    expect((observation.state as GenericOperateState | undefined)?.observations).toEqual([expect.objectContaining({ content: 'no rooms free today' })]);

    const pause = await handleOperateModeRequest(projectDir, 'site monitor pause reminders', new Date('2026-05-03T08:03:00.000Z'));
    expect(pause.response).toContain('paused');
    expect(pause.state).toMatchObject({ enabled: false, reminders_paused: true });
    await expect(listAutomationJobs(projectDir)).resolves.toEqual([expect.objectContaining({ enabled: false })]);

    const resume = await handleOperateModeRequest(projectDir, 'site monitor resume reminders', new Date('2026-05-03T08:04:00.000Z'));
    expect(resume.response).toContain('resumed');
    expect(resume.state).toMatchObject({ enabled: true, reminders_paused: false });
    await expect(listAutomationJobs(projectDir)).resolves.toEqual([expect.objectContaining({ enabled: true })]);
  });

  it('routes ambiguous reminder commands to bullet journal and scoped commands to site monitor', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-service-routing-'));
    await handleOperateModeRequest(projectDir, 'Create a bullet journal agent and remind me daily at 9am', new Date('2026-05-03T08:00:00.000Z'));
    await handleOperateModeRequest(projectDir, 'check https://example.com/rooms daily to see if a room is free', new Date('2026-05-03T08:01:00.000Z'));

    const unscoped = await handleOperateModeRequest(projectDir, 'pause reminders', new Date('2026-05-03T08:02:00.000Z'));
    expect(unscoped.service).toMatchObject({ service_id: 'bullet_journal' });
    expect(unscoped.state).toMatchObject({ service_id: 'bullet_journal', enabled: false, reminders_paused: true });

    const scoped = await handleOperateModeRequest(projectDir, 'site monitor pause reminders', new Date('2026-05-03T08:03:00.000Z'));
    expect(scoped.service).toMatchObject({ service_name: 'Site Monitor Agent' });
    expect(scoped.state).toMatchObject({ enabled: false, reminders_paused: true });

    const jobs = await listAutomationJobs(projectDir);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Bullet Journal daily check-in', enabled: false }),
      expect.objectContaining({ name: expect.stringContaining('Site Monitor Agent'), enabled: false }),
    ]));
  });
});
