import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Dropdown, Modal, Popconfirm, Tooltip } from "antd";
import { DeleteOutlined, DisconnectOutlined, ExperimentOutlined, HeatMapOutlined, LinkOutlined, LoadingOutlined, MoreOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { BroadcastReading, ConfigPatch, ConfigStatus, FirmwareImage, HardwareSample, loadFirmwareImage, OpenPillClient, OtaProgress, parseBroadcast, PublicConfig } from "./ble";
import { checkLatestRelease, ReleaseCheck } from "./releases";
import SettingsModal from "./SettingsModal";
import FirmwareUpdateModal from "./FirmwareUpdateModal";
import type { SavedPill } from "./savedPills";
import { fromBroadcast, fromHardware, HistoricalReading, loadReadings, saveReading } from "./history";
import PillHistory, { HistoryPeriod } from "./PillHistory";
import { batteryPercentFromMv } from "./battery";
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

export default function PillCard({ pill, device, autoConnect, units, onRemember, onForget, onChoose }: {
  pill: SavedPill;
  device?: BluetoothDevice;
  autoConnect: boolean;
  units: UnitPreferences;
  onRemember: (pill: SavedPill) => void;
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
      if (active) { setHistory(readings); setHistoryLoading(false); setHistoryError(""); }
    }).catch(() => {
      if (active) { setHistoryLoading(false); setHistoryError("Could not load saved readings."); }
    });
    return () => { active = false; };
  }, [pill.id, historyRevision]);

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
        config: nextConfig,
        sample: nextSample, readAt: Date.now() });
      void saveReading(fromHardware(device!.id, nextSample)).then(() =>
        setHistoryRevision((current) => current + 1)).catch(() => {});
    } catch (error) {
      client.disconnect();
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Could not connect to this Pill." });
      if (reconnectAfterUpdate) setReconnectAfterUpdate(null);
    } finally {
      connecting.current = false;
      setBusy(null);
    }
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

  async function save(patch: ConfigPatch) {
    if (!client) return;
    setBusy("saving");
    setFeedback(null);
    try {
      await client.saveConfig(patch, setStatus);
      const nextConfig = await client.readConfig();
      setConfig(nextConfig);
      onRemember({ ...pill, firmwareVersion: nextConfig.firmware_version, config: nextConfig });
      setSettingsOpen(false);
      setFeedback({ tone: "success", message: patch.wifi_telemetry ? "Settings saved and a test reading was sent." : "Settings saved." });
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Settings could not be saved." });
    } finally {
      setBusy(null);
    }
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

  const name = device?.name || pill.name;
  const recentBroadcast = broadcast && now - broadcast.at.getTime() < 30 * 60_000;
  const readingSource = connected && sample ? "connected" : recentBroadcast ? "broadcast" : pill.sample ? "saved" : "none";
  const shownSample = readingSource === "connected" ? sample : readingSource === "saved" ? pill.sample : null;
  const temperature = shownSample && (shownSample.valid & 2)
    ? formatTemperature(shownSample.temperatureC, units.temperature) : readingSource === "broadcast" && broadcast?.reading.temperatureC != null ? formatTemperature(broadcast.reading.temperatureC, units.temperature) : "—";
  const battery = shownSample && (shownSample.valid & 4)
    ? `${Math.round(batteryPercentFromMv(shownSample.batteryMv))}%` : readingSource === "broadcast" && broadcast ? `${Math.round(broadcast.reading.batteryPercent)}%` : "—";
  const lastGravity = [...history].reverse().find((reading) => reading.gravity != null)?.gravity;
  const gravity = readingSource === "connected" && sample?.gravity != null
    ? formatGravity(sample.gravity, units.gravity) : recentBroadcast && broadcast?.reading.gravity != null
      ? formatGravity(broadcast.reading.gravity, units.gravity) : lastGravity != null ? formatGravity(lastGravity, units.gravity) : "—";
  const lastSeenAt = Math.max(lastRead?.getTime() ?? 0, broadcast?.at.getTime() ?? 0, pill.readAt ?? 0, history[history.length - 1]?.at ?? 0);
  const firmwareVersion = connected ? config?.firmware_version : pill.firmwareVersion;
  const firmwareInfo = <section className="settings-firmware">
    <div className="firmware-settings-row">
      <span><strong>Firmware</strong><small>{firmwareVersion ? `${connected ? "Version" : "Last known version"} v${firmwareVersion.replace(/^v/, "")}` : "Version available when connected"}</small></span>
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

  return <Card className="pill-card" title={<div className="pill-heading"><span className="pill-name"><span className="pill-dot" />{name}</span>
    {lastSeenAt > 0 && <span className="pill-last-seen">Last seen {new Date(lastSeenAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>}
  </div>}
    extra={<span className="pill-card-menu">{connected && <Tooltip title={busy === "refreshing" ? "Reading sensors…" : "Connected"}>{busy === "refreshing" ? <LoadingOutlined className="pill-connected-icon" spin aria-label="Reading sensors" /> : <LinkOutlined className="pill-connected-icon" aria-label="Connected" />}</Tooltip>}
      <Dropdown trigger={["click"]} menu={{ items: [
        ...(!connected ? [{ key: "connect", label: "Connect", icon: <LinkOutlined /> }] : []),
        { key: "settings", label: "Settings", icon: <SettingOutlined /> },
        ...(connected ? [
          { key: "refresh", label: "Refresh readings", icon: <ReloadOutlined /> },
          { key: "disconnect", label: "Disconnect", icon: <DisconnectOutlined /> }
        ] : [])
      ], onClick: ({ key }) => {
        if (key === "connect") { if (device) void connect(); else onChoose(); }
        if (key === "settings") setSettingsOpen(true);
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
    <PillHistory readings={history} period={historyPeriod} onPeriodChange={setHistoryPeriod} loading={historyLoading} error={historyError} units={units} summary={<div className="pill-readings">
      <div><Tooltip title="Temperature"><HeatMapOutlined aria-label="Temperature" /></Tooltip><strong>{temperature}</strong></div>
      <div><Tooltip title={gravity === "—" ? sample?.version === 1 ? "Connected gravity requires a firmware update." : "Gravity needs a valid floating angle; standing upright is for waking the Pill." : "Gravity"}><ExperimentOutlined aria-label="Gravity" /></Tooltip><strong>{gravity}</strong></div>
      <div><Tooltip title="Battery"><ThunderboltOutlined aria-label="Battery" /></Tooltip><strong>{battery}</strong></div>
    </div>} />
    {updateOpen && <FirmwareUpdateModal name={name} config={firmwareIdentity} connected={connected} reconnecting={!!reconnectAfterUpdate} onClose={() => setUpdateOpen(false)} onInstall={installUpdate} />}
    {settingsOpen && (config || pill.config ? <SettingsModal name={name} config={config ?? pill.config!} connected={connected} connecting={busy === "connecting"} onConnect={() => { if (device) void connect(); else { setSettingsOpen(false); onChoose(); } }} busy={busy === "saving" || busy === "testing"} saving={busy === "saving"} testing={busy === "testing"} status={status} onClose={() => setSettingsOpen(false)} onSave={save} onTestPost={testPost} onScanWifi={() => client!.scanWifiNetworks()} onConfigureWifi={configureWifi} onForget={onForget} firmwareInfo={firmwareInfo} /> :
      <Modal open title={`Settings · ${name}`} onCancel={() => setSettingsOpen(false)} footer={null}>
        <p className="muted">Connect to your Pill to view or change its settings.</p>
        <Button type="primary" onClick={() => { if (device) void connect(); else { setSettingsOpen(false); onChoose(); } }} loading={busy === "connecting"}>Connect to Pill</Button>
        {firmwareInfo}
        <div className="modal-actions"><Popconfirm title="Forget this Pill?" description="Removes its saved card and readings from this browser." onConfirm={onForget} okText="Forget" cancelText="Keep"><Button danger icon={<DeleteOutlined />}>Forget Pill</Button></Popconfirm><Button onClick={() => setSettingsOpen(false)}>Close</Button></div>
      </Modal>)}
  </Card>;
}
