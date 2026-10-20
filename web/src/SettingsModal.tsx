import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Popconfirm, Select, Switch } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { ConfigPatch, ConfigStatus, PublicConfig, WifiNetwork } from "./ble";
import WifiSetupModal from "./WifiSetupModal";

const reportingIntervals = [5, 10, 15, 30, 60, 120, 240, 360, 720, 1440].map((minutes) => ({
  value: minutes * 60,
  label: minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`,
}));

const examplePayload = {
  schema: 1,
  device_id: "56642E",
  gravity: 1.046,
  temperature_c: 20.5,
  battery_percent: 79,
};

function withDefaultProtocol(value: string): string {
  const entered = value.trim();
  return entered && !/^[a-z][a-z\d+.-]*:\/\//i.test(entered) && !/^https?:/i.test(entered)
    ? `https://${entered}` : entered;
}

function normalizePostUrl(value: string, allowHttp: boolean): string {
  const entered = value.trim();
  if (!entered) throw new Error("Enter a POST URL.");
  const endpoint = withDefaultProtocol(value);
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("Enter a full HTTPS or HTTP URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Enter a valid POST URL, such as https://example.com/readings.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The POST URL must use HTTPS or HTTP.");
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new Error("This Pill requires an HTTPS POST URL.");
  }
  if (endpoint.length > 256) throw new Error("The POST URL is too long.");
  return endpoint;
}

type Props = {
  name: string;
  config: PublicConfig;
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
  busy: boolean;
  saving: boolean;
  testing: boolean;
  status: ConfigStatus;
  onClose: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
  onTestPost: (endpointUrl: string, allowHttp: boolean, wifiTimeoutSeconds: number) => Promise<void>;
  onScanWifi: () => Promise<WifiNetwork[]>;
  onConfigureWifi: (ssid: string, password?: string) => Promise<PublicConfig>;
  onForget: () => void;
  firmwareInfo: ReactNode;
  historyReadKey: string | null;
  historyControlKey: string | null;
  onResetHistory: () => Promise<void>;
};

export default function SettingsModal({ name, config, connected, connecting, onConnect, busy, saving, testing, status, onClose, onSave, onTestPost, onScanWifi, onConfigureWifi, onForget, firmwareInfo, historyReadKey, historyControlKey, onResetHistory }: Props) {
  const [draft, setDraft] = useState<PublicConfig>({ ...config });
  const [wifiOpen, setWifiOpen] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    setDraft({ ...config });
    setTestResult(null);
  }, [config]);

  useEffect(() => {
    if (!connected) setWifiOpen(false);
  }, [connected]);

  const update = <K extends keyof PublicConfig>(key: K, value: PublicConfig[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const availableIntervals = draft.history_telemetry
    ? reportingIntervals.filter((option) => option.value >= 900) : reportingIntervals;
  const intervalOptions = availableIntervals.some((option) => option.value === draft.wake_interval_s)
    ? availableIntervals
    : [{ value: draft.wake_interval_s, label: `${draft.wake_interval_s / 60} minutes (current)` }, ...availableIntervals];
  const destination = draft.history_telemetry ? "history" : draft.wifi_telemetry ? "post" : "off";

  function selectDestination(value: string) {
    setDraft((current) => ({ ...current,
      wifi_telemetry: value === "post",
      history_telemetry: value === "history",
      wake_interval_s: value === "history" ? Math.max(current.wake_interval_s, 900) : current.wake_interval_s
    }));
    setTestResult(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connected) return;
    let endpointUrl = draft.endpoint_url;
    if (draft.wifi_telemetry) {
      try {
        endpointUrl = normalizePostUrl(endpointUrl, draft.allow_http);
        update("endpoint_url", endpointUrl);
        setTestResult(null);
      } catch (error) {
        setTestResult({ tone: "error", message: error instanceof Error ? error.message : "Invalid POST URL." });
        return;
      }
    }
    const patch: ConfigPatch = {
      wake_interval_s: draft.wake_interval_s,
      wifi_timeout_s: draft.wifi_timeout_s,
      ble_telemetry: draft.ble_telemetry,
      wifi_telemetry: draft.wifi_telemetry,
      history_telemetry: !!draft.history_telemetry,
      auto_wifi_update: draft.auto_wifi_update,
      allow_http: draft.allow_http,
      endpoint_url: endpointUrl
    };
    await onSave(patch);
  }

  async function testPost() {
    setTestResult(null);
    try {
      const endpointUrl = normalizePostUrl(draft.endpoint_url, draft.allow_http);
      update("endpoint_url", endpointUrl);
      await onTestPost(endpointUrl, draft.allow_http, draft.wifi_timeout_s);
      setTestResult({ tone: "success", message: "Test POST succeeded. URL not saved." });
    } catch (error) {
      setTestResult({ tone: "error", message: error instanceof Error ? error.message : "Test POST failed." });
    }
  }

  return <><Modal open title={`Settings · ${name}`} onCancel={onClose} footer={null}
    width={560} destroyOnHidden maskClosable={!busy} closable={!busy} keyboard={!busy}>
    <form onSubmit={(event) => void submit(event)} className="settings-form" autoComplete="off">
      {!connected && <div className="settings-offline-notice"><span>Connect to your Pill to change these settings.</span><Button type="primary" onClick={onConnect} loading={connecting}>Connect</Button></div>}
      {saving && <Alert type="info" showIcon message={status.state === 3 ? "Testing Wi-Fi and sending a reading…" : "Saving settings…"} />}
      <div className="settings-content">
        <section>
          <label className="switch-setting"><span><strong>Bluetooth broadcast</strong><small>Send a reading at each reporting interval</small></span><Switch checked={draft.ble_telemetry} disabled={!connected || busy} onChange={(value) => update("ble_telemetry", value)} /></label>
          <div className="wifi-settings-row"><span><strong>Wi-Fi</strong><small>{config.wifi_ssid ? `${config.wifi_ssid} · Connected` : "Not connected"}</small></span><Button onClick={() => setWifiOpen(true)} disabled={!connected || busy}>Configure</Button></div>
          {config.wifi_ssid && <label className="interval-settings-row"><span><strong>Wi-Fi readings</strong><small>Choose where the Pill sends readings</small></span><span className="interval-settings-control"><Select aria-label="Wi-Fi readings destination" value={destination} disabled={!connected || busy} onChange={selectDestination} options={[
            { value: "off", label: "Off" },
            { value: "post", label: "HTTPS POST" },
            { value: "history", label: "OpenPill history (free)", disabled: !config.history_id },
            { value: "brewfather", label: "Brewfather (future)", disabled: true }
          ]} /></span></label>}
          {config.wifi_ssid && destination === "off" && <Alert type="info" showIcon message="Wi-Fi is ready. Choose a destination to upload readings; history is off until you opt in." />}
          {draft.history_telemetry && <><p>OpenPill stores up to 90 days of readings. This browser keeps the read key; copy it to add the history on another phone.</p>
            {config.history_id && historyReadKey && <Button htmlType="button" onClick={() => void navigator.clipboard.writeText(`${config.history_id}:${historyReadKey}`)}>Copy history key</Button>}
            {config.history_id && historyReadKey && historyControlKey && <><Button htmlType="button" onClick={() => void navigator.clipboard.writeText(`${config.history_id}:${historyReadKey}:${historyControlKey}`)}>Copy history and control keys</Button><small>Sharing the control key lets another phone edit calibration.</small></>}
            {config.has_history_read_hash && !historyReadKey && <Alert type="warning" showIcon message="This browser does not have the read key. Import it from another phone, or start a new history." />}
            {config.has_history_read_hash && !historyReadKey && <Popconfirm title="Start a new history?" description="The old server history will be inaccessible without its read key." onConfirm={() => void onResetHistory()} okText="Start new history" cancelText="Cancel"><Button htmlType="button" danger disabled={!connected || busy}>Start new history</Button></Popconfirm>}
          </>}
          {draft.wifi_telemetry && <>
            <div className="settings-detail-row"><span className="settings-post-label"><label htmlFor="openpill-post-url"><strong>POST URL</strong></label><Button className="settings-example-link" type="link" size="small" onClick={() => setExampleOpen(true)}>(example)</Button></span><span className="settings-post-control"><Input id="openpill-post-url" type="text" inputMode="url" name="openpillPostEndpointUrl" autoComplete="off" maxLength={256} required disabled={!connected || busy} value={draft.endpoint_url} onChange={(event) => { update("endpoint_url", event.target.value); setTestResult(null); }} onBlur={(event) => update("endpoint_url", withDefaultProtocol(event.target.value))} placeholder="https://example.com/readings" /><Button htmlType="button" onClick={() => void testPost()} loading={testing} disabled={!connected || busy || !config.wifi_ssid || !draft.endpoint_url.trim()}>Test</Button></span></div>
            {testResult && <Alert className="settings-test-result" type={testResult.tone} showIcon title={testResult.message} />}
          </>}
          {config.wifi_ssid && <label className="switch-setting"><span><strong>Automatic firmware updates</strong><small>Check weekly over Wi-Fi; replaces the previous firmware slot</small></span><Switch checked={draft.auto_wifi_update} disabled={!connected || busy} onChange={(value) => update("auto_wifi_update", value)} /></label>}
          <label className="interval-settings-row"><span><strong>Reporting interval</strong><small>How often the Pill sends readings</small></span><span className="interval-settings-control"><Select aria-label="Reporting interval" options={intervalOptions} disabled={!connected || busy} value={draft.wake_interval_s} onChange={(value) => update("wake_interval_s", value)} /></span></label>
          {firmwareInfo}
          {!draft.ble_telemetry && !draft.wifi_telemetry && !draft.history_telemetry && <Alert type="info" message="Both reporting methods are off. The Pill will sleep until moved." />}
        </section>
      </div>
      <div className="modal-actions"><Popconfirm title="Forget this Pill?" description="Removes its saved card and readings from this browser." onConfirm={onForget} okText="Forget" cancelText="Keep"><Button danger icon={<DeleteOutlined />} disabled={!connected || busy}>Forget Pill</Button></Popconfirm><span>{draft.wifi_telemetry || draft.history_telemetry ? "Saving also sends a test reading." : ""}</span><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="primary" htmlType="submit" loading={saving} disabled={!connected || busy}>Save settings</Button></div>
    </form>
  </Modal><Modal open={exampleOpen} title="Example POST payload" onCancel={() => setExampleOpen(false)} footer={null} width={520} destroyOnHidden>
    <p>The Pill sends JSON with <code>Content-Type: application/json</code>. Fields for unavailable readings are omitted.</p>
    <pre className="settings-example-payload">{JSON.stringify(examplePayload, null, 2)}</pre>
  </Modal>{wifiOpen && <WifiSetupModal config={config} connected={connected} onClose={() => setWifiOpen(false)} onScan={onScanWifi} onConfigure={onConfigureWifi} />}</>;
}
