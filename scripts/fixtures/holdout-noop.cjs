globalThis.fetch = async url => {
  const target = new URL(url);
  if (target.origin !== 'http://127.0.0.1:11434') throw new Error('Unexpected fixture origin');
  if (target.pathname === '/api/tags') return Response.json({ models: [{ name: 'qwen3:1.7b', digest: 'offline-negative-control' }] });
  if (target.pathname === '/api/version') return Response.json({ version: 'offline-negative-control' });
  if (target.pathname === '/api/ps') return Response.json({ models: [] });
  throw new Error('Offline control forbids inference');
};

const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => spawn(command, ['--require', __filename, ...args], options);

const { OllamaClient } = require('../../dist/core/ollamaClient');
OllamaClient.prototype.getContextWindow = async () => 4096;
OllamaClient.prototype.chat = async () => ({ message: { role: 'assistant', content: 'Done.' } });
require('node:http').request = () => { throw new Error('Offline control forbids HTTP'); };
require('node:https').request = () => { throw new Error('Offline control forbids HTTPS'); };