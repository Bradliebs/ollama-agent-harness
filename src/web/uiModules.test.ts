import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf-8');
const appJs = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf-8');

const movedModules = [
  { file: 'snapshotsPanel.js', fn: 'async function loadSnapshots(' },
  { file: 'localRagPanel.js', fn: 'async function loadRagTab(' },
  { file: 'localToolsDashboard.js', fn: 'async function loadToolsDashboard(' },
  { file: 'runsPanel.js', fn: 'async function loadRuns(' },
  { file: 'workflowsPanel.js', fn: 'async function loadWorkflows(' },
  { file: 'healthMyceliumPanel.js', fn: 'async function loadMycelium(' },
  { file: 'promisesEventsPanels.js', fn: 'async function loadPromises(' },
  { file: 'codeIntelPanel.js', fn: 'async function loadCodeIntel(' },
];

describe('classic UI modules moved out of app.js', () => {
  it('loads each moved module before app.js', () => {
    const appIdx = indexHtml.indexOf('src="./app.js');
    expect(appIdx).toBeGreaterThan(-1);
    for (const { file } of movedModules) {
      const idx = indexHtml.indexOf(`src="./${file}?v=1"`);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(appIdx);
    }
  });

  it('keeps moved declarations in their module and out of app.js', () => {
    for (const { file, fn } of movedModules) {
      const moduleJs = fs.readFileSync(path.join(root, 'ui', file), 'utf-8');
      expect(moduleJs).toContain(fn);
      expect(appJs).not.toContain(fn);
    }
  });
});
