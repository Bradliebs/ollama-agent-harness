const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planRepair, applyRepair, SOUL_FIXTURE } = require('./repair-workspace');

const REAL_SOUL = `# Soul — Moss\n\n${'I am Moss, an adaptive working partner. '.repeat(10)}`;

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repair-'));
  const harness = path.join(root, '.harness');
  const identity = path.join(harness, 'identity');
  fs.mkdirSync(path.join(identity, 'history', '2026-07-09T10-00-00-000Z-pre-user-update'), { recursive: true });
  fs.mkdirSync(path.join(identity, 'history', '2026-09-05T12-00-00-000Z-pre-user-update'), { recursive: true });
  fs.writeFileSync(path.join(identity, 'history', '2026-07-09T10-00-00-000Z-pre-user-update', 'SOUL.md'), REAL_SOUL);
  fs.writeFileSync(path.join(identity, 'history', '2026-09-05T12-00-00-000Z-pre-user-update', 'SOUL.md'), SOUL_FIXTURE);
  fs.writeFileSync(path.join(identity, 'SOUL.md'), SOUL_FIXTURE);
  fs.writeFileSync(path.join(harness, 'settings.json'), JSON.stringify({
    permissionMode: 'dontAsk',
    modelDebugLog: { enabled: false, path: '.harness/test-model-debug.jsonl' },
    capabilityGrants: [
      { id: 'a', capabilityId: 'arbitrary-shell', reason: 'server test grant' },
      { id: 'b', capabilityId: 'background-autonomous-jobs', reason: 'lifecycle test' },
      { id: 'c', capabilityId: 'arbitrary-shell', reason: 'Auto-granted in dontAsk mode.' },
      { id: 'd', capabilityId: 'arbitrary-shell', reason: 'One-click unattended runway from chat window' },
    ],
  }));
  fs.writeFileSync(path.join(harness, 'model-reliability.json'), JSON.stringify({
    'kimi-k3:cloud::general': { successes: 8, total: 8 },
    'test-model::general': { successes: 18, total: 32 },
  }));
  fs.writeFileSync(path.join(harness, 'synthesis-stats.json'), JSON.stringify({
    'kimi-k3:cloud': { fired: 0, total: 9 },
    'test-model': { fired: 0, total: 32 },
  }));
  return root;
}

test('dry run plans every repair without touching disk', () => {
  const root = makeWorkspace();
  try {
    const before = fs.readFileSync(path.join(root, '.harness', 'settings.json'), 'utf-8');
    const actions = planRepair(root);
    assert.deepEqual(actions.map((a) => a.kind), ['restore-soul', 'write-json', 'write-json', 'write-json']);
    assert.equal(actions[0].snapshot, '2026-07-09T10-00-00-000Z-pre-user-update');
    assert.equal(fs.readFileSync(path.join(root, '.harness', 'settings.json'), 'utf-8'), before);
    assert.equal(fs.readFileSync(path.join(root, '.harness', 'identity', 'SOUL.md'), 'utf-8'), SOUL_FIXTURE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply restores SOUL.md, strips test residue, keeps user settings, and backs up', async () => {
  const root = makeWorkspace();
  try {
    const backupDir = await applyRepair(root, planRepair(root), new Date('2026-09-23T10:00:00.000Z'));
    const harness = path.join(root, '.harness');

    assert.equal(fs.readFileSync(path.join(harness, 'identity', 'SOUL.md'), 'utf-8'), REAL_SOUL);
    assert.equal(fs.readFileSync(path.join(harness, 'identity', 'history', '2026-09-23T10-00-00-000Z-pre-repair', 'SOUL.md'), 'utf-8'), SOUL_FIXTURE);

    const settings = JSON.parse(fs.readFileSync(path.join(harness, 'settings.json'), 'utf-8'));
    assert.equal(settings.permissionMode, 'dontAsk');
    assert.deepEqual(settings.capabilityGrants.map((g) => g.id), ['c', 'd']);
    assert.equal(settings.modelDebugLog.path, '.harness/model-debug.jsonl');

    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(harness, 'model-reliability.json'), 'utf-8'))), ['kimi-k3:cloud::general']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(harness, 'synthesis-stats.json'), 'utf-8'))), ['kimi-k3:cloud']);

    assert.equal(fs.readFileSync(path.join(backupDir, 'identity', 'SOUL.md'), 'utf-8'), SOUL_FIXTURE);
    assert.match(fs.readFileSync(path.join(backupDir, 'settings.json'), 'utf-8'), /server test grant/);

    assert.deepEqual(planRepair(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real SOUL.md is never replaced', () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, '.harness', 'identity', 'SOUL.md'), '# Soul — custom\nHand-written persona.');
    assert.equal(planRepair(root).some((a) => a.kind === 'restore-soul'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a large knowledge graph is backed up and compacted', async () => {
  const root = makeWorkspace();
  try {
    const knowledge = path.join(root, '.harness', 'jarvis', 'knowledge.jsonl');
    fs.mkdirSync(path.dirname(knowledge), { recursive: true });
    const line = JSON.stringify({ kind: 'entity', id: 'e1', type: 'file', name: 'PLAN.md', source: 'ambient', observedAt: '2026-09-18T00:00:00.000Z', attributes: { pad: 'x'.repeat(200) } }) + '\n';
    fs.writeFileSync(knowledge, line.repeat(Math.ceil((21 * 1024 * 1024) / line.length)));
    const actions = planRepair(root);
    assert.ok(actions.some((a) => a.kind === 'compact-knowledge'));
    let compactedWith = null;
    const backupDir = await applyRepair(root, actions, new Date('2026-09-23T10:00:00.000Z'), {
      compactKnowledgeGraph: async (dir) => { compactedWith = dir; fs.writeFileSync(knowledge, line); return { before: 2, after: 1 }; },
    });
    assert.equal(compactedWith, root);
    assert.ok(fs.statSync(path.join(backupDir, 'jarvis', 'knowledge.jsonl')).size >= 21 * 1024 * 1024);
    assert.equal(planRepair(root).some((a) => a.kind === 'compact-knowledge'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test and smoke fixtures are moved to the backup, user content stays', async () => {
  const root = makeWorkspace();
  try {
    const h = path.join(root, '.harness');
    fs.writeFileSync(path.join(root, 'IMPLEMENTATION_PLAN.md'), [
      '# Implementation Plan',
      '- [x] real-task — Real finished task',
      '- [ ] set-up-the-project — Set up the project',
      '- [ ] ac24b381-a1b8-4579-8600-dc454f9f7dfe — Kanban move test task',
      '- [ ] my-task — Book the Algarve flights',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(h, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(h, 'documents', '2026-07-09T12-10-23-526Z-server-test-brief-b075ec.md'), 'x');
    fs.writeFileSync(path.join(h, 'documents', '2026-09-01T10-00-00-000Z-trip-plan-abc123.md'), 'mine');
    fs.mkdirSync(path.join(h, 'skills', 'scaffold-test-skill'), { recursive: true });
    fs.mkdirSync(path.join(h, 'skills', 'my-skill'), { recursive: true });
    fs.mkdirSync(path.join(h, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(h, 'uploads', 'sample.png'), 'png');
    fs.writeFileSync(path.join(h, 'uploads', 'holiday.png'), 'a real photo');
    for (const [id, purpose] of [['site_monitor_1', 'Check https://example.com/rooms daily'], ['bullet_journal', 'Maintain a persistent bullet journal']]) {
      fs.mkdirSync(path.join(h, 'services', id), { recursive: true });
      fs.writeFileSync(path.join(h, 'services', id, 'service.json'), JSON.stringify({ service_id: id, purpose }));
    }
    fs.mkdirSync(path.join(h, 'automations'), { recursive: true });
    fs.writeFileSync(path.join(h, 'automations', 'jobs.json'), JSON.stringify({ jobs: [
      { id: 'j1', prompt: 'service_id: site_monitor_1\nmode: operate' },
      { id: 'j2', prompt: 'service_id: bullet_journal\nmode: operate' },
    ] }));

    const backupDir = await applyRepair(root, planRepair(root), new Date('2026-09-23T11:00:00.000Z'));

    assert.equal(fs.readFileSync(path.join(root, 'IMPLEMENTATION_PLAN.md'), 'utf-8'), '# Implementation Plan\n- [x] real-task — Real finished task\n- [ ] my-task — Book the Algarve flights\n');
    assert.deepEqual(fs.readdirSync(path.join(h, 'documents')), ['2026-09-01T10-00-00-000Z-trip-plan-abc123.md']);
    assert.deepEqual(fs.readdirSync(path.join(h, 'skills')), ['my-skill']);
    assert.deepEqual(fs.readdirSync(path.join(h, 'uploads')), ['holiday.png']);
    assert.deepEqual(fs.readdirSync(path.join(h, 'services')), ['bullet_journal']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'automations', 'jobs.json'), 'utf-8')).jobs.map((j) => j.id), ['j2']);
    assert.ok(fs.existsSync(path.join(backupDir, 'services', 'site_monitor_1', 'service.json')));
    assert.ok(fs.existsSync(path.join(backupDir, 'workspace-root', 'IMPLEMENTATION_PLAN.md')));
    assert.deepEqual(planRepair(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
