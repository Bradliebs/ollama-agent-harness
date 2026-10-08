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

  it('treats leading ** and single * globs as globs, not as match-everything', () => {
    const root = path.resolve('/work/app');
    const store = new WorkingStateStore({ protectedPaths: ['**/secret.txt', '*.pem', 'src/**/keys', 'docs'] });
    const at = (rel: string) => store.protectedMatch(path.join(root, rel), root);
    expect(at('docs/guide/a.md')).toBe('docs');
    expect(at('docs.md')).toBeNull();
    expect(at('a/b/secret.txt')).toBe('**/secret.txt');
    expect(at('secret.txt')).toBe('**/secret.txt');
    expect(at('certs/server.pem')).toBe('*.pem');
    expect(at('src/deep/keys')).toBe('src/**/keys');
    expect(at('src/app.ts')).toBeNull();
    expect(at('notsecret.txt')).toBeNull();
    expect(shellTouchesProtected('rm build/secret.txt', store)).toBe('**/secret.txt');
  });

  it('anchors a leading "/" at the project root, gitignore style', () => {
    const root = path.resolve('/work/app');
    const store = new WorkingStateStore({ protectedPaths: ['/secrets', '/config/prod.json'] });
    const at = (rel: string) => store.protectedMatch(path.join(root, rel), root);
    expect(at('secrets/key.pem')).toBe('/secrets');
    expect(at('config/prod.json')).toBe('/config/prod.json');
    expect(at('lib/secrets/key.pem')).toBeNull();
    expect(at('config/dev.json')).toBeNull();
  });

  it('matches pathological wildcard patterns in linear time (no catastrophic backtracking)', () => {
    const root = path.resolve('/work/app');
    const hostile = ['*'.repeat(40) + 'x', 'a*'.repeat(60) + 'z', '**/'.repeat(40) + 'q'];
    const store = new WorkingStateStore({ protectedPaths: hostile });
    const target = path.join(root, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(60) + '.txt');
    const started = Date.now();
    expect(store.protectedMatch(target, root)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(store.protectedMatch(path.join(root, 'deep', 'x'), root)).toBe(hostile[0]);
  });

  it('never lets model updates evict seeded or earlier protections and invariants', async () => {
    const store = new WorkingStateStore({ protectedPaths: ['.env'], invariants: ['keep the public API stable'] });
    const tool = createStateUpdateTool(store);
    await tool.execute({
      protectPaths: Array.from({ length: 80 }, (_, i) => `junk-${i}/`),
      addInvariants: Array.from({ length: 40 }, (_, i) => `junk invariant ${i}`),
    });
    expect(store.state.protectedPaths[0]).toBe('.env');
    expect(store.state.protectedPaths).toHaveLength(50);
    expect(store.state.invariants[0]).toBe('keep the public API stable');
    expect(store.state.invariants).toHaveLength(20);
    expect(store.protectedMatch(path.resolve('/work/app/.env'), path.resolve('/work/app'))).toBe('.env');
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

  it('tail position: keeps the system prompt and history stable and still rebuilds the prompts exactly', async () => {
    const runLog = new RunLog(dir, 'state-tail-run');
    const { sent } = await run(
      { workingState: { inject: true, position: 'tail' }, protectedPaths: ['secrets/'] },
      [
        { role: 'assistant', content: '', tool_calls: [call('state_update', { plan: ['look up price', 'answer'] })] } as Message,
        { role: 'assistant', content: '', tool_calls: [call('state_update', { completeSteps: [1] })] } as Message,
        { role: 'assistant', content: 'The price is £1,669.' },
      ],
      [],
      runLog,
    );
    // The system prompt never changes; the state rides in the last message.
    expect(sent.map((request) => request[0].content)).toEqual(['system', 'system', 'system']);
    expect(String(sent[1][sent[1].length - 1].content)).toContain('1. [ ] look up price');
    expect(String(sent[2][sent[2].length - 1].content)).toContain('1. [x] look up price');
    // Each request extends the previous one's prefix (minus the old state message).
    expect(sent[2].slice(0, sent[1].length - 1)).toEqual(sent[1].slice(0, -1));
    const events = await readRunEvents(dir, 'state-tail-run');
    expect(reconstructModelRequests(events).map((request) => request.messages)).toEqual(sent);
  });

  it('does not offer state_update or change prompts when injection is off', async () => {
    const { sent, offered } = await run({}, [{ role: 'assistant', content: 'hi' }], []);
    expect(offered[0]).not.toContain('state_update');
    expect(sent[0][0].content).toBe('system');
  });
});
