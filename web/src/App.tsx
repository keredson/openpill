import { useEffect, useState } from "react";
import { Alert, Button, Card, ConfigProvider, Input, Modal, Segmented } from "antd";
import { PlusOutlined, SettingOutlined } from "@ant-design/icons";
import { choosePill } from "./ble";
import PillCard from "./PillCard";
import pillReady from "./assets/pill-ready.svg";
import { loadSavedPills, SavedPill, shouldImportGrantedPills, storeSavedPills } from "./savedPills";
import { deleteReadings } from "./history";
import { forgetProfiles } from "./calibrationProfiles";
import { handleInternalLink, routeUrl } from "./navigation";
import { sitePath } from "./sitePath";
import { loadUnitPreferences, storeUnitPreferences, UnitPreferences } from "./units";
import { forgetReadKey, forgetControlKey, saveReadKey, saveControlKey } from "./historyKeys";

export default function App() {
  const [pills, setPills] = useState<SavedPill[]>(loadSavedPills);
  const [importGrantedPills] = useState(shouldImportGrantedPills);
  const [devices, setDevices] = useState<Map<string, BluetoothDevice>>(() => new Map());
  const [autoConnectId, setAutoConnectId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState("");
  const [historyKeyRevision, setHistoryKeyRevision] = useState(0);
  const [units, setUnits] = useState<UnitPreferences>(loadUnitPreferences);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void navigator.bluetooth?.getDevices?.().then((known) => {
      if (active && importGrantedPills) setPills((current) => {
        const byId = new Map(current.map((pill) => [pill.id, pill]));
        for (const device of known) {
          if (!byId.has(device.id)) byId.set(device.id, { id: device.id, name: device.name || "OpenPill" });
        }
        return [...byId.values()];
      });
      if (active) setDevices((current) => {
        const byId = new Map(current);
        for (const device of known) {
          byId.set(device.id, device);
        }
        return byId;
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [importGrantedPills]);

  useEffect(() => storeSavedPills(pills), [pills]);
  useEffect(() => storeUnitPreferences(units), [units]);

  function rememberPill(pill: SavedPill) {
    setPills((current) => {
      const existing = current.find((item) => item.id === pill.id);
      return existing
        ? current.map((item) => item.id === pill.id ? { ...item, ...pill } : item)
        : [...current, pill];
    });
  }

  function forgetPill(id: string) {
    const removed = pills.find((pill) => pill.id === id);
    setPills((current) => current.filter((item) => item.id !== id));
    void deleteReadings(id, removed?.historyId).catch(() => {});
    forgetProfiles(id);
    if (removed?.historyId && !pills.some((pill) => pill.id !== id && pill.historyId === removed.historyId))
      { forgetReadKey(removed.historyId); forgetControlKey(removed.historyId); forgetProfiles(removed.historyId); }
  }

  function importHistory() {
    const match = /^([0-9a-f]{64}):([A-Za-z0-9_-]{43})(?::([A-Za-z0-9_-]{43}))?$/.exec(importValue.trim());
    if (!match) { setImportError("Paste a history key copied from the first phone."); return; }
    try {
      saveReadKey(match[1], match[2]);
      if (match[3]) saveControlKey(match[1], match[3]);
      setHistoryKeyRevision((current) => current + 1);
      const existing = pills.find((pill) => pill.historyId === match[1] || pill.config?.history_id === match[1]);
      if (!existing) rememberPill({ id: `history:${match[1]}`, historyId: match[1], name: "OpenPill history" });
      setImportValue("");
      setImportError("");
      setImportOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Invalid history key.");
    }
  }

  async function addPill() {
    setChoosing(true);
    setError("");
    try {
      const device = await choosePill();
      setDevices((current) => new Map(current).set(device.id, device));
      rememberPill({ id: device.id, name: device.name || "OpenPill" });
      setAutoConnectId(device.id);
      setGuideOpen(false);
    } catch (failure) {
      if (!(failure instanceof Error && /cancelled? the requestDevice\(\) chooser/i.test(failure.message))) {
        setError(failure instanceof Error ? failure.message : "Could not find a Pill.");
      }
    } finally {
      setChoosing(false);
    }
  }

  const connectionGuide = <div className="connect-guide-content">
    <div className="guide-content">
      <h2>How to connect</h2>
      <ol>
        <li><strong>Stand your Pill on its clear end, or put it on the charger.</strong><span>If standing it up, keep the colored cap at the top for a few seconds.</span></li>
        <li><strong>Look for the green status light.</strong><span>It should slowly brighten and dim, like the Pill shown here.</span></li>
        <li><strong>Connect to your Pill.</strong><span>Select it from the list. It stays available for up to five minutes.</span>
          <Button className="guide-button" type="primary" size="large" onClick={() => void addPill()} loading={choosing}>Connect to Pill</Button>
        </li>
      </ol>
      {error && <Alert className="page-alert" type="error" showIcon message={error} />}
      <p>No breathing light or no Pill in the list? Lay it down, then stand it up again with the colored cap at the top.</p>
    </div>
    <div className="guide-art" aria-hidden="true"><img src={pillReady} alt="" /></div>
  </div>;

  return <ConfigProvider theme={{ token: {
    colorPrimary: "#2b7055", colorInfo: "#2b7055", colorSuccess: "#4e9f76",
    colorText: "#263c36", colorBgBase: "#fffefa", borderRadius: 12,
    fontFamily: '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif'
  } }}>
    <main className="app-shell">
      <header className="site-header">
        <div className="brand"><img src={sitePath("openpill.svg")} alt="" /><span>OpenPill</span></div>
        <div className="header-actions">
          <a className="header-link" href="https://github.com/keredson/openpill" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>
          <Button type="text" shape="circle" icon={<SettingOutlined />} aria-label="Display settings" title="Display settings" onClick={() => setDisplaySettingsOpen(true)} />
        </div>
      </header>

      {pills.length > 0 && <section className="pill-section" aria-labelledby="pills-title">
        <div className="section-heading"><div><h1 id="pills-title">Your Pills</h1><p>Readings and controls for the Pills you’ve added.</p></div>
          <span><Button onClick={() => setImportOpen(true)}>Import history key</Button> <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => { setError(""); setGuideOpen(true); }}>Add a Pill</Button></span>
        </div>
        <div className="pill-grid">{pills.map((pill) => <PillCard key={pill.id} pill={pill} device={devices.get(pill.id)} autoConnect={autoConnectId === pill.id} units={units} historyKeyRevision={historyKeyRevision} onRemember={rememberPill} onForget={() => forgetPill(pill.id)} onChoose={() => { setError(""); setGuideOpen(true); }} />)}</div>
      </section>}

      {pills.length === 0 && <><Card className="connect-guide">{connectionGuide}</Card><Button onClick={() => setImportOpen(true)}>Import history key</Button></>}
      <Modal title="Import OpenPill history" open={importOpen} onCancel={() => setImportOpen(false)} onOk={importHistory} okText="Import">
        <p>Paste a read key to view history and calibration. If you also received the control key, include it to edit calibration.</p>
        <Input.Password value={importValue} onChange={(event) => { setImportValue(event.target.value); setImportError(""); }} placeholder="History ID:read key[:control key]" autoComplete="off" />
        {importError && <Alert type="error" showIcon message={importError} />}
      </Modal>
      <Modal className="connect-modal" open={pills.length > 0 && guideOpen} onCancel={() => setGuideOpen(false)} footer={null} width={900} aria-label="How to connect a Pill">
        {connectionGuide}
      </Modal>
      <Modal title="Display settings" open={displaySettingsOpen} onCancel={() => setDisplaySettingsOpen(false)} footer={<Button type="primary" onClick={() => setDisplaySettingsOpen(false)}>Done</Button>}>
        <div className="unit-settings">
          <div className="unit-setting"><span>Temperature</span><Segmented aria-label="Temperature unit" value={units.temperature} options={[{ label: "°C", value: "celsius" }, { label: "°F", value: "fahrenheit" }]} onChange={(value) => setUnits((current) => ({ ...current, temperature: value as UnitPreferences["temperature"] }))} /></div>
          <div className="unit-setting"><span>Gravity</span><Segmented aria-label="Gravity unit" value={units.gravity} options={[{ label: "SG", value: "sg" }, { label: "°Plato", value: "plato" }]} onChange={(value) => setUnits((current) => ({ ...current, gravity: value as UnitPreferences["gravity"] }))} /></div>
          <p>These preferences only change how readings appear in this browser. Plato values are approximate.</p>
        </div>
      </Modal>

      <section className="convert-link" aria-labelledby="convert-title">
        <div><h2 id="convert-title">Convert your RAPT Pill to OpenPill</h2><p>Use an ESP32 bridge to save a recovery copy and flash OpenPill, step by step.</p></div>
        <a href={routeUrl("/flash")} onClick={(event) => handleInternalLink(event, "/flash")}>Start</a>
      </section>

    </main>
  </ConfigProvider>;
}
