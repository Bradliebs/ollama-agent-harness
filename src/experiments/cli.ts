#!/usr/bin/env node
import { loadExperimentManifest } from './resolver';
import { runExperiment } from './runner';
import { listExperimentEvents } from './persistence';
import { detailExperimentEvents, summarizeExperimentEvents, summarizeExperimentHistory } from './report';

interface CliArgs {
  manifestPath?: string;
  projectDir: string;
  baseUrl?: string;
  dryRun: boolean;
  persist: boolean;
  list: boolean;
  showExperimentId?: string;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.list || args.showExperimentId) {
    const events = await listExperimentEvents(args.projectDir, args.showExperimentId);
    console.log(JSON.stringify({
      type: 'experiment_history',
      experimentId: args.showExperimentId,
      count: events.length,
      summary: summarizeExperimentHistory(events),
      events: summarizeExperimentEvents(events),
      // --show targets one experiment: surface task-level diffs the compact
      // summary drops, so callers can see which tasks actually moved.
      ...(args.showExperimentId ? { details: detailExperimentEvents(events) } : {}),
    }, null, 2));
    return 0;
  }

  if (!args.manifestPath) {
    printUsage();
    return 1;
  }
  const manifest = await loadExperimentManifest(args.manifestPath);
  const result = await runExperiment({
    projectDir: args.projectDir,
    manifest,
    dryRun: args.dryRun,
    baseUrl: args.baseUrl,
    persist: args.persist,
  });
  if (result.type === 'dry_run') {
    console.log(JSON.stringify({
      type: result.type,
      experimentId: result.plan.manifest.id,
      selectedTaskCount: result.plan.selectedTaskCount,
      selectedTaskIds: result.plan.selectedTaskIds,
      evaluator: result.plan.evaluator,
    }, null, 2));
    return 0;
  }
  console.log(JSON.stringify({
    type: result.type,
    experimentId: result.record.manifest.id,
    runId: result.record.id,
    selectedTaskCount: result.record.evaluator.taskIds.length,
    decision: result.record.scorecard?.decision,
    promotionEvidence: result.record.promotionEvidence,
    safety: result.record.safety ? {
      baselineViolations: result.record.safety.baselineViolations,
      candidateViolations: result.record.safety.candidateViolations,
      baselineViolationRules: result.record.safety.baselineViolationRules,
      candidateViolationRules: result.record.safety.candidateViolationRules,
    } : undefined,
    passRateDelta: result.record.scorecard?.passRateDelta,
    paired: result.record.scorecard?.paired,
  }, null, 2));
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { projectDir: process.cwd(), dryRun: false, persist: true, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifestPath = argv[++index];
    else if (arg === '--project-dir') args.projectDir = argv[++index];
    else if (arg === '--base-url') args.baseUrl = argv[++index];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-persist') args.persist = false;
    else if (arg === '--list') args.list = true;
    else if (arg === '--show') args.showExperimentId = argv[++index];
    else if (arg === '--help' || arg === '-h') printUsage();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printUsage(): void {
  console.error('Usage: npm run experiment:run -- --manifest <file.json> [--dry-run] [--project-dir <dir>] [--base-url <url>] [--no-persist]');
  console.error('       npm run experiment:run -- --list [--project-dir <dir>]');
  console.error('       npm run experiment:run -- --show <experimentId> [--project-dir <dir>]');
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}