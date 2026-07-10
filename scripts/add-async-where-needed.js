// One-off fixer used after the v0.5.10 confirm/prompt → toast sweep:
// finds every function / arrow / method that contains an `await` but
// is not declared `async`, and prepends `async ` to it. Idempotent —
// re-running yields zero changes. Uses Babel parser because acorn
// bails at the first stray await even with allowAwaitOutsideFunction.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const target = path.resolve(process.argv[2] || 'ui/app.js');
const src = fs.readFileSync(target, 'utf8');
// Babel parser tolerates stray awaits with errorRecovery: true, so the
// whole file gets parsed and every offender becomes visible in one
// pass.
const ast = parser.parse(src, {
  sourceType: 'script',
  errorRecovery: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
});

const offenders = new Set();
traverse(ast, {
  AwaitExpression(p) {
    const fn = p.getFunctionParent();
    if (fn && !fn.node.async) offenders.add(fn.node);
  },
});

if (offenders.size === 0) {
  console.log('No functions need conversion. File is clean.');
  process.exit(0);
}

// Sort descending by start so earlier inserts don't shift later ones.
const sorted = Array.from(offenders).sort((a, b) => b.start - a.start);
let out = src;
const summary = [];
for (const fn of sorted) {
  const insertAt = fn.start;
  out = out.slice(0, insertAt) + 'async ' + out.slice(insertAt);
  summary.push('  line ' + (fn.loc && fn.loc.start.line) + ' (' + fn.type + ')');
}

fs.writeFileSync(target, out, 'utf8');
console.log('Prepended `async ` to ' + offenders.size + ' function(s):');
console.log(summary.join('\n'));
