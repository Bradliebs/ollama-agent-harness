// Default factories for the Lead Agent — wire the provider-free seams in
// leadAgent.ts to the real chat client, the parallel orchestrator, and the
// toolchain verifier. Kept separate from the core so the core stays testable
// without a model or a filesystem.

import * as path from 'path';
import * as fs from 'fs/promises';
import type { IChatClient } from './chatClient';
import type { Tool } from '../types/tool';
import {
  orchestrate,
  verifyCodeBranch,
  type WorkstreamTask,
  type AgentRole,
} from '../agents/orchestrator';
import { verifyCode } from './doneStateVerifier';
import type { Decomposer, OrchestrateFn, OverallVerifier, PersistFn } from './leadAgent';

// ─── Decomposer ─────────────────────────────────────────────────────

const KNOWN_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'planner', 'researcher', 'coder', 'debugger', 'reviewer', 'critic',
  'summariser', 'tool_executor', 'service_operator', 'safety_checker', 'context_compressor',
]);

export const DECOMPOSER_SYSTEM_PROMPT = [
  'You are the lead planning agent for an autonomous multi-agent system. Break the',
  "user's task into a small graph of sub-agent workstreams that can run in parallel.",
  '',
  'Each workstream is executed by a specialised sub-agent. Available roles:',
  '  coder, debugger, researcher, reviewer, critic, planner, summariser,',
  '  tool_executor, service_operator, safety_checker, context_compressor.',
  '',
  'Rules:',
  '- 1 to 6 workstreams. Fewer is better. Prefer parallelism, but use "dependsOn"',
  '  for work that truly must wait for another workstream (e.g. review depends on code).',
  '- Give each workstream a short unique "id" (kebab-case) and a concrete "prompt"',
  '  telling the sub-agent exactly what to produce.',
  '- Pick the most specific role for the work. Use "coder" for writing/editing code.',
  '',
  'Respond with ONLY a JSON object, no prose, no markdown fences:',
  '{"workstreams":[{"id":"impl","role":"coder","prompt":"...","dependsOn":[]}]}',
].join('\n');

/**
 * LLM-backed decomposer. On attempt 1 it plans; on later attempts it is given
 * the prior failure reasons and asked to replan around them. Falls back to a
 * single coder workstream (the whole task) when no usable JSON is produced, so
 * the lead agent degrades to a single sub-agent run rather than dead-ending.
 */
export function createLlmDecomposer(client: IChatClient): Decomposer {
  return async (task, attempt, priorFailures): Promise<WorkstreamTask[]> => {
    const userContent = attempt <= 1 || priorFailures.length === 0
      ? task
      : [
          `Task: ${task}`,
          '',
          'Your previous attempt did NOT pass verification. Replan to fix these problems:',
          ...priorFailures.map((f) => `- ${f}`),
          '',
          'Produce a revised workstream graph that specifically addresses the failures above.',
        ].join('\n');
    try {
      const res = await client.chatOnce([
        { role: 'system', content: DECOMPOSER_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ]);
      const content = typeof res.message.content === 'string' ? res.message.content : '';
      return parseWorkstreams(content, task);
    } catch {
      return [singleCoderWorkstream(task)];
    }
  };
}

/**
 * Parse a decomposer model response into validated workstream tasks. Tolerant of
 * markdown fences and surrounding prose. Falls back to a single coder workstream
 * when nothing usable is found.
 */
export function parseWorkstreams(text: string, task: string): WorkstreamTask[] {
  const raw = extractJsonObject(text);
  if (raw) {
    try {
      const obj = JSON.parse(raw) as { workstreams?: unknown };
      const arr = Array.isArray(obj.workstreams) ? obj.workstreams : [];
      const tasks: WorkstreamTask[] = [];
      const usedIds = new Set<string>();
      for (const entry of arr) {
        const e = entry as Record<string, unknown>;
        const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
        if (!prompt) continue;
        const role: AgentRole = KNOWN_ROLES.has(e.role as AgentRole) ? (e.role as AgentRole) : 'coder';
        let id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `ws-${tasks.length + 1}`;
        while (usedIds.has(id)) id = `${id}-${tasks.length + 1}`;
        usedIds.add(id);
        const dependsOn = Array.isArray(e.dependsOn)
          ? e.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
          : undefined;
        tasks.push({ id, role, prompt, dependsOn });
      }
      // Drop dependencies that point at unknown ids so orchestrate() never
      // deadlocks on a hallucinated dependency.
      const valid = new Set(tasks.map((t) => t.id));
      for (const t of tasks) {
        if (t.dependsOn) t.dependsOn = t.dependsOn.filter((d) => valid.has(d) && d !== t.id);
      }
      if (tasks.length > 0) return tasks;
    } catch {
      // fall through to single-workstream fallback
    }
  }
  return [singleCoderWorkstream(task)];
}

function singleCoderWorkstream(task: string): WorkstreamTask {
  return { id: 'impl', role: 'coder', prompt: task };
}

/** Extract the first balanced `{...}` block from arbitrary model text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ─── Orchestrate seam ───────────────────────────────────────────────

/**
 * Wire the lead agent's orchestrate seam to the real parallel orchestrator,
 * verifying code-producing branches against `projectDir`.
 */
export function createOrchestrateFn(
  client: IChatClient,
  tools: Tool[],
  projectDir?: string,
): OrchestrateFn {
  return (tasks) => orchestrate(tasks, client, tools, projectDir, verifyCodeBranch);
}

// ─── Overall verifier ───────────────────────────────────────────────

/**
 * Overall acceptance verifier backed by the real toolchain (tsc / lint / tests).
 * Treats `fail` as not-passed; `warn` / `skip` / `pass` count as passed so a
 * repo whose suite merely times out does not trap the lead agent in an
 * unwinnable replan loop. When no projectDir is available it cannot judge, and
 * conservatively reports passed so a non-code task is not blocked forever.
 */
export function createToolchainVerifier(projectDir?: string, opts?: { quick?: boolean }): OverallVerifier {
  return async (): Promise<{ passed: boolean; detail?: string }> => {
    if (!projectDir) return { passed: true };
    const result = await verifyCode({ projectDir, quick: opts?.quick ?? true });
    if (result.overall !== 'fail') return { passed: true };
    const failed = result.checks.filter((c) => c.status === 'fail');
    const detail = failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('; ').slice(0, 1500);
    return { passed: false, detail: detail || 'toolchain verification failed' };
  };
}

// ─── Persistence ────────────────────────────────────────────────────

/** Write lead-agent artifacts under `<projectDir>/.harness/lead/<runId>/`. */
export function createLeadPersist(projectDir: string, runId: string): PersistFn {
  return async (name, data): Promise<void> => {
    try {
      const dir = path.join(projectDir, '.harness', 'lead', runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // persistence is best-effort; never fail a run over it
    }
  };
}
