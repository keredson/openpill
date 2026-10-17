const FLASH_SIZE = 0x400000;
export const PILL_APP_ADDRESS = 0x10000;
export const PILL_APP_SLOT_SIZE = 0x180000;
export type OtaSlot = 0 | 1;
export type TransferStage = "inspect" | "write" | "verify" | "select";
export type TransferProgress = (stage: TransferStage, percent: number) => void;
export interface SlotInfo { slot: OtaSlot; name: string; version: string; valid: boolean; active: boolean }
export interface PillSlots { mac: string; slots: [SlotInfo, SlotInfo]; activeSlot: OtaSlot }
const OTA_DATA_ADDRESS = 0xd000;
const OTA_DATA_SIZE = 0x2000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface FlashOptions {
  fileArray: { data: Uint8Array; address: number }[];
  flashMode: "dio";
  flashFreq: "40m";
  flashSize: "4MB";
  eraseAll: false;
  compress: boolean;
  reportProgress?: (index: number, written: number, total: number) => void;
}

interface EspLoader {
  transport: EspTransport;
  chip: {
    CHIP_NAME: string;
    getChipDescription(loader: EspLoader): Promise<string>;
    readMac(loader: EspLoader): Promise<string>;
  };
  main(mode?: "default_reset" | "no_reset"): Promise<string>;
  detectFlashSize(): Promise<string | undefined>;
  readFlash(address: number, size: number, progress?: (packet: Uint8Array, read: number, total: number) => void): Promise<Uint8Array>;
  writeFlash(options: FlashOptions): Promise<void>;
  after(mode: "custom_reset", usingUsbOtg?: boolean, sequence?: string): Promise<void>;
}

interface EspTransport {
  disconnect(): Promise<void>;
  read(timeout: number): Promise<Uint8Array>;
}
interface EspToolModule {
  ESPLoader: new (options: { transport: EspTransport; baudrate: number; terminal?: {
    clean(): void; write(data: string): void; writeLine(data: string): void;
  } }) => EspLoader;
  Transport: new (port: BrowserSerialPort) => EspTransport;
}

async function esptool(): Promise<EspToolModule> {
  const url = new URL("/vendor/esptool-js-0.7.0.js", location.origin).href;
  return await import(/* @vite-ignore */ url) as EspToolModule;
}

export async function chooseSerialPort(): Promise<BrowserSerialPort> {
  if (!navigator.serial) throw new Error("Use a desktop Chromium browser with Web Serial and HTTPS (or localhost).");
  try {
    return await navigator.serial.requestPort();
  } catch (error) {
    if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "AbortError")) {
      throw new SerialPortSelectionCancelled();
    }
    throw error;
  }
}

export class SerialPortSelectionCancelled extends Error {}
export class PillTrafficNotDetected extends Error {}
export class BridgeNotResponding extends Error {
  constructor(message: string, readonly startupOutput = "") { super(message); }
}

async function asset(path: string): Promise<Uint8Array> {
  const response = await fetch(`/firmware/${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Firmware package ${path} is unavailable on this site.`);
  const image = new Uint8Array(await response.arrayBuffer());
  if (path === "openpill.bin") {
    const elfSha256 = image.length >= 0xd0
      ? Array.from(image.subarray(0xb0, 0xd0), (byte) => byte.toString(16).padStart(2, "0")).join("")
      : "unavailable";
    console.info("[OpenPill] Pill firmware asset", {
      bytes: image.length, elfSha256,
      source: response.headers.get("X-OpenPill-Firmware-Source") ?? "staged-site-asset"
    });
  }
  return image;
}

export async function flashBridge(port: BrowserSerialPort, onProgress: (percent: number) => void): Promise<void> {
  const [bootloader, partitions, app] = await Promise.all([
    asset("bridge-bootloader.bin"), asset("bridge-partitions.bin"), asset("bridge-app.bin")
  ]);
  if (bootloader[0] !== 0xe9 || app[0] !== 0xe9 || partitions[0] !== 0xaa || partitions[1] !== 0x50) {
    throw new Error("The bridge firmware package failed validation.");
  }
  const tool = await esptool();
  const transport = new tool.Transport(port);
  try {
    const loader = new tool.ESPLoader({ transport, baudrate: 115200 });
    await loader.main("default_reset");
    if (loader.chip.CHIP_NAME !== "ESP32") throw new Error("The selected bridge board is not a classic ESP32.");
    if (/^ESP32-S0WD/.test(await loader.chip.getChipDescription(loader))) {
      throw new Error("This looks like the Pill, not the development-board bridge. No bridge firmware was written.");
    }
    if (await loader.detectFlashSize() !== "4MB") throw new Error("The bridge board must have 4 MiB of flash.");
    await loader.writeFlash({
      fileArray: [
        { data: bootloader, address: 0x1000 },
        { data: partitions, address: 0x8000 },
        { data: app, address: 0x10000 }
      ],
      flashMode: "dio", flashFreq: "40m", flashSize: "4MB", eraseAll: false,
      compress: true,
      reportProgress: (index, written, total) => {
        const sizes = [bootloader.length, partitions.length, app.length];
        const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
        const completed = before + sizes[index] * (written / total);
        onProgress(Math.round(completed / sizes.reduce((sum, size) => sum + size, 0) * 95));
      }
    });
    // The default hard reset only releases RTS. Pulse reset explicitly so the
    // freshly flashed bridge leaves the ROM/stub and starts its application.
    await loader.after("custom_reset", false, "D0|R1|W100|R0|W500");
  } finally {
    await transport.disconnect().catch(() => {});
  }
  try {
    await pingBridge(port);
  } catch (failure) {
    if (failure instanceof BridgeNotResponding) {
      throw new BridgeNotResponding("The bridge firmware was written, but the ESP32 did not answer after restarting.", failure.startupOutput);
    }
    throw failure;
  }
  onProgress(100);
}

async function bridgeCommand(port: BrowserSerialPort, command: "BOOT" | "RESET" | "PING", listenAfterAckMs = 0): Promise<string> {
  try {
    await port.open({ baudRate: 115200 });
  } catch (failure) {
    if (failure instanceof DOMException && (failure.name === "NetworkError" || failure.name === "InvalidStateError")) {
      throw new BridgeNotResponding("Could not open the ESP32 board’s serial port. Unplug and reconnect USB, then select it again. Close any serial monitor or other tab using the port.");
    }
    throw failure;
  }
  try {
    // The flasher can leave modem-control lines asserted. Release them so the
    // development board is not held in reset when the port is reopened.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("Could not write to the ESP32 bridge.");
    try { await writer.write(textEncoder.encode(`+++OPENPILL_${command}\r`)); }
    finally { writer.releaseLock(); }

    const reader = port.readable?.getReader();
    if (!reader) throw new Error("Could not read from the ESP32 bridge.");
    let output = "";
    const timeout = window.setTimeout(() => void reader.cancel(), 4000 + listenAfterAckMs);
    let heardAck = false;
    let afterAckTimer: number | undefined;
    try {
      while (output.length < 8192) {
        const result = await reader.read();
        if (result.done) break;
        output += textDecoder.decode(result.value);
        if (output.includes(command === "PING" ? "OPENPILL-BRIDGE/1" : `OPENPILL-BRIDGE ${command}`)) {
          if (!listenAfterAckMs) break;
          if (!heardAck) {
            heardAck = true;
            afterAckTimer = window.setTimeout(() => void reader.cancel(), listenAfterAckMs);
          }
        }
      }
    } finally {
      window.clearTimeout(timeout);
      if (afterAckTimer !== undefined) window.clearTimeout(afterAckTimer);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!output.includes(command === "PING" ? "OPENPILL-BRIDGE/1" : `OPENPILL-BRIDGE ${command}`)) {
      const readable = output.replace(/[^\x20-\x7e\r\n]/g, "").trim();
      throw new BridgeNotResponding(readable
        ? "The ESP32 board started, but the bridge app did not answer."
        : "The ESP32 board did not answer, and no startup output was received.", readable);
    }
    return output;
  } finally {
    await port.close();
  }
}

export async function pingBridge(port: BrowserSerialPort): Promise<void> {
  await bridgeCommand(port, "PING");
}

export async function checkPillLink(port: BrowserSerialPort): Promise<void> {
  // A reset makes even a sleeping Pill send boot traffic. Its contents need not be decoded.
  const response = await bridgeCommand(port, "RESET", 1500);
  const pillTraffic = response.replace(/OPENPILL-BRIDGE RESET\r?\n/g, "")
    .replace(/OPENPILL-BRIDGE\/1\r?\n/g, "")
    .replace(/OPENPILL-BRIDGE BOOT\r?\n/g, "").trim();
  if (!pillTraffic) throw new PillTrafficNotDetected("No data heard from the Pill. Check its power and the wiring, then try again.");
}

export async function verifyPill(port: BrowserSerialPort): Promise<{ loader: EspLoader; transport: EspTransport; mac: string; description: string }> {
  await bridgeCommand(port, "PING");
  await bridgeCommand(port, "BOOT");
  const tool = await esptool();
  const transport = new tool.Transport(port);
  try {
    let mac = "";
    const terminal = {
      clean: () => {},
      write: (data: string) => { console.log(data); },
      writeLine: (data: string) => {
        console.log(data);
        const found = /^MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*$/i.exec(data.trim());
        if (found) mac = found[1].toUpperCase();
      }
    };
    const loader = new tool.ESPLoader({ transport, baudrate: 115200, terminal });
    await loader.main("no_reset");
    const description = await loader.chip.getChipDescription(loader);
    if (!/^ESP32-S0WD \(/.test(description)) throw new Error(`Unsupported Pill chip: ${description}. Expected ESP32-S0WD.`);
    if (await loader.detectFlashSize() !== "4MB") throw new Error("Expected a 4 MiB Pill flash chip.");
    if (!mac) throw new Error("Could not confirm the Pill’s MAC address. Nothing was written.");
    console.info(`[OpenPill] Pill verified: ${description}, ${mac}, 4 MiB flash`);
    return { loader, transport, mac, description };
  } catch (error) {
    await transport.disconnect().catch(() => {});
    if (error instanceof Error && error.message.includes("Failed to connect with the device")) {
      throw new Error("The Pill did not enter flashing mode. Check that its IO0 and EN pads are connected to GPIO26 and GPIO25 on the ESP32 bridge, and that TX/RX and ground are connected. Nothing was written to the Pill.");
    }
    throw error;
  }
}

function partitionTable(image: Uint8Array): Map<string, { offset: number; size: number }> {
  const partitions = new Map<string, { offset: number; size: number }>();
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  for (let address = 0; address < image.length; address += 32) {
    if (view.getUint16(address, true) !== 0x50aa) break;
    const name = textDecoder.decode(image.subarray(address + 12, address + 28)).replace(/\0.*$/, "");
    partitions.set(name, { offset: view.getUint32(address + 4, true), size: view.getUint32(address + 8, true) });
  }
  return partitions;
}

function validatePillLayout(bootloader: Uint8Array, table: Uint8Array, app0: Uint8Array, app1: Uint8Array): void {
  if (bootloader[0] !== 0xe9) throw new Error("The existing bootloader is not a readable ESP32 image. Protected flash is unsupported.");
  const partitions = partitionTable(table);
  for (const [name, offset, size] of [
    ["otadata", OTA_DATA_ADDRESS, OTA_DATA_SIZE],
    ["ota_0", PILL_APP_ADDRESS, PILL_APP_SLOT_SIZE],
    ["ota_1", 0x190000, PILL_APP_SLOT_SIZE],
    ["nvs", 0x310000, 0x80000]
  ] as const) {
    const found = partitions.get(name);
    if (!found || found.offset !== offset || found.size !== size) {
      throw new Error(`Unexpected ${name} partition layout. This conversion only supports the verified 4 MiB layout.`);
    }
  }
  if (app0[0] !== 0xe9 && app1[0] !== 0xe9) {
    throw new Error("Neither application slot contains a readable ESP32 image.");
  }
}

export function validatePillBackup(image: Uint8Array): void {
  if (image.length !== FLASH_SIZE) throw new Error("The backup must contain exactly 4 MiB.");
  validatePillLayout(image.subarray(0x1000, 0x2000), image.subarray(0x8000, 0x9000),
    image.subarray(PILL_APP_ADDRESS, PILL_APP_ADDRESS + 0x1000), image.subarray(0x190000, 0x191000));
}

export function otaSlotImage(image: Uint8Array, slot: OtaSlot): Uint8Array {
  validatePillBackup(image);
  const address = PILL_APP_ADDRESS + slot * PILL_APP_SLOT_SIZE;
  const app = image.slice(address, address + PILL_APP_SLOT_SIZE);
  if (app[0] !== 0xe9) throw new Error(`Saved firmware slot ${slot} does not contain a readable ESP32 image.`);
  return app;
}

function appDescription(header: Uint8Array, slot: OtaSlot): SlotInfo {
  const valid = header[0] === 0xe9 && new DataView(header.buffer, header.byteOffset).getUint32(0x20, true) === 0xabcd5432;
  const field = (offset: number) => textDecoder.decode(header.subarray(offset, offset + 32)).split("\0", 1)[0].trim();
  const project = valid ? field(0x50) : "";
  const version = valid ? field(0x30) : "";
  const name = project === "openpill" ? "OpenPill" : project === "rapt-hydrometer" ? "RAPT" : project || "Unknown firmware";
  return { slot, name, version: version || "Unknown version", valid, active: false };
}

function selectedOtaSlot(otadata: Uint8Array): OtaSlot {
  const view = new DataView(otadata.buffer, otadata.byteOffset);
  const entries = [0, 1].map((sector) => {
    const offset = sector * 0x1000;
    const sequence = view.getUint32(offset, true);
    const state = view.getUint32(offset + 24, true);
    const crc = view.getUint32(offset + 28, true);
    return { sequence, valid: sequence !== 0 && sequence !== 0xffffffff && state !== 3 && state !== 4 && crc === otaSequenceCrc(sequence) };
  });
  const active = entries.filter((entry) => entry.valid).sort((a, b) => b.sequence - a.sequence)[0];
  if (!active) throw new Error("The Pill’s active firmware slot could not be determined. No boot change was made.");
  return ((active.sequence - 1) % 2) as OtaSlot;
}

export async function inspectPillSlots(loader: EspLoader, mac: string): Promise<PillSlots> {
  const bootloader = await readPillRegion(loader, 0x1000, 0x1000, "bootloader header");
  const table = await readPillRegion(loader, 0x8000, 0x1000, "partition table");
  const app0 = await readPillRegion(loader, PILL_APP_ADDRESS, 0x1000, "slot 0 header");
  const app1 = await readPillRegion(loader, 0x190000, 0x1000, "slot 1 header");
  validatePillLayout(bootloader, table, app0, app1);
  const selector = await readPillRegion(loader, OTA_DATA_ADDRESS, OTA_DATA_SIZE, "boot selector");
  const activeSlot = selectedOtaSlot(selector);
  const slots: [SlotInfo, SlotInfo] = [appDescription(app0, 0), appDescription(app1, 1)];
  slots[activeSlot].active = true;
  return { mac, slots, activeSlot };
}

export async function switchPillSlot(loader: EspLoader, mac: string, expected: PillSlots): Promise<SlotInfo> {
  const current = await inspectPillSlots(loader, mac);
  if (current.mac !== expected.mac || current.activeSlot !== expected.activeSlot ||
      current.slots.some((slot, index) => slot.name !== expected.slots[index].name || slot.version !== expected.slots[index].version)) {
    throw new Error("The Pill’s firmware slots changed since inspection. Inspect again before switching.");
  }
  const targetSlot = (1 - current.activeSlot) as OtaSlot;
  const target = current.slots[targetSlot];
  if (!target.valid) throw new Error("The other slot does not contain a readable firmware image.");
  const selector = await readPillRegion(loader, OTA_DATA_ADDRESS, OTA_DATA_SIZE, "boot selector");
  const next = inactiveSlot(selector, new Uint8Array([current.slots[0].valid ? 0xe9 : 0]), new Uint8Array([current.slots[1].valid ? 0xe9 : 0]));
  if (next.slot !== targetSlot) throw new Error("The boot selection changed. Inspect again before switching.");
  const newSelector = new Uint8Array(0x1000).fill(0xff);
  const view = new DataView(newSelector.buffer);
  view.setUint32(0, next.nextSequence, true);
  view.setUint32(24, 2, true); // Existing firmware image: select without marking it as newly written.
  view.setUint32(28, otaSequenceCrc(next.nextSequence), true);
  console.info(`[OpenPill] Switching boot selection to slot ${targetSlot}: ${target.name} ${target.version}`);
  await loader.writeFlash({ fileArray: [{ data: newSelector, address: next.selectorAddress }], flashMode: "dio", flashFreq: "40m", flashSize: "4MB", eraseAll: false, compress: false });
  const verified = await readPillRegion(loader, next.selectorAddress, newSelector.length, "boot selector verification");
  if (await sha256(verified) !== await sha256(newSelector)) throw new Error("Boot selection verification failed. Do not reset the Pill.");
  return target;
}

function otaSequenceCrc(sequence: number): number {
  let crc = 0;
  for (let index = 0; index < 4; index++) {
    crc ^= (sequence >>> (index * 8)) & 0xff;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function inactiveSlot(otadata: Uint8Array, app0: Uint8Array, app1: Uint8Array) {
  const view = new DataView(otadata.buffer, otadata.byteOffset, otadata.byteLength);
  const entries = [0, 1].map((sector) => {
    const offset = sector * 0x1000;
    const sequence = view.getUint32(offset, true);
    const state = view.getUint32(offset + 24, true);
    const crc = view.getUint32(offset + 28, true);
    return { sector, sequence, valid: sequence !== 0 && sequence !== 0xffffffff && state !== 3 && state !== 4 && crc === otaSequenceCrc(sequence) };
  });
  const active = entries.filter((entry) => entry.valid).sort((a, b) => b.sequence - a.sequence)[0];
  const activeSlot = active ? (active.sequence - 1) % 2 : 0;
  if ((activeSlot === 0 ? app0 : app1)[0] !== 0xe9) {
    throw new Error("The selected application slot is unreadable. A recovery copy is required before installing OpenPill.");
  }
  const nextSequence = active ? active.sequence + 1 : 2;
  if (nextSequence >= 0xffffffff) throw new Error("The Pill's update counter is exhausted. Installation stopped without writing.");
  return { slot: 1 - activeSlot, address: activeSlot === 0 ? 0x190000 : PILL_APP_ADDRESS,
    selectorAddress: OTA_DATA_ADDRESS + (active ? 1 - active.sector : 0) * 0x1000, nextSequence };
}

export async function readPillBackup(loader: EspLoader, onProgress: (percent: number) => void): Promise<Uint8Array> {
  const image = await readPillRegion(loader, 0, FLASH_SIZE, "full recovery backup", (read, total) =>
    onProgress(Math.round(read / total * 100)));
  validatePillBackup(image);
  return image;
}

export async function sha256(image: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", image.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readPillRegion(loader: EspLoader, address: number, size: number, purpose: string,
  onProgress?: (read: number, total: number) => void): Promise<Uint8Array> {
  const region = `0x${address.toString(16)} (${size} bytes)`;
  let accepted = 0;
  console.info(`[OpenPill] Reading ${purpose} at ${region}`);
  try {
    const image = await loader.readFlash(address, size, (_packet, read, total) => {
      accepted = read;
      onProgress?.(read, total);
    });
    if (image.length !== size) throw new Error(`Received ${image.length} of ${size} bytes.`);
    // The stub sends a raw 16-byte MD5 frame after the last acknowledged data
    // packet. esptool-js 0.7.0 returns before reading it; leaving that frame in
    // the transport makes the next flash command fail before any data arrives.
    const digest = await loader.transport.read(3000);
    if (digest.length !== 16) throw new Error(`Expected the 16-byte read digest; received ${digest.length} bytes.`);
    console.info(`[OpenPill] Read ${purpose} complete at ${region}`);
    return image;
  } catch (error) {
    console.error(`[OpenPill] Read ${purpose} failed at ${region}; received ${accepted} bytes`, error);
    const detail = error instanceof Error ? error.message : String(error);
    const reason = detail.startsWith("Serial data stream stopped:")
      ? "The serial connection stopped. Please try again."
      : detail;
    throw new Error(`Could not read ${purpose} at ${region} after ${accepted} bytes. ${reason}`);
  }
}

export async function flashPill(loader: EspLoader, onProgress: TransferProgress): Promise<0 | 1> {
  const app = await asset("openpill.bin");
  return installAppToInactiveSlot(loader, app, onProgress);
}

export async function restoreOtaSlot(loader: EspLoader, image: Uint8Array, slot: OtaSlot,
  onProgress: TransferProgress): Promise<OtaSlot> {
  return installAppToInactiveSlot(loader, otaSlotImage(image, slot), onProgress);
}

async function installAppToInactiveSlot(loader: EspLoader, app: Uint8Array,
  onProgress: TransferProgress): Promise<OtaSlot> {
  if (app[0] !== 0xe9 || app.length === 0 || app.length > PILL_APP_SLOT_SIZE) {
    throw new Error("The application image is invalid or too large for the Pill.");
  }
  onProgress("inspect", 0);
  const bootloader = await readPillRegion(loader, 0x1000, 0x1000, "bootloader header");
  const table = await readPillRegion(loader, 0x8000, 0x1000, "partition table");
  const app0 = await readPillRegion(loader, PILL_APP_ADDRESS, 0x1000, "slot 0 header");
  const app1 = await readPillRegion(loader, 0x190000, 0x1000, "slot 1 header");
  validatePillLayout(bootloader, table, app0, app1);
  const selector = await readPillRegion(loader, OTA_DATA_ADDRESS, OTA_DATA_SIZE, "boot selector");
  const target = inactiveSlot(selector, app0, app1);
  onProgress("write", 0);
  console.info(`[OpenPill] Writing application to inactive slot ${target.slot} at 0x${target.address.toString(16)} (${app.length} bytes)`);
  // Write the app first. Do not change boot selection until it reads back exactly.
  await loader.writeFlash({
    fileArray: [{ data: app, address: target.address }],
    flashMode: "dio", flashFreq: "40m", flashSize: "4MB", eraseAll: false,
    compress: true, reportProgress: (_index, written, total) => onProgress("write", Math.round(written / total * 100))
  });
  onProgress("write", 100);
  onProgress("verify", 0);
  const readBack = await readPillRegion(loader, target.address, app.length, "application verification", (read, total) =>
    onProgress("verify", Math.round(read / total * 100)));
  if (await sha256(readBack) !== await sha256(app)) {
    throw new Error("App read-back did not match. Boot selection was left unchanged. If needed, restore from a recovery copy.");
  }
  onProgress("verify", 100);
  onProgress("select", 0);
  const newSelector = new Uint8Array(0x1000).fill(0xff);
  const newSelectorView = new DataView(newSelector.buffer);
  newSelectorView.setUint32(0, target.nextSequence, true);
  newSelectorView.setUint32(24, 0, true); // New image; bootloader rollback can validate its first boot.
  newSelectorView.setUint32(28, otaSequenceCrc(target.nextSequence), true);
  console.info(`[OpenPill] Selecting slot ${target.slot} at 0x${target.selectorAddress.toString(16)}`);
  await loader.writeFlash({
    fileArray: [{ data: newSelector, address: target.selectorAddress }],
    flashMode: "dio", flashFreq: "40m", flashSize: "4MB", eraseAll: false, compress: false
  });
  const selected = await readPillRegion(loader, target.selectorAddress, newSelector.length, "boot selector verification");
  if (await sha256(selected) !== await sha256(newSelector)) {
    throw new Error("Boot selection could not be verified. Do not reset the Pill; restore from a recovery copy if available.");
  }
  onProgress("select", 100);
  return target.slot as 0 | 1;
}

export async function restorePill(loader: EspLoader, image: Uint8Array, onProgress: TransferProgress): Promise<void> {
  validatePillBackup(image);
  onProgress("write", 0);
  console.info("[OpenPill] Writing the full 4 MiB recovery image");
  await loader.writeFlash({
    fileArray: [{ data: image, address: 0 }],
    flashMode: "dio", flashFreq: "40m", flashSize: "4MB", eraseAll: false,
    compress: true, reportProgress: (_index, written, total) => onProgress("write", Math.round(written / total * 100))
  });
  onProgress("write", 100);
  onProgress("verify", 0);
  const readBack = await readPillRegion(loader, 0, FLASH_SIZE, "full recovery verification", (read, total) =>
    onProgress("verify", Math.round(read / total * 100)));
  if (await sha256(readBack) !== await sha256(image)) {
    throw new Error("The restored image did not match the recovery copy. Do not disconnect power; try the restore again.");
  }
  onProgress("verify", 100);
}

export async function resetPill(port: BrowserSerialPort): Promise<string> {
  return bridgeCommand(port, "RESET");
}
