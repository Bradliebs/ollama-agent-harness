import type { Message } from 'ollama';
import type { ChatResult, IChatClient } from '../core/chatClient';
import { orchestrate, type BranchVerifier, type WorkstreamTask } from './orchestrator';

// Minimal fake client: every subagent turn returns a fixed reply (no tool calls),
// so runSubagent terminates with non-empty output and the branch "completes".
class FakeClient implements IChatClient {
  constructor(private reply: string) {}
  async chatOnce(_messages: Message[]): Promise<ChatResult> {
    return {
      message: { role: 'assistant', content: this.reply },
      usage: { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 },
    };
  }
  async chat(messages: Message[]): Promise<ChatResult> { return this.chatOnce(messages); }
  async *chatStream(): AsyncGenerator<{ content: string; done: boolean }> { yield { content: '', done: true }; }
  async listModels(): Promise<string[]> { return []; }
  async getContextWindow(): Promise<number | null> { return null; }
  async healthCheck(): Promise<{ ok: boolean }> { return { ok: true }; }
  getModel(): string { return 'fake'; }
}

const tasks: WorkstreamTask[] = [
  { id: 'a', role: 'summariser', prompt: 'summarise a' },
  { id: 'b', role: 'summariser', prompt: 'summarise b' },
];

describe('orchestrate merged_output', () => {
  it('fills merged_output via the completion-based merge when no verifier is given', async () => {
    const client = new FakeClient('done-output');
    const res = await orchestrate(tasks, client, []);
    expect(res.merged_output).toContain('done-output');
    expect(res.merged_output).not.toContain('Excluded');
  });

  it('fills merged_output via the verified merge when a verifier proves both branches', async () => {
    const client = new FakeClient('done-output');
    const verify: BranchVerifier = async () => 'pass';
    const res = await orchestrate(tasks, client, [], undefined, verify);
    expect(res.merged_output).toContain('done-output');
    expect(res.merged_output).not.toContain('Excluded');
    expect(res.results.every((r) => r.verification === 'pass')).toBe(true);
  });

  it('excludes a branch the verifier rejects from the verified merge', async () => {
    const client = new FakeClient('done-output');
    const verify: BranchVerifier = async (r) => (r.id === 'b' ? 'fail' : 'pass');
    const res = await orchestrate(tasks, client, [], undefined, verify);
    expect(res.merged_output).toContain('Excluded (unverified)');
    expect(res.merged_output).toMatch(/b: verification failed/);
  });
});
