import { createServer } from 'http';
import type { Socket } from 'net';
import { OllamaClient } from './ollamaClient';

describe('Ollama request cancellation', () => {
  it.each(['chat', 'chatStream'] as const)('%s cancels before headers without cancelling a concurrent call', async method => {
    const sockets = new Set<Socket>();
    let notifyRequest: () => void = () => {};
    const received = new Promise<void>(resolve => { notifyRequest = resolve; });
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests += 1;
      if (requests === 1) {
        notifyRequest();
        return;
      }
      response.setHeader('Content-Type', 'application/x-ndjson');
      response.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n');
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const controller = new AbortController();
    const client = new OllamaClient({ host: `http://127.0.0.1:${address.port}`, model: 'fixture' });
    let timeout: NodeJS.Timeout | undefined;
    const waiting = method === 'chat'
      ? client.chat([{ role: 'user', content: 'wait' }], undefined, controller.signal)
      : client.chatStream([{ role: 'user', content: 'wait' }], undefined, controller.signal).next();
    const pending = waiting.then(() => 'completed', () => 'aborted');
    try {
      await received;
      const independent = client.chat([{ role: 'user', content: 'independent' }]);
      controller.abort();
      const result = await Promise.race([
        pending,
        new Promise<string>(resolve => { timeout = setTimeout(() => resolve('still waiting for headers'), 1000); }),
      ]);
      expect(result).toBe('aborted');
      await expect(independent).resolves.toMatchObject({
        message: { content: 'ok' },
      });
      expect(requests).toBe(2);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await pending;
    }
  });
});