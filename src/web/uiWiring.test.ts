import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf-8');
const appJs = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf-8');
const serverTs = fs.readFileSync(path.join(root, 'src', 'web', 'server.ts'), 'utf-8');

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
    expect(indexHtml).toContain('beginnerReadiness');
    expect(indexHtml).toContain('beginnerReadinessBadge');
    expect(appJs).toContain('function setBeginnerReadiness');
    expect(appJs).toContain('Start Ollama first');
    expect(appJs).toContain('Install one model');
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
    const serverRoutes = new Set([...serverTs.matchAll(/app\.(?:get|post|patch|put|delete)\('([^']+)'/g)].map((match) => normalizeServerRoute(match[1])));
    const uiRoutes = [...new Set(extractFetchExpressions(appJs).map(normalizeUiFetchPath).filter((route): route is string => Boolean(route)))].sort();
    const missing = uiRoutes.filter((route) => !serverRoutes.has(route));

    expect(missing).toEqual([]);
  });
});