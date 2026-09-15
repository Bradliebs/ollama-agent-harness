const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');

const root = path.resolve(__dirname, '..');
const cloudMode = process.argv[2] === '--cloud';
const argv = cloudMode ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;
const model = (argv[2] === '--worker' ? argv[5] : ['--files', '--outcomes', '--holdouts'].includes(argv[2]) ? argv[4] : argv[3]) || (cloudMode ? undefined : 'qwen3:1.7b');
const outcomes = require('./outcome-cases');
const host = 'http://127.0.0.1:11434';
const cases = [
  ['Add 19 and 8.', 27],
  ['Subtract 14 from 31.', 17],
  ['Multiply 7 by 6.', 42],
  ['Divide 81 by 9.', 9],
  ['Return the larger number: 12 or 21.', 21],
  ['Sort these numbers ascending: 8, 2, 5.', [2, 5, 8]],
  ['Count the entries in ["red","green","blue"].', 3],
  ['Evidence: {"name":"Mira","age":34}. Return age.', 34],
  ['Evidence: {"city":"Oslo","temperature":6}. Return city.', 'Oslo'],
  ['Evidence: {"price":15}. Return weight, or null if absent.', null],
  ['Convert 2 kilometres to metres.', 2000],
  ['Return true if 10 is an even number, otherwise false.', true],
  ['What is the sum of 26 and 17?', 43],
  ['There were 40 items and 13 were removed. How many remain?', 27],
  ['Three boxes each contain 9 pens. How many pens altogether?', 27],
  ['Order 11, 4, 9 from smallest to largest.', [4, 9, 11]],
  ['Record: {"owner":"Lena","count":12}. Give the owner.', 'Lena'],
  ['Record: {"height":180}. Give the mass, using null for an unknown field.', null],
  ['Express 3 metres as centimetres.', 300],
  ['Is 15 divisible by 3? Return a boolean.', true],
];
const fixture = { owner: 'Mira', items: [2, 5], count: 7 };
const initialOutput = { enabled: false, label: 'demo' };
const fileCases = [
  ['Read input.json and copy its complete JSON object into out/result.json.', fixture],
  ['Read input.json. Sum its items and write {"total":the sum} to out/result.json.', { total: 7 }],
  ['Read input.json and write only its owner field as a JSON object in out/result.json.', { owner: 'Mira' }],
  ['Read out/result.json. Change enabled to true, preserving label, and write the object back.', { enabled: true, label: 'demo' }],
  ['Read input.json and return its count as {"value":the count}. Do not modify any files.', 7],
];

function score(expected, text) {
  try {
    assert.deepEqual(JSON.parse(text), { value: expected });
    return { pass: true, reason: 'Exact structured result' };
  } catch {
    return { pass: false, reason: 'Result differs from the required JSON value' };
  }
}

function scoreFile(expected, workspace) {
  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'out/result.json'), 'utf8')), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'input.json'), 'utf8')), fixture);
    return { pass: true, reason: 'Output file contents verified and input unchanged' };
  } catch {
    return { pass: false, reason: 'File result missing, incorrect, or input changed' };
  }
}

function summarizeModelUsage(results) {
  const calls = results.flatMap(result => result.metrics?.modelCalls || []);
  const knownCalls = calls.filter(call => Number.isFinite(call.durationMs) && call.durationMs >= 0
    && Number.isSafeInteger(call.usage?.promptTokens) && call.usage.promptTokens >= 0
    && Number.isSafeInteger(call.usage?.completionTokens) && call.usage.completionTokens >= 0);
  const allCallsReported = results.length > 0
    && results.every(result => result.metrics?.modelCalls?.length > 0)
    && knownCalls.length === calls.length;
  const knownReportedTokens = knownCalls.length > 0
    ? knownCalls.reduce((sum, call) => sum + call.usage.promptTokens + call.usage.completionTokens, 0) : null;
  const reportedTotalTokens = allCallsReported ? knownReportedTokens : null;
  const passedAttempts = results.filter(result => result.status === 'pass').length;
  return {
    scope: 'Client-reported usage across recorded chat calls, including failed attempts; omitted counts may be normalized to zero and internal retries are not separately captured',
    recordedCalls: calls.length,
    callsWithUsage: knownCalls.length,
    allCallsReported,
    knownReportedTokens,
    reportedTotalTokens,
    reportedTokensPerPassedAttempt: reportedTotalTokens !== null && passedAttempts > 0 ? reportedTotalTokens / passedAttempts : null,
  };
}

function summarizeRequestUsage(results) {
  const summary = summarizeModelUsage(results.map(result => ({ ...result, metrics: { modelCalls: result.metrics?.modelRequests } })));
  const allCallsLinked = results.length > 0 && results.every(result => {
    const calls = result.metrics?.modelCalls || [];
    const requests = result.metrics?.modelRequests || [];
    return calls.length > 0
      && calls.every(call => Number.isSafeInteger(call.callId) && call.callId > 0 && requests.some(request => request.callId === call.callId))
      && requests.every(request => calls.some(call => call.callId === request.callId));
  });
  const allCallsReported = summary.allCallsReported && allCallsLinked;
  return { ...summary, allCallsLinked, allCallsReported,
    reportedTotalTokens: allCallsReported ? summary.reportedTotalTokens : null,
    reportedTokensPerPassedAttempt: allCallsReported ? summary.reportedTokensPerPassedAttempt : null,
    scope: 'Raw terminal usage for recorded OllamaClient.chat requests, including retries and failed attempts; missing counts or call linkage remain unknown. Excludes other clients, daemon background work and cost.' };
}

function describeContext(messages, tools) {
  const byRole = Object.fromEntries(['system', 'user', 'assistant', 'tool', 'other'].map(role => [role, { messages: 0, bytes: 0 }]));
  for (const message of messages) {
    const role = Object.hasOwn(byRole, message.role) ? message.role : 'other';
    byRole[role].messages += 1;
    byRole[role].bytes += Buffer.byteLength(JSON.stringify(message));
  }
  return {
    scope: 'UTF-8 JSON bytes of client messages and tool schemas, not tokens or the complete HTTP payload; message metadata and images belong to their message role',
    messageCount: messages.length,
    messageBytes: Buffer.byteLength(JSON.stringify(messages)),
    schemaBytes: Buffer.byteLength(JSON.stringify(tools || [])),
    framingBytes: messages.length > 0 ? messages.length + 1 : 2,
    byRole,
  };
}

async function worker(prompt, fileMode, outcomeTask) {
  const { queryLoop } = require(path.join(root, 'dist/core/queryLoop'));
  const { OllamaClient } = require(path.join(root, 'dist/core/ollamaClient'));
  const { FileReadTool, FileWriteTool } = require(path.join(root, 'dist/tools/fileTools'));
  const { DocumentExportTool } = require(path.join(root, 'dist/tools/documentTools'));
  const callContext = new AsyncLocalStorage();
  let nextCallId = 0;
  const client = new OllamaClient({ host, model, onRequestEvent: event => process.send?.({ type: 'model-request', ...event, callId: callContext.getStore() ?? null }) });
  const chat = client.chat.bind(client);
  client.chat = async (messages, tools, signal) => {
    const callId = ++nextCallId;
    const context = describeContext(messages, tools);
    process.send?.({ type: 'model-start', callId, messageBytes: context.messageBytes, schemaBytes: context.schemaBytes, context });
    const started = Date.now();
    try {
      const result = await callContext.run(callId, () => chat(messages, tools, signal));
      process.send?.({ type: 'model-end', callId, durationMs: Date.now() - started, usage: result.usage });
      return result;
    } catch (error) {
      process.send?.({ type: 'model-end', callId, durationMs: Date.now() - started, error: error.message });
      throw error;
    }
  };
  process.send?.({ type: 'ready' });
  for await (const event of queryLoop({
    model, systemPrompt: fileMode ? 'Use the provided file tools to complete the requested work in this workspace. Do not invent file contents.' : 'Return only valid JSON with exactly one key named value. No markdown or explanation.',
    maxTurns: outcomeTask ? 6 : fileMode ? 4 : 1, context: { enabled: false },
  }, { client, tools: fileMode ? [FileReadTool, FileWriteTool, ...(outcomeTask?.document ? [DocumentExportTool] : [])] : [], permissionCheck: async call => {
    const target = path.resolve(process.cwd(), String(call.input.path ?? ''));
    const input = path.join(process.cwd(), 'input.json');
    const output = path.join(process.cwd(), `out/result.${outcomeTask?.format || 'json'}`);
    if (outcomeTask) {
      const reads = [...(outcomeTask.fixtures ? Object.keys(outcomeTask.fixtures) : ['input.json', 'sources.json', 'checkpoint.json']), 'out/result.json'].map(name => path.join(process.cwd(), name));
      return { allowed: call.name === 'file_read' ? reads.includes(target) : !outcomeTask.response && ['file_write', 'document_export'].includes(call.name) && target === output, reason: 'Only this task fixture and output paths are authorized' };
    }
    return { allowed: fileMode && ((call.name === 'file_read' && [input, output].includes(target)) || (call.name === 'file_write' && target === output)), reason: 'Only the synthetic fixture paths are authorized' };
  } }, [
    { role: 'user', content: fileMode ? prompt : `${prompt} Return only JSON: {"value":...}.` },
  ])) {
    if (fileMode) fs.appendFileSync('events.jsonl', JSON.stringify(event) + '\n');
    if ((event.type === 'text' && event.content?.trim()) || (event.type === 'tool_result' && event.result.success)) process.send?.({ type: 'useful-output' });
    process.send?.({ type: 'resources', maxRssKiB: process.resourceUsage().maxRSS });
    process.stdout.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function validateModelRoute(name, installed, cloud = false) {
  if (!installed || installed.name !== name) throw new Error('Required model is unavailable. No downloads allowed.');
  if (!cloud) {
    if (!['qwen3:1.7b', 'gemma4:e4b'].includes(name) || installed.remote_host || installed.remote_model) {
      throw new Error('Required local model is unavailable or remote. No downloads allowed.');
    }
    return;
  }
  let remote;
  try { remote = new URL(installed.remote_host); } catch { throw new Error('Cloud mode requires an explicit Ollama cloud destination.'); }
  if (remote.origin !== 'https://ollama.com' || remote.username || remote.password
    || typeof installed.remote_model !== 'string' || !installed.remote_model.trim()) {
    throw new Error('Cloud mode requires an explicit Ollama cloud destination and remote model. Local inference is forbidden.');
  }
}

async function readModelRoute() {
  const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);
  const tags = await response.json();
  const installed = tags.models?.find(entry => entry.name === model);
  validateModelRoute(model, installed, cloudMode);
  return installed;
}

async function main() {
  if (cloudMode && !model) throw new Error('Cloud mode requires an explicit model name. No default or local fallback is allowed.');
  if (!cloudMode && !['qwen3:1.7b', 'gemma4:e4b'].includes(model)) throw new Error('Only the explicitly qualified local model names are allowed.');
  if (argv[2] === '--worker') {
    if (cloudMode) await readModelRoute();
    const collection = argv[4] === 'holdouts' ? require('./holdout-cases') : outcomes;
    const outcomeTask = ['outcomes', 'holdouts'].includes(argv[4]) ? collection.cases.find(task => task.id === argv[6]) : undefined;
    if (['outcomes', 'holdouts'].includes(argv[4]) && !outcomeTask) throw new Error('Unknown outcome task');
    await worker(Buffer.from(argv[3], 'base64').toString('utf8'), ['files', 'outcomes', 'holdouts'].includes(argv[4]), outcomeTask);
    return;
  }
  if (argv[2] === '--check-holdouts') {
    const holdouts = require('./holdout-cases');
    console.log(JSON.stringify({ tasks: holdouts.cases.length, digest: holdouts.digest, inferenceSent: false }));
    return;
  }
  if (argv[2] === '--check') {
    assert.equal(cases.length, 20);
    for (const [, expected] of cases) {
      assert.equal(score(expected, JSON.stringify({ value: expected })).pass, true);
      assert.equal(score(expected, JSON.stringify({ value: 'wrong' })).pass, false);
      assert.equal(score(expected, 'done').pass, false);
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-file-scorer-'));
    try {
      fs.mkdirSync(path.join(workspace, 'out'));
      fs.writeFileSync(path.join(workspace, 'input.json'), JSON.stringify(fixture));
      assert.equal(scoreFile({ total: 7 }, workspace).pass, false);
      fs.writeFileSync(path.join(workspace, 'out/result.json'), JSON.stringify({ total: 7 }));
      assert.equal(scoreFile({ total: 7 }, workspace).pass, true);
      assert.equal(scoreFile({ total: 8 }, workspace).pass, false);
      fs.writeFileSync(path.join(workspace, 'input.json'), '{}');
      assert.equal(scoreFile({ total: 7 }, workspace).pass, false);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
    console.log('20 structured scorers and file outcome checks validated; no inference sent.');
    return;
  }
  const holdoutMode = argv[2] === '--holdouts';
  const outcomeMode = argv[2] === '--outcomes' || holdoutMode;
  const collection = holdoutMode ? require('./holdout-cases') : outcomes;
  const fileMode = argv[2] === '--files' || outcomeMode;
  const selectedCases = outcomeMode ? collection.cases.map(task => [task.prompt, task]) : fileMode ? fileCases : cases;
  const outputPath = argv[fileMode ? 3 : 2];
  if (!outputPath) throw new Error('Provide a result JSON path, or --check. This command runs inference.');
  if (fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing baseline report.');
  const installed = await readModelRoute();
  const version = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const residencyBefore = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const { runBenchmarkTask } = require(path.join(root, 'dist/eval/benchmark'));
  const { summarizeTaskEfficiency } = require(path.join(root, 'dist/experiments/report'));
  const report = {
    schemaVersion: 1, inferenceMode: cloudMode ? 'ollama-cloud' : 'local',
    ...(cloudMode ? { remoteHost: installed.remote_host, remoteModel: installed.remote_model, qualificationLimit: 'Cloud workflow evidence only; not local GPU performance or local-model qualification. Account usage may apply.' } : {}),
    scope: holdoutMode ? 'Eight frozen separately AI-authored holdout tasks; not human-independent evidence, app-build or real interruption qualification' : outcomeMode ? 'Twelve self-authored development outcome tasks; no independent holdout, app-build or real interruption qualification' : fileMode ? 'Preliminary file-tool qualification with synthetic fixtures; no product UI or independent holdout review' : 'Preliminary core JSON qualification; no tools, product UI, or independent holdout review',
    ...(holdoutMode ? { datasetDigest: collection.digest, authorship: 'separate-agent-ai-authored' }
      : outcomeMode ? { datasetVersion: collection.datasetVersion, datasetDigest: collection.digest, authorship: 'development-self-authored' } : {}),
    model, modelDigest: installed.digest, host, node: process.version, ollama: version.version,
    cpu: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(), residencyBefore,
    taskCount: selectedCases.length, plannedReplicates: 3, perTaskTimeoutMs: fileMode ? 60000 : 20000,
    startedAt: new Date().toISOString(), results: [], efficiency: null,
  };
  const started = Date.now();
  let consecutiveInfrastructureFailures = 0;
  for (let replicate = 0; replicate < 3; replicate += 1) {
    for (const [index, [prompt, expected]] of selectedCases.entries()) {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-local-qualification-'));
      const outcomeTask = outcomeMode ? expected : undefined;
      const fixtures = outcomeTask ? collection.prepare(workspace, outcomeTask) : undefined;
      if (fileMode && !outcomeMode) {
        fs.mkdirSync(path.join(workspace, 'out'));
        fs.writeFileSync(path.join(workspace, 'input.json'), JSON.stringify(fixture));
        fs.writeFileSync(path.join(workspace, 'out/result.json'), JSON.stringify(initialOutput));
      }
      let child;
      let exited;
      let workerStderr = '';
      let workerExit;
      let fullResponse = '';
      const metrics = { startupMs: null, firstUsefulOutputMs: null, workerPeakRssKiB: null, modelCalls: [], modelRequests: [] };
      const fetchImpl = async (_url, init) => {
        const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
        const spawnedAt = Date.now();
        child = spawn(process.execPath, [__filename, ...(cloudMode ? ['--cloud'] : []), '--worker', Buffer.from(prompt).toString('base64'), holdoutMode ? 'holdouts' : outcomeMode ? 'outcomes' : fileMode ? 'files' : 'core', model, ...(outcomeTask ? [outcomeTask.id] : [])], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.on('message', message => {
          if (message.type === 'ready') metrics.startupMs = Date.now() - spawnedAt;
          if (message.type === 'useful-output' && metrics.firstUsefulOutputMs === null) metrics.firstUsefulOutputMs = Date.now() - spawnedAt;
          if (message.type === 'resources') metrics.workerPeakRssKiB = Math.max(metrics.workerPeakRssKiB || 0, message.maxRssKiB);
          if (message.type === 'model-start') metrics.modelCalls.push({ callId: message.callId, startedMs: Date.now() - spawnedAt, messageBytes: message.messageBytes, schemaBytes: message.schemaBytes, context: message.context, durationMs: null, usage: null });
          if (message.type === 'model-end') {
            const call = metrics.modelCalls.find(entry => entry.callId === message.callId);
            if (call) Object.assign(call, { durationMs: message.durationMs, usage: message.usage || null, error: message.error });
          }
          if (message.type === 'model-request') {
            if (message.phase === 'start') metrics.modelRequests.push({ requestId: message.requestId, callId: message.callId, startedMs: Date.now() - spawnedAt, durationMs: null, usage: null });
            else {
              const request = metrics.modelRequests.find(entry => entry.requestId === message.requestId);
              if (request) Object.assign(request, { phase: message.phase, durationMs: message.durationMs, usage: message.usage, error: message.error });
            }
          }
        });
        exited = new Promise(resolve => child.once('close', (code, signal) => { workerExit = { code, signal }; resolve(); }));
        child.stderr.on('data', chunk => { workerStderr = (workerStderr + chunk.toString()).slice(-16000); });
        init.signal.addEventListener('abort', () => child.kill(), { once: true });
        return new Response(Readable.toWeb(child.stdout), { headers: { 'Content-Type': 'text/event-stream' } });
      };
      try {
        const readonly = outcomeTask ? Boolean(outcomeTask.response) : fileMode && index === fileCases.length - 1;
        const customScorer = text => {
          if (outcomeMode) { fullResponse = text; return { pass: true, reason: 'Awaiting independent artifact verification' }; }
          if (!fileMode) return score(expected, text);
          if (!readonly) return scoreFile(expected, workspace);
          const files = scoreFile(initialOutput, workspace);
          return files.pass ? score(expected, text) : files;
        };
        const result = await runBenchmarkTask({ id: outcomeTask?.id || `${fileMode ? 'files' : 'core'}-${index + 1}`, tier: 'regression', description: prompt, input: prompt, customScorer,
          requireTools: fileMode ? readonly ? ['file_read'] : ['file_read', outcomeTask?.document ? 'document_export' : 'file_write'] : undefined,
          forbiddenTools: readonly ? ['file_write', 'document_export'] : undefined,
        }, { fetchImpl, model, perTaskTimeoutMs: report.perTaskTimeoutMs });
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        let outcomeCheck;
        if (outcomeTask) {
          const verifyStarted = Date.now();
          outcomeCheck = await collection.verify(workspace, outcomeTask, fullResponse, fixtures);
          result.durationMs += Date.now() - verifyStarted;
          if (!outcomeCheck.pass && result.status === 'pass') {
            result.status = 'fail';
            result.failureCategory = 'WRONG_ANSWER';
            result.reason = outcomeCheck.reason;
          }
        }
        const evidence = fileMode ? {
          output: fs.readFileSync(path.join(workspace, 'out/result.json'), 'utf8'),
          input: fs.readFileSync(path.join(workspace, 'input.json'), 'utf8'),
          events: fs.existsSync(path.join(workspace, 'events.jsonl')) ? fs.readFileSync(path.join(workspace, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
        } : undefined;
        report.results.push({ ...result, replicate: replicate + 1, split: holdoutMode ? 'held-out-ai-authored' : fileMode || index < 12 ? 'development' : 'held-out-unreviewed', evidence, outcomeCheck, workerStderr, workerExit, metrics });
        consecutiveInfrastructureFailures = result.failureCategory === 'TIMEOUT' || result.status === 'error' ? consecutiveInfrastructureFailures + 1 : 0;
        report.efficiency = summarizeTaskEfficiency(report.results);
        report.clientUsage = summarizeModelUsage(report.results);
        report.requestUsage = summarizeRequestUsage(report.results);
        report.finishedAt = new Date().toISOString();
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(`${result.taskId} repeat ${replicate + 1}: ${result.status} (${result.durationMs}ms)`);
      } finally {
        if (child) { child.kill(); await exited; }
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      if (consecutiveInfrastructureFailures >= 3 || Date.now() - started >= 30 * 60 * 1000) {
        report.stoppedEarly = 'Infrastructure failures or overall time budget reached';
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(report.stoppedEarly);
        return;
      }
    }
  }
  console.log(JSON.stringify(report.efficiency));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { score, summarizeModelUsage, summarizeRequestUsage, describeContext, validateModelRoute };