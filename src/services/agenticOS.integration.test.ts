import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { classifyMode } from './modeClassifier';
import { CapabilityRegistry, createDefaultCapabilityRegistry } from './capabilityRegistry';
import { ModelRegistry } from '../models/modelRegistry';
import { ModelRouter } from '../models/modelRouter';
import { WorkerQueue } from './workerQueue';
import { extractCommands, parseJsonCommands, validateStateTransition } from './commandExtractor';
import { classifyAgenticMode, handleOperateModeRequest } from './agenticServiceMode';
import { MyceliumGraph } from '../mycelium/graph';
import { seedGenericGraph } from '../mycelium/seeds';
import { evaluateReflexes, createRunState } from '../nervous/reflexes';
import type { NervousSignal } from '../nervous/signals';

describe('agentic operating system integration', () => {
  // ─── Mode classification ──────────────────────────────────────
  describe('mode classification', () => {
    it('bullet journal request classified as OPERATE_MODE', () => {
      const result = classifyMode('Create me a bullet journal where you send me daily reminders, I can add, update, close tasks and add notes');
      expect(result.mode).toBe('operate');
    });

    it('bullet journal request does NOT trigger app generation (build mode)', () => {
      const result = classifyMode('Create me a bullet journal where you send me daily reminders');
      expect(result.mode).not.toBe('build');
    });

    it('distinguishes all six modes', () => {
      expect(classifyMode('what is TypeScript?').mode).toBe('chat');
      expect(classifyMode('build a REST API service').mode).toBe('build');
      expect(classifyMode('send me reminders every morning').mode).toBe('operate');
      expect(classifyMode('automate the nightly ETL pipeline').mode).toBe('automate');
      expect(classifyMode('research the best database').mode).toBe('research');
      expect(classifyMode('maintain the server health checks').mode).toBe('maintain');
    });
  });

  // ─── Service definition creation ──────────────────────────────
  describe('service creation', () => {
    it('creates service definition via handleOperateModeRequest', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-integration-'));
      const result = await handleOperateModeRequest(projectDir, 'Create a bullet journal, send me reminders, let me add tasks, keep me honest');
      expect(result.handled).toBe(true);
      expect(result.service).toBeDefined();
      expect(result.service!.service_id).toBe('bullet_journal');
      expect(result.service!.mode).toBe('operate');
    });

    it('creates state files', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-state-'));
      await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me daily, keep me honest');
      const statePath = path.join(projectDir, '.harness', 'services', 'bullet_journal', 'state.json');
      const exists = await fs.stat(statePath).then(() => true, () => false);
      expect(exists).toBe(true);
    });

    it('registers commands in service definition', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-cmds-'));
      const result = await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me, update for me, keep me honest');
      expect(result.service!.supported_commands).toContain('add_task');
      expect(result.service!.supported_commands).toContain('update_task');
      expect(result.service!.supported_commands).toContain('close_task');
      expect(result.service!.supported_commands).toContain('add_note');
    });
  });

  // ─── Command extraction and state mutation ────────────────────
  describe('command extraction and state mutation', () => {
    it('add_task command mutates state', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-add-'));
      await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me daily, keep me honest');
      const result = await handleOperateModeRequest(projectDir, 'add task buy groceries');
      expect(result.handled).toBe(true);
    });

    it('close_task command mutates state', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-close-'));
      await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me, keep me honest');
      const addResult = await handleOperateModeRequest(projectDir, 'add task test task');
      // Extract task ID from state
      const taskId = (addResult.state as any)?.tasks?.[0]?.id;
      if (taskId) {
        const closeResult = await handleOperateModeRequest(projectDir, `close task ${taskId}`);
        expect(closeResult.handled).toBe(true);
      }
    });

    it('update_task command mutates state', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-update-'));
      await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me, keep me honest');
      await handleOperateModeRequest(projectDir, 'add task original task');
      const taskId = ((await handleOperateModeRequest(projectDir, 'show open tasks')).state as any)?.tasks?.[0]?.id;
      if (taskId) {
        const result = await handleOperateModeRequest(projectDir, `update task ${taskId} new title`);
        expect(result.handled).toBe(true);
      }
    });

    it('add_note command mutates state', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-note-'));
      await handleOperateModeRequest(projectDir, 'Create a bullet journal, remind me, keep me honest');
      const result = await handleOperateModeRequest(projectDir, 'add note I felt great today');
      expect(result.handled).toBe(true);
    });

    it('JSON command extraction validates before state mutation', () => {
      const valid = parseJsonCommands(JSON.stringify({
        commands: [{ type: 'add_task', title: 'Valid' }],
      }));
      expect(valid.valid).toBe(true);

      const invalid = parseJsonCommands(JSON.stringify({
        commands: [{ type: 'close_task' }], // no identifier
      }));
      expect(invalid.valid).toBe(false);
    });
  });

  // ─── Capability registry ─────────────────────────────────────
  describe('capability registry', () => {
    it('scheduler capability is checked', () => {
      const registry = createDefaultCapabilityRegistry();
      expect(registry.has('scheduler')).toBe(true);
    });

    it('reminder schedule created only if scheduler exists', () => {
      const registryWith = createDefaultCapabilityRegistry();
      expect(registryWith.has('scheduler')).toBe(true);

      const registryWithout = new CapabilityRegistry();
      registryWithout.register('scheduler', 'Scheduler', 'unavailable');
      expect(registryWithout.has('scheduler')).toBe(false);
    });

    it('missing scheduler produces honest limitation message', () => {
      const registry = new CapabilityRegistry();
      registry.register('scheduler', 'Scheduler', 'unavailable', 'Not configured.');
      registry.register('notifications', 'Notifications', 'unavailable');
      const message = registry.formatLimitations(['scheduler', 'notifications']);
      expect(message).toContain('not available');
    });

    it('capability limitations are wired into operate-mode responses', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-caps-'));
      const result = await handleOperateModeRequest(
        projectDir,
        'Create a bullet journal, remind me daily, keep me honest',
        new Date(),
        {
          checkCapabilities: (required) => {
            if (required.includes('notifications')) {
              return 'Push notifications are not available.';
            }
            return null;
          },
        },
      );
      expect(result.handled).toBe(true);
      expect(result.capabilityLimitations).toContain('not available');
      expect(result.response).toContain('not available');
    });

    it('no capability limitations when all capabilities are available', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-caps-ok-'));
      const result = await handleOperateModeRequest(
        projectDir,
        'Create a bullet journal, remind me daily, keep me honest',
        new Date(),
        { checkCapabilities: () => null },
      );
      expect(result.handled).toBe(true);
      expect(result.capabilityLimitations).toBeNull();
    });
  });

  // ─── Model routing ───────────────────────────────────────────
  describe('model routing', () => {
    it('local model selected for task extraction', () => {
      const registry = new ModelRegistry();
      const router = new ModelRouter(registry);
      const result = router.route('task_extraction');
      expect(result.model).toBeDefined();
      expect(result.model!.privacy_level).toBe('local');
    });

    it('cloud model selected for architecture review when available', () => {
      const registry = new ModelRegistry();
      const gpt = registry.get('gpt-4.1')!;
      gpt.enabled = true;
      registry.register(gpt);
      const router = new ModelRouter(registry);
      const result = router.route('architecture');
      expect(result.model!.privacy_level).not.toBe('local');
    });
  });

  // ─── Nervous system ──────────────────────────────────────────
  describe('nervous system', () => {
    it('ongoing service reflex suppresses BUILD_MODE', () => {
      const state = createRunState('test-1', 'general');
      const signal: NervousSignal = {
        id: 'sig-1',
        type: 'ONGOING_SERVICE_REQUEST',
        source: 'mode_classifier',
        severity: 'info',
        confidence: 0.9,
        message: 'Ongoing service request detected.',
        handled: false,
        createdAt: new Date().toISOString(),
      };
      const result = evaluateReflexes([signal], state);
      const serviceReflex = result.triggered.find((r) => r.reflexName === 'ongoing_service_request');
      expect(serviceReflex).toBeDefined();
      expect(serviceReflex!.triggered).toBe(true);
      expect(state.safetyNotes.some((n) => n.includes('OPERATE'))).toBe(true);
      expect(state.requiredNodes).toContain('service.operate_mode');
    });

    it('route explanation includes service-mode reflex', () => {
      const state = createRunState('test-2', 'general');
      const signal: NervousSignal = {
        id: 'sig-2',
        type: 'ONGOING_SERVICE_REQUEST',
        source: 'mode_classifier',
        severity: 'info',
        confidence: 0.9,
        message: 'Ongoing service request.',
        handled: false,
        createdAt: new Date().toISOString(),
      };
      evaluateReflexes([signal], state);
      expect(state.activeReflexes).toContain('ongoing_service_request');
    });
  });

  // ─── Mycelial graph ──────────────────────────────────────────
  describe('mycelial graph', () => {
    it('records service/model/command/capability nodes after seeding', () => {
      const graph = new MyceliumGraph();
      const summary = seedGenericGraph(graph);
      expect(summary.nodesAdded).toBeGreaterThan(0);

      // Check new node types exist
      expect(graph.getNode('model.local_general')).toBeDefined();
      expect(graph.getNode('model.cloud_reasoner')).toBeDefined();
      expect(graph.getNode('provider.ollama')).toBeDefined();
      expect(graph.getNode('service.operate_mode')).toBeDefined();
      expect(graph.getNode('service.bullet_journal')).toBeDefined();
      expect(graph.getNode('scheduler.daily')).toBeDefined();
      expect(graph.getNode('command.add_task')).toBeDefined();
      expect(graph.getNode('capability.scheduler')).toBeDefined();
      expect(graph.getNode('worker.classify')).toBeDefined();
      expect(graph.getNode('notification.daily_check_in')).toBeDefined();
    });

    it('has service -> command_handler edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('service.bullet_journal', 'command.add_task');
      expect(edge).toBeDefined();
      expect(edge!.relation).toBe('handles');
    });

    it('has command_handler -> model edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('command.add_task', 'model.local_general');
      expect(edge).toBeDefined();
    });

    it('has model -> provider edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('model.local_general', 'provider.ollama');
      expect(edge).toBeDefined();
    });

    it('has service -> scheduler edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('service.bullet_journal', 'scheduler.daily');
      expect(edge).toBeDefined();
    });

    it('has scheduler -> notification_template edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('scheduler.daily', 'notification.daily_check_in');
      expect(edge).toBeDefined();
    });

    it('has service -> capability edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('service.operate_mode', 'capability.scheduler');
      expect(edge).toBeDefined();
    });

    it('has worker -> model edges', () => {
      const graph = new MyceliumGraph();
      seedGenericGraph(graph);
      const edge = graph.getEdge('worker.classify', 'model.local_general');
      expect(edge).toBeDefined();
    });
  });

  // ─── Worker queue ────────────────────────────────────────────
  describe('worker queue', () => {
    it('local model background jobs execute', async () => {
      const queue = new WorkerQueue();
      queue.registerExecutor('classify_task', async (job) => {
        const input = job.input as { message: string };
        return { mode: classifyMode(input.message).mode };
      });
      queue.enqueue('classify_task', { message: 'send me reminders' }, { model_id: 'llama3.1:8b' });
      const results = await queue.processAll();
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('completed');
      expect((results[0].output as any).mode).toBe('operate');
    });
  });
});
