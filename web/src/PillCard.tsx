import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Dropdown, Modal, Popconfirm, Tooltip } from "antd";
import { DeleteOutlined, DisconnectOutlined, ExperimentOutlined, HeatMapOutlined, LinkOutlined, LoadingOutlined, MoreOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { BroadcastReading, ConfigPatch, ConfigStatus, FirmwareImage, HardwareSample, loadFirmwareImage, OpenPillClient, OtaProgress, parseBroadcast, PublicConfig } from "./ble";
import { checkLatestRelease, ReleaseCheck } from "./releases";
import SettingsModal from "./SettingsModal";
import PillAppearanceFields from "./PillAppearanceFields";
import FirmwareUpdateModal from "./FirmwareUpdateModal";
import { CAP_COLORS, type CapColor, type SavedPill } from "./savedPills";
import { fromBroadcast, fromHardware, HistoricalReading, loadReadings, saveReading, syncServerHistory } from "./history";
import PillHistory, { HistoryPeriod } from "./PillHistory";
import CalibrationModal from "./CalibrationModal";
import { loadProfiles, resolvePendingProfiles, syncProfiles } from "./calibrationProfiles";
import { fitPhysicalProfile, gravityFromAngle } from "./physicsCalibration";
import { batteryPercentFromMv } from "./battery";
import { generateReadKey, hashReadKey, loadReadKey, saveReadKey, loadControlKey, saveControlKey } from "./historyKeys";
import { formatGravity, formatTemperature, UnitPreferences } from "./units";

type Feedback = { tone: "success" | "error" | "info"; message: string };
type SiteFirmware = { version: string; state: "newer" | "different" | "current" | "older" | "unknown" };

function firmwareParts(value: string | undefined): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  return match ? match.slice(1).map(Number) : null;
}

function siteFirmwareState(config: Pick<PublicConfig, "firmware_version" | "firmware_elf_sha256">, image: FirmwareImage): SiteFirmware {
  if (config.firmware_elf_sha256?.toLowerCase() === image.elfSha256.toLowerCase()) {
    return { version: image.version, state: "current" };
  }
  const installed = firmwareParts(config.firmware_version);
  const available = firmwareParts(image.version);
  if (!installed || !available) return { version: image.version, state: "unknown" };
  for (let index = 0; index < 3; index++) {
    if (available[index] !== installed[index]) {
      return { version: image.version, state: available[index] > installed[index] ? "newer" : "older" };
    }
  }
  return { version: image.version, state: config.firmware_elf_sha256 ? "different" : "unknown" };
}

export default function PillCard({ pill, device, autoConnect, units, historyKeyRevision, onRemember, onUpdateAppearance, onForget, onChoose }: {
  pill: SavedPill;
  device?: BluetoothDevice;
  autoConnect: boolean;
  units: UnitPreferences;
  historyKeyRevision: number;
  onRemember: (pill: SavedPill) => void;
  onUpdateAppearance: (customName: string, capColor?: CapColor) => void;
  onForget: () => void;
  onChoose: () => void;
}) {
  const client = useMemo(() => device ? new OpenPillClient(device) : null, [device]);
  const autoStarted = useRef(false);
  const connecting = useRef(false);
  const advertisementWatch = useRef<AbortController | null>(null);
  const lastSavedBroadcastAt = useRef(0);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<"connecting" | "refreshing" | "saving" | "testing" | "checking" | "updating" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [reconnectAfterUpdate, setReconnectAfterUpdate] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [sample, setSample] = useState<HardwareSample | null>(null);
  const [broadcast, setBroadcast] = useState<{ reading: BroadcastReading; at: Date } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastRead, setLastRead] = useState<Date | null>(null);
  const [status, setStatus] = useState<ConfigStatus>({ version: 1, state: 0, message: "Ready" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftCustomName, setDraftCustomName] = useState(pill.customName ?? "");
  const [draftCapColor, setDraftCapColor] = useState<CapColor | undefined>(pill.capColor);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<HistoricalReading[]>([]);
  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>("week");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [release, setRelease] = useState<ReleaseCheck | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [siteFirmware, setSiteFirmware] = useState<SiteFirmware | null>(null);
  const [siteError, setSiteError] = useState("");

  const knownFirmwareVersion = connected ? config?.firmware_version : pill.firmwareVersion;
  useEffect(() => {
    if (!knownFirmwareVersion) return;
    let active = true;
    void checkLatestRelease(knownFirmwareVersion).then((latest) => {
      if (active) setRelease(latest);
    }).catch(() => { /* A release check failure should not interrupt readings. */ });
    return () => { active = false; };
  }, [knownFirmwareVersion]);

  const firmwareIdentity: Pick<PublicConfig, "firmware_version" | "firmware_elf_sha256"> =
    connected && config ? config : pill.config ?? { firmware_version: pill.firmwareVersion };
  const knownFirmwareHash = firmwareIdentity.firmware_elf_sha256;
  useEffect(() => {
    if (!knownFirmwareVersion) { setSiteFirmware(null); return; }
    let active = true;
    void loadFirmwareImage().then((image) => {
      if (active) { setSiteFirmware(siteFirmwareState({ firmware_version: knownFirmwareVersion,
        firmware_elf_sha256: knownFirmwareHash }, image)); setSiteError(""); }
    }).catch((error) => {
      if (active) { setSiteFirmware(null); setSiteError(error instanceof Error ? error.message : "Could not check this site's firmware."); }
    });
    return () => { active = false; };
  }, [knownFirmwareVersion, knownFirmwareHash]);

  useEffect(() => () => client?.disconnect(), [client]);

  useEffect(() => {
    let active = true;
    void loadReadings(pill.id).then((readings) => {
      if (active) {
        const id = config?.history_id || pill.historyId || pill.config?.history_id || pill.id;
        if (resolvePendingProfiles(id, readings)) setProfileRevision((revision) => revision + 1);
        setHistory(readings); setHistoryLoading(false); setHistoryError("");
      }
    }).catch(() => {
      if (active) { setHistoryLoading(false); setHistoryError("Could not load saved readings."); }
    });
    return () => { active = false; };
  }, [pill.id, historyRevision]);

  const historyId = config?.history_id || pill.historyId || pill.config?.history_id;
  const profileStorageId = historyId || pill.id;
  const profileServiceId = historyId && loadReadKey(historyId) ? historyId : undefined;
  const profileChanged = useCallback(() => setProfileRevision((revision) => revision + 1), []);
  useEffect(() => {
    if (!historyId) return;
    const key = loadReadKey(historyId);
    if (!key) return;
    let active = true;
    let syncing = false;
    const sync = async () => {
      if (!active || syncing || document.visibilityState !== "visible") return;
      syncing = true;
      try {
        const result = await syncServerHistory(pill.id, historyId, key);
        if (active && result.readings) setHistoryRevision((current) => current + 1);
        if (active && result.profilesChanged) profileChanged();
        const previous = loadProfiles(historyId);
        const profiles = previous.dirty ? await syncProfiles(historyId, key, loadControlKey(historyId)) : previous;
        if (active && (profiles.revision !== previous.revision || profiles.dirty !== previous.dirty)) profileChanged();
      } catch (error) {
        if (active) setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not sync history." });
      } finally { syncing = false; }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 15 * 60_000);
    document.addEventListener("visibilitychange", sync);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [pill.id, historyId, config?.has_history_read_hash, historyKeyRevision, profileChanged]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!device?.watchAdvertisements || connected || busy === "connecting") return;
    let active = true;
    let controller: AbortController | null = null;
    const onAdvertisement = (event: Event) => {
      const reading = parseBroadcast(event as BluetoothAdvertisingEvent);
      if (reading) {
        const at = Date.now();
        setBroadcast({ reading, at: new Date(at) });
        // One telemetry burst can contain several identical advertisements.
        if (at - lastSavedBroadcastAt.current >= 30_000) {
          lastSavedBroadcastAt.current = at;
          void saveReading(fromBroadcast(device.id, reading, at)).then(() =>
            setHistoryRevision((current) => current + 1)).catch(() => {});
        }
      }
    };
    const watch = () => {
      if (!active || document.visibilityState !== "visible" || controller) return;
      const next = new AbortController();
      controller = next;
      advertisementWatch.current = next;
      void device.watchAdvertisements!({ signal: next.signal }).catch(() => {
        if (controller === next) controller = null;
        if (advertisementWatch.current === next) advertisementWatch.current = null;
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") watch();
      else { controller?.abort(); controller = null; }
    };
    device.addEventListener("advertisementreceived", onAdvertisement);
    document.addEventListener("visibilitychange", onVisibility);
    watch();
    return () => {
      active = false;
      controller?.abort();
      if (advertisementWatch.current === controller) advertisementWatch.current = null;
      device.removeEventListener("advertisementreceived", onAdvertisement);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [device, connected, busy]);

  async function connect() {
    if (!client || connected || busy || connecting.current) return;
    connecting.current = true;
    advertisementWatch.current?.abort();
    advertisementWatch.current = null;
    setBusy("connecting");
    setFeedback(null);
    try {
      const { config: nextConfig, sample: nextSample } = await client.connect((expected) => {
        if (!expected) console.warn("[OpenPill] Pill Bluetooth disconnected unexpectedly", { pill: device?.name });
        setConnected(false);
        setConfig(null);
        setSample(null);
      }, setStatus);
      setConfig(nextConfig);
      setSample(nextSample);
      setLastRead(new Date());
      setConnected(true);
      if (reconnectAfterUpdate) {
        if (nextConfig.firmware_elf_sha256?.toLowerCase() !== reconnectAfterUpdate.toLowerCase()) {
          setFeedback({ tone: "error", message: `The Pill reconnected, but did not report the updated firmware image. It reports v${nextConfig.firmware_version || "unknown"}.` });
        }
        setReconnectAfterUpdate(null);
      }
      onRemember({ id: device!.id, name: device!.name || pill.name,
        firmwareVersion: nextConfig.firmware_version,
        historyId: nextConfig.history_id,
        config: nextConfig,
        sample: nextSample, readAt: Date.now() });
      void saveReading(fromHardware(device!.id, nextSample)).then(() =>
        setHistoryRevision((current) => current + 1)).catch(() => {});
      if (nextConfig.history_telemetry && nextConfig.history_id && loadControlKey(nextConfig.history_id))
        void claimHistoryControl(nextConfig.history_id).catch(() => {});
    } catch (error) {
      client.disconnect();
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not connect to this Pill." });
      if (reconnectAfterUpdate) setReconnectAfterUpdate(null);
    } finally {
      connecting.current = false;
      setBusy(null);
    }
  }

  async function claimHistoryControl(historyId: string): Promise<void> {
    if (!client) return;
    const controlKey = loadControlKey(historyId);
    if (!controlKey) return;
    const readKey = loadReadKey(historyId);
    if (!readKey) throw new Error("History read key is required to authorize calibration control.");
    const challenge = await fetch(`https://openpill.yeast.win/v1/control/${historyId}`, {
      headers: { Authorization: `Bearer ${readKey}` }, cache: "no-store"
    });
    if (!challenge.ok) throw new Error(`Calibration control challenge failed (HTTP ${challenge.status}).`);
    const nonce = (await challenge.json() as { nonce: string }).nonce;
    const hash = await hashReadKey(controlKey);
    const signature = await client.signHistoryControl(hash, nonce);
    const claim = await fetch(`https://openpill.yeast.win/v1/control/${historyId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash, nonce, signature })
    });
    if (!claim.ok) throw new Error(`Calibration control registration failed (HTTP ${claim.status}).`);
  }

  useEffect(() => {
    if (autoConnect && !autoStarted.current) {
      autoStarted.current = true;
      // StrictMode replays effects in development. Defer the first connection
      // so its replay cleanup cannot disconnect an in-flight GATT setup.
      const timer = window.setTimeout(() => void connect(), 0);
      return () => {
        window.clearTimeout(timer);
        autoStarted.current = false;
      };
    }
  }, [autoConnect]);

  useEffect(() => {
    if (!reconnectAfterUpdate || busy || connected) return;
    const timer = window.setTimeout(() => void connect(), 2500);
    return () => window.clearTimeout(timer);
  }, [reconnectAfterUpdate, busy, connected]);

  async function refresh() {
    console.info("[OpenPill] Refresh requested", { pill: pill.name, connected, busy });
    if (!client || !connected) {
      setFeedback({ tone: "error", message: "Connect to this Pill before refreshing readings." });
      return;
    }
    if (busy) {
      setFeedback({ tone: "info", message: "Wait for the current action to finish, then refresh again." });
      return;
    }
    setBusy("refreshing");
    setFeedback(null);
    try {
      const nextSample = await client.readHardware();
      const at = Date.now();
      await saveReading(fromHardware(pill.id, nextSample, at));
      setSample(nextSample);
      setLastRead(new Date(at));
      onRemember({ ...pill, sample: nextSample, readAt: at });
      setHistoryRevision((current) => current + 1);
      console.info("[OpenPill] Reading saved", { pill: pill.name, at: new Date(at).toISOString(), sample: nextSample });
      setFeedback(null);
    } catch (error) {
      console.error("[OpenPill] Refresh failed", { pill: pill.name, error });
      setFeedback({ tone: "error", message: error instanceof Error ? `Could not refresh: ${error.message}` : "Could not refresh this Pill." });
    } finally {
      setBusy(null);
    }
  }

  async function readCalibrationTilt(): Promise<{ angle: number; at: number }> {
    if (!client || !connected) throw new Error("Connect to the Pill before adding a reference.");
    if (busy) throw new Error("Wait for the current Pill action to finish.");
    setBusy("refreshing");
    try {
      const nextSample = await client.readHardware();
      const at = Date.now();
      const reading = fromHardware(pill.id, nextSample, at);
      if (reading.tiltDegrees == null || !Number.isFinite(reading.tiltDegrees))
        throw new Error("The Pill did not provide a valid tilt reading.");
      await saveReading(reading);
      setSample(nextSample);
      setLastRead(new Date(at));
      onRemember({ ...pill, sample: nextSample, readAt: at });
      setHistoryRevision((current) => current + 1);
      return { angle: reading.tiltDegrees, at };
    } finally {
      setBusy(null);
    }
  }

  async function save(patch: ConfigPatch) {
    if (!client) return;
    setBusy("saving");
    setFeedback(null);
    try {
      if (patch.history_telemetry) {
        const historyId = config?.history_id;
        if (!historyId) throw new Error("Update the Pill firmware before enabling OpenPill history.");
        let key = loadReadKey(historyId);
        if (!key && config?.has_history_read_hash) {
          throw new Error("This Pill already has a history read key. Import it from another phone before enabling history here.");
        }
        if (!key) {
          key = generateReadKey();
          saveReadKey(historyId, key);
        }
        patch.history_read_hash = await hashReadKey(key);
        let controlKey = loadControlKey(historyId);
        if (!controlKey) {
          controlKey = generateReadKey();
          saveControlKey(historyId, controlKey);
        }
      }
      await client.saveConfig(patch, setStatus);
      const nextConfig = await client.readConfig();
      let controlWarning = "";
      if (patch.history_telemetry && nextConfig.history_id) {
        try { await claimHistoryControl(nextConfig.history_id); }
        catch (error) { controlWarning = error instanceof Error ? error.message : "Could not authorize calibration control."; }
      }
      setConfig(nextConfig);
      onRemember({ ...pill, firmwareVersion: nextConfig.firmware_version,
        historyId: nextConfig.history_id, config: nextConfig });
      if (patch.history_telemetry && nextConfig.history_id) {
        const key = loadReadKey(nextConfig.history_id);
        if (key) void syncServerHistory(pill.id, nextConfig.history_id, key).then((result) => {
          if (result.readings) setHistoryRevision((current) => current + 1);
          if (result.profilesChanged) profileChanged();
        }).catch(() => {});
      }
      setSettingsOpen(false);
      setFeedback(controlWarning ? { tone: "error", message: `Settings saved. ${controlWarning}` } :
        { tone: "success", message: patch.wifi_telemetry || patch.history_telemetry
          ? "Settings saved and a test reading was sent." : "Settings saved." });
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Settings could not be saved." });
    } finally {
      setBusy(null);
    }
  }

  async function resetHistory() {
    if (!client || !connected) return;
    setBusy("saving");
    setFeedback(null);
    try {
      await client.resetHistory(setStatus);
      const nextConfig = await client.readConfig();
      setConfig(nextConfig);
      onRemember({ ...pill, historyId: nextConfig.history_id, config: nextConfig });
      setFeedback({ tone: "success", message: "New history identity ready. Select OpenPill history and save to start uploading." });
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not start a new history." });
    } finally { setBusy(null); }
  }

  async function testPost(endpointUrl: string, allowHttp: boolean, wifiTimeoutSeconds: number) {
    if (!client) throw new Error("Connect to this Pill first.");
    const installed = firmwareParts(config?.firmware_version ?? pill.config?.firmware_version);
    if (installed && installed[0] === 0 &&
        (installed[1] < 2 || (installed[1] === 2 && installed[2] < 5))) {
      throw new Error("Update the Pill to firmware v0.2.5 to test a POST without saving.");
    }
    setBusy("testing");
    try {
      await client.testPost(endpointUrl, allowHttp, wifiTimeoutSeconds, setStatus);
    } finally {
      setBusy(null);
    }
  }

  async function configureWifi(ssid: string, password?: string): Promise<PublicConfig> {
    if (!client) throw new Error("Connect to this Pill first.");
    setBusy("saving");
    try {
      await client.configureWifi(ssid, password, setStatus);
      const nextConfig = await client.readConfig();
      setConfig(nextConfig);
      onRemember({ ...pill, firmwareVersion: nextConfig.firmware_version, config: nextConfig });
      return nextConfig;
    } finally {
      setBusy(null);
    }
  }

  async function checkUpdates() {
    if (!connected || !client) return;
    setBusy("checking");
    setRelease(null);
    setReleaseError("");
    setSiteError("");
    try {
      const current = await client.readConfig();
      setConfig(current);
      onRemember({ ...pill, firmwareVersion: current.firmware_version, config: current });
      console.info("[OpenPill] Firmware reported over BLE", {
        pill: pill.name, version: current.firmware_version,
        elfSha256: current.firmware_elf_sha256, slot: current.running_slot
      });
      const [site, github] = await Promise.allSettled([
        loadFirmwareImage(),
        current.firmware_version ? checkLatestRelease(current.firmware_version, true) : Promise.reject(new Error("The Pill did not report a firmware version."))
      ]);
      if (site.status === "fulfilled") {
        const result = siteFirmwareState(current, site.value);
        setSiteFirmware(result);
        console.info("[OpenPill] Firmware available on this site", {
          pill: pill.name, version: result.version, state: result.state,
          elfSha256: site.value.elfSha256
        });
      } else {
        setSiteFirmware(null);
        setSiteError(site.reason instanceof Error ? site.reason.message : "Could not check this site's firmware.");
      }
      if (github.status === "fulfilled") {
        setRelease(github.value);
        if (!github.value) setReleaseError("No public firmware release has been published yet.");
      } else setReleaseError(github.reason instanceof Error ? github.reason.message : "Could not check GitHub releases.");
    } catch (error) {
      setReleaseError(error instanceof Error ? `Could not read the Pill over Bluetooth: ${error.message}` : "Could not read the Pill over Bluetooth.");
    } finally {
      setBusy(null);
    }
  }

  async function installUpdate(image: FirmwareImage, onProgress: (progress: OtaProgress) => void): Promise<"installed" | "already-current"> {
    if (!client) throw new Error("Select this Pill before updating.");
    setBusy("updating");
    try {
      let current: PublicConfig | null = null;
      if (connected) current = await client.readConfig();
      else {
        try {
          const result = await client.connect(() => {}, () => {}, 1);
          current = result.config;
        } catch (error) {
          console.info("[OpenPill] Full connection unavailable; using public firmware recovery", { pill: pill.name, error });
          await client.connectForFirmwareUpdate();
        }
      }
      if (current && siteFirmwareState(current, image).state === "current") {
        setConfig(current);
        onRemember({ ...pill, firmwareVersion: current.firmware_version, config: current });
        setFeedback({ tone: "info", message: `Firmware v${image.version} is already installed. No update was sent.` });
        return "already-current";
      }
      const slot = await client.uploadFirmware(image, onProgress);
      console.info("[OpenPill] Firmware update verified", { pill: pill.name, slot, elfSha256: image.elfSha256 });
      setReconnectAfterUpdate(image.elfSha256);
      setFeedback({ tone: "info", message: "Firmware verified. Waiting for the Pill to restart and reconnect…" });
      client.disconnect();
      return "installed";
    } finally {
      if (!connected) client.disconnect();
      setBusy(null);
    }
  }

  const cap = CAP_COLORS.find((color) => color.value === pill.capColor);
  const name = pill.customName?.trim() || `${cap ? `${cap.label} ` : ""}${device?.name || pill.name}`;
  const openSettings = () => {
    setDraftCustomName(pill.customName ?? "");
    setDraftCapColor(pill.capColor);
    setSettingsOpen(true);
  };
  const saveAppearance = () => onUpdateAppearance(draftCustomName.trim(), draftCapColor);
  const recentBroadcast = broadcast && now - broadcast.at.getTime() < 30 * 60_000;
  const readingSource = connected && sample ? "connected" : recentBroadcast ? "broadcast" : pill.sample ? "saved" : "none";
  const shownSample = readingSource === "connected" ? sample : readingSource === "saved" ? pill.sample : null;
  const lastTemperature = [...history].reverse().find((reading) => reading.temperatureC != null)?.temperatureC;
  const lastBattery = [...history].reverse().find((reading) => reading.batteryPercent != null)?.batteryPercent;
  const temperature = shownSample && (shownSample.valid & 2)
    ? formatTemperature(shownSample.temperatureC, units.temperature) : readingSource === "broadcast" && broadcast?.reading.temperatureC != null ? formatTemperature(broadcast.reading.temperatureC, units.temperature) : lastTemperature != null ? formatTemperature(lastTemperature, units.temperature) : "—";
  const battery = shownSample && (shownSample.valid & 4)
    ? `${Math.round(batteryPercentFromMv(shownSample.batteryMv))}%` : readingSource === "broadcast" && broadcast ? `${Math.round(broadcast.reading.batteryPercent)}%` : lastBattery != null ? `${Math.round(lastBattery)}%` : "—";
  const lastGravity = [...history].reverse().find((reading) => reading.gravity != null)?.gravity;
  const calibratedHistory = useMemo(() => {
    const profiles = loadProfiles(profileStorageId).document.profiles;
    if (!profiles.length) return history;
    const fits = profiles.map((profile) => fitPhysicalProfile(profile));
    const cache = profiles.map(() => new Map<number, number | null>());
    return history.map((reading) => {
      if (reading.tiltDegrees == null) return reading;
      let index = profiles.length - 1;
      while (index >= 0 && reading.at < profiles[index].startsAt) index--;
      if (index < 0) return reading;
      if (!fits[index]) return { ...reading, gravity: undefined };
      const scaled = reading.tiltDegrees * 2;
      const lower = Math.floor(scaled), upper = Math.ceil(scaled);
      for (const bucket of [lower, upper])
        if (!cache[index].has(bucket)) cache[index].set(bucket, gravityFromAngle(bucket / 2, fits[index]!));
      const a = cache[index].get(lower), b = cache[index].get(upper);
      const gravity = a != null && b != null ? a + (b - a) * (scaled - lower) : null;
      return { ...reading, gravity: gravity ?? undefined };
    });
  }, [history, profileStorageId, profileRevision]);
  const calibratedLastGravity = calibratedHistory.at(-1) !== history.at(-1)
    ? calibratedHistory.at(-1)?.gravity : null;
  const calibrationPending = calibratedHistory.at(-1) !== history.at(-1) &&
    calibratedHistory.at(-1)?.gravity == null;
  const gravity = calibrationPending ? "—" : calibratedLastGravity != null ? formatGravity(calibratedLastGravity, units.gravity) :
    readingSource === "connected" && sample?.gravity != null ? formatGravity(sample.gravity, units.gravity) :
      recentBroadcast && broadcast?.reading.gravity != null ? formatGravity(broadcast.reading.gravity, units.gravity) :
        lastGravity != null ? formatGravity(lastGravity, units.gravity) : "—";
  const lastSeenAt = Math.max(lastRead?.getTime() ?? 0, broadcast?.at.getTime() ?? 0, pill.readAt ?? 0, history[history.length - 1]?.at ?? 0);
  const firmwareVersion = connected ? config?.firmware_version : pill.firmwareVersion;
  const runningSlot = connected ? config?.running_slot : pill.config?.running_slot;
  const firmwareInfo = <section className="settings-firmware">
    <div className="firmware-settings-row">
      <span><strong>Firmware</strong><small>{firmwareVersion ? `Version v${firmwareVersion.replace(/^v/, "")}${runningSlot ? ` @ ${runningSlot}` : ""}` : "Version available when connected"}</small></span>
      {(firmwareVersion || connected) && <span className="firmware-row-actions"><Button onClick={() => void checkUpdates()} loading={busy === "checking"} disabled={!connected || (busy !== null && busy !== "checking")}>Check for updates</Button><Button onClick={() => { setSettingsOpen(false); setUpdateOpen(true); }} disabled={!device || busy !== null}>Update firmware</Button></span>}
    </div>
    {sample && (!(sample.valid & 4) || sample.batteryMv > 4300) && <p>Battery reading unavailable; firmware updates are blocked.</p>}
    {sample && (sample.valid & 4) && sample.batteryMv <= 4300 && batteryPercentFromMv(sample.batteryMv) < 10 && <p>Battery below 10%; charge it before updating firmware.</p>}
    {sample && (sample.valid & 4) && (sample.valid & 8) && sample.batteryMv <= 4300 && batteryPercentFromMv(sample.batteryMv) >= 10 && batteryPercentFromMv(sample.batteryMv) < 30 && !sample.externalPower && <p>Connect the charger before updating below 30% battery.</p>}
    {siteFirmware && siteFirmware.state !== "current" && <p>{siteFirmware.state === "newer" ? `This site has firmware v${siteFirmware.version}.` : siteFirmware.state === "different" ? `This site has a different v${siteFirmware.version} build.` : siteFirmware.state === "older" ? `This site has older firmware v${siteFirmware.version}.` : `This site has firmware v${siteFirmware.version}; compare builds before installing.`}</p>}
    {siteError && <p role="status">{siteError}</p>}
    {release && <p>{release.state === "newer" ? `GitHub release ${release.version} is available.` : release.state === "current" ? `Latest GitHub release: ${release.version}.` : `GitHub release: ${release.version}.`} <a href={release.url} target="_blank" rel="noopener noreferrer">View release</a></p>}
    {releaseError && <p role="status">{releaseError}</p>}
  </section>;

  return <Card className="pill-card" title={<div className="pill-heading"><span className="pill-name"><span className="pill-dot" style={cap ? { backgroundColor: cap.hex } : undefined} />{name}</span>
    {lastSeenAt > 0 && <span className="pill-last-seen">Last seen {new Date(lastSeenAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>}
  </div>}
    extra={<span className="pill-card-menu">{connected && <Tooltip title={busy === "refreshing" ? "Reading sensors…" : "Connected"}>{busy === "refreshing" ? <LoadingOutlined className="pill-connected-icon" spin aria-label="Reading sensors" /> : <LinkOutlined className="pill-connected-icon" aria-label="Connected" />}</Tooltip>}
      <Dropdown trigger={["click"]} menu={{ items: [
        ...(!connected ? [{ key: "connect", label: "Connect", icon: <LinkOutlined /> }] : []),
        { key: "settings", label: "Settings", icon: <SettingOutlined /> },
        { key: "calibration", label: "Calibration", icon: <ExperimentOutlined /> },
        ...(connected ? [
          { key: "refresh", label: "Refresh readings", icon: <ReloadOutlined /> },
          { key: "disconnect", label: "Disconnect", icon: <DisconnectOutlined /> }
        ] : [])
      ], onClick: ({ key }) => {
        if (key === "connect") { if (device) void connect(); else onChoose(); }
        if (key === "settings") openSettings();
        if (key === "calibration") setCalibrationOpen(true);
        if (key === "refresh") void refresh();
        if (key === "disconnect") client?.disconnect();
      } }}>
        <Button type="text" shape="circle" icon={<MoreOutlined />} aria-label={`Options for ${name}`} title={`Options for ${name}`} loading={busy === "connecting"} disabled={busy === "updating"} />
      </Dropdown>
    </span>}>
    {(siteFirmware?.state === "newer" || siteFirmware?.state === "different") ?
      <Alert className="firmware-banner" type="info" showIcon title={siteFirmware.state === "newer" ? `Firmware v${siteFirmware.version} is available` : `A different v${siteFirmware.version} firmware build is available`} action={<Button type="link" onClick={() => setUpdateOpen(true)} disabled={!device}>Update</Button>} /> :
      release?.state === "newer" && <Alert className="firmware-banner" type="info" showIcon title={`GitHub release ${release.version} is available`} action={<a href={release.url} target="_blank" rel="noopener noreferrer">View release</a>} />}
    {feedback && <Alert className="card-feedback" type={feedback.tone} showIcon title={feedback.message} />}
    <PillHistory readings={calibratedHistory} period={historyPeriod} onPeriodChange={setHistoryPeriod} loading={historyLoading} error={historyError} units={units} summary={<div className="pill-readings">
      <div><Tooltip title="Temperature"><HeatMapOutlined aria-label="Temperature" /></Tooltip><strong>{temperature}</strong></div>
      <div><Tooltip title={calibrationPending ? "Calibration needs more reference points." : gravity === "—" ? sample?.version === 1 ? "Connected gravity requires a firmware update." : "Gravity needs a valid floating angle; standing upright is for waking the Pill." : "Gravity"}><ExperimentOutlined aria-label="Gravity" /></Tooltip><strong>{gravity}</strong></div>
      <div><Tooltip title="Battery"><ThunderboltOutlined aria-label="Battery" /></Tooltip><strong>{battery}</strong></div>
    </div>} />
    {updateOpen && <FirmwareUpdateModal name={name} config={firmwareIdentity} connected={connected} reconnecting={!!reconnectAfterUpdate} onClose={() => setUpdateOpen(false)} onInstall={installUpdate} />}
    {calibrationOpen && <CalibrationModal open name={name} storageId={profileStorageId} historyId={profileServiceId} readKey={profileServiceId ? loadReadKey(profileServiceId) : null} controlKey={profileServiceId ? loadControlKey(profileServiceId) : null} readings={history} onReadLiveTilt={connected ? readCalibrationTilt : undefined} onClose={() => setCalibrationOpen(false)} onChange={profileChanged} />}
    {settingsOpen && (config || pill.config ? <SettingsModal name={name} config={config ?? pill.config!} connected={connected} connecting={busy === "connecting"} onConnect={() => { if (device) void connect(); else { setSettingsOpen(false); onChoose(); } }} busy={busy === "saving" || busy === "testing"} saving={busy === "saving"} testing={busy === "testing"} status={status} onClose={() => setSettingsOpen(false)} onSave={save} onTestPost={testPost} onScanWifi={() => client!.scanWifiNetworks()} onConfigureWifi={configureWifi} onForget={onForget} firmwareInfo={firmwareInfo} historyReadKey={loadReadKey((config ?? pill.config)?.history_id || "")} historyControlKey={loadControlKey((config ?? pill.config)?.history_id || "")} onResetHistory={resetHistory}
      customName={draftCustomName} capColor={draftCapColor} onNameChange={setDraftCustomName} onCapColorChange={setDraftCapColor} onSaveAppearance={saveAppearance} /> :
      <Modal open title={`Settings · ${name}`} onCancel={() => setSettingsOpen(false)} footer={null}>
        <PillAppearanceFields customName={draftCustomName} capColor={draftCapColor} onNameChange={setDraftCustomName} onCapColorChange={setDraftCapColor} />
        <p className="muted">Connect to your Pill to view or change its settings.</p>
        <Button type="primary" onClick={() => { if (device) void connect(); else { setSettingsOpen(false); onChoose(); } }} loading={busy === "connecting"}>Connect to Pill</Button>
        {firmwareInfo}
        <div className="modal-actions"><Popconfirm title="Forget this Pill?" description="Removes its saved card and readings from this browser." onConfirm={onForget} okText="Forget" cancelText="Keep"><Button danger icon={<DeleteOutlined />}>Forget Pill</Button></Popconfirm><span /><Button onClick={() => setSettingsOpen(false)}>Cancel</Button><Button type="primary" onClick={() => { saveAppearance(); setSettingsOpen(false); }}>Save appearance</Button></div>
      </Modal>)}
  </Card>;
}
