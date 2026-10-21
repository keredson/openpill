// Floating-body model for an axially symmetric 37 mm housing. The 125 mm
// nominal length and 7 mm rounded ends are starting geometry, not a claimed
// measurement of the exact cap contour. With two points and a known mass,
// length stays nominal; a third point lets us fit it alongside balance.
const RADIUS_MM = 18.5;
const END_MM = 7;
const SLICES = 48;

export interface CalibrationPoint {
  at: number;
  sg: number;
  angle: number | null;
}

export interface CalibrationProfile {
  id: string;
  startsAt: number;
  massG: number | null;
  points: CalibrationPoint[];
  curve?: number[];
}

export interface ProfileDocument {
  version: 1;
  profiles: CalibrationProfile[];
}

export interface PhysicalFit {
  massG: number;
  lengthMm: number;
  cgXmm: number;
  cgZmm: number;
  rmseMm: number;
}

function sliceRadius(x: number, length: number): number {
  const endStart = length / 2 - END_MM;
  const beyond = Math.abs(x) - endStart;
  if (beyond <= 0) return RADIUS_MM;
  if (beyond >= END_MM) return 0;
  return RADIUS_MM * Math.sqrt(Math.max(0, 1 - (beyond / END_MM) ** 2));
}

function displaced(angle: number, line: number, length: number) {
  const radians = angle * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  const dx = length / SLICES;
  let volume = 0, momentX = 0, momentZ = 0;
  for (let i = 0; i < SLICES; i++) {
    const x = -length / 2 + (i + 0.5) * dx;
    const r = sliceRadius(x, length);
    const u = s < 1e-8 ? (line >= x * c ? r : -r) : (line - x * c) / s;
    let area: number, zMoment: number;
    if (u <= -r) { area = 0; zMoment = 0; }
    else if (u >= r) { area = Math.PI * r * r; zMoment = 0; }
    else {
      const side = Math.sqrt(Math.max(0, r * r - u * u));
      area = r * r * (Math.asin(u / r) + Math.PI / 2) + u * side;
      zMoment = -2 / 3 * side ** 3;
    }
    volume += area * dx;
    momentX += x * area * dx;
    momentZ += zMoment * dx;
  }
  return { volume, bx: volume ? momentX / volume : 0, bz: volume ? momentZ / volume : 0 };
}

function buoyancyAt(angle: number, sg: number, massG: number, length: number) {
  const target = massG * 1000 / sg;
  const full = displaced(angle, length, length).volume;
  if (target >= full || target <= 0) return null;
  let low = -length, high = length;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (displaced(angle, mid, length).volume < target) low = mid;
    else high = mid;
  }
  return displaced(angle, (low + high) / 2, length);
}

function solveBalance(points: { angle: number; sg: number }[], massG: number, length: number): PhysicalFit | null {
  let aa = 0, ab = 0, bb = 0, ay = 0, by = 0;
  const rows: { a: number; b: number; y: number }[] = [];
  for (const point of points) {
    const buoyancy = buoyancyAt(point.angle, point.sg, massG, length);
    if (!buoyancy) return null;
    const radians = point.angle * Math.PI / 180;
    const a = -Math.sin(radians), b = Math.cos(radians);
    const y = a * buoyancy.bx + b * buoyancy.bz;
    aa += a * a; ab += a * b; bb += b * b; ay += a * y; by += b * y;
    rows.push({ a, b, y });
  }
  const determinant = aa * bb - ab * ab;
  if (determinant < 0.01) return null;
  const cgXmm = (ay * bb - by * ab) / determinant;
  const cgZmm = (by * aa - ay * ab) / determinant;
  if (Math.abs(cgXmm) > length / 2 || Math.abs(cgZmm) > RADIUS_MM) return null;
  const rmseMm = Math.sqrt(rows.reduce((sum, row) =>
    sum + (row.y - row.a * cgXmm - row.b * cgZmm) ** 2, 0) / rows.length);
  return { massG, lengthMm: length, cgXmm, cgZmm, rmseMm };
}

export function fitPhysicalProfile(profile: CalibrationProfile): PhysicalFit | null {
  const points = profile.points.filter((point): point is CalibrationPoint & { angle: number } =>
    point.angle != null && Number.isFinite(point.angle) && Number.isFinite(point.sg));
  if (points.length < (profile.massG == null ? 3 : 2) ||
      Math.max(...points.map((point) => point.angle)) - Math.min(...points.map((point) => point.angle)) < 8) return null;
  let best: PhysicalFit | null = null;
  const fitLength = profile.massG != null && points.length >= 3;
  const masses = profile.massG == null
    ? Array.from({ length: 26 }, (_, i) => 80 + i * 2) : [profile.massG];
  const lengths = fitLength ? [120, 122, 124, 126, 128, 130] : [125];
  for (const mass of masses) for (const length of lengths) {
    const fit = solveBalance(points, mass, length);
    if (fit && (!best || fit.rmseMm < best.rmseMm)) best = fit;
  }
  if (best) {
    const centerMass = best.massG, centerLength = best.lengthMm;
    for (let mass = Math.max(80, centerMass - (profile.massG == null ? 2 : 0));
      mass <= Math.min(130, centerMass + (profile.massG == null ? 2 : 0)); mass += 1) {
      for (let length = fitLength ? Math.max(120, centerLength - 2) : 125;
        length <= (fitLength ? Math.min(130, centerLength + 2) : 125); length += 1) {
        const fit = solveBalance(points, mass, length);
        if (fit && fit.rmseMm < best.rmseMm) best = fit;
      }
    }
  }
  return best;
}

export function gravityFromAngle(angle: number, fit: PhysicalFit): number | null {
  const radians = angle * Math.PI / 180;
  const a = -Math.sin(radians), b = Math.cos(radians);
  const target = a * fit.cgXmm + b * fit.cgZmm;
  const angleMoment = (sg: number) => {
    const result = buoyancyAt(angle, sg, fit.massG, fit.lengthMm);
    return result ? a * result.bx + b * result.bz - target : null;
  };
  const full = displaced(angle, fit.lengthMm, fit.lengthMm).volume;
  let lo = Math.max(0.7, fit.massG * 1000 / full + 0.00001), hi = 1.6;
  if (lo >= hi) return null;
  const first = angleMoment(lo), last = angleMoment(hi);
  if (first == null || last == null || first * last > 0) return null;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const moment = angleMoment(mid)!;
    if (first * moment <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function firmwareCurve(profile: CalibrationProfile): number[] | undefined {
  const fit = fitPhysicalProfile(profile);
  if (!fit) return undefined;
  return Array.from({ length: 91 }, (_, angle) => {
    const sg = gravityFromAngle(angle, fit);
    return sg == null ? 0 : Math.max(7000, Math.min(16000, Math.round(sg * 10000)));
  });
}

export function interpolatedAngle(readings: { at: number; tiltDegrees?: number }[], at: number): number | null {
  let before: typeof readings[number] | undefined, after: typeof readings[number] | undefined;
  for (const reading of readings) {
    if (reading.tiltDegrees == null) continue;
    if (reading.at <= at && (!before || reading.at > before.at)) before = reading;
    if (reading.at >= at && (!after || reading.at < after.at)) after = reading;
  }
  if (!before || !after || after.at - before.at > 45 * 60_000) return null;
  if (after.at === before.at) return before.tiltDegrees!;
  if (Math.abs(after.tiltDegrees! - before.tiltDegrees!) > 5) return null;
  return before.tiltDegrees! + (after.tiltDegrees! - before.tiltDegrees!) *
    (at - before.at) / (after.at - before.at);
}
