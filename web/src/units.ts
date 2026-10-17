export type TemperatureUnit = "celsius" | "fahrenheit";
export type GravityUnit = "sg" | "plato";

export interface UnitPreferences {
  temperature: TemperatureUnit;
  gravity: GravityUnit;
}

const STORAGE_KEY = "openpill-display-units";
const defaults: UnitPreferences = { temperature: "celsius", gravity: "sg" };

export function loadUnitPreferences(): UnitPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return {
      temperature: saved?.temperature === "fahrenheit" ? "fahrenheit" : "celsius",
      gravity: saved?.gravity === "plato" ? "plato" : "sg"
    };
  } catch {
    return defaults;
  }
}

export function storeUnitPreferences(units: UnitPreferences): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(units)); } catch { /* Display choices still apply in this tab. */ }
}

export function temperatureValue(celsius: number, unit: TemperatureUnit): number {
  return unit === "fahrenheit" ? celsius * 9 / 5 + 32 : celsius;
}

export function gravityValue(sg: number, unit: GravityUnit): number {
  return unit === "plato" ? -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3 : sg;
}

export function formatTemperature(celsius: number, unit: TemperatureUnit): string {
  return `${temperatureValue(celsius, unit).toFixed(1)}°${unit === "fahrenheit" ? "F" : "C"}`;
}

export function formatGravity(sg: number, unit: GravityUnit): string {
  return unit === "plato" ? `${gravityValue(sg, unit).toFixed(1)}°P` : sg.toFixed(3);
}
