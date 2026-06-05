import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf-8');
const appJs = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf-8');
const serverTs = fs.readFileSync(path.join(root, 'src', 'web', 'server.ts'), 'utf-8');
const goalRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'goalRoutes.ts'), 'utf-8');
const identityRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'identityRoutes.ts'), 'utf-8');
const taskRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'taskRoutes.ts'), 'utf-8');
const promiseRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'promiseRoutes.ts'), 'utf-8');
const profileRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'profileRoutes.ts'), 'utf-8');
const evalRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'evalRoutes.ts'), 'utf-8');
const memoryHealthRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'memoryHealthRoutes.ts'), 'utf-8');
const scanRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'scanRoutes.ts'), 'utf-8');
const promptsRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'promptsRoutes.ts'), 'utf-8');
const eventRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'eventRoutes.ts'), 'utf-8');
const doneStateRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'doneStateRoutes.ts'), 'utf-8');
const codeIntelRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'codeIntelRoutes.ts'), 'utf-8');
const myceliumRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'myceliumRoutes.ts'), 'utf-8');
const traceRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'traceRoutes.ts'), 'utf-8');
const snapshotRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'snapshotRoutes.ts'), 'utf-8');
const historyRoutesTs = fs.readFileSync(path.join(root, 'src', 'web', 'historyRoutes.ts'), 'utf-8');

const inlineGlobals = new Set([
  'alert',
  'Boolean',
  'clearInterval',
  'clearTimeout',
  'confirm',
  'function',
  'if',
  'Number',
  'parseFloat',
  'parseInt',
  'prompt',
  'setInterval',
  'setTimeout',
  'String',
  'var',
]);

function definedFunctions(source: string): Set<string> {
  return new Set([...source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
}

function inlineHandlerBodies(source: string): string[] {
  return [...source.matchAll(/\bon(?:click|change|input|keydown|paste|drop|dragover|dragleave)="([^"]+)"/g)].map((match) => match[1]);
}

function calledInlineFunctions(body: string): string[] {
  return [...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => !inlineGlobals.has(name));
}

function extractFetchExpressions(source: string): string[] {
  const expressions: string[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('fetch(', index);
    if (start === -1) break;
    let cursor = start + 'fetch('.length;
    let depth = 0;
    let quote = '';
    let escaped = false;
    let expression = '';

    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (quote) {
        expression += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = '';
        }
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        quote = char;
        expression += char;
        continue;
      }
      if (char === '(') {
        depth += 1;
        expression += char;
        continue;
      }
      if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
        expression += char;
        continue;
      }
      if (char === ',' && depth === 0) break;
      expression += char;
    }

    expressions.push(expression.trim());
    index = cursor + 1;
  }
  return expressions;
}

function stripQuery(pathValue: string): string {
  return pathValue.replace(/[?#].*$/, '');
}

function normalizeUiFetchPath(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.startsWith('`')) {
    const literal = trimmed.slice(1, trimmed.lastIndexOf('`')).replace(/\$\{[^}]+\}/g, ':param');
    return literal.startsWith('/api/') ? stripQuery(literal) : null;
  }

  const literals = [...trimmed.matchAll(/(['"])((?:\\.|(?!\1).)*?)\1/g)].map((match) => match[2]);
  if (!literals.length || !literals[0].startsWith('/api/')) return null;
  if (!trimmed.includes('+')) return stripQuery(literals[0]);
  if (literals[0].includes('?')) return stripQuery(literals[0]);

  let pathValue = literals[0];
  for (const literal of literals.slice(1)) pathValue += ':param' + literal;
  if (literals.length === 1 && pathValue.endsWith('/')) pathValue += ':param';
  return stripQuery(pathValue);
}

function normalizeServerRoute(route: string): string {
  return route.replace(/:[A-Za-z_$][\w$]*/g, ':param');
}

describe('web UI wiring', () => {
  it('loads helper components before the app uses them', () => {
    const scripts = [...indexHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);

    expect(scripts.findIndex((script) => script.includes('chatHistory.js'))).toBeLessThan(scripts.findIndex((script) => script.includes('app.js')));
    expect(scripts.findIndex((script) => script.includes('toolActivity.js'))).toBeLessThan(scripts.findIndex((script) => script.includes('app.js')));
    expect(appJs).toContain('window.HarnessChatHistory');
    expect(appJs).toContain('HarnessToolActivity.createToolActivityBox');
    expect(appJs).toContain('HarnessToolActivity.updateToolActivitySummary');
  });

  it('surfaces model retry events and debug log settings in the UI', () => {
    expect(appJs).toContain("case 'model_retry'");
    expect(appJs).toContain('toggleModelDebugLog');
    expect(appJs).toContain("updateSetting('modelDebugLog'");
    expect(indexHtml).toContain('modelDebugLogToggle');
    expect(indexHtml).toContain('modelDebugLogPath');
  });

  it('keeps the beginner first-chat readiness surface wired', () => {
    // The legacy beginner-readiness banner + model-capability-hint were
    // removed in the v0.5.10 welcome trim. The replacement surfaces are
    // the no-model banner (with concrete "ollama pull" / "ollama serve"
    // instructions and a Refresh button), the quick-start panel, and the
    // first-visit onboarding modal. This test guards against accidental
    // regression of that beginner-friendly first-chat experience.
    expect(indexHtml).toContain('noModelBanner');
    expect(indexHtml).toContain('quickStartHint');
    expect(indexHtml).toContain('onboardModal');
    expect(appJs).toContain('function updateNoModelEmptyState');
    expect(appJs).toContain('shouldShowOnboardModal');
    // Concrete remediation text must be wired so beginners see the fix,
    // not a bare "Server not running" message.
    expect(appJs).toContain('ollama pull llama3.2');
    expect(appJs).toContain('ollama serve');
  });

  it('keeps tool-only final replies readable', () => {
    expect(appJs).toContain('function summarizeToolOnlyResult');
    expect(appJs).toContain('function buildToolOnlyFallback');
    expect(appJs).toContain('What I could see from the tool results');
    expect(appJs).not.toContain('Done. The model used tools, but did not return a readable final message.');
  });

  it('opens to a fresh chat instead of auto-restoring the previous one', () => {
    expect(appJs).toContain('let chatMessages = [];');
    expect(appJs).toContain('let currentChatId = null;');
    expect(appJs).not.toContain('const persisted = loadPersistedChatSession();');
    expect(appJs).not.toContain('Restore prior chat session');
  });

  it('fully hides the resizable left panel when closed', () => {
    expect(indexHtml).toContain('--left-panel-width:300px');
    expect(indexHtml).toContain('margin-left:calc(-1 * var(--left-panel-width))');
    expect(indexHtml).toContain('transform:translateX(-100%)');
    expect(indexHtml).toContain('left-panel-close');
    expect(appJs).toContain("panel.style.setProperty('--left-panel-width'");
    expect(appJs).toContain("panel.classList.toggle('visible', !hidden)");
    expect(indexHtml).not.toContain('.left-panel.hidden{margin-left:-300px}');
  });

  it('keeps panel toggle and backdrop dismiss functions wired', () => {
    expect(appJs).toContain('function toggleLeft()');
    expect(appJs).toContain('function toggleRight()');
    expect(appJs).toContain('function updatePanelBackdrop()');
    expect(appJs).toContain('function dismissPanelBackdrop()');
    expect(indexHtml).toContain('id="panelBackdrop"');
    expect(indexHtml).toContain('panel-backdrop');
    expect(indexHtml).toContain('onclick="dismissPanelBackdrop()"');
  });

  it('guards against marked.js CDN failure', () => {
    expect(appJs).toContain("if (typeof marked === 'undefined')");
    expect(appJs).toContain('window.marked =');
  });

  it('keeps inline controls connected to global app functions', () => {
    const definitions = definedFunctions(appJs);
    const missing = inlineHandlerBodies(indexHtml + '\n' + appJs)
      .flatMap(calledInlineFunctions)
      .filter((name) => !definitions.has(name));

    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it('keeps every left-panel tab connected to a view and loader', () => {
    const tabs = [...indexHtml.matchAll(/showLeftTab\('([^']+)'/g)].map((match) => match[1]);
    const expectedViews: Record<string, string> = {
      history: 'historyList',
      files: 'fileTree',
      skills: 'skillList',
      memory: 'memoryView',
      palace: 'memoryPalaceView',
      discovery: 'discoveryView',
      learning: 'learningView',
      snapshots: 'snapshotsView',
      rag: 'ragView',
      tools: 'toolsDashboardView',
      runs: 'runsView',
      workflows: 'workflowsView',
      mycelium: 'myceliumView',
      promises: 'promisesView',
      events: 'eventsView',
      codeintel: 'codeintelView',
      tasks: 'tasksView',
      audit: 'auditView',
      triggers: 'triggersView',
      agents: 'agentsView',
      squads: 'squadsView',
      identity: 'identityView',
      health: 'healthView',
    };
    const showLeftTab = appJs.match(/function showLeftTab\(tab, el\) \{(?<body>.*?)\nfunction toggleLeft/s)?.groups?.body ?? '';

    for (const tab of tabs) {
      const viewId = expectedViews[tab];
      expect(viewId).toBeDefined();
      expect(indexHtml).toContain(`id="${viewId}"`);
      expect(showLeftTab).toContain(`tab === '${tab}'`);
      expect(showLeftTab).toContain(`'${viewId}'`);
    }
  });

  it('keeps UI API calls backed by server routes', () => {
    const appRoutes = [...serverTs.matchAll(/app\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const goalRouterRoutes = [...goalRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const identityRouterRoutes = [...identityRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const taskRouterRoutes = [...taskRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const promiseRouterRoutes = [...promiseRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const profileRouterRoutes = [...profileRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const evalRouterRoutes = [...evalRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const memoryHealthRouterRoutes = [...memoryHealthRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const scanRouterRoutes = [...scanRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const promptsRouterRoutes = [...promptsRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const eventRouterRoutes = [...eventRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const doneStateRouterRoutes = [...doneStateRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const codeIntelRouterRoutes = [...codeIntelRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const myceliumRouterRoutes = [...myceliumRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const traceRouterRoutes = [...traceRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const snapshotRouterRoutes = [...snapshotRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const historyRouterRoutes = [...historyRoutesTs.matchAll(/router\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1]));
    const serverRoutes = new Set([...appRoutes, ...goalRouterRoutes, ...identityRouterRoutes, ...taskRouterRoutes, ...promiseRouterRoutes, ...profileRouterRoutes, ...evalRouterRoutes, ...memoryHealthRouterRoutes, ...scanRouterRoutes, ...promptsRouterRoutes, ...eventRouterRoutes, ...doneStateRouterRoutes, ...codeIntelRouterRoutes, ...myceliumRouterRoutes, ...traceRouterRoutes, ...snapshotRouterRoutes, ...historyRouterRoutes]);
    const uiRoutes = [...new Set(extractFetchExpressions(appJs).map(normalizeUiFetchPath).filter((route): route is string => Boolean(route)))].sort();

    // A UI route like '/api/foo/:param' is satisfied either by an exact match
    // (Express `:foo` placeholder) or by any concrete sibling route under the
    // same prefix — e.g. UI calls '/api/jarvis/ambient/' + action and the
    // server registers '/api/jarvis/ambient/start' and '.../stop' as the only
    // valid actions. Without this the test forces every UI string-concat
    // fetch to be backed by an Express-level wildcard, which would weaken
    // the server's input validation.
    const missing = uiRoutes.filter((route) => {
      if (serverRoutes.has(route)) return false;
      if (route.endsWith('/:param')) {
        const prefix = route.slice(0, -':param'.length);
        for (const serverRoute of serverRoutes) {
          if (serverRoute.startsWith(prefix) && serverRoute.length > prefix.length) {
            return false;
          }
        }
      }
      if (route.endsWith('/:param/')) {
        const prefix = route.slice(0, -':param/'.length);
        for (const serverRoute of serverRoutes) {
          if (serverRoute.startsWith(prefix) && serverRoute.length > prefix.length) {
            return false;
          }
        }
      }
      return true;
    });

    expect(missing).toEqual([]);
  });

  it('exposes a per-goal Undo control wired to the undo route', () => {
    // The Undo button lets a user roll back a goal run's recorded side effects.
    // It is keyed by goal.id via the container dataset, posts to the undo
    // route, and surfaces the revert summary.
    expect(appJs).toContain("class=\"goal-run-undo\"");
    expect(appJs).toContain("goalRunControl(el, 'undo')");
    expect(appJs).toContain("if (action === 'undo')");
    expect(appJs).toContain('Undone: reverted ');
    // finalizeGoalRunControls disables pause/abandon but must leave Undo usable
    // after the run ends, since undo is a post-run recovery action.
    const finalizeBody = appJs.slice(appJs.indexOf('function finalizeGoalRunControls'));
    expect(finalizeBody.slice(0, 200)).not.toContain('goal-run-undo');
  });
});