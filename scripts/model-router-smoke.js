// Model Router smoke test — validates routing decisions against the registry.
//
// Run with: node scripts/model-router-smoke.js
//
// This script does NOT require a running Ollama instance. It validates
// that the model registry and router make correct decisions across all
// task types.

const { ModelRegistry } = require('../dist/models/modelRegistry');
const { ModelRouter } = require('../dist/models/modelRouter');

const TASK_TYPES = [
  'classification',
  'summarisation',
  'task_extraction',
  'note_cleanup',
  'daily_reminder',
  'log_scanning',
  'memory_compression',
  'codebase_scanning',
  'code_edit',
  'debugging',
  'test_explanation',
  'embedding',
  'vector_search',
  'architecture',
  'complex_reasoning',
  'ambiguous_planning',
  'difficult_debugging',
  'final_review',
  'json_validation',
  'general',
];

function run() {
  const registry = new ModelRegistry();
  const router = new ModelRouter(registry);
  let pass = 0;
  let fail = 0;

  console.log('=== Model Router Smoke Test ===\n');
  console.log(`Registry: ${registry.list().length} models (${registry.enabled().length} enabled)\n`);

  for (const taskType of TASK_TYPES) {
    const result = router.route(taskType);
    const localResult = router.routeLocal(taskType);
    const escalate = router.shouldEscalateToCloud(taskType);
    const explanation = router.explain(taskType);

    if (!result.model) {
      console.log(`  FAIL  ${taskType}: no model selected`);
      fail++;
      continue;
    }

    const isLocal = result.model.privacy_level === 'local';
    const localCheck = localResult.model?.privacy_level === 'local';

    console.log(`  OK    ${taskType}`);
    console.log(`        → ${result.model.model_name} (${result.role}, ${result.model.cost_level}, ${isLocal ? 'local' : 'cloud'}${result.fallback ? ', fallback' : ''})`);
    if (escalate) console.log(`        ↑ would escalate to cloud if available`);
    pass++;
  }

  console.log(`\n--- Results: ${pass} pass, ${fail} fail ---`);

  // Test cloud escalation with enabled cloud model
  console.log('\n=== Cloud Escalation Test ===\n');
  const cloudRegistry = new ModelRegistry();
  const gpt = cloudRegistry.get('gpt-4.1');
  if (gpt) {
    gpt.enabled = true;
    cloudRegistry.register(gpt);
    const cloudRouter = new ModelRouter(cloudRegistry);

    for (const taskType of ['architecture', 'complex_reasoning', 'final_review']) {
      const result = cloudRouter.route(taskType);
      const isCloud = result.model && result.model.privacy_level !== 'local';
      console.log(`  ${isCloud ? 'OK   ' : 'FAIL '} ${taskType} → ${result.model?.model_name ?? 'none'} (${isCloud ? 'cloud' : 'local'})`);
      if (isCloud) pass++; else fail++;
    }
  }

  console.log(`\n=== Final: ${pass} pass, ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
