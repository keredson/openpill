import { parseTelemetry, type BroadcastReading, type HardwareSample } from "./ble";
import { batteryPercentFromMv } from "./battery";

const DATABASE_NAME = "openpill-readings";
const STORE_NAME = "readings";

export interface HistoricalReading {
  id?: number;
  pillId: string;
  at: number;
  source: "broadcast" | "connected" | "server";
  serverUs?: number;
  temperatureC?: number;
  gravity?: number;
  batteryPercent?: number;
  batteryMv?: number;
  batteryRaw?: number;
  acceleration?: [number, number, number];
  tiltDegrees?: number;
  externalPower?: boolean;
}

let databasePromise: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 2);
      request.onupgradeneeded = () => {
        const store = request.transaction!.objectStoreNames.contains(STORE_NAME)
          ? request.transaction!.objectStore(STORE_NAME)
          : request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        if (!store.indexNames.contains("by_pill_time")) store.createIndex("by_pill_time", ["pillId", "at"]);
        if (!store.indexNames.contains("by_pill_server_us"))
          store.createIndex("by_pill_server_us", ["pillId", "serverUs"], { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise!;
}

export function fromBroadcast(pillId: string, reading: BroadcastReading, at = Date.now()): HistoricalReading {
  const acceleration = reading.acceleration;
  return {
    pillId, at, source: "broadcast",
    ...(reading.temperatureC != null && { temperatureC: reading.temperatureC }),
    ...(reading.gravity != null && { gravity: reading.gravity }),
    ...(acceleration && {
      acceleration,
      tiltDegrees: Math.min(90, Math.atan2(Math.hypot(acceleration[1], acceleration[2]), acceleration[0]) * 180 / Math.PI)
    }),
    batteryPercent: reading.batteryPercent
  };
}

export function fromHardware(pillId: string, sample: HardwareSample, at = Date.now()): HistoricalReading {
  const [x, y, z] = sample.acceleration;
  return {
    pillId, at, source: "connected",
    ...((sample.valid & 1) !== 0 && {
      acceleration: sample.acceleration,
      tiltDegrees: Math.min(90, Math.atan2(Math.hypot(y, z), x) * 180 / Math.PI)
    }),
    ...((sample.valid & 2) !== 0 && { temperatureC: sample.temperatureC }),
    ...(sample.gravity != null && Number.isFinite(sample.gravity) && { gravity: sample.gravity }),
    ...((sample.valid & 4) !== 0 && {
      batteryMv: sample.batteryMv,
      batteryRaw: sample.batteryRaw,
      batteryPercent: batteryPercentFromMv(sample.batteryMv)
    }),
    ...((sample.valid & 8) !== 0 && { externalPower: sample.externalPower })
  };
}

export async function saveReading(reading: HistoricalReading): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add(reading);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function loadReadings(pillId: string): Promise<HistoricalReading[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("by_pill_time");
    const request = index.getAll(IDBKeyRange.bound([pillId, 0], [pillId, Number.MAX_SAFE_INTEGER]));
    request.onsuccess = () => {
      const all = request.result as HistoricalReading[];
      const local = all.filter((reading) => reading.source !== "server");
      let firstLocal = 0;
      resolve(all.filter((reading) => {
        if (reading.source !== "server") return true;
        while (firstLocal < local.length && local[firstLocal].at <= reading.at - 120_000) firstLocal++;
        for (let next = firstLocal; next < local.length && local[next].at < reading.at + 120_000; next++) {
          const other = local[next];
          const comparable = (other.temperatureC != null && reading.temperatureC != null) ||
            (other.gravity != null && reading.gravity != null) ||
            (other.batteryPercent != null && reading.batteryPercent != null);
          if (comparable && (other.tiltDegrees != null || reading.tiltDegrees == null) &&
              (other.batteryPercent == null || reading.batteryPercent == null || Math.abs(other.batteryPercent - reading.batteryPercent) < 1) &&
              (other.temperatureC == null || reading.temperatureC == null || Math.abs(other.temperatureC - reading.temperatureC) < 0.03) &&
              (other.gravity == null || reading.gravity == null || Math.abs(other.gravity - reading.gravity) < 0.0005)) return false;
        }
        return true;
      }));
    };
    request.onerror = () => reject(request.error);
  });
}

async function latestServerUs(pillId: string): Promise<number> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).index("by_pill_server_us")
      .openCursor(IDBKeyRange.bound([pillId, 0], [pillId, Number.MAX_SAFE_INTEGER]), "prev");
    request.onsuccess = () => resolve((request.result?.value as HistoricalReading | undefined)?.serverUs ?? 0);
    request.onerror = () => reject(request.error);
  });
}

async function saveServerPage(readings: HistoricalReading[]): Promise<void> {
  if (!readings.length) return;
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const reading of readings) store.add(reading);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function syncServerHistory(pillId: string, historyId: string, readKey: string): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(historyId)) throw new Error("Invalid history ID.");
  let after = await latestServerUs(pillId);
  let added = 0;
  for (;;) {
    const response = await fetch(`https://openpill.yeast.win/v1/history/${historyId}?after=${after}`, {
      headers: { Authorization: `Bearer ${readKey}` }, cache: "no-store"
    });
    if (response.status === 404 && after === 0) return added;
    if (!response.ok) throw new Error(`History sync failed (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength % 33 !== 0) throw new Error("Invalid history response.");
    const view = new DataView(bytes);
    const readings: HistoricalReading[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 33) {
      const us = Number(view.getBigUint64(offset, false));
      if (!Number.isSafeInteger(us) || us <= after) throw new Error("Invalid history timestamp.");
      const decoded = parseTelemetry(new DataView(bytes, offset + 8, 25));
      if (!decoded) throw new Error("Invalid history reading.");
      readings.push({ ...fromBroadcast(pillId, decoded, Math.floor(us / 1000)), source: "server", serverUs: us });
      after = us;
    }
    await saveServerPage(readings);
    added += readings.length;
    if (readings.length < 1024) return added;
  }
}

export async function deleteReadings(pillId: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const index = transaction.objectStore(STORE_NAME).index("by_pill_time");
    const request = index.openKeyCursor(IDBKeyRange.bound([pillId, 0], [pillId, Number.MAX_SAFE_INTEGER]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        transaction.objectStore(STORE_NAME).delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
