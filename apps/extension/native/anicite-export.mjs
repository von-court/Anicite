#!/usr/bin/env node
// Anicite export from the command line.
//
// One file, two roles. Chrome starts it as the native messaging host when the extension connects
// (its argv carries the extension origin); then it relays requests between a local Unix socket and
// the extension. A user runs it with `export` (the CLI) or `install` (writes the host manifest once).
//
//   anicite-export install                    register the host with Brave (run once)
//   anicite-export export [--range all|7d|30d|90d] [--out FILE]   print or write the CSV
//
// Requires Brave running with the Anicite extension loaded and connected. No dependencies.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.von_court.anicite';
// The fork pins this id with a manifest key (wxt.config.ts); the host accepts only this origin.
export const EXTENSION_ORIGIN = 'chrome-extension://ioghagoipeacdknjpnjmbdmnnhjmpmfe/';
export const SOCKET_PATH = process.env.ANICITE_EXPORT_SOCKET
  || path.join(os.homedir(), '.local', 'state', 'anicite', 'export.sock');
const RANGES = ['all', '7d', '30d', '90d'];
const TIMEOUT_MS = 20_000;

// ---- native messaging framing: 4-byte little-endian length, then UTF-8 JSON ----

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Feed chunks in, get each complete message out: returns a function(chunk) -> [messages]. */
export function deframer() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      out.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
    }
    return out;
  };
}

// ---- host role: socket <-> extension ----

export function runHost({ stdin = process.stdin, stdout = process.stdout, socketPath = SOCKET_PATH, exitOnEnd = true } = {}) {
  const waiting = new Map(); // request id -> socket waiting for the answer
  let nextId = 1;
  const read = deframer();

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch { /* no stale socket */ }

  const server = net.createServer((sock) => {
    let line = '';
    sock.on('data', (chunk) => {
      line += chunk.toString('utf8');
      if (!line.includes('\n')) return;
      let req;
      try { req = JSON.parse(line.split('\n')[0]); } catch { return sock.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); }
      const id = nextId++;
      waiting.set(id, sock);
      stdout.write(frame({ id, type: 'export', format: 'csv', range: RANGES.includes(req.range) ? req.range : 'all' }));
    });
    sock.on('error', () => waiting.forEach((s, id) => { if (s === sock) waiting.delete(id); }));
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));

  stdin.on('data', (chunk) => {
    for (const msg of read(chunk)) {
      const sock = waiting.get(msg.id);
      if (!sock) continue;
      waiting.delete(msg.id);
      sock.end(JSON.stringify(msg) + '\n');
    }
  });
  const shutdown = () => {
    server.close();
    try { fs.unlinkSync(socketPath); } catch { /* gone */ }
    if (exitOnEnd) process.exit(0);
  };
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  return server;
}

// ---- CLI role ----

export function requestExport({ range = 'all', socketPath = SOCKET_PATH, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no answer from Brave within 20 s')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ format: 'csv', range }) + '\n'));
    sock.on('data', (c) => { data += c.toString('utf8'); });
    sock.on('end', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(data);
        if (reply.ok) resolve(reply.csv);
        else reject(new Error(reply.error || 'export failed in the extension'));
      } catch { reject(new Error('unreadable answer from the extension')); }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      const down = err.code === 'ECONNREFUSED' || err.code === 'ENOENT';
      reject(new Error(down
        ? 'Brave is not connected to Anicite: start Brave with the extension loaded (and reload it once after `install`)'
        : err.message));
    });
  });
}

export function installHost({ home = os.homedir(), node = process.execPath, script = fileURLToPath(import.meta.url) } = {}) {
  const dir = path.join(home, '.local', 'share', 'anicite');
  fs.mkdirSync(dir, { recursive: true });
  const wrapper = path.join(dir, 'native-host.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`, { mode: 0o755 });
  const manifest = {
    name: HOST_NAME,
    description: 'Anicite export: hands the local browsing CSV to the anicite-export CLI',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  };
  const targets = [path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')];
  for (const t of targets) {
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
  return { wrapper, manifests: targets.map((t) => path.join(t, `${HOST_NAME}.json`)) };
}

function parseArgs(argv) {
  const opts = { range: 'all', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--range') opts.range = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (!RANGES.includes(opts.range)) throw new Error(`--range must be one of ${RANGES.join(', ')}`);
  return opts;
}

async function main(argv) {
  if (argv.some((a) => a.startsWith('chrome-extension://'))) return runHost();
  const [cmd, ...rest] = argv;
  if (cmd === 'install') {
    const { manifests, wrapper } = installHost();
    console.log(`host: ${wrapper}\nmanifest: ${manifests.join('\n          ')}\nreload the Anicite extension in Brave once (chrome://extensions)`);
    return;
  }
  if (cmd === 'export') {
    const opts = parseArgs(rest);
    const csv = await requestExport({ range: opts.range });
    if (opts.out) fs.writeFileSync(opts.out, csv, { mode: 0o600 });
    else process.stdout.write(csv);
    return;
  }
  console.error('usage: anicite-export install | export [--range all|7d|30d|90d] [--out FILE]');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => { console.error(`anicite-export: ${err.message}`); process.exitCode = 3; });
}
