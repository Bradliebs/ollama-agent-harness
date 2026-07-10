import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { once } from 'events';
import { WebSocket } from 'ws';
import express from 'express';
import { attachWsServer } from './wsServer';
import { emitEvent } from '../persistence/eventStore';

describe('attachWsServer', () => {
  let projectDir: string;
  let httpServer: http.Server;
  let wsHandle: ReturnType<typeof attachWsServer>;
  let port: number;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ws-'));
    const app = express();
    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    port = address.port;
    wsHandle = attachWsServer(httpServer);
  });

  afterEach(async () => {
    await wsHandle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!predicate()) throw new Error('waitFor: predicate did not become true');
  }

  it('greets new clients with a hello message', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const [data] = await once(client, 'message') as [Buffer];
    const message = JSON.parse(data.toString());
    expect(message.type).toBe('hello');
    expect(message.protocol).toBe('harness-ws/1');
    client.close();
    await once(client, 'close');
  }, 15000);

  it('broadcasts harness events to connected clients', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.on('message', (data: Buffer) => {
      messages.push(JSON.parse(data.toString()));
    });
    await once(client, 'open');
    // Wait for hello to be received and for the server-side connection
    // handler to have registered the new client (Windows can run these in
    // either order).
    await waitFor(() => messages.length >= 1 && wsHandle.clientCount() === 1);
    expect(messages[0].type).toBe('hello');

    await emitEvent(projectDir, 'task', 'task.created', { id: 't-1', title: 'demo' }, 'test');
    await waitFor(() => messages.length >= 2);
    const eventMsg = messages[1] as { type: string; event: { category: string; type: string; data: unknown } };
    expect(eventMsg.type).toBe('event');
    expect(eventMsg.event.category).toBe('task');
    expect(eventMsg.event.type).toBe('task.created');
    expect(eventMsg.event.data).toEqual({ id: 't-1', title: 'demo' });
    client.close();
    await once(client, 'close');
  }, 15000);

  it('tracks client count', async () => {
    expect(wsHandle.clientCount()).toBe(0);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(client, 'open');
    await waitFor(() => wsHandle.clientCount() === 1);
    expect(wsHandle.clientCount()).toBe(1);
    client.close();
    await once(client, 'close');
    await waitFor(() => wsHandle.clientCount() === 0);
    expect(wsHandle.clientCount()).toBe(0);
  }, 15000);
});

describe('attachWsServer backpressure', () => {
  let projectDir: string;
  let httpServer: http.Server;
  let port: number;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ws-bp-'));
    const app = express();
    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('drops slow clients with an overflow notice when the buffer fills', async () => {
    // Force the backpressure check to always return true so the queue can
    // never drain — every emitEvent fills another slot.
    const wsHandle = attachWsServer(httpServer, { bufferSize: 4, isBackpressuredFn: () => true });
    try {
      const messages: Array<Record<string, unknown>> = [];
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.on('message', (data: Buffer) => { messages.push(JSON.parse(data.toString())); });
      await once(client, 'open');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Bombard the broadcaster well past the buffer cap.
      for (let i = 0; i < 20; i++) {
        await emitEvent(projectDir, 'system', 'spam', { i }, 'test');
      }

      const closed = once(client, 'close');
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
      expect(wsHandle.overflowCount()).toBeGreaterThan(0);
      expect(wsHandle.clientCount()).toBe(0);
    } finally {
      await wsHandle.close();
    }
  }, 15000);
});

describe('attachWsServer snapshot channel', () => {
  let projectDir: string;
  let httpServer: http.Server;
  let port: number;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ws-snap-'));
    const app = express();
    httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!predicate()) throw new Error('waitFor: predicate did not become true');
  }

  it('does not emit session_view by default', async () => {
    const wsHandle = attachWsServer(httpServer);
    try {
      const messages: Array<Record<string, unknown>> = [];
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.on('message', (data: Buffer) => { messages.push(JSON.parse(data.toString())); });
      await once(client, 'open');
      await waitFor(() => messages.length >= 1);
      await emitEvent(projectDir, 'task', 'task.created', { id: 't-1' }, 'test');
      await waitFor(() => messages.some((m) => m.type === 'event'));
      // Give any throttled snapshot a generous window to NOT fire.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(messages.some((m) => m.type === 'session_view')).toBe(false);
      client.close();
      await once(client, 'close');
    } finally {
      await wsHandle.close();
    }
  }, 15000);

  it('broadcasts session_view snapshots when enabled, alongside raw events', async () => {
    const wsHandle = attachWsServer(httpServer, { sessionViewThrottleMs: 30 });
    try {
      const messages: Array<Record<string, unknown>> = [];
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.on('message', (data: Buffer) => { messages.push(JSON.parse(data.toString())); });
      await once(client, 'open');
      await waitFor(() => messages.length >= 1);

      await emitEvent(projectDir, 'tool', 'tool_called', { tool: 'demo' }, 'agent', 'svc1');
      await waitFor(() => messages.some((m) => m.type === 'session_view'));

      const rawEvents = messages.filter((m) => m.type === 'event');
      const snapshots = messages.filter((m) => m.type === 'session_view') as Array<{
        type: 'session_view';
        view: { version: number; totalEvents: number; lastByCategory: Record<string, { type: string } | undefined> };
      }>;
      expect(rawEvents.length).toBeGreaterThanOrEqual(1);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(snapshots[0].view.version).toBeGreaterThanOrEqual(1);
      expect(snapshots[0].view.totalEvents).toBeGreaterThanOrEqual(1);
      expect(snapshots[0].view.lastByCategory.tool?.type).toBe('tool_called');

      client.close();
      await once(client, 'close');
    } finally {
      await wsHandle.close();
    }
  }, 15000);

  it('coalesces bursts: snapshot count < event count for rapid fire', async () => {
    const wsHandle = attachWsServer(httpServer, { sessionViewThrottleMs: 80 });
    try {
      const messages: Array<Record<string, unknown>> = [];
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.on('message', (data: Buffer) => { messages.push(JSON.parse(data.toString())); });
      await once(client, 'open');
      await waitFor(() => messages.length >= 1);

      for (let i = 0; i < 20; i++) {
        await emitEvent(projectDir, 'system', 'burst', { i }, 'test');
      }
      // Wait long enough for the throttle window to flush at most ~2 snapshots.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const snapshots = messages.filter((m) => m.type === 'session_view');
      const rawEvents = messages.filter((m) => m.type === 'event');
      expect(rawEvents.length).toBe(20);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(snapshots.length).toBeLessThan(rawEvents.length);

      client.close();
      await once(client, 'close');
    } finally {
      await wsHandle.close();
    }
  }, 15000);
});
