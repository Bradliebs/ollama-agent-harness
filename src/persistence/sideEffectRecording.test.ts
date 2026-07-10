import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolDispatcher } from '../tools/dispatcher';
import { describeFileMutation, describeNotification, prepareSideEffectRecording } from './sideEffectRecording';
import { listSideEffects } from './sideEffectLedger';
import { revertRun } from './runReverter';
import type { Tool, ToolResult } from '../types';

// A tool that performs the SAME fs mutation a real file tool would, so the
// dispatcher's record-after-success wiring can be exercised end-to-end. Paths in
// `input.path` are resolved against projectDir, mirroring real confinement.
function fileTool(name: string, projectDir: string, op: 'write' | 'delete'): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    isReadOnly: false,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const abs = path.join(projectDir, input.path as string);
      if (op === 'write') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, (input.content as string) ?? '', 'utf-8');
      } else {
        await fs.unlink(abs);
      }
      return { success: true, output: `${name} ok` };
    },
  };
}

// A notification tool stub: succeeds without IO, mirroring slack_notify /
// telegram_notify which take { title, body } and perform an irreversible send.
function notifyTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    isReadOnly: false,
    execute: async (): Promise<ToolResult> => ({ success: true, output: `${name} sent` }),
  };
}

describe('sideEffectRecording', () => {
  describe('describeFileMutation (pure)', () => {
    it('classifies the write tools and the delete tool', () => {
      expect(describeFileMutation('file_write', { path: 'a.txt' })).toEqual({ kind: 'write', path: 'a.txt' });
      expect(describeFileMutation('file_edit', { path: 'a.txt' })).toEqual({ kind: 'write', path: 'a.txt' });
      expect(describeFileMutation('file_delete', { path: 'a.txt' })).toEqual({ kind: 'delete', path: 'a.txt' });
    });

    it('returns null for untracked tools or a missing path', () => {
      expect(describeFileMutation('bash', { command: 'ls' })).toBeNull();
      expect(describeFileMutation('file_move', { path: 'a.txt' })).toBeNull();
      expect(describeFileMutation('file_write', {})).toBeNull();
      expect(describeFileMutation('file_write', { path: '' })).toBeNull();
    });
  });

  describe('describeNotification (pure)', () => {
    it('classifies the notify tools with a channel and headline', () => {
      expect(describeNotification('slack_notify', { title: 'Done', body: 'b' })).toEqual({ channel: 'Slack', headline: 'Done' });
      expect(describeNotification('telegram_notify', { title: 'Hi', body: 'b' })).toEqual({ channel: 'Telegram', headline: 'Hi' });
    });

    it('falls back to body, then a placeholder, for the headline', () => {
      expect(describeNotification('slack_notify', { body: 'just body' })).toEqual({ channel: 'Slack', headline: 'just body' });
      expect(describeNotification('slack_notify', {})).toEqual({ channel: 'Slack', headline: '(no content)' });
    });

    it('returns null for non-notification tools', () => {
      expect(describeNotification('file_write', { title: 't' })).toBeNull();
      expect(describeNotification('bash', { command: 'ls' })).toBeNull();
    });
  });

  describe('prepareSideEffectRecording (pre-image capture)', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-serec-'));
    });
    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns null for an untracked call', async () => {
      const commit = await prepareSideEffectRecording({ projectDir: tmpDir, runId: 'r' }, 'bash', { command: 'ls' });
      expect(commit).toBeNull();
    });

    it('returns null for deleting an absent file (nothing happened)', async () => {
      const commit = await prepareSideEffectRecording({ projectDir: tmpDir, runId: 'r' }, 'file_delete', { path: 'ghost.txt' });
      expect(commit).toBeNull();
    });
  });

  describe('dispatcher integration (end-to-end undo)', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-serec-e2e-'));
    });
    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('records writes through the dispatcher and reverts the whole run as a unit', async () => {
      await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'original', 'utf-8');

      const dispatcher = new ToolDispatcher([
        fileTool('file_write', tmpDir, 'write'),
        fileTool('file_delete', tmpDir, 'delete'),
      ]);
      const options = { sideEffectRecorder: { projectDir: tmpDir, runId: 'run-1' } };

      await dispatcher.dispatch([{ name: 'file_write', input: { path: 'existing.txt', content: 'changed' } }], undefined, undefined, options);
      await dispatcher.dispatch([{ name: 'file_write', input: { path: 'created.txt', content: 'fresh' } }], undefined, undefined, options);
      await dispatcher.dispatch([{ name: 'file_delete', input: { path: 'existing.txt' } }], undefined, undefined, options);

      const effects = await listSideEffects(tmpDir, 'run-1');
      expect(effects.map((e) => e.kind)).toEqual(['file_modify', 'file_create', 'file_delete']);

      const result = await revertRun(tmpDir, 'run-1');
      expect(result.reverted).toHaveLength(3);
      expect(result.failed).toEqual([]);
      // existing.txt was modified then deleted; undo unwinds both -> back to original.
      expect(await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf-8')).toBe('original');
      // created.txt is removed by its create reversal.
      await expect(fs.access(path.join(tmpDir, 'created.txt'))).rejects.toThrow();
    });

    it('records a notification as irreversible and surfaces it on undo alongside reverted files', async () => {
      const dispatcher = new ToolDispatcher([
        fileTool('file_write', tmpDir, 'write'),
        notifyTool('slack_notify'),
      ]);
      const options = { sideEffectRecorder: { projectDir: tmpDir, runId: 'run-n' } };

      await dispatcher.dispatch([{ name: 'file_write', input: { path: 'report.txt', content: 'data' } }], undefined, undefined, options);
      await dispatcher.dispatch([{ name: 'slack_notify', input: { title: 'Report ready', body: 'see attached' } }], undefined, undefined, options);

      const effects = await listSideEffects(tmpDir, 'run-n');
      expect(effects.map((e) => e.kind)).toEqual(['file_create', 'notification']);

      const result = await revertRun(tmpDir, 'run-n');
      // The file is reverted; the notification is surfaced as irreversible, never failed.
      expect(result.reverted.map((e) => e.kind)).toEqual(['file_create']);
      expect(result.irreversible.map((e) => e.kind)).toEqual(['notification']);
      expect(result.failed).toEqual([]);
      await expect(fs.access(path.join(tmpDir, 'report.txt'))).rejects.toThrow();
    });

    it('does not record a notification when the send fails', async () => {
      const failingNotify: Tool = {
        name: 'slack_notify',
        description: 'slack_notify',
        parameters: { type: 'object', properties: {} },
        isReadOnly: false,
        execute: async () => ({ success: false, output: 'nope', error: 'boom' }),
      };
      const dispatcher = new ToolDispatcher([failingNotify]);
      await dispatcher.dispatch(
        [{ name: 'slack_notify', input: { title: 't', body: 'b' } }],
        undefined,
        undefined,
        { sideEffectRecorder: { projectDir: tmpDir, runId: 'run-n' } },
      );
      expect(await listSideEffects(tmpDir, 'run-n')).toEqual([]);
    });

    it('records nothing when no recorder is supplied', async () => {
      const dispatcher = new ToolDispatcher([fileTool('file_write', tmpDir, 'write')]);
      await dispatcher.dispatch([{ name: 'file_write', input: { path: 'a.txt', content: 'x' } }]);
      expect(await listSideEffects(tmpDir, 'run-1')).toEqual([]);
    });

    it('does not record when the tool reports failure', async () => {
      const failing: Tool = {
        name: 'file_write',
        description: 'file_write',
        parameters: { type: 'object', properties: {} },
        isReadOnly: false,
        execute: async () => ({ success: false, output: 'nope', error: 'boom' }),
      };
      const dispatcher = new ToolDispatcher([failing]);
      await dispatcher.dispatch(
        [{ name: 'file_write', input: { path: 'a.txt', content: 'x' } }],
        undefined,
        undefined,
        { sideEffectRecorder: { projectDir: tmpDir, runId: 'run-1' } },
      );
      expect(await listSideEffects(tmpDir, 'run-1')).toEqual([]);
    });
  });
});
