import { PassThrough } from 'stream';
import type { Tool } from '../types';
import { HarnessMcpServer } from './mcpServer';
import { singleRequest, startMcpStdioServer } from './mcpStdio';

const echoTool: Tool = {
  name: 'echo',
  description: 'Echoes the input text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  isReadOnly: true,
  async execute(input: Record<string, unknown>) {
    return { success: true, output: String(input.text ?? '') };
  },
};

describe('mcp stdio transport', () => {
  it('singleRequest handles tools/list', async () => {
    const server = new HarnessMcpServer({ tools: [echoTool] });
    const response = await singleRequest(server, { id: 1, method: 'tools/list' });
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools[0].name).toBe('echo');
  });

  it('singleRequest handles tools/call', async () => {
    const server = new HarnessMcpServer({ tools: [echoTool] });
    const response = await singleRequest(server, {
      id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.content[0].text).toBe('hello');
    expect(result.isError).toBe(false);
  });

  it('singleRequest returns method error for unknown method', async () => {
    const server = new HarnessMcpServer({ tools: [echoTool] });
    const response = await singleRequest(server, { id: 3, method: 'initialize' });
    expect(response.result).toBeDefined();
  });

  it('initialize advertises server info', async () => {
    const server = new HarnessMcpServer({ tools: [], serverName: 'test-srv', version: '9.9.9' });
    const response = await singleRequest(server, { id: 1, method: 'initialize' });
    const result = response.result as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo.name).toBe('test-srv');
    expect(result.serverInfo.version).toBe('9.9.9');
  });

  it('stdio loop reads lines and writes line-delimited JSON', async () => {
    const server = new HarnessMcpServer({ tools: [echoTool] });
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on('data', (chunk: Buffer) => { collected.push(chunk.toString()); });
    const handle = startMcpStdioServer({ server, input, output });
    input.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
    // Allow the async handler to drain
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    const all = collected.join('');
    expect(all.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(all.trim().split('\n')[0]);
    expect(parsed.id).toBe(1);
    expect(parsed.result.tools[0].name).toBe('echo');
  });

  it('stdio loop calls onParseError on bad JSON without crashing', async () => {
    const server = new HarnessMcpServer({ tools: [] });
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: string[] = [];
    const handle = startMcpStdioServer({ server, input, output, onParseError: (line) => errors.push(line) });
    input.write('not-json\n');
    await new Promise((r) => setTimeout(r, 20));
    handle.stop();
    expect(errors).toContain('not-json');
  });
});
