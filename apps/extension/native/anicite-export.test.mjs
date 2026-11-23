import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { deframer, frame, requestExport, runHost } from './anicite-export.mjs';

test('native messages round-trip through the 4-byte length framing, even split across chunks', () => {
  const bytes = Buffer.concat([frame({ id: 1, ok: true, csv: 'host,path\nx.org,/a\n' }), frame({ id: 2, ok: false })]);
  const read = deframer();
  const got = [];
  for (let i = 0; i < bytes.length; i += 3) got.push(...read(bytes.subarray(i, i + 3)));
  assert.deepEqual(got, [{ id: 1, ok: true, csv: 'host,path\nx.org,/a\n' }, { id: 2, ok: false }]);
});

test('a CLI request reaches the extension side and the CSV comes back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anicite-test-'));
  const socketPath = path.join(dir, 'export.sock');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const read = deframer();
  runHost({ stdin, stdout, socketPath, exitOnEnd: false });

  // The extension's side: read the request, answer with CSV.
  stdout.on('data', (chunk) => {
    for (const req of read(chunk)) {
      assert.equal(req.type, 'export');
      assert.equal(req.format, 'csv');
      assert.equal(req.range, '7d');
      stdin.write(frame({ id: req.id, ok: true, csv: 'host,path,category\nwww.notion.so,abc,productive\n' }));
    }
  });

  // Wait for the socket to listen.
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  const csv = await requestExport({ range: '7d', socketPath, timeoutMs: 2000 });
  assert.equal(csv, 'host,path,category\nwww.notion.so,abc,productive\n');
  stdin.end();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI says Brave is not connected when no host listens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anicite-test-'));
  await assert.rejects(
    requestExport({ socketPath: path.join(dir, 'missing.sock'), timeoutMs: 500 }),
    /Brave is not connected to Anicite/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
