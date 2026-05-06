import * as fs from 'fs/promises';
import * as path from 'path';

export type HarnessRequest = (route: string, init?: RequestInit) => Promise<Response>;

export interface HarnessDocumentArtifact {
  id: string;
  filename?: string;
}

export interface HarnessArtifactCleanupOptions {
  projectDir: string;
  request?: HarnessRequest;
  automationJobIds?: string[];
  documents?: HarnessDocumentArtifact[];
}

export interface HarnessRuntimeStateSnapshot {
  automationJobsRaw: string | null;
  documentFiles: string[];
}

export interface HarnessRuntimeStateDiff {
  automationJobsChanged: boolean;
  addedDocuments: string[];
  removedDocuments: string[];
}

export async function cleanupHarnessArtifacts(options: HarnessArtifactCleanupOptions): Promise<void> {
  await cleanupHarnessAutomationJobs(options.request, options.automationJobIds || []);
  await cleanupHarnessDocuments(options.projectDir, options.documents || []);
}

export async function cleanupHarnessAutomationJobs(request: HarnessRequest | undefined, jobIds: string[]): Promise<void> {
  if (!request) return;

  for (const jobId of unique(jobIds)) {
    await request(`/api/automations/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }
}

export async function cleanupHarnessDocuments(projectDir: string, documents: HarnessDocumentArtifact[]): Promise<void> {
  const documentsDir = path.join(projectDir, '.harness', 'documents');
  for (const document of uniqueDocuments(documents)) {
    if (document.filename) {
      await fs.rm(path.join(documentsDir, path.basename(document.filename)), { force: true });
    }
    await fs.rm(path.join(documentsDir, `${document.id}.json`), { force: true });
  }
}

export async function snapshotHarnessRuntimeState(projectDir: string): Promise<HarnessRuntimeStateSnapshot> {
  const automationJobsPath = harnessAutomationJobsPath(projectDir);
  let automationJobsRaw: string | null;
  try {
    automationJobsRaw = await fs.readFile(automationJobsPath, 'utf-8');
  } catch {
    automationJobsRaw = null;
  }

  return {
    automationJobsRaw,
    documentFiles: await listHarnessDocumentFiles(projectDir),
  };
}

export async function seedHarnessAutomationJobsForTest(projectDir: string, jobs: unknown[] = []): Promise<void> {
  const filePath = harnessAutomationJobsPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ jobs }, null, 2), 'utf-8');
}

export async function restoreHarnessRuntimeState(projectDir: string, snapshot: HarnessRuntimeStateSnapshot): Promise<void> {
  const currentDocuments = await listHarnessDocumentFiles(projectDir);
  const expectedDocuments = new Set(snapshot.documentFiles);
  const documentsDir = path.join(projectDir, '.harness', 'documents');
  for (const added of currentDocuments.filter((filename) => !expectedDocuments.has(filename))) {
    await fs.rm(path.join(documentsDir, added), { force: true });
  }

  const jobsPath = harnessAutomationJobsPath(projectDir);
  if (snapshot.automationJobsRaw === null) {
    await fs.rm(jobsPath, { force: true });
  } else {
    await fs.mkdir(path.dirname(jobsPath), { recursive: true });
    await fs.writeFile(jobsPath, snapshot.automationJobsRaw, 'utf-8');
  }
}

export async function diffHarnessRuntimeState(projectDir: string, snapshot: HarnessRuntimeStateSnapshot): Promise<HarnessRuntimeStateDiff> {
  const current = await snapshotHarnessRuntimeState(projectDir);
  const expectedDocuments = new Set(snapshot.documentFiles);
  const currentDocuments = new Set(current.documentFiles);
  return {
    automationJobsChanged: current.automationJobsRaw !== snapshot.automationJobsRaw,
    addedDocuments: current.documentFiles.filter((filename) => !expectedDocuments.has(filename)),
    removedDocuments: snapshot.documentFiles.filter((filename) => !currentDocuments.has(filename)),
  };
}

async function listHarnessDocumentFiles(projectDir: string): Promise<string[]> {
  try {
    const documentsDir = path.join(projectDir, '.harness', 'documents');
    const entries = await fs.readdir(documentsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function harnessAutomationJobsPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'automations', 'jobs.json');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueDocuments(documents: HarnessDocumentArtifact[]): HarnessDocumentArtifact[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    const key = `${document.id}:${document.filename || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(document.id);
  });
}
