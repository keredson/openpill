import { batteryPercentFromMv } from "./battery";
import { SecureConfigChannel } from "./secureConfig";
import { sitePath } from "./sitePath";

export const UUID = {
  otaService: "369af8ff-2190-465f-b538-6df2fba7fcdc",
  otaControl: "84ef205e-52cc-4331-84a2-18cbaf9e0e56",
  otaData: "1b3d644f-58b8-47f7-ba13-3e0878893b25",
  otaStatus: "1b23db1d-f22f-456d-82a4-0a35710139c1",
  configService: "8f5f0000-bfc1-4d83-bf4b-28f27e63c700",
  configInfo: "8f5f0001-bfc1-4d83-bf4b-28f27e63c700",
  configWrite: "8f5f0002-bfc1-4d83-bf4b-28f27e63c700",
  configCommand: "8f5f0003-bfc1-4d83-bf4b-28f27e63c700",
  configStatus: "8f5f0004-bfc1-4d83-bf4b-28f27e63c700",
  configWifiScan: "8f5f0005-bfc1-4d83-bf4b-28f27e63c700",
  configSession: "8f5f0006-bfc1-4d83-bf4b-28f27e63c700",
  configSecureRequest: "8f5f0007-bfc1-4d83-bf4b-28f27e63c700",
  configSecureResponse: "8f5f0008-bfc1-4d83-bf4b-28f27e63c700",
  hardwareService: "3cf82945-e436-4a1a-badc-bf55bcbffc59",
  hardwareSample: "dfaba240-7af2-4e73-ae91-1925685accd5",
} as const;

const TELEMETRY_COMPANY_ID = 0x4152;

export interface BroadcastReading {
  temperatureC: number | null;
  gravity: number | null;
  batteryPercent: number;
  acceleration?: [number, number, number];
}

function packetAcceleration(data: DataView, offset: number): [number, number, number] | undefined {
  const values: [number, number, number] = [
    data.getInt16(offset, false) / 16,
    data.getInt16(offset + 2, false) / 16,
    data.getInt16(offset + 4, false) / 16
  ];
  return Math.hypot(...values) >= 500 ? values : undefined;
}

function parseSpecificGravity(value: number): number | null {
  const gravity = value > 10 ? value / 1000 : value;
  return Number.isFinite(gravity) && gravity >= 0.7 && gravity <= 1.6 ? gravity : null;
}

export function parseBroadcast(event: BluetoothAdvertisingEvent): BroadcastReading | null {
  const data = event.manufacturerData.get(TELEMETRY_COMPANY_ID);
  // Web Bluetooth removes the two-byte company ID from manufacturer data.
  if (!data || data.byteLength < 23 || data.getUint8(0) !== 0x50 ||
      data.getUint8(1) !== 0x54 || data.getUint8(2) !== 2) return null;
  const encodedTemperature = data.getUint16(9, false);
  const encodedGravity = data.getFloat32(11, false);
  const temperatureC = encodedTemperature ? encodedTemperature / 128 - 273.15 : null;
  const gravity = parseSpecificGravity(encodedGravity);
  const batteryPercent = Math.max(0, Math.min(100, data.getInt16(21, false) / 256));
  return { temperatureC, gravity, batteryPercent, acceleration: packetAcceleration(data, 15) };
}

export function parseTelemetry(data: DataView): BroadcastReading | null {
  if (data.byteLength !== 25 || data.getUint8(0) !== 0x52 || data.getUint8(1) !== 0x41 ||
      data.getUint8(2) !== 0x50 || data.getUint8(3) !== 0x54 || data.getUint8(4) !== 2) return null;
  const encodedTemperature = data.getUint16(11, false);
  const temperatureC = encodedTemperature ? encodedTemperature / 128 - 273.15 : null;
  return {
    temperatureC,
    gravity: parseSpecificGravity(data.getFloat32(13, false)),
    batteryPercent: Math.max(0, Math.min(100, data.getInt16(23, false) / 256)),
    acceleration: packetAcceleration(data, 17)
  };
}

export async function choosePill(): Promise<BluetoothDevice> {
  if (!navigator.bluetooth) throw new Error("This browser does not provide Web Bluetooth.");
  return navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "OpenPill-" }],
    optionalServices: [UUID.configService, UUID.hardwareService, UUID.otaService],
    optionalManufacturerData: [TELEMETRY_COMPANY_ID]
  });
}

export interface PublicConfig {
  schema_version: number;
  firmware_version?: string;
  firmware_elf_sha256?: string;
  running_slot?: string;
  wake_interval_s: number;
  wifi_timeout_s: number;
  ble_telemetry: boolean;
  wifi_telemetry: boolean;
  history_telemetry?: boolean;
  history_id?: string;
  has_history_read_hash?: boolean;
  auto_wifi_update: boolean;
  allow_http: boolean;
  wifi_ssid: string;
  has_wifi_password: boolean;
  endpoint_url: string;
}

export interface ConfigPatch {
  wake_interval_s: number;
  wifi_timeout_s: number;
  ble_telemetry: boolean;
  wifi_telemetry: boolean;
  history_telemetry: boolean;
  history_read_hash?: string;
  auto_wifi_update: boolean;
  allow_http: boolean;
  endpoint_url: string;
}

export interface ConfigStatus {
  version: number;
  state: number;
  message: string;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  secure: boolean;
}

export interface HardwareSample {
  version?: number;
  valid: number;
  externalPower: boolean;
  led: number;
  acceleration: [number, number, number];
  temperatureC: number;
  batteryRaw: number;
  batteryMv: number;
  gravity?: number;
}

export interface FirmwareImage {
  bytes: Uint8Array;
  sha256: Uint8Array;
  elfSha256: string;
  version: string;
}

export interface OtaProgress {
  phase: "uploading" | "verifying" | "restarting";
  accepted: number;
  total: number;
  slot?: string;
}

interface OtaStatus {
  state: number;
  error: number;
  accepted: number;
  expected: number;
  slot?: string;
}

const OTA_ERRORS: Record<number, string> = {
  1: "Invalid update command", 2: "Image is too large", 3: "No update slot available",
  4: "Could not begin the update", 5: "Wrong update state", 6: "A packet arrived out of order",
  7: "Flash write failed", 8: "Image transfer was incomplete", 9: "Image checksum did not match",
  10: "Invalid firmware image", 11: "Could not select the updated slot",
  12: "Bluetooth disconnected", 13: "Connect the charger below 30% battery",
  14: "Battery reading is unavailable", 15: "Battery below 10%; charge before updating"
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadFirmwareImage(): Promise<FirmwareImage> {
  const response = await fetch(sitePath("firmware/openpill.bin"), { cache: "no-store" });
  if (!response.ok) throw new Error("The firmware image is not available on this site.");
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 0xd0 || bytes.length > 0x180000 || bytes[0] !== 0xe9 ||
      view.getUint32(32, true) !== 0xabcd5432 || bytes[1] < 1 || bytes[1] > 16) {
    throw new Error("This site does not have a valid OpenPill application image.");
  }
  const version = decoder.decode(bytes.subarray(0x30, 0x50)).split("\0", 1)[0].trim();
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return { bytes, sha256, version, elfSha256: hex(bytes.subarray(0xb0, 0xd0)) };
}

function parseOtaStatus(view: DataView): OtaStatus {
  if (view.byteLength !== 12 || view.getUint8(0) !== 1) {
    throw new Error("The Pill returned an unsupported firmware update status.");
  }
  const slotCode = view.getUint8(3);
  return { state: view.getUint8(1), error: view.getUint8(2),
    accepted: view.getUint32(4, true), expected: view.getUint32(8, true),
    ...(slotCode >= 1 && slotCode <= 16 && { slot: `ota_${slotCode - 1}` }) };
}

function checkOtaStatus(status: OtaStatus): OtaStatus {
  if (status.error || status.state === 4) {
    throw new Error(OTA_ERRORS[status.error] ?? `The Pill rejected the update (error ${status.error}).`);
  }
  return status;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function servedFirmwareElfHash(): Promise<string | null> {
  try {
    const response = await fetch(sitePath("firmware/openpill.bin"), { cache: "no-store" });
    if (!response.ok) return null;
    const image = new Uint8Array(await response.arrayBuffer());
    if (image.length < 0xd0) return null;
    return Array.from(image.subarray(0xb0, 0xd0), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function decodeJson<T>(view: DataView): T {
  return JSON.parse(decoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
}

function parseHardware(view: DataView): HardwareSample {
  const version = view.byteLength ? view.getUint8(0) : 0;
  if (!((version === 1 && view.byteLength === 16) || (version === 2 && view.byteLength === 20))) {
    throw new Error("The device returned an unsupported sensor record.");
  }
  const encodedGravity = version === 2 ? view.getFloat32(16, true) : NaN;
  const gravity = parseSpecificGravity(encodedGravity);
  return {
    version,
    valid: view.getUint8(1),
    externalPower: view.getUint8(2) !== 0,
    led: view.getUint8(3),
    acceleration: [view.getInt16(4, true), view.getInt16(6, true), view.getInt16(8, true)],
    temperatureC: view.getInt16(10, true) / 100,
    batteryRaw: view.getInt16(12, true),
    batteryMv: view.getUint16(14, true),
    ...(gravity !== null && { gravity })
  };
}

export class OpenPillClient {
  constructor(readonly device: BluetoothDevice) {}

  server: BluetoothRemoteGATTServer | null = null;
  private gattTail: Promise<unknown> = Promise.resolve();
  private configInfo?: BluetoothRemoteGATTCharacteristic;
  private configWrite?: BluetoothRemoteGATTCharacteristic;
  private configCommand?: BluetoothRemoteGATTCharacteristic;
  private configStatus?: BluetoothRemoteGATTCharacteristic;
  private configWifiScan?: BluetoothRemoteGATTCharacteristic;
  private hardwareSample?: BluetoothRemoteGATTCharacteristic;
  private secure?: SecureConfigChannel;
  private intentionalDisconnect = false;

  private gatt<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const busyDeadline = Date.now() + 25_000;
      for (;;) {
        try {
          return await operation();
        } catch (error) {
          if (!(error instanceof Error) || !/GATT operation already in progress/i.test(error.message) ||
              Date.now() >= busyDeadline || !this.device.gatt?.connected) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    };
    const result = this.gattTail.then(run, run);
    this.gattTail = result.catch(() => {});
    return result;
  }

  private write(characteristic: BluetoothRemoteGATTCharacteristic, value: BufferSource): Promise<void> {
    return this.gatt(() => characteristic.writeValueWithResponse(value));
  }

  async connect(onDisconnect: (expected: boolean) => void, onStatus: (status: ConfigStatus) => void, maxAttempts = 5) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let stage = "opening the Bluetooth connection";
      try {
        this.intentionalDisconnect = false;
        this.secure = undefined;
        this.server = await this.device.gatt!.connect();
        stage = "finding the configuration service";
        const config = await this.gatt(() => this.server!.getPrimaryService(UUID.configService));
        stage = "finding the secure configuration channel";
        const session = await this.gatt(() => config.getCharacteristic(UUID.configSession)).catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "NotFoundError" && this.device.gatt?.connected) return undefined;
          throw error;
        });
        if (session) {
          stage = "opening the secure configuration session";
          const request = await this.gatt(() => config.getCharacteristic(UUID.configSecureRequest));
          const response = await this.gatt(() => config.getCharacteristic(UUID.configSecureResponse));
          this.secure = new SecureConfigChannel(session, request, response, (operation) => this.gatt(operation));
          await this.secure.open();
        } else {
          stage = "reading legacy configuration";
          this.configInfo = await this.gatt(() => config.getCharacteristic(UUID.configInfo));
          this.configWrite = await this.gatt(() => config.getCharacteristic(UUID.configWrite));
          this.configCommand = await this.gatt(() => config.getCharacteristic(UUID.configCommand));
        }
        stage = "reading configuration status";
        this.configStatus = await this.gatt(() => config.getCharacteristic(UUID.configStatus));
        if (!this.secure) this.configWifiScan = await this.gatt(() => config.getCharacteristic(UUID.configWifiScan)).catch(() => undefined);
        if (!this.secure) {
          await this.gatt(() => this.configStatus!.startNotifications());
          this.configStatus.addEventListener("characteristicvaluechanged", (event) => {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (value) onStatus(decodeJson<ConfigStatus>(value));
          });
        }
        stage = "finding the sensor service";
        const hardware = await this.gatt(() => this.server!.getPrimaryService(UUID.hardwareService));
        this.hardwareSample = await this.gatt(() => hardware.getCharacteristic(UUID.hardwareSample));
        // Older firmware requires link-level pairing for this read.
        stage = session ? "reading secure configuration" : "reading legacy configuration";
        const initialConfig = await this.readConfig();
        stage = "reading the sensor";
        const initialSample = await this.readHardware();
        this.device.addEventListener("gattserverdisconnected", () => {
          const expected = this.intentionalDisconnect;
          this.intentionalDisconnect = false;
          onDisconnect(expected);
        }, { once: true });
        return { config: initialConfig, sample: initialSample };
      } catch (error) {
        const disconnected = !this.device.gatt?.connected;
        const legacyReadFailed = stage === "reading legacy configuration";
        console.warn("[OpenPill] Bluetooth connection setup failed", {
          pill: this.device.name, attempt: attempt + 1, stage, disconnected,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error), error
        });
        this.device.gatt?.disconnect();
        this.server = null;
        this.configInfo = undefined;
        this.configWrite = undefined;
        this.configCommand = undefined;
        this.configStatus = undefined;
        this.configWifiScan = undefined;
        this.hardwareSample = undefined;
        this.secure = undefined;
        if (legacyReadFailed && (attempt === maxAttempts - 1 || (error instanceof Error && error.name === "NotSupportedError"))) {
          throw new Error("The browser sees the Pill's old Bluetooth service list. If you just updated firmware, remove this Pill from your computer's Bluetooth devices, reload the app, and select it again. Your saved readings will remain in the app.");
        }
        if (stage === "reading secure configuration" && disconnected && attempt === maxAttempts - 1) {
          throw new Error("The Pill disconnected during its first encrypted configuration read. Open Settings → Update firmware to install the firmware on this site. The update can use the public channel without configuration access.");
        }
        if (!disconnected || attempt === maxAttempts - 1) {
          throw new Error(`Could not finish connecting to the Pill while ${stage}. ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
    throw new Error("Could not connect to the Pill.");
  }

  disconnect() {
    if (this.device.gatt?.connected) this.intentionalDisconnect = true;
    this.device.gatt?.disconnect();
    this.secure = undefined;
  }

  /** OTA recovery on firmware that exposes public sensors and OTA but whose
   * configuration handshake cannot finish. Does not read any secrets. */
  async connectForFirmwareUpdate(): Promise<void> {
    if (!this.device.gatt?.connected) this.server = await this.device.gatt!.connect();
    else this.server = this.device.gatt;
    const hardware = await this.gatt(() => this.server!.getPrimaryService(UUID.hardwareService));
    this.hardwareSample = await this.gatt(() => hardware.getCharacteristic(UUID.hardwareSample));
    await this.readHardware();
    const ota = await this.gatt(() => this.server!.getPrimaryService(UUID.otaService));
    const status = await this.gatt(() => ota.getCharacteristic(UUID.otaStatus));
    parseOtaStatus(await this.gatt(() => status.readValue()));
  }

  async readConfig(): Promise<PublicConfig> {
    if (this.secure) return JSON.parse(await this.secure.readText(3)) as PublicConfig;
    return decodeJson<PublicConfig>(await this.gatt(() => this.configInfo!.readValue()));
  }

  async readHardware(): Promise<HardwareSample> {
    return parseHardware(await this.gatt(() => this.hardwareSample!.readValue()));
  }

  async readConfigStatus(): Promise<ConfigStatus> {
    return decodeJson<ConfigStatus>(await this.gatt(() => this.configStatus!.readValue()));
  }

  async uploadFirmware(image: FirmwareImage, onProgress: (progress: OtaProgress) => void): Promise<string | undefined> {
    if (!this.device.gatt?.connected || !this.server) throw new Error("Connect to the Pill before updating.");
    const sample = await this.readHardware();
    if (!(sample.valid & 4) || !(sample.valid & 8) || sample.batteryMv > 4300) {
      throw new Error("The Pill could not confirm its battery level; update blocked.");
    }
    const battery = batteryPercentFromMv(sample.batteryMv);
    if (battery < 10) throw new Error("Battery below 10%; charge the Pill before updating.");
    if (battery < 30 && !sample.externalPower) throw new Error("Put the Pill on its charger before updating below 30% battery.");
    let service: BluetoothRemoteGATTService;
    try {
      service = await this.gatt(() => this.server!.getPrimaryService(UUID.otaService));
    } catch (error) {
      if (!this.device.gatt?.connected) {
        console.warn("[OpenPill] Pill disconnected before OTA service discovery; reconnecting once", {
          pill: this.device.name, error
        });
        try {
          this.server = await this.device.gatt!.connect();
          service = await this.gatt(() => this.server!.getPrimaryService(UUID.otaService));
        } catch (reconnectError) {
          throw new Error(`The Pill disconnected before the firmware transfer began. Reconnect it and try again. ${reconnectError instanceof Error ? reconnectError.message : ""}`.trim());
        }
      } else {
        if (error instanceof Error && /security|not allowed|not permitted|permission/i.test(error.message)) {
          throw new Error("Firmware update access was not granted to this site. Add this Pill again, then reconnect and retry.");
        }
        throw error;
      }
    }
    const control = await this.gatt(() => service.getCharacteristic(UUID.otaControl));
    const data = await this.gatt(() => service.getCharacteristic(UUID.otaData));
    const statusCharacteristic = await this.gatt(() => service.getCharacteristic(UUID.otaStatus));
    const rawStatus = async () => parseOtaStatus(await this.gatt(() => statusCharacteristic.readValue()));
    const status = async () => checkOtaStatus(await rawStatus());
    const initial = await rawStatus();
    if (initial.state === 1 || initial.state === 2) throw new Error("An update is already in progress on this Pill.");
    const begin = new Uint8Array(37);
    begin[0] = 1;
    new DataView(begin.buffer).setUint32(1, image.bytes.length, true);
    begin.set(image.sha256, 5);
    let begun = false;
    let commitAttempted = false;
    try {
      try {
        await this.write(control, begin);
      } catch (error) {
        await status(); // Prefer the Pill's specific rejection reason when available.
        throw error;
      }
      begun = true;
      let current = await status();
      if (current.state !== 1 || current.accepted !== 0 || current.expected !== image.bytes.length) {
        throw new Error("The Pill did not accept the firmware image.");
      }
      const slot = current.slot;
      const chunkSizes = [180, 100, 64, 32, 16];
      let chunkIndex = 0;
      let offset = 0;
      let nextCheckpoint = 4096;
      onProgress({ phase: "uploading", accepted: 0, total: image.bytes.length, slot });
      while (offset < image.bytes.length) {
        const payload = image.bytes.subarray(offset, offset + chunkSizes[chunkIndex]);
        const packet = new Uint8Array(payload.length + 4);
        new DataView(packet.buffer).setUint32(0, offset, true);
        packet.set(payload, 4);
        try {
          await this.gatt(() => data.writeValueWithoutResponse(packet));
        } catch (error) {
          if (offset !== 0 || chunkIndex === chunkSizes.length - 1) throw error;
          current = await status();
          if (current.accepted !== 0 || current.state !== 1) throw error;
          chunkIndex++;
          console.info("[OpenPill] Firmware transfer retrying with smaller chunks", { payloadBytes: chunkSizes[chunkIndex] });
          continue;
        }
        offset += payload.length;
        if (offset >= nextCheckpoint || offset === image.bytes.length) {
          const deadline = Date.now() + 10_000;
          do {
            current = await status();
            if (current.accepted >= offset) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          if (current.accepted < offset) throw new Error(`The Pill stopped accepting firmware at ${current.accepted} of ${offset} bytes.`);
          onProgress({ phase: "uploading", accepted: current.accepted, total: image.bytes.length, slot });
          nextCheckpoint = offset + 4096;
        }
      }
      onProgress({ phase: "verifying", accepted: image.bytes.length, total: image.bytes.length, slot });
      commitAttempted = true;
      let readyAfterLostResponse = false;
      try {
        await this.write(control, Uint8Array.of(2));
      } catch (error) {
        try {
          current = await status();
          readyAfterLostResponse = current.state === 3;
        } catch (statusError) {
          console.warn("[OpenPill] Commit response and status were lost", {
            pill: this.device.name, commitError: error, statusError,
            connected: this.device.gatt?.connected
          });
          throw new Error("The Pill disconnected while finishing the update. It may have restarted successfully. Reconnect and check the installed firmware before trying again.");
        }
      }
      if (!readyAfterLostResponse) {
        try {
          current = await status();
        } catch (error) {
          console.warn("[OpenPill] Could not read final OTA status", {
            pill: this.device.name, error, connected: this.device.gatt?.connected
          });
          throw new Error("The Pill disconnected before the update could be confirmed. Reconnect and check the installed firmware before trying again.");
        }
      }
      if (current.state !== 3) throw new Error("The Pill did not confirm the update. Reconnect and check its firmware version before trying again.");
      onProgress({ phase: "restarting", accepted: image.bytes.length, total: image.bytes.length, slot });
      return slot;
    } finally {
      if (begun && !commitAttempted && this.device.gatt?.connected) {
        try { await this.write(control, Uint8Array.of(3)); } catch { /* Disconnect also aborts the transfer. */ }
      }
    }
  }

  async scanWifiNetworks(): Promise<WifiNetwork[]> {
    if (this.secure) {
      await this.secure.send(5);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = JSON.parse(await this.secure.readText(4)) as { state: string; message?: string; networks?: WifiNetwork[] };
        if (result.state === "ready") return result.networks ?? [];
        if (result.state === "error") throw new Error(result.message ?? "The Pill could not scan for Wi-Fi networks.");
      }
      throw new Error("The Wi-Fi scan timed out. Please try again.");
    }
    let stage = "finding the Wi-Fi scan characteristic";
    console.info("[OpenPill] Wi-Fi scan requested", { pill: this.device.name, connected: this.device.gatt?.connected });
    try {
    if (!this.configWifiScan) {
      const service = await this.gatt(() => this.server!.getPrimaryService(UUID.configService));
      this.configWifiScan = await this.gatt(() => service.getCharacteristic(UUID.configWifiScan)).catch(() => undefined);
    }
    if (!this.configWifiScan) {
      const [config, servedHash] = await Promise.all([this.readConfig(), servedFirmwareElfHash()]);
      const runningHash = config.firmware_elf_sha256?.toLowerCase();
      console.warn("[OpenPill] Wi-Fi scan GATT characteristic missing", {
        firmware: config.firmware_version, slot: config.running_slot,
        runningElfSha256: runningHash, servedElfSha256: servedHash
      });
      if (runningHash && servedHash && runningHash === servedHash) {
        throw new Error("The Pill is running the firmware served by this site, but Bluetooth still shows an older service list. Disconnect the Pill, restart Bluetooth and the browser, then reconnect.");
      }
      if (runningHash && servedHash && runningHash !== servedHash) {
        throw new Error("This Pill is running a different firmware image from the one served by this site. Check which image and OTA slot were flashed, then reconnect.");
      }
      throw new Error("This Pill is not exposing Wi-Fi scan over Bluetooth. Reconnect after flashing; if it still fails, restart Bluetooth and the browser.");
    }
    stage = "starting the scan";
    console.info("[OpenPill] Starting Wi-Fi scan on Pill");
    await this.write(this.configWifiScan, Uint8Array.of(1));
    stage = "waiting for scan results";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = decodeJson<{ state: string; message?: string; networks?: WifiNetwork[] }>(await this.gatt(() => this.configWifiScan!.readValue()));
      if (result.state === "ready") {
        console.info("[OpenPill] Wi-Fi scan complete", { networks: result.networks?.length ?? 0 });
        return result.networks ?? [];
      }
      if (result.state === "error") throw new Error(result.message ?? "The Pill could not scan for Wi-Fi networks.");
    }
    throw new Error("The Wi-Fi scan timed out. Please try again.");
    } catch (error) {
      console.error("[OpenPill] Wi-Fi scan failed", { pill: this.device.name, stage,
        connected: this.device.gatt?.connected, error });
      if (!this.device.gatt?.connected) {
        throw new Error("The Pill disconnected while scanning for Wi-Fi networks. Reconnect it and try again.");
      }
      throw error;
    }
  }

  async saveConfig(patch: ConfigPatch, onStatus: (status: ConfigStatus) => void) {
    await this.stageConfig(patch, onStatus);
    await this.applyConfig(1, patch.wifi_timeout_s, onStatus);
  }

  async resetHistory(onStatus: (status: ConfigStatus) => void) {
    if (!this.secure) throw new Error("Update the Pill firmware before resetting its history identity.");
    await this.applyConfig(5, 30, onStatus);
  }

  async signHistoryControl(hashHex: string, nonceHex: string): Promise<string> {
    if (!this.secure || !/^[0-9a-f]{64}$/.test(hashHex) || !/^[0-9a-f]{64}$/.test(nonceHex))
      throw new Error("Update the Pill firmware before enabling calibration control.");
    const data = Uint8Array.from((hashHex + nonceHex).match(/../g)!, (pair) => Number.parseInt(pair, 16));
    const signature = await this.secure.send(6, data);
    if (signature.length < 64 || signature.length > 80)
      throw new Error("Invalid Pill control signature.");
    return btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  async testPost(endpointUrl: string, allowHttp: boolean, wifiTimeoutSeconds: number, onStatus: (status: ConfigStatus) => void) {
    await this.stageConfig({ endpoint_url: endpointUrl, allow_http: allowHttp, wifi_timeout_s: wifiTimeoutSeconds }, onStatus);
    await this.applyConfig(4, wifiTimeoutSeconds, onStatus);
  }

  async configureWifi(ssid: string, password: string | undefined, onStatus: (status: ConfigStatus) => void): Promise<void> {
    await this.stageConfig({ wifi_ssid: ssid, ...(password !== undefined && { wifi_password: password }) }, onStatus);
    const config = await this.readConfig();
    await this.applyConfig(3, config.wifi_timeout_s, onStatus);
  }

  private async stageConfig(patch: object, onStatus: (status: ConfigStatus) => void) {
    const document = encoder.encode(JSON.stringify(patch));
    if (document.byteLength > 1024) throw new Error("Configuration is too large.");
    await this.writeConfigPacket(Uint8Array.of(1));
    // Keep configuration packets within the default 23-byte ATT MTU. This
    // remains reliable even when a browser does not request a larger MTU.
    for (let offset = 0; offset < document.byteLength; offset += 19) {
      const chunk = document.slice(offset, offset + 19);
      const packet = new Uint8Array(chunk.byteLength + 1);
      packet[0] = 2;
      packet.set(chunk, 1);
      await this.writeConfigPacket(packet);
    }
    await this.writeConfigPacket(Uint8Array.of(3));
    const staged = await this.readConfigStatus();
    onStatus(staged);
    if (staged.state !== 2) throw new Error(staged.message);
  }

  private async applyConfig(command: number, wifiTimeoutSeconds: number, onStatus: (status: ConfigStatus) => void) {
    if (this.secure) await this.secure.send(2, Uint8Array.of(command));
    else await this.write(this.configCommand!, Uint8Array.of(command));
    const deadline = Date.now() + Math.max(75_000, wifiTimeoutSeconds * 1000 + 30_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await this.readConfigStatus();
      onStatus(status);
      if (status.state === (command === 4 ? 6 : 4)) return;
      if (status.state === 5) throw new Error(status.message);
    }
    throw new Error("Timed out waiting for the device to save configuration.");
  }

  private async writeConfigPacket(packet: Uint8Array): Promise<void> {
    if (this.secure) await this.secure.send(1, packet);
    else await this.write(this.configWrite!, Uint8Array.from(packet).buffer);
  }

}
