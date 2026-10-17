// Capability layers: optional structure that helps a model do better work, applied
// the same way wherever a run starts (web chat, task mode, the CLI and the
// autonomy loop that runs through it) and in experiments that A/B test them.
//
//   adapter       — fit tools and the tool-call format to the model's probed profile
//   scaffold      — plan-first working method, fewer tools and calls per turn
//   workingState  — typed plan/facts/decisions kept in every prompt (state_update tool)
//   lessons       — recall lessons from earlier runs into the prompt
//
// All change answers, so they are off unless switched on (HARNESS_ADAPTER_MODE,
// HARNESS_SCAFFOLD_MODE, HARNESS_WORKING_STATE, HARNESS_LESSONS) or chosen by an
// experiment variant. See docs/MODEL-CAPABILITY.md.

import type { LoopConfig, Tool } from '../types';
import { compileModelRequestPlan } from './adapter';
import { isCapabilityProfileFresh, loadCapabilityProfile, type CapabilityProfile } from './capabilityProfile';
import { rankToolsByRelevance, resolveScaffoldLevel, scaffoldFor, type ScaffoldLevel } from '../core/scaffolding';
import { DEFAULT_CORE_TOOLS } from '../core/toolLoading';
import { loadLessons, recallLessons, renderLessons, resolveLessonsMode } from '../learning/lessons';

export type ScaffoldMode = ScaffoldLevel | 'profile';

export interface CapabilityLayerSpec {
  /** Use the model's capability profile to pick tools and the tool-call format. */
  adapter?: boolean;
  /** A fixed scaffolding level, or 'profile' for the level the model's probe recommends. */
  scaffold?: ScaffoldMode;
  /** Typed working state in every prompt; 'tail' sends it as the last message instead. */
  workingState?: boolean | 'tail';
  /** Recall relevant lessons from earlier runs into the prompt. */
  lessons?: boolean;
}

export interface ApplyCapabilityLayersInput {
  config: LoopConfig;
  tools: Tool[];
  model: string;
  projectDir: string;
  /** The conversation's user messages, oldest first, ending with the current one. */
  userMessages: string[];
  /** HARNESS_PROMPT_LAYOUT=cache: message-dependent text goes in turnContext. */
  cacheLayout?: boolean;
  /** The run has its own planner (conductor): no plan-only first reply or step prompts. */
  externalPlanner?: boolean;
  /** For tests. */
  loadProfile?: (model: string, projectDir: string) => Promise<CapabilityProfile | null>;
}

export interface AppliedCapabilityLayers {
  /** What was applied, e.g. ['adapter: constrained-json, 5 tools', 'scaffold: medium (from probe)']. */
  applied: string[];
  /** Layers asked for that did nothing, with the reason. */
  skipped: string[];
}

const SCAFFOLD_MODES = new Set(['light', 'medium', 'heavy', 'profile']);

/** The layers switched on by environment variables (the defaults for every run). */
export function layersFromEnv(env: NodeJS.ProcessEnv = process.env): CapabilityLayerSpec {
  const spec: CapabilityLayerSpec = {};
  if (env.HARNESS_ADAPTER_MODE?.trim().toLowerCase() === 'profile') spec.adapter = true;
  const scaffold = env.HARNESS_SCAFFOLD_MODE?.trim().toLowerCase();
  if (scaffold && SCAFFOLD_MODES.has(scaffold)) spec.scaffold = scaffold as ScaffoldMode;
  if (env.HARNESS_WORKING_STATE?.trim().toLowerCase() === 'on') {
    spec.workingState = env.HARNESS_WORKING_STATE_POSITION?.trim().toLowerCase() === 'tail' ? 'tail' : true;
  }
  if (resolveLessonsMode(env.HARNESS_LESSONS) === 'recall') spec.lessons = true;
  return spec;
}

/**
 * A layer spec from untrusted JSON (an experiment variant or a request body):
 * known fields with valid values only. Returns an error message for bad input.
 */
export function parseLayerSpec(value: unknown): { spec: CapabilityLayerSpec } | { error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'layers must be an object' };
  const raw = value as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((key) => !['adapter', 'scaffold', 'workingState', 'lessons'].includes(key));
  if (unknownKeys.length > 0) return { error: `unknown layer(s): ${unknownKeys.join(', ')}` };
  const spec: CapabilityLayerSpec = {};
  for (const key of ['adapter', 'lessons'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') return { error: `layers.${key} must be true or false` };
    if (raw[key]) spec[key] = true;
  }
  if (raw.scaffold !== undefined && raw.scaffold !== false) {
    const scaffold = typeof raw.scaffold === 'string' ? raw.scaffold.trim().toLowerCase() : '';
    if (!SCAFFOLD_MODES.has(scaffold)) return { error: 'layers.scaffold must be light, medium, heavy or profile' };
    spec.scaffold = scaffold as ScaffoldMode;
  }
  if (raw.workingState !== undefined && raw.workingState !== false) {
    if (raw.workingState !== true && raw.workingState !== 'tail') return { error: "layers.workingState must be true, false or 'tail'" };
    spec.workingState = raw.workingState;
  }
  return { spec };
}

/** Short description of a spec, e.g. "adapter, scaffold=medium" or "none". */
export function describeLayerSpec(spec: CapabilityLayerSpec): string {
  const parts = [
    spec.adapter ? 'adapter' : '',
    spec.scaffold ? `scaffold=${spec.scaffold}` : '',
    spec.workingState ? (spec.workingState === 'tail' ? 'working-state=tail' : 'working-state') : '',
    spec.lessons ? 'lessons' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** Core tools in the order a limited tool set keeps them. */
const CORE_PRIORITY = ['file_read', 'bash', 'file_edit', 'grep', 'list_files', 'file_write', 'web_search', 'web_read',
  ...DEFAULT_CORE_TOOLS.filter((name) => !['file_read', 'bash', 'file_edit', 'grep', 'list_files', 'file_write', 'web_search', 'web_read'].includes(name))];

/**
 * Tool relevance over the whole conversation, so a follow-up such as "yes, do
 * it" keeps the tools the request needed; the latest message counts twice.
 */
export function rankToolsForConversation(tools: Tool[], userMessages: string[]): Map<string, number> {
  const all = rankToolsByRelevance(tools, userMessages.join('\n'));
  const latest = rankToolsByRelevance(tools, userMessages[userMessages.length - 1] ?? '');
  return new Map([...all.entries()].map(([name, score]) => [name, score + (latest.get(name) ?? 0)]));
}

/**
 * At most `limit` tools: tools marked required, then core tools in
 * CORE_PRIORITY order (half the limit, and at least three from five up, so the
 * probe's usual limits of 5 and 8 keep reading, shell and editing), then the
 * most relevant of the rest, with core tools first among equals. Keeps
 * registration order.
 */
export function selectToolsForLimit(tools: Tool[], scores: Map<string, number>, limit: number): Tool[] {
  if (limit <= 0 || tools.length <= limit) return tools;
  const required = tools.filter((tool) => tool.required);
  const chosen = new Set(required.map((tool) => tool.name));
  const room = Math.max(0, limit - required.length);
  const present = new Set(tools.map((tool) => tool.name));
  const coreQuota = limit >= 5 ? Math.max(3, Math.floor(limit / 2)) : Math.floor(limit / 2);
  for (const name of CORE_PRIORITY.filter((candidate) => present.has(candidate) && !chosen.has(candidate)).slice(0, Math.min(coreQuota, room))) {
    chosen.add(name);
  }
  const score = (name: string): number => scores.get(name) ?? 0;
  const tieRank = (name: string, index: number): number => {
    const core = CORE_PRIORITY.indexOf(name);
    return core >= 0 ? core : CORE_PRIORITY.length + index;
  };
  const rest = tools
    .map((tool, index) => ({ name: tool.name, index }))
    .filter((entry) => !chosen.has(entry.name))
    .sort((a, b) => score(b.name) - score(a.name) || tieRank(a.name, a.index) - tieRank(b.name, b.index))
    .slice(0, Math.max(0, limit - chosen.size));
  for (const entry of rest) chosen.add(entry.name);
  return tools.filter((tool) => chosen.has(tool.name));
}

/** Scaffolding wording for runs whose steps come from an external planner (the conductor). */
const STEP_ADDENDUM: Record<'medium' | 'heavy', string> = {
  medium: 'Working method: work on the current step only. Use at most 3 tool calls per turn.',
  heavy: 'Working method: work on the current step only and call exactly ONE tool per turn. When the step is done, reply with a short result.',
};
/**
 * Apply the layers in `spec` to `config` (mutated). Profile-driven layers need
 * a fresh capability profile (`harness probe`); without one they are skipped
 * and say so rather than silently doing nothing.
 */
export async function applyCapabilityLayers(spec: CapabilityLayerSpec, input: ApplyCapabilityLayersInput): Promise<AppliedCapabilityLayers> {
  const { config } = input;
  const applied: string[] = [];
  const skipped: string[] = [];
  const message = input.userMessages[input.userMessages.length - 1] ?? '';

  if (spec.workingState) {
    config.workingState = { inject: true, ...(spec.workingState === 'tail' ? { position: 'tail' as const } : {}) };
    applied.push(spec.workingState === 'tail' ? 'working state (tail)' : 'working state');
  }

  if (spec.lessons) {
    const recalled = message ? recallLessons(await loadLessons(input.projectDir), message) : [];
    if (recalled.length > 0) {
      // Recalled lessons depend on the message, so the cache layout keeps them out of the system prompt.
      if (input.cacheLayout) config.turnContext = [config.turnContext, renderLessons(recalled)].filter(Boolean).join('\n\n');
      else config.systemPrompt = `${config.systemPrompt}\n\n${renderLessons(recalled)}`;
      config.recalledLessons = recalled.map((lesson) => lesson.id);
      applied.push(`lessons: ${recalled.length} recalled`);
    }
  }

  if (!spec.adapter && !spec.scaffold) return { applied, skipped };

  const loaded = await (input.loadProfile ?? loadCapabilityProfile)(input.model, input.projectDir).catch(() => null);
  const profile = isCapabilityProfileFresh(loaded) ? loaded : null;
  const noProfile = loaded ? `the probe profile for ${input.model} is out of date; probe it again` : `${input.model} has not been probed (harness probe, or Probe model in the UI)`;
  const scores = rankToolsForConversation(input.tools, input.userMessages);

  if (spec.adapter) {
    if (profile) {
      // Choose the probe's number of tools here, so core tools are kept; the adapter then uses all of them.
      const offered = selectToolsForLimit(input.tools, scores, profile.recommended.maxToolsPerStep);
      const plan = compileModelRequestPlan({ tools: offered, systemPrompt: config.systemPrompt, profile, relevanceScores: scores });
      config.systemPrompt = plan.systemPrompt;
      config.modelPlan = { toolMode: plan.toolMode, toolNames: plan.tools.map((tool) => tool.name), ...(plan.format ? { format: plan.format } : {}) };
      applied.push(`adapter: ${plan.toolMode} tool calls, ${plan.tools.length} tools`);
    } else {
      skipped.push(`adapter: ${noProfile}`);
    }
  }

  if (spec.scaffold) {
    const level = resolveScaffoldLevel(spec.scaffold, profile?.recommended.scaffoldLevel);
    if (!level) {
      skipped.push(`scaffold: ${noProfile}`);
    } else if (level === 'light') {
      applied.push(`scaffold: light${spec.scaffold === 'profile' ? ' (from probe)' : ''} (no changes)`);
    } else {
      const scaffold = scaffoldFor(level);
      if (input.externalPlanner) {
        // The conductor plans the steps: no plan-only first reply, no plan wording,
        // and no scaffold narrowing of the tools (the adapter's probe-sized set,
        // when that layer is on, still applies to every step).
        scaffold.planTurnFirst = false;
        scaffold.stepPrompt = false;
        scaffold.systemAddendum = STEP_ADDENDUM[level];
        scaffold.maxToolsOffered = 0;
      }
      config.scaffold = scaffold;
      if (!config.modelPlan && scaffold.maxToolsOffered > 0) {
        config.modelPlan = { toolMode: 'native', toolNames: selectToolsForLimit(input.tools, scores, scaffold.maxToolsOffered).map((tool) => tool.name) };
      }
      applied.push(`scaffold: ${level}${spec.scaffold === 'profile' ? ' (from probe)' : ''}`);
    }
  }

  return { applied, skipped };
}
