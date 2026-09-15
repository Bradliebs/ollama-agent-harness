const fs = require('node:fs/promises');
const path = require('node:path');

const files = {
  'src/app.ts': `const quantity = document.querySelector<HTMLInputElement>('#quantity')!;
const price = document.querySelector<HTMLInputElement>('#price')!;
const result = document.querySelector<HTMLOutputElement>('#total')!;
document.querySelector<HTMLFormElement>('form')!.addEventListener('submit', event => {
  event.preventDefault();
  result.value = (Number(quantity.value) * Number(price.value)).toFixed(2);
});
`,
  'index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order total</title>
<style>body{font-family:Georgia,serif;margin:24px;max-width:480px}form{display:grid;gap:12px}input,button{box-sizing:border-box;width:100%;padding:8px;font:inherit}output{display:block;font-size:24px;margin-top:20px}</style></head>
<body><h1>Order total</h1><form><label>Quantity<input id="quantity" type="number" min="0" step="1" required></label><label>Unit price<input id="price" type="number" min="0" step="0.01" required></label><button type="submit">Calculate</button></form><output id="total" aria-live="polite">0.00</output><script src="dist/app.js"></script></body></html>
`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], types: [], strict: true, outDir: 'dist' }, include: ['src/*.ts'] }),
};

async function main() {
  const { queryLoop } = require('../../dist/core/queryLoop');
  const { FileWriteTool } = require('../../dist/tools/fileTools');
  const workspace = process.cwd();
  const entries = Object.entries(files);
  let turn = 0;
  const client = { chat: async () => {
    const entry = entries[turn++];
    return { message: entry
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path: path.resolve(workspace, entry[0]), content: entry[1] } } }] }
      : { role: 'assistant', content: 'App files written.' },
    usage: { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 } };
  } };
  const events = [];
  for await (const event of queryLoop({ model: 'offline-app-fixture', systemPrompt: 'Build the requested app.', maxTurns: 4, context: { enabled: false } }, {
    client, tools: [FileWriteTool],
    permissionCheck: async call => ({ allowed: call.name === 'file_write' && entries.some(([name]) => path.resolve(workspace, name) === path.resolve(workspace, String(call.input.path))), reason: 'Only the three app fixture files are authorized.' }),
  }, [{ role: 'user', content: 'Build an order-total calculator with quantity, unit price, Calculate, and a total to two decimals.' }])) events.push(event);
  await fs.writeFile('events.json', JSON.stringify(events));
}

module.exports = { files };
if (require.main === module) {
  globalThis.fetch = async () => { throw new Error('App fixture forbids network access'); };
  require('node:http').request = () => { throw new Error('App fixture forbids HTTP'); };
  require('node:https').request = () => { throw new Error('App fixture forbids HTTPS'); };
  main().catch(error => { console.error(error); process.exitCode = 1; });
}