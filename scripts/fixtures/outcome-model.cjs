const { cases } = require('../outcome-cases');

globalThis.fetch = async url => {
  const pathname = new URL(url).pathname;
  if (pathname === '/api/tags') {
    if (process.argv.includes('--cloud')) process.stderr.write('offline-cloud-discovery\n');
    return Response.json({ models: [
      { name: 'qwen3:1.7b', digest: 'offline-fixture' },
      { name: 'fixture:cloud', digest: 'offline-cloud-fixture', remote_host: 'https://ollama.com', remote_model: 'fixture' },
    ] });
  }
  if (pathname === '/api/version') return Response.json({ version: 'offline-fixture' });
  if (pathname === '/api/ps') return Response.json({ models: [] });
  throw new Error(`Unexpected network request: ${url}`);
};

const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => spawn(command, ['--require', __filename, ...args], options);

const { OllamaClient } = require('../../dist/core/ollamaClient');
OllamaClient.prototype.getContextWindow = async () => 4096;
OllamaClient.prototype.chat = async function (messages) {
  const task = cases.find(candidate => messages.some(message => message.role === 'user' && message.content === candidate.prompt));
  if (!task) throw new Error('Unknown offline task');
  const turn = messages.filter(message => message.role === 'assistant').length;
  let call;
  if (turn === 0) call = { name: 'file_read', arguments: { path: 'input.json' } };
  else if (turn === 1 && !task.response) {
    if (task.document) {
      const content = ['csv', 'xlsx'].includes(task.format)
        ? { rows: [['owner', 'count'], ['Mira', 7]] }
        : { body: [{ type: 'paragraph', text: 'Mira has 7 items.' }] };
      call = { name: 'document_export', arguments: { path: `out/result.${task.format}`, format: task.format, title: 'Inventory', content } };
    } else call = { name: 'file_write', arguments: { path: 'out/result.json', content: JSON.stringify(task.expected) } };
  }
  process.stderr.write('offline-model-call\n');
  return {
    message: { role: 'assistant', content: call ? '' : task.response ? JSON.stringify(task.response) : 'Done.', ...(call ? { tool_calls: [{ function: call }] } : {}) },
    usage: { promptTokens: 12, completionTokens: 6, totalDurationNs: 1000000 },
  };
};

require('node:http').request = () => { throw new Error('Offline fixture forbids HTTP'); };
require('node:https').request = () => { throw new Error('Offline fixture forbids HTTPS'); };