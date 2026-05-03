// Worker Queue — local model background task processing.
//
// Local models handle cheap background tasks: classify new tasks,
// extract structured tasks from notes, summarise daily notes,
// compress memory, scan logs, detect repeated failures, generate
// reminder drafts, refresh project summaries, validate JSON outputs.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export type WorkerJobType =
  | 'classify_task'
  | 'extract_tasks'
  | 'summarise_notes'
  | 'summarise_weekly'
  | 'compress_memory'
  | 'scan_logs'
  | 'detect_failures'
  | 'generate_reminder'
  | 'refresh_summary'
  | 'validate_json'
  | 'custom';

export type WorkerJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface WorkerJob {
  job_id: string;
  job_type: WorkerJobType;
  service_id?: string;
  model_id?: string;
  input: unknown;
  output?: unknown;
  status: WorkerJobStatus;
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface WorkerJobResult {
  job_id: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: string;
  duration_ms: number;
}

export type WorkerExecutor = (job: WorkerJob) => Promise<unknown>;

// ─── Queue ──────────────────────────────────────────────────────────

export class WorkerQueue {
  private queue: WorkerJob[] = [];
  private completed: WorkerJob[] = [];
  private executors = new Map<WorkerJobType, WorkerExecutor>();
  private maxCompleted: number;

  constructor(maxCompleted = 100) {
    this.maxCompleted = maxCompleted;
  }

  /** Register an executor for a job type. */
  registerExecutor(jobType: WorkerJobType, executor: WorkerExecutor): void {
    this.executors.set(jobType, executor);
  }

  /** Enqueue a new job. */
  enqueue(jobType: WorkerJobType, input: unknown, options?: { service_id?: string; model_id?: string }): WorkerJob {
    const job: WorkerJob = {
      job_id: crypto.randomUUID(),
      job_type: jobType,
      service_id: options?.service_id,
      model_id: options?.model_id,
      input,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    this.queue.push(job);
    return job;
  }

  /** Process the next pending job. Returns result or null if queue is empty. */
  async processNext(): Promise<WorkerJobResult | null> {
    const job = this.queue.find((j) => j.status === 'pending');
    if (!job) return null;

    const executor = this.executors.get(job.job_type);
    if (!executor) {
      job.status = 'failed';
      job.error = `No executor registered for job type: ${job.job_type}`;
      job.completed_at = new Date().toISOString();
      this.moveToCompleted(job);
      return { job_id: job.job_id, status: 'failed', error: job.error, duration_ms: 0 };
    }

    job.status = 'running';
    job.started_at = new Date().toISOString();
    const startMs = Date.now();

    try {
      const output = await executor(job);
      job.status = 'completed';
      job.output = output;
      job.completed_at = new Date().toISOString();
      const duration_ms = Date.now() - startMs;
      this.moveToCompleted(job);
      return { job_id: job.job_id, status: 'completed', output, duration_ms };
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completed_at = new Date().toISOString();
      const duration_ms = Date.now() - startMs;
      this.moveToCompleted(job);
      return { job_id: job.job_id, status: 'failed', error: job.error, duration_ms };
    }
  }

  /** Process all pending jobs. */
  async processAll(): Promise<WorkerJobResult[]> {
    const results: WorkerJobResult[] = [];
    while (this.pendingCount() > 0) {
      const result = await this.processNext();
      if (result) results.push(result);
    }
    return results;
  }

  /** Get the number of pending jobs. */
  pendingCount(): number {
    return this.queue.filter((j) => j.status === 'pending').length;
  }

  /** List pending jobs. */
  pending(): WorkerJob[] {
    return this.queue.filter((j) => j.status === 'pending');
  }

  /** List completed jobs (recent history). */
  history(): WorkerJob[] {
    return [...this.completed];
  }

  /** Get a job by ID. */
  getJob(jobId: string): WorkerJob | undefined {
    return this.queue.find((j) => j.job_id === jobId)
      ?? this.completed.find((j) => j.job_id === jobId);
  }

  /** Clear all pending jobs. */
  clear(): number {
    const count = this.pendingCount();
    this.queue = this.queue.filter((j) => j.status !== 'pending');
    return count;
  }

  private moveToCompleted(job: WorkerJob): void {
    this.queue = this.queue.filter((j) => j.job_id !== job.job_id);
    this.completed.push(job);
    while (this.completed.length > this.maxCompleted) {
      this.completed.shift();
    }
  }

  // ─── Disk persistence ────────────────────────────────────────

  /** Save queue state to a JSON file. */
  async saveToDisk(filePath: string): Promise<void> {
    const data: WorkerQueueSnapshot = {
      version: 1,
      saved_at: new Date().toISOString(),
      pending: this.queue.filter((j) => j.status === 'pending'),
      completed: this.completed.slice(-this.maxCompleted),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  /** Load queue state from a JSON file. Does not overwrite registered executors. */
  async loadFromDisk(filePath: string): Promise<{ loaded: number; errors: string[] }> {
    const errors: string[] = [];
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<WorkerQueueSnapshot>;
      if (data.version !== 1) {
        return { loaded: 0, errors: ['Unsupported snapshot version.'] };
      }
      let loaded = 0;
      if (Array.isArray(data.pending)) {
        for (const job of data.pending) {
          if (isWorkerJob(job) && !this.getJob(job.job_id)) {
            job.status = 'pending'; // Reset in case it was running when saved
            this.queue.push(job);
            loaded++;
          }
        }
      }
      if (Array.isArray(data.completed)) {
        for (const job of data.completed) {
          if (isWorkerJob(job) && !this.getJob(job.job_id)) {
            this.completed.push(job);
          }
        }
      }
      return { loaded, errors };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { loaded: 0, errors: [] }; // No file yet, not an error
      }
      return { loaded: 0, errors: [`Failed to load: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  /** Append a completed job to a JSONL log file for auditability. */
  async appendToLog(logPath: string, job: WorkerJob): Promise<void> {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(job) + '\n', 'utf-8');
  }
}

// ─── Snapshot types ─────────────────────────────────────────────────

export interface WorkerQueueSnapshot {
  version: 1;
  saved_at: string;
  pending: WorkerJob[];
  completed: WorkerJob[];
}

function isWorkerJob(value: unknown): value is WorkerJob {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.job_id === 'string' && typeof v.job_type === 'string' && typeof v.status === 'string';
}
