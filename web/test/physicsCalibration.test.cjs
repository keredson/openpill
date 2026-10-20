'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/physicsCalibration.ts'), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
}}).outputText;
const moduleRecord = {exports: {}};
vm.runInNewContext(code, {module: moduleRecord, exports: moduleRecord.exports, Math, Array, Number, Set, Map});
const {fitPhysicalProfile, gravityFromAngle, firmwareCurve, interpolatedAngle} = moduleRecord.exports;

test('physical fit recovers balance and cap length from widely spaced references', () => {
  const actual = {massG: 112, lengthMm: 127, cgXmm: -10, cgZmm: -2};
  const points = [25, 35, 45, 55, 65].map((angle, index) => ({
    at: 1000 + index, angle, sg: gravityFromAngle(angle, actual)
  }));
  const measured = {id: 'test', startsAt: 1, massG: 112, points};
  const fit = fitPhysicalProfile(measured);
  assert.ok(fit);
  assert.equal(fit.lengthMm, 127);
  assert.ok(Math.abs(fit.cgXmm - actual.cgXmm) < 0.1);
  assert.ok(Math.abs(fit.cgZmm - actual.cgZmm) < 0.1);
  const curve = firmwareCurve(measured);
  assert.equal(curve.length, 91);
  assert.ok(Math.abs(curve[45] / 10000 - points[2].sg) < 0.001);
});

test('unknown mass uses nominal length and calibration waits for a bracketing reading', () => {
  const actual = {massG: 110, lengthMm: 125, cgXmm: -10, cgZmm: -2};
  const points = [25, 35, 45, 55, 65].map((angle, index) => ({
    at: 1000 + index, angle, sg: gravityFromAngle(angle, actual)
  }));
  const fit = fitPhysicalProfile({id: 'test', startsAt: 1, massG: null, points});
  assert.ok(fit);
  assert.equal(fit.lengthMm, 125);
  assert.ok(Math.abs(fit.massG - actual.massG) <= 1);
  assert.equal(interpolatedAngle([{at: 0, tiltDegrees: 30}], 5 * 60_000), null);
  assert.equal(interpolatedAngle([
    {at: 0, tiltDegrees: 30}, {at: 10 * 60_000, tiltDegrees: 32}
  ], 5 * 60_000), 31);
});
