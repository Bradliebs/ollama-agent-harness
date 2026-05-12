#!/usr/bin/env node

const http = require('http');

async function main() {
  const { longLivedFetch } = require('../dist/core/ollamaClient');

  await checkDelayedHeaders(longLivedFetch);
  await checkRequestBody(longLivedFetch);
  await checkAbortBeforeHeaders(longLivedFetch);

  console.log(JSON.stringify({ ok: true, checks: ['delayed-headers', 'request-body', 'abort-before-headers'] }, null, 2));
}

async function checkDelayedHeaders(longLivedFetch) {
  const server = await listen((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('delayed ');
      response.end('ok');
    }, 100);
  });

  try {
    const response = await longLivedFetch(server.url);
    const text = await response.text();
    if (response.status !== 200 || text !== 'delayed ok') {
      throw new Error(`delayed header check failed: status=${response.status}, body=${JSON.stringify(text)}`);
    }
  } finally {
    await server.close();
  }
}

async function checkRequestBody(longLivedFetch) {
  const seen = { body: '', contentLength: '' };
  const server = await listen((request, response) => {
    seen.contentLength = String(request.headers['content-length'] ?? '');
    request.setEncoding('utf-8');
    request.on('data', (chunk) => { seen.body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'Content-Type': 'text/plain' });
      response.end('received');
    });
  });

  try {
    const response = await longLivedFetch(server.url, { method: 'POST', body: 'hello' });
    const text = await response.text();
    if (response.status !== 201 || text !== 'received' || seen.body !== 'hello' || seen.contentLength !== '5') {
      throw new Error(`request body check failed: status=${response.status}, body=${JSON.stringify(text)}, seen=${JSON.stringify(seen)}`);
    }
  } finally {
    await server.close();
  }
}

async function checkAbortBeforeHeaders(longLivedFetch) {
  const server = await listen(() => {
    // Keep the request open until the client aborts.
  });
  const controller = new AbortController();

  try {
    const result = longLivedFetch(server.url, { signal: controller.signal });
    controller.abort();
    await result;
    throw new Error('abort check failed: request resolved after abort');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('aborted')) throw error;
  } finally {
    await server.close();
  }
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});