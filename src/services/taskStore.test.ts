import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  createTask,
  deleteTask,
  detectStaleTasks,
  getTask,
  listTasks,
  recordCheckIn,
  summarizeTasks,
  updateTask,
} from './taskStore';

describe('taskStore', () => {
  let projectDir: string;
  const cwd = process.cwd();

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-tasks-'));
  });

  afterEach(async () => {
    process.chdir(cwd);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('creates and lists tasks', async () => {
    const t1 = await createTask(projectDir, { title: 'first' });
    const t2 = await createTask(projectDir, { title: 'second', assigneeId: 'agent-a' });
    expect(t1.status).toBe('pending');
    expect(t2.status).toBe('assigned');
    const tasks = await listTasks(projectDir);
    expect(tasks).toHaveLength(2);
    expect(await listTasks(projectDir, { assigneeId: 'agent-a' })).toHaveLength(1);
  });

  it('records check-ins and advances status to in_progress', async () => {
    const task = await createTask(projectDir, { title: 'work' });
    const updated = await recordCheckIn(projectDir, task.id, { progressPercent: 25, message: 'started' });
    expect(updated.status).toBe('in_progress');
    expect(updated.progressPercent).toBe(25);
    expect(updated.checkIns).toHaveLength(1);
  });

  it('updates and deletes tasks', async () => {
    const task = await createTask(projectDir, { title: 'work' });
    const updated = await updateTask(projectDir, task.id, { status: 'review', priority: 'high' });
    expect(updated.status).toBe('review');
    expect(updated.priority).toBe('high');
    expect(await deleteTask(projectDir, task.id)).toBe(true);
    expect(await getTask(projectDir, task.id)).toBeUndefined();
  });

  it('detects stale in-progress tasks', async () => {
    const task = await createTask(projectDir, { title: 'work' });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await recordCheckIn(projectDir, task.id, { message: 'started', progressPercent: 50 }, past);
    const stale = await detectStaleTasks(projectDir);
    expect(stale).toHaveLength(1);
    expect(stale[0].taskId).toBe(task.id);
    expect(stale[0].staleForMs).toBeGreaterThan(30 * 60 * 1000);
  });

  it('summarizes by status', async () => {
    await createTask(projectDir, { title: 'a' });
    const b = await createTask(projectDir, { title: 'b' });
    await updateTask(projectDir, b.id, { status: 'done' });
    const summary = await summarizeTasks(projectDir);
    expect(summary.total).toBe(2);
    expect(summary.pending).toBe(1);
    expect(summary.done).toBe(1);
  });

  it('clamps progress percent and persists across reads', async () => {
    const task = await createTask(projectDir, { title: 'work' });
    await recordCheckIn(projectDir, task.id, { progressPercent: 200, message: 'capped' });
    const reread = await getTask(projectDir, task.id);
    expect(reread?.progressPercent).toBe(100);
  });
});
