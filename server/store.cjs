'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {parentPort, workerData} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');

const directory = workerData.directory;
fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const meta = new DatabaseSync(path.join(directory, 'pills.sqlite'));
meta.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
meta.exec('CREATE TABLE IF NOT EXISTS pills (ordinal INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, read_hash BLOB NOT NULL, last_us INTEGER NOT NULL DEFAULT 0)');
const lookup = meta.prepare('SELECT ordinal,read_hash FROM pills WHERE key=?');
const register = meta.prepare('INSERT OR IGNORE INTO pills(key,public_key,read_hash) VALUES(?,?,?)');
const updateLast = meta.prepare('UPDATE pills SET last_us=max(last_us,?) WHERE ordinal=?');
const loaded = meta.prepare('SELECT key,public_key,read_hash,last_us FROM pills').all().map((row) => ({
  key: row.key, publicKey: row.public_key, readHash: row.read_hash, lastUs: Number(row.last_us)
}));

let writerDay = '';
let writer = null;
let insert = null;
let lastCheckpoint = 0;

function dayOf(us) {
  return new Date(Math.floor(us / 1000)).toISOString().slice(0, 10).replaceAll('-', '');
}

function dayPath(day) {
  return path.join(directory, `day-${day}.sqlite`);
}

function openWriter(day) {
  if (writerDay === day) return;
  if (writer) { writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); writer.close(); }
  writerDay = day;
  writer = new DatabaseSync(dayPath(day));
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-32768; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=5000');
  writer.exec('CREATE TABLE IF NOT EXISTS readings(pill_id INTEGER NOT NULL,received_us INTEGER NOT NULL,message BLOB NOT NULL CHECK(length(message)=25),PRIMARY KEY(pill_id,received_us)) WITHOUT ROWID');
  insert = writer.prepare('INSERT OR IGNORE INTO readings(pill_id,received_us,message) VALUES(?,?,?)');
}

function insertBatch(rows) {
  if (!rows.length) return;
  const ordinalByKey = new Map();
  meta.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (ordinalByKey.has(row.key)) continue;
      register.run(row.key, Buffer.from(row.publicKey), Buffer.from(row.readHash));
      const saved = lookup.get(row.key);
      if (!Buffer.from(saved.read_hash).equals(Buffer.from(row.readHash))) throw new Error('Read hash conflict');
      ordinalByKey.set(row.key, saved.ordinal);
    }
    meta.exec('COMMIT');
  } catch (error) {
    meta.exec('ROLLBACK');
    throw error;
  }
  const byDay = new Map();
  for (const row of rows) {
    const day = dayOf(row.us);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  for (const [day, dayRows] of byDay) {
    openWriter(day);
    writer.exec('BEGIN IMMEDIATE');
    try {
      for (const row of dayRows) insert.run(ordinalByKey.get(row.key), row.us, Buffer.from(row.message));
      writer.exec('COMMIT');
    } catch (error) {
      writer.exec('ROLLBACK');
      throw error;
    }
  }
  meta.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) updateLast.run(row.us, ordinalByKey.get(row.key));
    meta.exec('COMMIT');
  } catch (error) {
    meta.exec('ROLLBACK');
    throw error;
  }
  if (Date.now() - lastCheckpoint >= 60_000 && writer) {
    writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    lastCheckpoint = Date.now();
  }
}

function readPage(key, after, limit) {
  const pill = lookup.get(key);
  if (!pill) return [];
  const records = [];
  const nowDay = dayOf(Date.now() * 1000);
  const oldest = (Date.now() - 90 * 86400_000) * 1000;
  let current = Math.max(after, oldest);
  for (let day = dayOf(current); day <= nowDay && records.length < limit; ) {
    const filename = dayPath(day);
    if (fs.existsSync(filename)) {
      const db = day === writerDay ? writer : new DatabaseSync(filename, {readOnly: true});
      const rows = db.prepare('SELECT received_us,message FROM readings WHERE pill_id=? AND received_us>? ORDER BY received_us LIMIT ?').all(pill.ordinal, current, limit - records.length);
      for (const row of rows) records.push({us: Number(row.received_us), message: row.message});
      if (db !== writer) db.close();
      if (records.length === limit) break;
    }
    const date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    day = date.toISOString().slice(0, 10).replaceAll('-', '');
    current = Math.max(after, date.getTime() * 1000 - 1);
  }
  return records;
}

function prune() {
  const cutoffDay = dayOf((Date.now() - 90 * 86400_000) * 1000);
  for (const name of fs.readdirSync(directory)) {
    const match = /^day-(\d{8})\.sqlite$/.exec(name);
    if (!match || match[1] >= cutoffDay || match[1] === writerDay) continue;
    const base = path.join(directory, name);
    fs.unlinkSync(base);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(base + suffix)) fs.unlinkSync(base + suffix);
  }
  const cutoffUs = Date.parse(`${cutoffDay.slice(0, 4)}-${cutoffDay.slice(4, 6)}-${cutoffDay.slice(6, 8)}T00:00:00Z`) * 1000;
  meta.prepare('DELETE FROM pills WHERE last_us < ?').run(cutoffUs);
}

parentPort.postMessage({type: 'ready', loaded});
parentPort.on('message', ({requestId, type, rows, key, after, limit}) => {
  try {
    const value = type === 'insert' ? insertBatch(rows) :
      type === 'read' ? readPage(key, after, limit) :
      type === 'prune' ? prune() : null;
    if (!['insert', 'read', 'prune'].includes(type)) throw new Error('Unknown store request');
    parentPort.postMessage({requestId, ok: true, value});
  } catch (error) {
    parentPort.postMessage({requestId, ok: false, error: String(error)});
  }
});
