const DATABASE_NAME = "openpill-recovery";
const STORE_NAME = "backups";
const OTA_SLOT_SIZE = 0x180000;

export interface RecoveryBackup {
  id: string;
  mac: string;
  createdAt: number;
  sha256: string;
  image: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBackup(backup: RecoveryBackup): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(backup);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function listBackups(): Promise<RecoveryBackup[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as RecoveryBackup[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function downloadImage(image: Blob, name: string) {
  const url = URL.createObjectURL(image);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadBackup(backup: RecoveryBackup) {
  downloadImage(backup.image, `pill-recovery-${backup.mac.replaceAll(":", "").toLowerCase()}-${backup.sha256}-${new Date(backup.createdAt).toISOString().replaceAll(":", "-")}.bin`);
}

export function downloadOtaSlot(backup: RecoveryBackup, slot: 0 | 1) {
  const address = 0x10000 + slot * OTA_SLOT_SIZE;
  downloadImage(backup.image.slice(address, address + OTA_SLOT_SIZE),
    `pill-${backup.mac.replaceAll(":", "").toLowerCase()}-ota_${slot}-${new Date(backup.createdAt).toISOString().replaceAll(":", "-")}.bin`);
}
