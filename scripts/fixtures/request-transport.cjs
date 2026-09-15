const http = require('node:http');
const request = http.request;
const port = Number(process.env.HARNESS_TRANSPORT_FIXTURE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Missing fixture port');

http.request = (url, options, callback) => {
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== 11434) throw new Error('Unexpected fixture destination');
  const target = new URL(url);
  target.port = String(port);
  return request(target, options, callback);
};
require('node:https').request = () => { throw new Error('Fixture forbids HTTPS'); };
globalThis.fetch = () => { throw new Error('Fixture forbids global fetch'); };