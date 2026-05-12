import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RuntimeTracer } from '../core/tracing';
import { appendEvalTraceExample, createContextLossEvalRun, createEvalTraceExample, createOutputValidationEvalRun, createOutputValidationTrendExport, createProfileFeedbackEvalRun, createReplayEvalExample, createUploadsFallbackEvalRun, deleteEvalTraceExample, detectAssistantContextLoss, listEvalTraceExamples, listEvalTraceRuns, readEvalTraceDataset, recordOutputValidationEvalRun, recordProfileFeedbackEvalRun, runEvalTraceDataset, summarizeContextLossRuns, summarizeEvalTraceRuns, summarizeOutputValidationRuns, summarizeProfileFeedbackRuns, summarizeUploadsFallbackRuns, updateEvalTraceExampleTags } from './evalTrace';

describe('eval trace examples', () => {
  it('creates passing examples from successful traces', () => {
    const tracer = new RuntimeTracer();
    const span = tracer.startSpan('model.chat', { model: 'base' });
    tracer.recordEvent('session.status', { status: 'completed' });
    span.end('ok');

    const example = createEvalTraceExample(tracer.snapshot(), { task: 'answer user' });

    expect(example).toMatchObject({ task: 'answer user', status: 'pass' });
    expect(example.tags).toEqual(expect.arrayContaining(['pass', 'model', 'session']));
  });

  it('creates failing examples from errored traces', () => {
    const tracer = new RuntimeTracer();
    const span = tracer.startSpan('tool.execute', { tool: 'bash' });
    span.fail(new Error('boom'));

    const example = createEvalTraceExample(tracer.snapshot());

    expect(example).toMatchObject({ status: 'fail', error: 'boom' });
    expect(example.tags).toEqual(expect.arrayContaining(['fail', 'tools']));
  });

  it('appends examples as JSONL', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-'));
    const example = createEvalTraceExample({ spans: [], events: [] }, { task: 'empty trace' });

    const filePath = await appendEvalTraceExample(projectDir, example);
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ task: 'empty trace' });
    await expect(listEvalTraceExamples(projectDir)).resolves.toEqual([expect.objectContaining({ task: 'empty trace' })]);
  });

  it('updates tags, reads, and deletes dataset examples', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-manage-'));
    const example = createEvalTraceExample({ spans: [], events: [] }, { task: 'managed trace', tags: ['old'] });
    await appendEvalTraceExample(projectDir, example);

    await expect(updateEvalTraceExampleTags(projectDir, example.id, ['new', 'reviewed', 'new'])).resolves.toMatchObject({ tags: ['new', 'reviewed'] });
    await expect(readEvalTraceDataset(projectDir)).resolves.toContain('managed trace');
    await expect(deleteEvalTraceExample(projectDir, example.id)).resolves.toBe(true);
    await expect(listEvalTraceExamples(projectDir)).resolves.toEqual([]);
  });

  it('runs curated trace examples and summarizes trends by tag', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-run-'));
    const passing = createEvalTraceExample({ spans: [], events: [] }, { task: 'passing trace', tags: ['smoke'] });
    const failing = createEvalTraceExample({ spans: [{ id: 's1', name: 'tool.execute', startedAt: '2026-04-29T00:00:00.000Z', status: 'error', attributes: {}, error: 'boom' }], events: [] }, { task: 'unexpected failure', tags: ['smoke'] });
    await appendEvalTraceExample(projectDir, passing);
    await appendEvalTraceExample(projectDir, failing);

    const run = await runEvalTraceDataset(projectDir);
    const trend = summarizeEvalTraceRuns([run]);

    expect(run).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(run.results).toEqual(expect.arrayContaining([expect.objectContaining({ task: 'unexpected failure', status: 'fail' })]));
    expect(trend.byTag.smoke).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
  });

  it('creates and evaluates replayable examples deterministically', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-replay-eval-'));
    const example = createReplayEvalExample({
      task: 'weather answer regression',
      prompt: 'What is the weather like in Bracknell, UK today?',
      expectedResponseIncludes: ['Bracknell', 'weather'],
      expectedTools: ['web_search', 'web_read'],
      actualResponse: 'The weather in Bracknell looks cloudy today.',
      actualTools: ['web_search', 'web_read'],
      tags: ['weather', 'replay'],
    });
    await appendEvalTraceExample(projectDir, example);

    const run = await runEvalTraceDataset(projectDir);

    expect(example).toMatchObject({ mode: 'replay', status: 'pass' });
    expect(run).toMatchObject({ total: 1, passed: 1, failed: 0, passRate: 1 });
    expect(run.results[0]).toMatchObject({ checks: ['expected response fragments', 'expected tool calls'] });
  });

  it('uses replay adapters and returns source links for replay evals', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-replay-adapter-'));
    const example = createReplayEvalExample({
      task: 'linked replay regression',
      prompt: 'Summarize trace failure',
      expectedResponseIncludes: ['trace', 'failure'],
      expectedTools: ['web_read'],
      sourceTraceId: 'trace-2026-04-29T00-00-00-000Z',
      sourceSessionId: 'session-123',
      sourceContext: 'Created from a failed weather answer.',
      tags: ['replay'],
    });
    await appendEvalTraceExample(projectDir, example);

    const run = await runEvalTraceDataset(projectDir, {
      replayAdapter: async () => ({ actualResponse: 'Trace failure was reproduced.', actualTools: ['web_read'] }),
    });

    expect(run).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(run.results[0]).toMatchObject({
      links: {
        traceUrl: '/api/traces/exports/trace-2026-04-29T00-00-00-000Z',
        sessionUrl: '/api/sessions/session-123',
        context: 'Created from a failed weather answer.',
      },
    });
  });

  it('records output-validation results as eval runs', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-validation-eval-'));
    const validation = {
      profile: 'coding-answer' as const,
      status: 'warn' as const,
      score: 0.95,
      findings: [{ code: 'missing-validation-summary', severity: 'warn' as const, message: 'Coding answer should state validation performed.' }],
      missingSections: [],
    };

    const run = createOutputValidationEvalRun(validation, 'final answer');
    await recordOutputValidationEvalRun(projectDir, validation, 'final answer');

    expect(run).toMatchObject({ total: 1, passed: 0, failed: 1, passRate: 0 });
    expect(run.results[0]).toMatchObject({ task: 'final answer', tags: ['output-validation', 'coding-answer', 'warn', 'manual-selected'] });
    await expect(listEvalTraceRuns(projectDir)).resolves.toEqual([expect.objectContaining({ results: [expect.objectContaining({ task: 'final answer' })] })]);
  });

  it('summarizes output-validation eval runs by profile and status', () => {
    const warnRun = createOutputValidationEvalRun({
      profile: 'coding-answer',
      status: 'warn',
      score: 0.95,
      findings: [{ code: 'missing-validation-summary', severity: 'warn', message: 'State validation performed.' }],
      missingSections: [],
    }, 'coding summary', { selectionSource: 'auto-selected', selectionReason: 'The prompt looks like code.' });
    const passRun = createOutputValidationEvalRun({ profile: 'factual-answer', status: 'pass', score: 1, findings: [], missingSections: [] }, 'weather answer');

    const trend = summarizeOutputValidationRuns([warnRun, passRun]);

    expect(trend.totalResults).toBe(2);
    expect(trend.byProfile['coding-answer']).toMatchObject({ total: 1, failed: 1, passRate: 0 });
    expect(trend.bySelectionSource['auto-selected']).toMatchObject({ total: 1, failed: 1, passRate: 0 });
    expect(trend.bySelectionSource['manual-selected']).toMatchObject({ total: 1, passed: 1, passRate: 1 });
    expect(trend.byStatus.warn).toBe(1);
    expect(trend.latestFailures[0]).toMatchObject({ profile: 'coding-answer', selectionSource: 'auto-selected', checks: ['missing-validation-summary'] });
  });

  it('exports output-validation trends with raw validation results', () => {
    const warnRun = createOutputValidationEvalRun({
      profile: 'coding-answer',
      status: 'warn',
      score: 0.95,
      findings: [{ code: 'missing-validation-summary', severity: 'warn', message: 'State validation performed.' }],
      missingSections: [],
    }, 'coding summary', { selectionSource: 'auto-selected' });

    const exported = createOutputValidationTrendExport([warnRun], '2026-04-29T00:00:00.000Z');

    expect(exported.generatedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(exported.trend.totalResults).toBe(1);
    expect(exported.results).toEqual([expect.objectContaining({ task: 'coding summary', profile: 'coding-answer', status: 'warn', selectionSource: 'auto-selected', passed: false })]);
  });

  it('summarizes profile feedback votes by profile with calibration insights', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-feedback-'));
    const downRuns = [
      createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'down', selectionSource: 'auto-selected', prompt: 'analyze csv data' }),
      createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'down', selectionSource: 'auto-selected', prompt: 'summarize report' }),
      createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'down', selectionSource: 'auto-selected', prompt: 'graph trends' }),
    ];
    const upRun = createProfileFeedbackEvalRun({ profile: 'factual-answer', vote: 'up', selectionSource: 'auto-selected', prompt: 'weather query' });
    const recorded = await recordProfileFeedbackEvalRun(projectDir, { profile: 'oracle-prime', vote: 'up' });
    expect(recorded.results[0].tags).toEqual(expect.arrayContaining(['profile-feedback', 'profile-feedback:up', 'oracle-prime']));

    const trend = summarizeProfileFeedbackRuns([...downRuns, upRun, recorded]);

    expect(trend.totalVotes).toBe(5);
    expect(trend.byProfile['coding-answer']).toMatchObject({ total: 3, up: 0, down: 3, approvalRate: 0 });
    expect(trend.byProfile['factual-answer']).toMatchObject({ up: 1, down: 0, approvalRate: 1 });
    expect(trend.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'coding-answer', severity: 'warn', downVotes: 3 }),
    ]));
    // Oracle-prime got 1 up-vote and 0 downs — should not produce a warning insight.
    expect(trend.insights.find((insight) => insight.profile === 'oracle-prime')).toBeUndefined();
    expect(trend.recentVotes[0]).toMatchObject({ profile: 'oracle-prime', vote: 'up' });
  });

  it('groups profile-feedback votes by day for a sparkline', () => {
    const day1 = createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'down' });
    day1.createdAt = '2026-04-27T10:00:00.000Z';
    const day2a = createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'up' });
    day2a.createdAt = '2026-04-28T10:00:00.000Z';
    const day2b = createProfileFeedbackEvalRun({ profile: 'coding-answer', vote: 'up' });
    day2b.createdAt = '2026-04-28T11:00:00.000Z';

    const trend = summarizeProfileFeedbackRuns([day1, day2a, day2b]);

    expect(trend.dailyApproval).toEqual([
      { date: '2026-04-27', total: 1, up: 0, down: 1, approvalRate: 0 },
      { date: '2026-04-28', total: 2, up: 2, down: 0, approvalRate: 1 },
    ]);
  });

  it('detects assistant context loss when the response shares no significant token with prior turns', () => {
    const lost = detectAssistantContextLoss({
      priorUserMessage: 'analyze lotto-draw-history.csv with draw date and machine number',
      priorAssistantMessage: 'The dataset covers lottery draws between November 2025 and April 2026.',
      assistantResponse: 'Industrial maintenance requires scheduled downtime windows for each manufacturing asset.',
    });
    expect(lost.contextLoss).toBe(true);
    expect(lost.overlapTokens).toEqual([]);

    const ok = detectAssistantContextLoss({
      priorUserMessage: 'analyze lotto-draw-history.csv with draw date and machine number',
      assistantResponse: 'The lotto draw dataset shows machine and draw distributions for the recorded history.',
    });
    expect(ok.contextLoss).toBe(false);
    expect(ok.overlapTokens.length).toBeGreaterThan(0);

    expect(createContextLossEvalRun({
      priorUserMessage: 'analyze lotto draws',
      assistantResponse: 'Industrial maintenance schedules.',
    })).toBeNull(); // prior token count too small for the heuristic
    const run = createContextLossEvalRun({
      priorUserMessage: 'analyze lotto-draw-history.csv with draw date and machine number',
      priorAssistantMessage: 'The dataset covers lottery draws between November 2025 and April 2026.',
      assistantResponse: 'Industrial maintenance requires scheduled downtime windows for each manufacturing asset.',
    });
    expect(run).not.toBeNull();
    expect(run!.results[0].tags).toContain('assistant-context-loss');
  });

  it('summarizes assistant-context-loss runs with totals and recent entries', () => {
    const lossRun = createContextLossEvalRun({
      priorUserMessage: 'analyze lotto-draw-history.csv with draw date and machine number',
      priorAssistantMessage: 'The dataset covers lottery draws between November 2025 and April 2026.',
      assistantResponse: 'Industrial maintenance requires scheduled downtime windows for each manufacturing asset.',
      task: 'lotto follow-up',
    })!;
    const passRun = createOutputValidationEvalRun({ profile: 'oracle-prime', status: 'pass', score: 1, findings: [], missingSections: [] }, 'unrelated');

    const trend = summarizeContextLossRuns([passRun, lossRun]);

    expect(trend.total).toBe(1);
    expect(trend.recent[0]).toMatchObject({ task: 'lotto follow-up' });
    expect(summarizeContextLossRuns([])).toEqual({ total: 0, recent: [] });
  });

  it('summarizes uploads-fallback runs by tool with totals and recent entries', () => {
    const fallbackRun = createUploadsFallbackEvalRun({
      uniqueFallbacks: 3,
      suppressedFallbacks: 2,
      tools: ['file_read', 'pdf_read'],
      task: 'analyze attachments',
    })!;
    const passRun = createOutputValidationEvalRun({ profile: 'oracle-prime', status: 'pass', score: 1, findings: [], missingSections: [] }, 'unrelated');

    const trend = summarizeUploadsFallbackRuns([passRun, fallbackRun]);

    expect(trend.totalSessions).toBe(1);
    expect(trend.totalFallbacks).toBe(3);
    expect(trend.byTool.file_read).toBe(3);
    expect(trend.byTool.pdf_read).toBe(3);
    expect(trend.recent[0]).toMatchObject({ unique: 3, tools: ['file_read', 'pdf_read'] });
    expect(createUploadsFallbackEvalRun({ uniqueFallbacks: 0, suppressedFallbacks: 0, tools: [] })).toBeNull();
  });
});