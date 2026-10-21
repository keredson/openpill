import type { HardwareSample, PublicConfig } from "./ble";

const STORAGE_KEY = "openpill.savedPills.v1";

export const CAP_COLORS = [
  { value: "yellow", label: "Yellow", hex: "#e5b83d" },
  { value: "red", label: "Red", hex: "#c85d56" },
  { value: "green", label: "Green", hex: "#4f9d71" },
  { value: "blue", label: "Blue", hex: "#5d83c4" },
] as const;

export type CapColor = typeof CAP_COLORS[number]["value"];

export interface SavedPill {
  id: string;
  name: string;
  customName?: string;
  capColor?: CapColor;
  firmwareVersion?: string;
  sample?: HardwareSample;
  config?: PublicConfig;
  historyId?: string;
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
