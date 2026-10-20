'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const PORT = Number(process.env.OPENPILL_PORT || 8040);
const BIND = process.env.OPENPILL_BIND || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.OPENPILL_DATA_DIR || path.join(__dirname, 'data'));
const ORIGINS = new Set((process.env.OPENPILL_ORIGINS ||
  'https://keredson.github.io,https://openpill.yeast.win,http://localhost:5173').split(','));
const SIGNING_PREFIX = Buffer.from('OpenPill history upload v1\0', 'ascii');
const CONTROL_CLAIM_PREFIX = Buffer.from('OpenPill history control v1\0', 'ascii');
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const UPLOAD_INTERVAL_MS = 15 * 60_000;
const MAX_QUEUED = 100_000;
const PAGE_LIMIT = 1024;
const FLUSH_MS = Number(process.env.OPENPILL_FLUSH_MS || 60_000);

const CLEAR_CALIBRATION = Buffer.from('OPC0');
function encodeCurve(curve) {
  if (!curve) return CLEAR_CALIBRATION;
  const output = Buffer.alloc(4 + curve.length * 2);
  output.write('OPC1');
  curve.forEach((value, index) => output.writeUInt16BE(value, 4 + index * 2));
  return output;
}

const worker = new Worker(path.join(__dirname, 'store.cjs'), {workerData: {directory: DATA_DIR}});
const registry = new Map();
const waiting = new Map();
let nextRequestId = 1;
let queued = [];
let inFlight = null;
let healthy = true;
let workerAlive = true;

function storeRequest(type, data = {}) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    waiting.set(requestId, {resolve, reject});
    worker.postMessage({requestId, type, ...data});
  });
}

const ready = new Promise((resolve, reject) => {
  worker.on('message', (message) => {
    if (message.type === 'ready') {
      for (const row of message.loaded) registry.set(row.key, {
        publicKey: Buffer.from(row.publicKey), readHash: Buffer.from(row.readHash),
        controlHash: row.controlHash ? Buffer.from(row.controlHash) : null, lastUs: row.lastUs,
        curveReply: encodeCurve(row.curve), profileRevision: row.profileRevision
      });
      resolve();
      return;
    }
    const pending = waiting.get(message.requestId);
    if (!pending) return;
    waiting.delete(message.requestId);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  });
  worker.once('error', reject);
});

worker.on('error', (error) => {
  healthy = false;
  workerAlive = false;
  console.error('SQLite worker failed:', error);
  for (const pending of waiting.values()) pending.reject(error);
  waiting.clear();
});
worker.on('exit', (code) => {
  healthy = false;
  workerAlive = false;
  for (const pending of waiting.values()) pending.reject(new Error('SQLite worker exited'));
  waiting.clear();
  if (code !== 0) console.error('SQLite worker exited:', code);
});

async function flush() {
  if (inFlight || !queued.length || !workerAlive) return;
  const rows = queued;
  queued = [];
  inFlight = rows;
  try {
    await storeRequest('insert', {rows});
    inFlight = null;
    healthy = true;
  } catch (error) {
    console.error('SQLite batch failed:', error);
    queued = rows.concat(queued);
    inFlight = null;
    healthy = false;
  }
}

function respond(res, status, body = '', headers = {}) {
  res.writeHead(status, {'Cache-Control': 'no-store', ...headers});
  res.end(body);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-None-Match');
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-After, ETag');
  }
  return !origin || ORIGINS.has(origin);
}

async function readBody(req) {
  const length = Number(req.headers['content-length']);
  if (!Number.isInteger(length) || length !== 25) throw new Error('Body must be exactly 25 bytes');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25) throw new Error('Body exceeds 25 bytes');
    chunks.push(chunk);
  }
  if (size !== 25) throw new Error('Body must be exactly 25 bytes');
  return Buffer.concat(chunks);
}

function decodeBase64url(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
}

async function upload(req, res) {
  if (!healthy || queued.length + (inFlight?.length || 0) >= MAX_QUEUED) return respond(res, 503);
  if (req.headers['content-type'] !== 'application/octet-stream') return respond(res, 415);
  const publicBytes = decodeBase64url(req.headers['x-openpill-key'], 65);
  const hashText = req.headers['x-openpill-read-hash'];
  if (!publicBytes || publicBytes[0] !== 4 || typeof hashText !== 'string' ||
      !/^[0-9a-f]{64}$/.test(hashText) || typeof req.headers['x-openpill-signature'] !== 'string') {
    return respond(res, 400);
  }
  // DER-encoded P-256 ECDSA signatures are variable length.
  const signatureBytes = Buffer.from(req.headers['x-openpill-signature'], 'base64url');
  if (signatureBytes.length < 64 || signatureBytes.length > 80 ||
      signatureBytes.toString('base64url') !== req.headers['x-openpill-signature']) return respond(res, 400);
  let body;
  try { body = await readBody(req); } catch { return respond(res, 413); }
  if (body.toString('ascii', 0, 4) !== 'RAPT' || body[4] !== 2) return respond(res, 400);
  const readHash = Buffer.from(hashText, 'hex');
  const signed = Buffer.concat([SIGNING_PREFIX, readHash, body]);
  let verified = false;
  try {
    const key = crypto.createPublicKey({key: Buffer.concat([P256_SPKI_PREFIX, publicBytes]), format: 'der', type: 'spki'});
    verified = crypto.verify('sha256', signed, key, signatureBytes);
  } catch { /* Invalid public key or signature. */ }
  if (!verified) return respond(res, 401);
  const id = crypto.createHash('sha256').update(publicBytes).digest('hex');
  let pill = registry.get(id);
  if (pill && (!pill.publicKey.equals(publicBytes) || !pill.readHash.equals(readHash))) return respond(res, 403);
  const now = Date.now();
  if (pill && now * 1000 - pill.lastUs < UPLOAD_INTERVAL_MS * 1000) {
    const retry = Math.ceil((UPLOAD_INTERVAL_MS * 1000 - (now * 1000 - pill.lastUs)) / 1e6);
    return respond(res, 429, calibrationReply(pill), {
      'Retry-After': String(Math.max(1, retry)), 'Content-Type': 'application/vnd.openpill.calibration-v1'
    });
  }
  const us = Math.max(now * 1000, (pill?.lastUs || 0) + 1);
  if (!pill) {
    pill = {publicKey: publicBytes, readHash, controlHash: null,
      curveReply: CLEAR_CALIBRATION, profileRevision: 0, lastUs: us};
    registry.set(id, pill);
  } else pill.lastUs = us;
  queued.push({key: id, publicKey: publicBytes, readHash, us, message: body});
  respond(res, 202, calibrationReply(pill), {'Content-Type': 'application/vnd.openpill.calibration-v1'});
}

function calibrationReply(pill) {
  return pill.curveReply;
}

async function history(req, res, url) {
  const id = url.pathname.slice('/v1/history/'.length);
  if (!/^[0-9a-f]{64}$/.test(id)) return respond(res, 404);
  const pill = registry.get(id);
  if (!pill) return respond(res, 404);
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
  const secret = bearer && decodeBase64url(bearer[1], 32);
  if (!secret) return respond(res, 401);
  const hash = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(hash, pill.readHash)) return respond(res, 403);
  const rawAfter = url.searchParams.get('after') || '0';
  if (!/^(0|[1-9][0-9]{0,15})$/.test(rawAfter)) return respond(res, 400);
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after)) return respond(res, 400);
  if (!healthy) return respond(res, 503);
  let records;
  try { records = await storeRequest('read', {key: id, after, limit: PAGE_LIMIT}); }
  catch { return respond(res, 503); }
  const response = Buffer.allocUnsafe(records.length * 33);
  for (let index = 0; index < records.length; index++) {
    response.writeBigUInt64BE(BigInt(records[index].us), index * 33);
    Buffer.from(records[index].message).copy(response, index * 33 + 8);
  }
  const next = records.length ? records.at(-1).us : after;
  respond(res, 200, response, {'Content-Type': 'application/vnd.openpill.history-v1', 'X-Next-After': String(next)});
}

function bearerHash(req) {
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
  const secret = bearer && decodeBase64url(bearer[1], 32);
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

function validProfiles(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.profiles) ||
      document.profiles.length > 16 || Object.keys(document).some((key) => !['version', 'profiles'].includes(key))) return false;
  let previous = 0;
  const ids = new Set();
  for (const profile of document.profiles) {
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' ||
        !/^[0-9a-f]{32}$/.test(profile.id) || ids.has(profile.id) ||
        !Number.isSafeInteger(profile.startsAt) || profile.startsAt <= previous ||
        (profile.massG != null && (typeof profile.massG !== 'number' ||
          !Number.isFinite(profile.massG) || profile.massG < 50 || profile.massG > 180)) ||
        !Array.isArray(profile.points) || profile.points.length > 16 ||
        (profile.curve !== undefined && (!Array.isArray(profile.curve) || profile.curve.length !== 91 ||
          profile.curve.some((value) => !Number.isInteger(value) ||
            (value !== 0 && (value < 7000 || value > 16000)))))) return false;
    previous = profile.startsAt;
    ids.add(profile.id);
    for (const point of profile.points) {
      if (!point || !Number.isSafeInteger(point.at) || point.at < profile.startsAt ||
          !Number.isFinite(point.sg) || point.sg < 0.7 || point.sg > 1.6 ||
          (point.angle != null && (!Number.isFinite(point.angle) || point.angle < 0 || point.angle > 90))) return false;
    }
  }
  return true;
}

async function claimControl(req, res, url) {
  const id = url.pathname.slice('/v1/control/'.length);
  if (!/^[0-9a-f]{64}$/.test(id)) return respond(res, 404);
  const pill = registry.get(id);
  if (!pill) return respond(res, 404);
  if (req.method === 'GET') {
    const hash = bearerHash(req);
    if (!hash) return respond(res, 401);
    if (!crypto.timingSafeEqual(hash, pill.readHash)) return respond(res, 403);
    const nonce = crypto.randomBytes(32);
    pill.controlChallenge = {nonce, expires: Date.now() + 5 * 60_000};
    return respond(res, 200, JSON.stringify({nonce: nonce.toString('hex')}),
      {'Content-Type': 'application/json'});
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512) return respond(res, 413);
    chunks.push(chunk);
  }
  let claim;
  try { claim = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return respond(res, 400); }
  if (typeof claim.hash !== 'string' || !/^[0-9a-f]{64}$/.test(claim.hash) ||
      typeof claim.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(claim.nonce) ||
      typeof claim.signature !== 'string') return respond(res, 400);
  if (!pill.controlChallenge || pill.controlChallenge.expires < Date.now() ||
      !crypto.timingSafeEqual(Buffer.from(claim.nonce, 'hex'), pill.controlChallenge.nonce))
    return respond(res, 409);
  const signature = Buffer.from(claim.signature, 'base64url');
  if (signature.length < 64 || signature.length > 80 || signature.toString('base64url') !== claim.signature) return respond(res, 400);
  const digestInput = Buffer.concat([CONTROL_CLAIM_PREFIX, Buffer.from(claim.hash, 'hex'),
    pill.controlChallenge.nonce]);
  let verified = false;
  try {
    const key = crypto.createPublicKey({key: Buffer.concat([P256_SPKI_PREFIX, pill.publicKey]), format: 'der', type: 'spki'});
    verified = crypto.verify('sha256', digestInput, key, signature);
  } catch { /* Invalid signature. */ }
  if (!verified) return respond(res, 401);
  if (!healthy) return respond(res, 503);
  await storeRequest('claimControl', {key: id, publicKey: pill.publicKey, readHash: pill.readHash,
    controlHash: Buffer.from(claim.hash, 'hex')});
  pill.controlHash = Buffer.from(claim.hash, 'hex');
  pill.controlChallenge = null;
  respond(res, 204);
}

async function profiles(req, res, url) {
  const id = url.pathname.slice('/v1/profiles/'.length);
  if (!/^[0-9a-f]{64}$/.test(id)) return respond(res, 404);
  const pill = registry.get(id);
  if (!pill) return respond(res, 404);
  const hash = bearerHash(req);
  if (!hash) return respond(res, 401);
  const expectedHash = req.method === 'GET' ? pill.readHash : pill.controlHash;
  if (!expectedHash || !crypto.timingSafeEqual(hash, expectedHash)) return respond(res, 403);
  if (!healthy) return respond(res, 503);
  if (req.method === 'GET') {
    const etag = `"${pill.profileRevision}"`;
    if (req.headers['if-none-match'] === etag) return respond(res, 304, '', {ETag: etag});
    const saved = await storeRequest('getProfiles', {key: id});
    return saved ? respond(res, 200, saved.body, {'Content-Type': 'application/json', ETag: `"${saved.revision}"`}) : respond(res, 404);
  }
  if (req.method !== 'PUT') return respond(res, 405);
  const ifMatch = /^"(0|[1-9][0-9]*)"$/.exec(req.headers['if-match'] || '');
  if (!ifMatch) return respond(res, 428);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) return respond(res, 413);
    chunks.push(chunk);
  }
  let document;
  try { document = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return respond(res, 400); }
  if (!validProfiles(document)) return respond(res, 400);
  const result = await storeRequest('saveProfiles', {
    key: id, expected: Number(ifMatch[1]), body: JSON.stringify(document)
  });
  if (!result) return respond(res, 404);
  if (result.conflict) return respond(res, 409, '', {ETag: `"${result.revision}"`});
  pill.curveReply = encodeCurve(document.profiles.at(-1)?.curve);
  pill.profileRevision = result.revision;
  respond(res, 204, '', {ETag: `"${result.revision}"`});
}

async function handle(req, res) {
  if (!cors(req, res)) return respond(res, 403);
  if (req.method === 'OPTIONS') return respond(res, 204);
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return respond(res, healthy ? 200 : 503, healthy ? 'ok' : 'unavailable');
  if (req.method === 'POST' && url.pathname === '/v1/readings') return upload(req, res);
  if ((req.method === 'GET' || req.method === 'PUT') && url.pathname.startsWith('/v1/control/'))
    return claimControl(req, res, url);
  if (req.method === 'GET' && url.pathname.startsWith('/v1/history/')) return history(req, res, url);
  if ((req.method === 'GET' || req.method === 'PUT') && url.pathname.startsWith('/v1/profiles/'))
    return profiles(req, res, url);
  respond(res, 404);
}

ready.then(() => {
  const server = http.createServer((req, res) => void handle(req, res).catch((error) => {
    console.error('Request failed:', error);
    if (!res.headersSent) respond(res, 500);
    else res.destroy();
  }));
  server.listen(PORT, BIND, () => console.log(`OpenPill history listening on ${BIND}:${server.address().port}`));
  setInterval(() => void flush(), FLUSH_MS).unref();
  const sweep = () => void storeRequest('prune').then(() => {
    const cutoff = (Date.now() - 91 * 86400_000) * 1000;
    for (const [key, pill] of registry) if (pill.lastUs < cutoff) registry.delete(key);
  }).catch((error) => console.error('Retention sweep failed:', error));
  sweep();
  setInterval(sweep, 24 * 3600_000 + Math.floor(Math.random() * 3600_000)).unref();
}).catch((error) => { console.error('Could not start store:', error); process.exitCode = 1; });
