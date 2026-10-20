'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/calibrationProfiles.ts'), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
}}).outputText;
const data = new Map();
const localStorage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
  removeItem: (key) => data.delete(key)
};
const moduleRecord = {exports: {}};
vm.runInNewContext(code, {
  module: moduleRecord, exports: moduleRecord.exports, localStorage,
  require: () => ({firmwareCurve: () => Array(91).fill(10000)}),
  JSON, Number, Array, Map, Set, Math
});
const {applyProfileEvent, loadProfiles, storeProfiles} = moduleRecord.exports;

test('profile events replace cached documents and preserve unsent local points', () => {
  const id = 'a'.repeat(64);
  const profileId = 'b'.repeat(32);
  const first = {version: 1, profiles: [{id: profileId, startsAt: 1,
    massG: null, points: [{at: 2, sg: 1.02, angle: 30}]}]};
  assert.equal(applyProfileEvent(id, 1, first), true);
  assert.equal(applyProfileEvent(id, 1, first), false);
  assert.equal(loadProfiles(id).revision, 1);

  const local = loadProfiles(id);
  local.document.profiles[0].points.push({at: 3, sg: 1.03, angle: 31});
  storeProfiles(id, {...local, dirty: true});
  const second = {version: 1, profiles: [{id: profileId, startsAt: 1,
    massG: null, points: [{at: 2, sg: 1.02, angle: 30}, {at: 4, sg: 1.04, angle: 32}]}]};
  assert.equal(applyProfileEvent(id, 2, second), true);
  const merged = loadProfiles(id);
  assert.equal(merged.revision, 2);
  assert.equal(merged.dirty, true);
  assert.deepEqual(merged.document.profiles[0].points.map((point) => point.at), [2, 3, 4]);
});
