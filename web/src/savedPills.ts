import type { HardwareSample, PublicConfig } from "./ble";

const STORAGE_KEY = "openpill.savedPills.v1";

export interface SavedPill {
  id: string;
  name: string;
  firmwareVersion?: string;
  sample?: HardwareSample;
  config?: PublicConfig;
  readAt?: number;
}

export function shouldImportGrantedPills(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === null;
  } catch {
    return true;
  }
}

export function loadSavedPills(): SavedPill[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedPill =>
      typeof item === "object" && item !== null &&
      typeof item.id === "string" && typeof item.name === "string");
  } catch {
    return [];
  }
}

export function storeSavedPills(pills: SavedPill[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pills));
  } catch {
    // Private browsing or disabled storage should not prevent Bluetooth use.
  }
}
