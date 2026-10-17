import { FormEvent, useState } from "react";
import { Alert, AutoComplete, Button, Input, Modal } from "antd";
import type { PublicConfig, WifiNetwork } from "./ble";

export default function WifiSetupModal({ config, connected, onClose, onScan, onConfigure }: {
  config: PublicConfig;
  connected: boolean;
  onClose: () => void;
  onScan: () => Promise<WifiNetwork[]>;
  onConfigure: (ssid: string, password?: string) => Promise<PublicConfig>;
}) {
  const [ssid, setSsid] = useState(config.wifi_ssid);
  const [password, setPassword] = useState("");
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selected = networks.find((network) => network.ssid === ssid);
  const savedPasswordApplies = ssid === config.wifi_ssid && config.has_wifi_password;

  async function scan() {
    setScanning(true);
    setError("");
    try {
      const found = await onScan();
      setNetworks([...new Map(found.map((network) => [network.ssid, network])).values()]
        .sort((a, b) => b.rssi - a.rssi));
      setScanned(true);
    } catch (cause) {
      console.error("[OpenPill] Could not show Wi-Fi networks", cause);
      setError(cause instanceof Error ? cause.message : "Could not scan for Wi-Fi networks.");
    } finally {
      setScanning(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const networkName = ssid.trim();
    if (!networkName) { setError("Choose or enter a network name."); return; }
    if (selected?.secure && !password && !savedPasswordApplies) {
      setError("Enter the password for this network.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const passwordToSave = selected && !selected.secure ? ""
        : password || (savedPasswordApplies ? undefined : "");
      await onConfigure(networkName, passwordToSave);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to this Wi-Fi network.");
    } finally {
      setSaving(false);
    }
  }

  return <Modal open title="Configure Wi-Fi" onCancel={onClose} footer={null} width={500}
    closable={!saving} maskClosable={!saving} keyboard={!saving} destroyOnHidden>
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      {error && <Alert type="error" title={error} showIcon />}
      {saving && <Alert type="info" title="Connecting to Wi-Fi and saving…" showIcon />}
      <label className="setting-field"><span>Network</span>
        <div className="wifi-network-picker"><AutoComplete value={ssid} onChange={(value) => { setSsid(value.slice(0, 32)); setPassword(""); }} options={networks.map((network) => ({ value: network.ssid, label: `${network.ssid} · ${network.secure ? "Secured" : "Open"} · ${network.rssi} dBm` }))} filterOption={false} placeholder="Choose or type a 2.4 GHz network" /><Button onClick={() => void scan()} loading={scanning} disabled={saving || !connected}>Scan networks</Button></div>
        {scanned && networks.length === 0 && <small>No visible networks found. You can still type a network name.</small>}
      </label>
      {(!selected || selected.secure) && <label className="setting-field"><span>Password</span>
        <Input.Password maxLength={64} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={saving} placeholder={savedPasswordApplies ? "Leave blank to keep saved password" : "Wi-Fi password"} />
      </label>}
      <div className="modal-actions"><Button onClick={onClose} disabled={saving}>Cancel</Button><Button type="primary" htmlType="submit" loading={saving} disabled={scanning || !connected}>Connect and save</Button></div>
    </form>
  </Modal>;
}
