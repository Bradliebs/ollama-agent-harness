// Versioned prompts — version-controlled system prompts with registry,
// rollback, diffing, and Markdown history rendering.
//
// Each named prompt (e.g. "main-system-prompt") has its own registry stored
// at <projectDir>/.harness/prompts/<name>.json. Versions are append-only
// and auto-incremented.

import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

export interface PromptVersion {
  /** Auto-incremented version number (1, 2, 3...) */
  version: number;
  /** Human-readable label, e.g. "add-safety-rules" or "v2-concise" */
  label: string;
  /** The full system prompt text */
  content: string;
  /** ISO timestamp when this version was saved */
  createdAt: string;
  /** Optional author name */
  author?: string;
  /** Optional description of what changed */
  changelog?: string;
  /** Optional tags */
  tags?: string[];
}

export interface PromptDiff {
  fromVersion: number;
  toVersion: number;
  /** Lines added (prefixed with +) */
  added: string[];
  /** Lines removed (prefixed with -) */
  removed: string[];
  /** Total number of changed lines */
  totalChanges: number;
  /** Similarity ratio 0.0–1.0 between the two versions */
  similarity: number;
}

export interface PromptRegistry {
  /** The prompt name / identifier, e.g. "main-system-prompt" or "coding-agent" */
  name: string;
  /** All versions, ordered by version number ascending */
  versions: PromptVersion[];
  /** Which version number is currently active */
  activeVersion: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '-');
}

function promptsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'prompts');
}

function registryPath(projectDir: string, name: string): string {
  return path.join(promptsDir(projectDir), `${sanitizeName(name)}.json`);
}

// ─── Pure helpers ───────────────────────────────────────────────────

export function getVersion(
  registry: PromptRegistry,
  version: number,
): PromptVersion | undefined {
  return registry.versions.find((v) => v.version === version);
}

export function diffVersions(
  registry: PromptRegistry,
  fromVersion: number,
  toVersion: number,
): PromptDiff | undefined {
  const from = getVersion(registry, fromVersion);
  const to = getVersion(registry, toVersion);
  if (!from || !to) return undefined;

  const fromLines = from.content.split('\n');
  const toLines = to.content.split('\n');

  const fromSet = new Set(fromLines);
  const toSet = new Set(toLines);

  const removed = fromLines.filter((l) => !toSet.has(l)).map((l) => `-${l}`);
  const added = toLines.filter((l) => !fromSet.has(l)).map((l) => `+${l}`);

  const totalChanges = added.length + removed.length;
  const maxLines = Math.max(fromLines.length, toLines.length, 1);
  const similarity = 1 - totalChanges / maxLines;

  return {
    fromVersion,
    toVersion,
    added,
    removed,
    totalChanges,
    similarity: Math.max(0, Math.min(1, similarity)),
  };
}

export function renderPromptHistory(registry: PromptRegistry): string {
  const lines: string[] = [`# Prompt History: ${registry.name}`, ''];
  for (const v of registry.versions) {
    const active = v.version === registry.activeVersion ? ' **(active)**' : '';
    lines.push(`## v${v.version} — ${v.label}${active}`);
    lines.push(`- **Date:** ${v.createdAt}`);
    if (v.author) lines.push(`- **Author:** ${v.author}`);
    if (v.changelog) lines.push(`- **Changelog:** ${v.changelog}`);
    if (v.tags && v.tags.length > 0) lines.push(`- **Tags:** ${v.tags.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Persistence ────────────────────────────────────────────────────

export async function loadRegistry(
  projectDir: string,
  name: string,
): Promise<PromptRegistry | undefined> {
  const filePath = registryPath(projectDir, name);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as PromptRegistry;
  } catch {
    return undefined;
  }
}

async function saveRegistry(
  projectDir: string,
  registry: PromptRegistry,
): Promise<void> {
  const dir = promptsDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = registryPath(projectDir, registry.name);
  await fs.writeFile(filePath, JSON.stringify(registry, null, 2), 'utf-8');
}

export async function listRegistries(projectDir: string): Promise<string[]> {
  const dir = promptsDir(projectDir);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function savePromptVersion(
  projectDir: string,
  name: string,
  content: string,
  opts?: {
    label?: string;
    author?: string;
    changelog?: string;
    tags?: string[];
  },
): Promise<PromptVersion> {
  const existing = await loadRegistry(projectDir, name);
  const registry: PromptRegistry = existing ?? {
    name,
    versions: [],
    activeVersion: 0,
  };

  const nextVersion =
    registry.versions.length > 0
      ? registry.versions[registry.versions.length - 1].version + 1
      : 1;

  const version: PromptVersion = {
    version: nextVersion,
    label: opts?.label ?? `v${nextVersion}`,
    content,
    createdAt: new Date().toISOString(),
    ...(opts?.author !== undefined && { author: opts.author }),
    ...(opts?.changelog !== undefined && { changelog: opts.changelog }),
    ...(opts?.tags !== undefined && { tags: opts.tags }),
  };

  registry.versions.push(version);
  registry.activeVersion = nextVersion;

  await saveRegistry(projectDir, registry);
  return version;
}

export async function getActivePrompt(
  projectDir: string,
  name: string,
): Promise<PromptVersion | undefined> {
  const registry = await loadRegistry(projectDir, name);
  if (!registry) return undefined;
  return getVersion(registry, registry.activeVersion);
}

export async function setActiveVersion(
  projectDir: string,
  name: string,
  version: number,
): Promise<boolean> {
  const registry = await loadRegistry(projectDir, name);
  if (!registry) return false;
  if (!getVersion(registry, version)) return false;
  registry.activeVersion = version;
  await saveRegistry(projectDir, registry);
  return true;
}

export async function rollback(
  projectDir: string,
  name: string,
): Promise<PromptVersion | undefined> {
  const registry = await loadRegistry(projectDir, name);
  if (!registry) return undefined;
  const prev = registry.activeVersion - 1;
  const prevVersion = getVersion(registry, prev);
  if (!prevVersion) return undefined;
  registry.activeVersion = prev;
  await saveRegistry(projectDir, registry);
  return prevVersion;
}
