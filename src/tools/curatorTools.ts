import type { Tool, ToolResult } from '../types';
import { runDeterministicPhase, type CuratorConfig, DEFAULT_CURATOR_CONFIG } from '../curator/curator';

let projectDir = process.cwd();
let getCuratorConfig: () => CuratorConfig = () => ({ ...DEFAULT_CURATOR_CONFIG });
let getKillSwitch: () => boolean = () => false;

export function setCuratorToolRuntime(options: {
  projectDir?: string;
  getConfig?: () => CuratorConfig;
  isKillSwitchActive?: () => boolean;
}): void {
  if (options.projectDir) projectDir = options.projectDir;
  if (options.getConfig) getCuratorConfig = options.getConfig;
  if (options.isKillSwitchActive) getKillSwitch = options.isKillSwitchActive;
}

/**
 * curator_preview — read-only tool that runs the curator's deterministic
 * phase in dry-run mode and returns the would-archive list as text. Safe to
 * call from a workflow because no files are mutated.
 */
export const CuratorPreviewTool: Tool = {
  name: 'curator_preview',
  description: 'Preview which skills the curator would archive. Read-only, no files are changed. Returns counts and per-skill reasoning.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    try {
      const summary = await runDeterministicPhase(projectDir, getCuratorConfig(), { isKillSwitchActive: getKillSwitch }, { dryRun: true });
      const wouldArchive = summary.staleCandidates.filter((c) => c.kind === 'archive');
      const skipped = summary.staleCandidates.filter((c) => c.kind !== 'archive');
      const lines: string[] = [];
      lines.push(`Curator preview at ${summary.startedAt}`);
      lines.push(`${summary.staleCandidates.length} candidate(s) total, ${wouldArchive.length} would be archived.`);
      if (wouldArchive.length > 0) {
        lines.push('');
        lines.push('Would archive:');
        for (const action of wouldArchive) {
          lines.push(`  - ${action.skill}: ${action.reason}`);
        }
      }
      if (skipped.length > 0) {
        lines.push('');
        lines.push('Skipped:');
        for (const action of skipped.slice(0, 20)) {
          lines.push(`  - ${action.skill} (${action.kind}): ${action.reason}`);
        }
      }
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Curator preview failed: ${msg}`, error: msg };
    }
  },
};
