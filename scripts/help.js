#!/usr/bin/env node
// Friendly menu of the npm scripts a beginner actually needs.
// `npm run` lists all 50+ scripts, which is overwhelming. This prints only
// the handful that a non-developer is likely to want.

const c = (s, code) => process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s) => c(s, '1');
const dim = (s) => c(s, '2');
const cyan = (s) => c(s, '36');
const green = (s) => c(s, '32');

const sections = [
  {
    title: 'Most common',
    items: [
      ['npm run ui', 'Start the web UI (then open http://localhost:3000)'],
      ['npm test', 'Run the test suite'],
      ['npm run build', 'Compile TypeScript to JavaScript'],
    ],
  },
  {
    title: 'For developers',
    items: [
      ['npm run dev', 'Run the CLI directly via ts-node (no build needed)'],
      ['npm start', 'Run the compiled CLI (run `npm run build` first)'],
      ['npm run typecheck', 'Type-check the project without emitting files'],
      ['npm run serve', 'Run the compiled web server'],
    ],
  },
  {
    title: 'Hands-off / autonomy',
    items: [
      ['npm run autonomy', 'Start a self-directed task loop'],
      ['npm run autonomy:stop', 'Tell the autonomy loop to halt at the next checkpoint'],
      ['npm run autonomy:reset', 'Clear any stale autonomy stop/state files'],
    ],
  },
];

console.log('');
console.log(bold(cyan('Ollama Agent Harness — common commands')));
console.log(dim('First time here? Run:  ') + green('npm run ui'));
console.log('');

for (const section of sections) {
  console.log(bold(section.title));
  for (const [cmd, desc] of section.items) {
    console.log('  ' + green(cmd.padEnd(28)) + ' ' + dim(desc));
  }
  console.log('');
}

console.log(dim('There are ~50 other internal scripts (smoke tests, diagnostics, release tooling).'));
console.log(dim('Run `npm run` to see them all.'));
console.log('');
