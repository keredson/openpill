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
  const controlKey = crypto.randomBytes(32);
  const controlHash = crypto.createHash('sha256').update(controlKey).digest();
  const profileUrl = `${base}/v1/profiles/${historyId}`;
  const initial = await fetch(profileUrl, {headers: auth});
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('etag'), '"0"');
  assert.equal((await fetch(profileUrl, {headers: {...auth, 'If-None-Match': '"0"'}})).status, 304);
  const profile = {version: 1, profiles: [{id: crypto.randomBytes(16).toString('hex'),
    startsAt: Date.now() - 60_000, massG: 121, points: [{at: Date.now(), sg: 1.05, angle: null}],
    curve: Array(91).fill(10500)}]};
  const put = (key, revision) => fetch(profileUrl, {method: 'PUT', headers: {
    Authorization: `Bearer ${key.toString('base64url')}`, 'If-Match': `"${revision}"`,
    'Content-Type': 'application/json'}, body: JSON.stringify(profile)});
  assert.equal((await put(readKey, 0)).status, 403);
  const challengeResponse = await fetch(`${base}/v1/control/${historyId}`, {headers: auth});
  assert.equal(challengeResponse.status, 200);
  const nonce = (await challengeResponse.json()).nonce;
  assert.match(nonce, /^[0-9a-f]{64}$/);
  const forgedClaim = await fetch(`${base}/v1/control/${historyId}`, {method: 'PUT',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      hash: controlHash.toString('hex'), nonce, signature: crypto.randomBytes(70).toString('base64url')})});
  assert.equal(forgedClaim.status, 401);
  const claimSignature = crypto.sign('sha256',
    Buffer.concat([Buffer.from('OpenPill history control v1\0'), controlHash, Buffer.from(nonce, 'hex')]), privateKey);
  const claim = await fetch(`${base}/v1/control/${historyId}`, {method: 'PUT',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      hash: controlHash.toString('hex'), nonce, signature: claimSignature.toString('base64url')})});
  assert.equal(claim.status, 204);
  const replay = await fetch(`${base}/v1/control/${historyId}`, {method: 'PUT',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      hash: controlHash.toString('hex'), nonce, signature: claimSignature.toString('base64url')})});
  assert.equal(replay.status, 409);
  assert.equal((await put(controlKey, 0)).status, 204);
  assert.equal((await put(controlKey, 0)).status, 409);
  const savedProfile = await fetch(profileUrl, {headers: auth});
  assert.equal(savedProfile.headers.get('etag'), '"1"');
  assert.deepEqual(await savedProfile.json(), profile);
  assert.equal((await fetch(profileUrl, {headers: {...auth, 'If-None-Match': '"1"'}})).status, 304);
  const reply = await upload();
  assert.equal(reply.status, 429);
  const curveReply = Buffer.from(await reply.arrayBuffer());
  assert.equal(curveReply.length, 186);
  assert.equal(curveReply.subarray(0, 4).toString(), 'OPC1');
  assert.equal(curveReply.readUInt16BE(4), 10500);
  await stop();
  await start();
  result = await fetch(`${base}/v1/history/${historyId}?after=0`, {headers: auth});
  const persisted = Buffer.from(await result.arrayBuffer());
  assert.equal(persisted.length, 33);
  assert.deepEqual(persisted.subarray(8), body);
  const retainedProfile = await fetch(`${base}/v1/profiles/${historyId}`, {headers: auth});
  assert.deepEqual(await retainedProfile.json(), profile);
  assert.equal((await fetch(`${base}/v1/profiles/${historyId}`, {headers: {...auth, 'If-None-Match': '"1"'}})).status, 304);
  const afterRestart = await upload();
  assert.equal(afterRestart.status, 429);
  assert.equal(Buffer.from(await afterRestart.arrayBuffer()).readUInt16BE(4), 10500);
  await stop();
});
