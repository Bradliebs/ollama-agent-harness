const net = require('node:net');
const { spawn } = require('node:child_process');

const [port, depth] = process.argv.slice(2);
const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
socket.once('connect', () => socket.write(depth + '\n'));
socket.on('data', () => process.exit(0));
socket.on('error', () => process.exit(1));
socket.on('end', () => process.exit(0));
if (depth === '1') {
  spawn(process.execPath, [__filename, port, '2'], { detached: false, windowsHide: true, stdio: 'ignore' });
}