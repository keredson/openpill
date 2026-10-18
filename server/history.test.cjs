'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {test} = require('node:test');

test('signed upload, private sync, durable storage, and rate limit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openpill-history-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const rawPublic = publicKey.export({format: 'der', type: 'spki'}).subarray(-65);
  const historyId = crypto.createHash('sha256').update(rawPublic).digest('hex');
  const readKey = crypto.randomBytes(32);
  const readHash = crypto.createHash('sha256').update(readKey).digest();
  const body = Buffer.alloc(25);
  body.write('RAPT');
  body[4] = 2;
  body.writeUInt16BE(Math.round((20 + 273.15) * 128), 11);
  const signed = Buffer.concat([Buffer.from('OpenPill history upload v1\0'), readHash, body]);
  const signature = crypto.sign('sha256', signed, privateKey);
  let child;
  let base;
  async function start() {
    child = spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'index.cjs')], {
      env: {...process.env, OPENPILL_BIND: '127.0.0.1', OPENPILL_PORT: '0',
        OPENPILL_DATA_DIR: directory, OPENPILL_FLUSH_MS: '50'}, stdio: ['ignore', 'pipe', 'pipe']
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      child.once('exit', (code) => {clearTimeout(timer); reject(new Error(`Server exited: ${code}`));});
      child.stdout.on('data', (chunk) => {
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(chunk.toString());
        if (match) {clearTimeout(timer); resolve(Number(match[1]));}
      });
    });
    base = `http://127.0.0.1:${port}`;
  }
  async function stop() {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  t.after(() => { if (child && child.exitCode === null) child.kill(); });
  await start();
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-OpenPill-Key': rawPublic.toString('base64url'),
    'X-OpenPill-Signature': signature.toString('base64url'),
    'X-OpenPill-Read-Hash': readHash.toString('hex')
  };
  const upload = () => fetch(`${base}/v1/readings`, {method: 'POST', headers, body});
  const invalid = await fetch(`${base}/v1/readings`, {method: 'POST',
    headers: {...headers, 'X-OpenPill-Signature': crypto.randomBytes(70).toString('base64url')}, body});
  assert.equal(invalid.status, 401);
  const oversized = await fetch(`${base}/v1/readings`, {method: 'POST', headers,
    body: Buffer.alloc(26)});
  assert.equal(oversized.status, 413);
  assert.equal((await upload()).status, 202);
  assert.equal((await upload()).status, 429);
  const historyUrl = `${base}/v1/history/${historyId}?after=0`;
  const wrong = await fetch(historyUrl, {headers: {Authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}`}});
  assert.equal(wrong.status, 403);
  const auth = {Authorization: `Bearer ${readKey.toString('base64url')}`};
  let result;
  for (let tries = 0; tries < 30; tries++) {
    result = await fetch(historyUrl, {headers: auth});
    if ((await result.arrayBuffer()).byteLength === 33) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 200);
  const cursor = result.headers.get('x-next-after');
  assert.match(cursor, /^\d+$/);
  assert.equal((await (await fetch(`${base}/v1/history/${historyId}?after=${cursor}`, {headers: auth})).arrayBuffer()).byteLength, 0);
  await stop();
  await start();
  result = await fetch(`${base}/v1/history/${historyId}?after=0`, {headers: auth});
  const persisted = Buffer.from(await result.arrayBuffer());
  assert.equal(persisted.length, 33);
  assert.deepEqual(persisted.subarray(8), body);
  await stop();
});
