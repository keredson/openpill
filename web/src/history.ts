import type { BroadcastReading, HardwareSample } from "./ble";
import { batteryPercentFromMv } from "./battery";

const DATABASE_NAME = "openpill-readings";
const STORE_NAME = "readings";

export interface HistoricalReading {
  id?: number;
  pillId: string;
  at: number;
  source: "broadcast" | "connected";
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
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("by_pill_time", ["pillId", "at"]);
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
  return {
    pillId, at, source: "broadcast",
    ...(reading.temperatureC != null && { temperatureC: reading.temperatureC }),
    ...(reading.gravity != null && { gravity: reading.gravity }),
    batteryPercent: reading.batteryPercent
  };
}

export function fromHardware(pillId: string, sample: HardwareSample, at = Date.now()): HistoricalReading {
  const [x, y, z] = sample.acceleration;
  return {
    pillId, at, source: "connected",
    ...((sample.valid & 1) !== 0 && {
      acceleration: sample.acceleration,
      tiltDegrees: Math.atan2(Math.hypot(y, z), Math.abs(x)) * 180 / Math.PI
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
    request.onsuccess = () => resolve(request.result as HistoricalReading[]);
    request.onerror = () => reject(request.error);
  });
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
