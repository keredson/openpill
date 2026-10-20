const PREFIX = "openpill.history.read.v1.";
const CONTROL_PREFIX = "openpill.history.control.v1.";

function validSecret(value: string): boolean {
  try {
    return /^[A-Za-z0-9_-]{43}$/.test(value) && encodeBase64url(base64urlBytes(value)) === value;
  } catch { return false; }
}

function base64urlBytes(value: string): Uint8Array {
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function loadReadKey(historyId: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(historyId)) return null;
  try {
    const value = localStorage.getItem(PREFIX + historyId);
    return value && validSecret(value) ? value : null;
  } catch { return null; }
}

export function loadControlKey(historyId: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(historyId)) return null;
  try {
    const value = localStorage.getItem(CONTROL_PREFIX + historyId);
    return value && validSecret(value) ? value : null;
  } catch { return null; }
}

export function saveControlKey(historyId: string, secret: string): void {
  if (!/^[0-9a-f]{64}$/.test(historyId) || !validSecret(secret)) throw new Error("Invalid control key.");
  localStorage.setItem(CONTROL_PREFIX + historyId, secret);
}

export function forgetControlKey(historyId: string): void {
  localStorage.removeItem(CONTROL_PREFIX + historyId);
}

export function saveReadKey(historyId: string, secret: string): void {
  if (!/^[0-9a-f]{64}$/.test(historyId) || !validSecret(secret)) throw new Error("Invalid history key.");
  localStorage.setItem(PREFIX + historyId, secret);
}

export function forgetReadKey(historyId: string): void {
  localStorage.removeItem(PREFIX + historyId);
}

export function generateReadKey(): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashReadKey(secret: string): Promise<string> {
  if (!validSecret(secret)) throw new Error("Invalid history key.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(base64urlBytes(secret))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
