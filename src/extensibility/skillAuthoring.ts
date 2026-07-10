import * as path from 'path';
import { promises as fs } from 'fs';

import { recordSwallowed } from '../observability/silentFailureSink';

// Shared skill-authoring primitives used by BOTH the HTTP skill routes
// (src/web/skillRoutes.ts) and the agent's create_skill tool
// (src/tools/skillTools.ts). Keeping these in one place ensures a skill
// authored by the model meets the same bar (escaped frontmatter, length
// caps, and history snapshots) as one created through the UI/REST API.

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

function yamlList(key: string, values: string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)];
}

export function buildRuntimeSkillFile(input: {
  name: string;
  description: string;
  domain: string;
  triggers: string[];
  whenToUse: string;
  requiredTools: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  body: string;
}): string {
  const lines = [
    '---',
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    `domain: ${yamlScalar(input.domain)}`,
    ...yamlList('triggers', input.triggers),
  ];
  if (input.whenToUse) lines.push(`when_to_use: ${yamlScalar(input.whenToUse)}`);
  if (input.requiredTools.length > 0) lines.push(...yamlList('required_tools', input.requiredTools));
  if (input.riskLevel) lines.push(`risk_level: ${yamlScalar(input.riskLevel)}`);
  lines.push('---', '', input.body);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function sanitizeSkillText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).replace(/[\r\n]+/g, ' ').slice(0, maxLength);
}

export function sanitizeSkillBody(value: unknown): string {
  const body = typeof value === 'string' && value.trim()
    ? value.trim()
    : '# Instructions\n\nDescribe when to use this skill, the steps to follow, and how to validate the result.';
  return body.slice(0, 20_000);
}

export function sanitizeSkillList(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of source) {
    const text = String(item ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, maxLength);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

export function sanitizeSkillRiskLevel(value: unknown): 'low' | 'medium' | 'high' | undefined {
  const risk = String(value ?? '').trim().toLowerCase();
  return risk === 'low' || risk === 'medium' || risk === 'high' ? risk : undefined;
}

/**
 * Snapshot the previous SKILL.md content into
 * `<skillsDir>/_history/<name>/<ISO>.md` (keeping the newest 20) before it is
 * overwritten, so a clobbered skill can be recovered. Best-effort: history
 * writes never block or fail the primary save.
 */
export async function snapshotSkillHistory(skillsDir: string, skillName: string, previousContent: string): Promise<void> {
  try {
    const dir = path.join(skillsDir, '_history', skillName);
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${ts}.md`), previousContent, 'utf-8');
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
    while (files.length > 20) {
      const oldest = files.shift();
      if (oldest) await fs.unlink(path.join(dir, oldest)).catch((err) => recordSwallowed('fs.unlink', err));
    }
  } catch {
    // History writes are best-effort; never block the primary save.
  }
}
