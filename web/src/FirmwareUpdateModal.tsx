import { useEffect, useState } from "react";
import { Alert, Button, Modal, Progress } from "antd";
import { CheckCircleFilled } from "@ant-design/icons";
import { FirmwareImage, loadFirmwareImage, OtaProgress, PublicConfig } from "./ble";

export default function FirmwareUpdateModal({ name, config, connected, reconnecting, onClose, onInstall }: {
  name: string;
  config: Pick<PublicConfig, "firmware_version" | "firmware_elf_sha256">;
  connected: boolean;
  reconnecting: boolean;
  onClose: () => void;
  onInstall: (image: FirmwareImage, onProgress: (progress: OtaProgress) => void) => Promise<"installed" | "already-current">;
}) {
  const [image, setImage] = useState<FirmwareImage | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<OtaProgress | null>(null);
  const [working, setWorking] = useState(false);
  const [complete, setComplete] = useState(false);
  const [alreadyCurrent, setAlreadyCurrent] = useState(false);
  const [mustReconnect, setMustReconnect] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void loadFirmwareImage().then((loaded) => {
      if (active) setImage(loaded);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load the firmware image.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const installed = !!image && !!config.firmware_elf_sha256 &&
    image.elfSha256.toLowerCase() === config.firmware_elf_sha256.toLowerCase();
  const updateConfirmed = complete && !alreadyCurrent && connected && installed;
  const confirmed = complete && (alreadyCurrent || updateConfirmed);
  const older = !!image && !!config.firmware_version && (() => {
    const current = config.firmware_version!.match(/^(\d+)\.(\d+)\.(\d+)$/);
    const candidate = image.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!current || !candidate) return false;
    for (let index = 1; index <= 3; index++) {
      if (+candidate[index] !== +current[index]) return +candidate[index] < +current[index];
    }
    return false;
  })();

  async function install() {
    if (!image || working || installed || older || mustReconnect) return;
    setWorking(true);
    setError("");
    let commitStarted = false;
    try {
      const outcome = await onInstall(image, (next) => {
        if (next.phase === "verifying") commitStarted = true;
        setProgress(next);
      });
      setAlreadyCurrent(outcome === "already-current");
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update did not finish.");
      if (commitStarted) setMustReconnect(true);
    } finally {
      setWorking(false);
    }
  }

  const percent = progress ? Math.min(100, Math.round(progress.accepted * 100 / progress.total)) : 0;
  const phaseText = progress?.phase === "uploading" ? `Sending firmware to ${name}${progress.slot ? ` · ${progress.slot}` : ""}`
    : progress?.phase === "verifying" ? "The Pill is verifying the firmware…"
      : progress?.phase === "restarting" ? "Verified. The Pill is restarting." : "";

  return <Modal open title="Update firmware" onCancel={onClose} footer={null} width={500}
    closable={!working} mask={{ closable: !working }} keyboard={!working}>
    <div className="firmware-update-content">
      {error && <Alert type="error" title={error} showIcon />}
      {mustReconnect && <p>Reconnect and check the installed firmware before trying another update.</p>}
      {loading && <p>Checking the firmware available on this site…</p>}
      {image && !complete && <>
        <p><strong>{name}</strong> {connected ? "is running" : "was last seen running"} v{config.firmware_version || "unknown"}. This site has v{image.version || "unknown"}.</p>
        {installed ? <Alert type="success" title="This firmware is already installed." showIcon /> :
          older ? <Alert type="warning" title="This site has an older firmware version." showIcon /> :
          <p>Keep this page open and the Pill nearby until the update finishes. The previous firmware remains in the other slot if the transfer fails.</p>}
      </>}
      {progress && !confirmed && <div className="firmware-update-progress">
        <p>{phaseText}</p>
        <Progress percent={percent} status={progress.phase === "restarting" ? "success" : "active"} />
        {progress.phase === "uploading" && <small>{progress.accepted.toLocaleString()} / {progress.total.toLocaleString()} bytes accepted</small>}
      </div>}
      {updateConfirmed && <div className="firmware-update-success" role="status">
        <CheckCircleFilled aria-hidden="true" />
        <p>Update complete</p>
      </div>}
      {complete && !updateConfirmed && <p>{alreadyCurrent ? `Firmware v${image?.version} is already installed. No update was sent.`
        : reconnecting ? "Firmware verified. Waiting for the Pill to restart and reconnect…"
          : "The update was verified, but automatic reconnection did not confirm the installed version. Close this dialog and use Connect to try again."}</p>}
      <div className="modal-actions">
        <Button onClick={onClose} disabled={working}>{complete ? "Done" : "Cancel"}</Button>
        {!complete && <Button type="primary" onClick={() => void install()} loading={working}
          disabled={loading || !image || installed || older || mustReconnect}>Install update</Button>}
      </div>
    </div>
  </Modal>;
}
