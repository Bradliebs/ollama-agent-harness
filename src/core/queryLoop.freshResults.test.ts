import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { queryLoop } from './queryLoop';
import { FileReadTool } from '../tools/fileTools';
import { getProjectRoot, setProjectRoot } from '../tools/pathResolution';

jest.mock('../learning/engine', () => ({ trackToolUsage: jest.fn().mockResolvedValue(undefined) }));

describe('queryLoop fresh tool results', () => {
  const previousRoot = getProjectRoot();
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-results-'));
    setProjectRoot(dir);
  });

  afterAll(() => {
    setProjectRoot(previousRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the model the whole file it just read, not a 4k head and tail', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i}; // line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'big.ts'), lines.join('\n'));
    const seen: Message[][] = [];
    const chat = jest.fn(async (messages: Message[]) => {
      seen.push(messages.map((m) => ({ ...m })));
      return seen.length === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: { path: 'big.ts', max_bytes: 20_000 } } }] } as Message }
        : { message: { role: 'assistant', content: 'done' } as Message };
    });
    for await (const event of queryLoop(
      { model: 'm', systemPrompt: 'system', maxTurns: 3, context: { maxTokens: 32_000 }, supervisor: false },
      { client: { chat } as never, tools: [FileReadTool] },
      [{ role: 'user', content: 'read big.ts' }],
    )) void event;

    const toolMessage = seen[1].find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe(lines.join('\n'));
  });
});
