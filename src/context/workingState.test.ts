import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Message } from 'ollama';
import { WorkingStateStore, WORKING_STATE_HEADER, createStateUpdateTool, injectWorkingState, parsePlanText, shellTouchesProtected } from './workingState';
import { queryLoop } from '../core/queryLoop';
import { RunLog, readRunEvents, reconstructModelRequests } from '../persistence/runLog';
import { FileWriteTool } from '../tools/fileTools';
import { buildTaskContract } from '../core/taskContractBuilder';
import { getProjectRoot, setProjectRoot } from '../tools/pathResolution';
import type { LoopConfig, LoopEvent, Tool } from '../types';

jest.mock('../learning/engine', () => ({
  trackToolUsage: jest.fn().mockResolvedValue(undefined),
}));

describe('WorkingStateStore', () => {
  it('applies updates, renders them, and only tightens protections', async () => {
    const store = new WorkingStateStore({ protectedPaths: ['.env'] });
    expect(store.revision).toBe(0);
    const tool = createStateUpdateTool(store);
    const result = await tool.execute({
      plan: ['search prices', 'compare', 'answer'],
      completeSteps: [1],
      addFacts: [{ claim: 'X100VI costs £1,669 new', source: 'idealo.co.uk' }],
      addDecisions: [{ what: 'use UK prices only', why: 'user is in the UK' }],
      addQuestions: ['grey import warranty?'],
      protectPaths: ['secrets/'],
    });
    expect(result.output).toMatch(/plan set \(3 steps\).*step 1 done.*fact: X100VI/);
    const rendered = store.render();
    expect(rendered.startsWith(WORKING_STATE_HEADER)).toBe(true);
    expect(rendered).toContain('1. [x] search prices');
    expect(rendered).toContain('- use UK prices only (because user is in the UK)');
    expect(rendered).toContain('Protected paths (never modify): .env, secrets/');
    expect(store.revision).toBeGreaterThan(0);
    // There is no removal operation for protections or invariants.
    await tool.execute({ protectPaths: [] });
    expect(store.state.protectedPaths).toEqual(['.env', 'secrets/']);
    await tool.execute({ resolveQuestions: ['warranty'] });
    expect(store.state.openQuestions).toEqual([]);
  });

  it('matches protected patterns: exact files, directories and ** globs', () => {
    const root = path.resolve('/work/app');
    const store = new WorkingStateStore({ protectedPaths: ['.env', 'secrets/', 'src/config/**', 'package.json'] });
    const at = (rel: string) => store.protectedMatch(path.join(root, rel), root);
    expect(at('.env')).toBe('.env');
    expect(at('services/api/.env')).toBe('.env');
    expect(at('secrets/key.pem')).toBe('secrets/');
    expect(at('src/config/prod/db.json')).toBe('src/config/**');
    expect(at('package.json')).toBe('package.json');
    expect(at('src/app.ts')).toBeNull();
    expect(at('.env.example')).toBeNull();
  });

  it('flags only writing shell commands that name a protected path', () => {
    const store = new WorkingStateStore({ protectedPaths: ['.env', 'secrets/'] });
    expect(shellTouchesProtected('echo KEY=1 >> .env', store)).toBe('.env');
    expect(shellTouchesProtected('rm -rf secrets/old', store)).toBe('secrets/');
    expect(shellTouchesProtected('cat .env', store)).toBeNull();
    expect(shellTouchesProtected('npm test > out.txt', store)).toBeNull();
  });

  it('parses a plan from text and injects state into the system prompt only', () => {
    expect(parsePlanText('1. search prices 2. read reviews 3. answer')).toEqual(['search prices', 'read reviews', 'answer']);
    expect(parsePlanText('- a thing\n- another thing')).toEqual(['a thing', 'another thing']);
    const messages: Message[] = [{ role: 'system', content: 'base' }, { role: 'user', content: 'q' }];
    expect(injectWorkingState(messages, 'STATE')).toEqual([{ role: 'system', content: 'base\n\nSTATE' }, { role: 'user', content: 'q' }]);
    expect(messages[0].content).toBe('base');
    expect(injectWorkingState(messages, '')).toEqual(messages);
  });
});

describe('queryLoop working state', () => {
  let dir: string;
  let previousRoot: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-working-state-'));
    previousRoot = getProjectRoot();
    setProjectRoot(dir);
  });
  afterEach(async () => {
    setProjectRoot(previousRoot);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

  async function run(config: Partial<LoopConfig>, replies: Message[], tools: Tool[], runLog?: RunLog) {
    const sent: Message[][] = [];
    const offered: string[][] = [];
    const client = {
      chat: jest.fn(async (messages: Message[], schemas: Array<{ function: { name: string } }> = []) => {
        sent.push(JSON.parse(JSON.stringify(messages)) as Message[]);
        offered.push(schemas.map((schema) => schema.function.name));
        return { message: replies.shift() as Message };
      }),
    };
    const events: LoopEvent[] = [];
    for await (const event of queryLoop(
      { model: 'm', systemPrompt: 'system', maxTurns: 5, context: { enabled: false }, supervisor: false, ...config },
      { client: client as never, tools, ...(runLog ? { runLog } : {}) },
      [{ role: 'user', content: 'go' }],
    )) events.push(event);
    return { sent, offered, events };
  }

  it('blocks writes to protected paths from the task contract and config, without injection', async () => {
    const { events } = await run(
      { protectedPaths: ['secrets/'], taskContract: buildTaskContract('update the notes file') },
      [
        { role: 'assistant', content: '', tool_calls: [call('file_write', { path: '.env', content: 'KEY=stolen' }), call('file_write', { path: 'secrets/token.txt', content: 'x' }), call('file_write', { path: 'notes/ok.md', content: 'fine' })] } as Message,
        { role: 'assistant', content: 'done' },
      ],
      [FileWriteTool],
    );
    const results = events.filter((event) => event.type === 'tool_result').map((event) => (event.type === 'tool_result' ? [String(event.call.input.path), event.result.success] : []));
    expect(results).toEqual(expect.arrayContaining([['.env', false], ['secrets/token.txt', false], ['notes/ok.md', true]]));
    await expect(fs.access(path.join(dir, '.env'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'notes', 'ok.md'), 'utf-8')).toBe('fine');
  });

  it('injects state into every request, offers state_update, and the run log rebuilds the prompts exactly', async () => {
    const runLog = new RunLog(dir, 'state-run');
    const { sent, offered } = await run(
      { workingState: { inject: true }, protectedPaths: ['secrets/'] },
      [
        { role: 'assistant', content: '', tool_calls: [call('state_update', { plan: ['look up price', 'answer'], addDecisions: [{ what: 'UK prices only', why: 'user in UK' }] })] } as Message,
        { role: 'assistant', content: '', tool_calls: [call('state_update', { completeSteps: [1] })] } as Message,
        { role: 'assistant', content: 'The price is £1,669.' },
      ],
      [],
      runLog,
    );
    expect(offered[0]).toContain('state_update');
    expect(String(sent[0][0].content)).toContain('Protected paths (never modify): secrets/');
    expect(String(sent[1][0].content)).toContain('1. [ ] look up price');
    expect(String(sent[2][0].content)).toContain('1. [x] look up price');
    expect(String(sent[2][0].content)).toContain('UK prices only (because user in UK)');
    // State lives outside the transcript: no user/tool message carries it.
    expect(sent[2].slice(1).some((m) => String(m.content).includes(WORKING_STATE_HEADER))).toBe(false);

    const events = await readRunEvents(dir, 'state-run');
    expect(reconstructModelRequests(events).map((request) => request.messages)).toEqual(sent);
    expect(events.filter((event) => event.kind === 'state').length).toBeGreaterThanOrEqual(2);
  });

  it('does not offer state_update or change prompts when injection is off', async () => {
    const { sent, offered } = await run({}, [{ role: 'assistant', content: 'hi' }], []);
    expect(offered[0]).not.toContain('state_update');
    expect(sent[0][0].content).toBe('system');
  });
});
