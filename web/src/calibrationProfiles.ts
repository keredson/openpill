import { firmwareCurve, interpolatedAngle, type ProfileDocument } from "./physicsCalibration";

const PREFIX = "openpill.calibration.v1.";
export const EMPTY_PROFILES: ProfileDocument = { version: 1, profiles: [] };

export interface SavedProfiles {
  revision: number;
  dirty: boolean;
  document: ProfileDocument;
}

export function loadProfiles(historyId: string): SavedProfiles {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFIX + historyId) || "null") as SavedProfiles | null;
    if (stored?.document?.version === 1 && Array.isArray(stored.document.profiles) &&
        Number.isSafeInteger(stored.revision)) return stored;
  } catch { /* New browser or unavailable storage. */ }
  return { revision: 0, dirty: false, document: EMPTY_PROFILES };
}

export function storeProfiles(historyId: string, saved: SavedProfiles): void {
  localStorage.setItem(PREFIX + historyId, JSON.stringify(saved));
}

export function forgetProfiles(historyId: string): void {
  localStorage.removeItem(PREFIX + historyId);
}

export function resolvePendingProfiles(historyId: string, readings: { at: number; tiltDegrees?: number }[]): boolean {
  const saved = loadProfiles(historyId);
  let changed = false;
  const profiles = saved.document.profiles.map((profile) => ({ ...profile, points: profile.points.map((point) => {
    if (point.angle != null) return point;
    const angle = interpolatedAngle(readings, point.at);
    if (angle == null) return point;
    changed = true;
    return { ...point, angle };
  }) }));
  if (!changed) return false;
  const last = profiles.at(-1);
  if (last) last.curve = firmwareCurve(last);
  storeProfiles(historyId, { ...saved, dirty: true, document: { version: 1, profiles } });
  return true;
}

export async function fetchProfiles(historyId: string, readKey: string, cached?: SavedProfiles): Promise<SavedProfiles> {
  const response = await fetch(`https://openpill.yeast.win/v1/profiles/${historyId}`, {
    headers: { Authorization: `Bearer ${readKey}`,
      ...(cached ? { "If-None-Match": `"${cached.revision}"` } : {}) }, cache: "no-store"
  });
  if (response.status === 304 && cached) return cached;
  if (!response.ok) throw new Error(`Calibration sync failed (HTTP ${response.status}).`);
  const document = await response.json() as ProfileDocument;
  const revision = Number(response.headers.get("ETag")?.replaceAll('"', ''));
  if (document.version !== 1 || !Array.isArray(document.profiles) || !Number.isSafeInteger(revision))
    throw new Error("Invalid calibration profile response.");
  return { revision, dirty: false, document };
}

function mergeDocuments(remote: ProfileDocument, local: ProfileDocument): ProfileDocument {
  const byId = new Map(remote.profiles.map((profile) => [profile.id, profile]));
  for (const incoming of local.profiles) {
    const existing = byId.get(incoming.id);
    if (!existing) { byId.set(incoming.id, incoming); continue; }
    if (existing.startsAt !== incoming.startsAt ||
        (existing.massG != null && incoming.massG != null && existing.massG !== incoming.massG))
      throw new Error("Calibration settings changed on another phone. Review both copies before saving.");
    const points = new Map(existing.points.map((point) => [point.at, point]));
    for (const point of incoming.points) {
      const other = points.get(point.at);
      if (other && (other.sg !== point.sg ||
          (other.angle != null && point.angle != null && Math.abs(other.angle - point.angle) > 0.01)))
        throw new Error("A reference point changed on another phone. Review both copies before saving.");
      points.set(point.at, { ...other, ...point, angle: point.angle ?? other?.angle ?? null });
    }
    byId.set(incoming.id, { ...existing, massG: incoming.massG ?? existing.massG,
      points: [...points.values()].sort((a, b) => a.at - b.at) });
  }
  const profiles = [...byId.values()].sort((a, b) => a.startsAt - b.startsAt);
  if (profiles.length > 16 || profiles.some((profile) => profile.points.length > 16))
    throw new Error("Combined calibration exceeds the server limit. Remove old points before syncing.");
  profiles.forEach((profile, index) => {
    delete profile.curve;
    if (index === profiles.length - 1) profile.curve = firmwareCurve(profile);
  });
  return { version: 1, profiles };
}

export async function syncProfiles(historyId: string, readKey: string, controlKey: string | null, attempt = 0): Promise<SavedProfiles> {
  const local = loadProfiles(historyId);
  if (!local.dirty) {
    const remote = await fetchProfiles(historyId, readKey, local);
    const current = loadProfiles(historyId);
    if (current.dirty) return current;
    storeProfiles(historyId, remote);
    return remote;
  }
  if (!controlKey) return local;
  const response = await fetch(`https://openpill.yeast.win/v1/profiles/${historyId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${controlKey}`, "Content-Type": "application/json", "If-Match": `"${local.revision}"` },
    body: JSON.stringify(local.document)
  });
  if (response.status === 404 || response.status === 403) return local; // Await the Pill's signed key registration.
  if (response.status === 409) {
    if (attempt >= 1) throw new Error("Calibration changed again while syncing. Try again shortly.");
    const remote = await fetchProfiles(historyId, readKey);
    const merged = mergeDocuments(remote.document, loadProfiles(historyId).document);
    storeProfiles(historyId, { revision: remote.revision, dirty: true, document: merged });
    return syncProfiles(historyId, readKey, controlKey, attempt + 1);
  }
  if (!response.ok) throw new Error(`Calibration save failed (HTTP ${response.status}).`);
  const revision = Number(response.headers.get("ETag")?.replaceAll('"', ''));
  if (!Number.isSafeInteger(revision)) throw new Error("Calibration save lacked a revision.");
  const current = loadProfiles(historyId);
  const saved = JSON.stringify(current.document) === JSON.stringify(local.document)
    ? { ...local, revision, dirty: false }
    : { ...current, revision, dirty: true };
  storeProfiles(historyId, saved);
  return saved;
}
