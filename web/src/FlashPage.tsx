import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, ConfigProvider, Modal, Popconfirm, Progress, Radio, Steps } from "antd";
import { ArrowLeftOutlined, UsbOutlined } from "@ant-design/icons";
import { downloadBackup, downloadOtaSlot, listBackups, RecoveryBackup, saveBackup } from "./flashBackup";
import { BridgeNotResponding, checkPillLink, chooseSerialPort, flashBridge, flashPill, inspectPillSlots, PillSlots, PillTrafficNotDetected, pingBridge, readPillBackup, resetPill, restoreOtaSlot, restorePill, SerialPortSelectionCancelled, sha256, switchPillSlot, TransferStage, validatePillBackup, verifyPill } from "./flashSerial";
import { handleInternalLink, navigate, routeUrl } from "./navigation";
import { sitePath } from "./sitePath";
import FlashPowerCheck from "./FlashPowerCheck";
import FlashWiringDiagram from "./FlashWiringDiagram";

type PillSession = Awaited<ReturnType<typeof verifyPill>>;
type Work = "bridge" | "verify" | "backup" | "flash" | "restore" | "inspect-slots" | "switch-slot" | null;
type RestoreChoice = "ota_0" | "ota_1" | "full" | null;

export default function FlashPage({ view }: { view: "convert" | "restore" }) {
  const [port, setPort] = useState<BrowserSerialPort | null>(null);
  const session = useRef<PillSession | null>(null);
  const restoreFileInput = useRef<HTMLInputElement | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [linked, setLinked] = useState(false);
  const [verified, setVerified] = useState<{ mac: string; description: string } | null>(null);
  const [backup, setBackup] = useState<RecoveryBackup | null>(null);
  const [skipBackup, setSkipBackup] = useState(false);
  const [backups, setBackups] = useState<RecoveryBackup[]>([]);
  const [restoreSource, setRestoreSource] = useState<RecoveryBackup | null>(null);
  const [restoreChoice, setRestoreChoice] = useState<RestoreChoice>(null);
  const [availableSlots, setAvailableSlots] = useState<[boolean, boolean] | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreChargingConfirmed, setRestoreChargingConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [chargingConfirmed, setChargingConfirmed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [restored, setRestored] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [work, setWork] = useState<Work>(null);
  const [lastWork, setLastWork] = useState<Work>(null);
  const [progress, setProgress] = useState(0);
  const [transferStage, setTransferStage] = useState<TransferStage | null>(null);
  const [writeProgress, setWriteProgress] = useState(0);
  const [verifyProgress, setVerifyProgress] = useState(0);
  const [pillSlots, setPillSlots] = useState<PillSlots | null>(null);
  const [switchChargingConfirmed, setSwitchChargingConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void listBackups().then(setBackups).catch(() => {});
    return () => { void session.current?.transport.disconnect().catch(() => {}); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAvailableSlots(null);
    if (restoreSource) {
      void Promise.all([0, 1].map(async (slot) => {
        const address = 0x10000 + slot * 0x180000;
        return new Uint8Array(await restoreSource.image.slice(address, address + 1).arrayBuffer())[0] === 0xe9;
      })).then((slots) => { if (!cancelled) setAvailableSlots(slots as [boolean, boolean]); })
        .catch(() => { if (!cancelled) setAvailableSlots([false, false]); });
    }
    return () => { cancelled = true; };
  }, [restoreSource]);

  function selectRestoreSource(source: RecoveryBackup | null) {
    setRestoreSource(source);
    setRestoreChoice(null);
    setRestoreConfirmed(false);
    setRestoreChargingConfirmed(false);
  }

  async function run(kind: Work, action: () => Promise<void>) {
    setWork(kind);
    setLastWork(kind);
    setProgress(0);
    setTransferStage(null);
    setWriteProgress(0);
    setVerifyProgress(0);
    setError("");
    setErrorDetails("");
    setMessage("");
    setRestored(false);
    try { await action(); }
    catch (failure) {
      if (!(failure instanceof SerialPortSelectionCancelled)) {
        console.error(`[OpenPill] ${kind ?? "operation"} failed`, failure);
        const message = failure instanceof Error ? failure.message : "The operation failed.";
        setError(message.startsWith("Serial data stream stopped:")
          ? "The serial connection stopped. Please try again."
          : message);
        if (failure instanceof BridgeNotResponding) setErrorDetails(failure.startupOutput);
      }
    }
    finally { setWork(null); }
  }

  function updateTransfer(stage: TransferStage, percent: number) {
    setTransferStage(stage);
    if (stage === "write") setWriteProgress(percent);
    if (stage === "verify") setVerifyProgress(percent);
  }

  async function clearPillSession() {
    await session.current?.transport.disconnect().catch(() => {});
    session.current = null;
    setLinked(false);
    setVerified(null);
    setBackup(null);
    setSkipBackup(false);
    setConfirmed(false);
    setChargingConfirmed(false);
    setFinished(false);
    setPillSlots(null);
  }

  async function selectAndFlashBridge() {
    await run("bridge", async () => {
      const selected = await chooseSerialPort();
      await clearPillSession();
      setPort(selected);
      setBridgeReady(false);
      try {
        await flashBridge(selected, setProgress);
      } catch (failure) {
        setPort(null);
        throw failure;
      }
      setBridgeReady(true);
      showStep(1);
    });
  }

  async function useExistingBridge() {
    await run("bridge", async () => {
      const selected = await chooseSerialPort();
      await clearPillSession();
      setBridgeReady(false);
      try {
        await pingBridge(selected);
      } catch (failure) {
        setPort(null);
        throw failure;
      }
      setPort(selected);
      setBridgeReady(true);
      showStep(1);
    });
  }

  async function checkConnection() {
    if (!port) return;
    await run("verify", async () => {
      await session.current?.transport.disconnect().catch(() => {});
      session.current = null;
      setLinked(false);
      setVerified(null);
      setBackup(null);
      setSkipBackup(false);
      setConfirmed(false);
      setChargingConfirmed(false);
      try {
        await checkPillLink(port);
      } catch (failure) {
        if (!(failure instanceof PillTrafficNotDetected)) {
          setPort(null);
          setBridgeReady(false);
          setWizardStep(0);
        }
        throw failure;
      }
      setLinked(true);
      showStep(2);
    });
  }

  async function makeBackup() {
    if (!port || !linked) return;
    await run("backup", async () => {
      await session.current?.transport.disconnect().catch(() => {});
      session.current = null;
      const next = await verifyPill(port);
      session.current = next;
      setVerified({ mac: next.mac, description: next.description });
      const image = await readPillBackup(session.current!.loader, setProgress);
      const stored: RecoveryBackup = {
        id: `${session.current!.mac}-${Date.now()}`,
        mac: session.current!.mac,
        createdAt: Date.now(),
        sha256: await sha256(image),
        image: new Blob([image.slice().buffer], { type: "application/octet-stream" })
      };
      await saveBackup(stored);
      const saved = (await listBackups()).find((item) => item.id === stored.id);
      if (!saved || saved.sha256 !== stored.sha256 || saved.image.size !== image.length ||
          await sha256(new Uint8Array(await saved.image.arrayBuffer())) !== stored.sha256) {
        throw new Error("The recovery copy could not be confirmed in this browser. The Pill was not flashed.");
      }
      setBackup(saved);
      setSkipBackup(false);
      setBackups(await listBackups());
      showStep(3);
    });
  }

  async function convertPill() {
    if (!port || !linked || (!backup && !skipBackup) || !confirmed || !chargingConfirmed) return;
    await run("flash", async () => {
      if (!session.current) {
        session.current = await verifyPill(port);
      }
      const currentMac = session.current!.mac;
      if ((verified && currentMac !== verified.mac) || (backup && currentMac !== backup.mac)) {
        throw new Error("The connected Pill no longer matches the saved backup. Nothing was flashed.");
      }
      await flashPill(session.current!.loader, updateTransfer);
      await session.current!.transport.disconnect();
      session.current = null;
      setFinished(true);
      try {
        await resetPill(port);
        setMessage(backup ? "OpenPill is installed and your Pill has restarted. Keep your recovery copy safe." : "OpenPill is installed and your Pill has restarted.");
      } catch {
        setMessage("OpenPill is installed and checked, but your Pill did not restart automatically. Restart it before connecting.");
      }
    });
  }

  function chooseRestoreFile(file: File | undefined) {
    if (!file) return;
    const match = /^pill-recovery-([0-9a-f]{12})-(?:([0-9a-f]{64})-)?(.+)\.bin$/i.exec(file.name);
    if (!match || file.size !== 0x400000) {
      selectRestoreSource(null);
      setError("Choose a 4 MiB recovery file downloaded from OpenPill. Its filename must include the Pill ID.");
      return;
    }
    const mac = match[1].match(/../g)!.join(":").toUpperCase();
    selectRestoreSource({ id: file.name, mac, createdAt: file.lastModified, sha256: match[2]?.toLowerCase() || "", image: file });
    setError("");
  }

  async function restoreBackup() {
    if (!port || !bridgeReady || !restoreSource || !restoreChoice || !restoreConfirmed || !restoreChargingConfirmed) return;
    await run("restore", async () => {
      const source = restoreSource;
      const choice = restoreChoice;
      const image = new Uint8Array(await source.image.arrayBuffer());
      validatePillBackup(image);
      if (source.sha256 && await sha256(image) !== source.sha256) {
        throw new Error("This recovery copy did not match the version saved in this browser. Nothing was written.");
      }
      await session.current?.transport.disconnect().catch(() => {});
      session.current = null;
      const next = await verifyPill(port);
      try {
        if (next.mac.toLowerCase() !== source.mac.toLowerCase()) {
          throw new Error("This recovery copy belongs to a different Pill. Nothing was written.");
        }
        if (choice === "full") {
          await restorePill(next.loader, image, updateTransfer);
        } else {
          await restoreOtaSlot(next.loader, image, choice === "ota_0" ? 0 : 1, updateTransfer);
        }
      } finally {
        await next.transport.disconnect().catch(() => {});
      }
      setLinked(false);
      setVerified(null);
      setBackup(null);
      setSkipBackup(false);
      setConfirmed(false);
      setChargingConfirmed(false);
      setFinished(false);
      setWizardStep(0);
      setRestoreConfirmed(false);
      setRestoreChargingConfirmed(false);
      setRestored(true);
      try {
        await resetPill(port);
        setMessage(choice === "full" ? "Your Pill’s full backup has been restored and it has restarted." : "Your chosen firmware has been restored and the Pill has restarted. Its settings were left intact.");
      } catch {
        setMessage(choice === "full" ? "Your Pill’s full backup was restored, but it did not restart automatically. Restart it before connecting." : "Your chosen firmware was restored, but the Pill did not restart automatically. Restart it before connecting.");
      }
    });
  }

  async function inspectSlots() {
    if (!port || !bridgeReady) return;
    await run("inspect-slots", async () => {
      setPillSlots(null);
      const next = await verifyPill(port);
      try {
        setPillSlots(await inspectPillSlots(next.loader, next.mac));
      } finally {
        await next.transport.disconnect().catch(() => {});
        await resetPill(port).catch(() => {});
      }
    });
  }

  async function switchSlot() {
    if (!port || !bridgeReady || !pillSlots || !switchChargingConfirmed) return;
    await run("switch-slot", async () => {
      const next = await verifyPill(port);
      let switched = false;
      try {
        const selected = await switchPillSlot(next.loader, next.mac, pillSlots);
        switched = true;
        setPillSlots(null);
        setMessage(`Boot selection changed to ${selected.name} ${selected.version} in slot ${selected.slot}. The Pill is restarting.`);
      } finally {
        await next.transport.disconnect().catch(() => {});
        if (switched) await resetPill(port).catch(() => {});
      }
    });
  }

  function showStep(step: number) {
    setWizardStep(step);
    setError("");
    setMessage("");
  }

  function cardFeedback(kind: Exclude<Work, null>) {
    const transfer = kind === "flash" || kind === "restore";
    const showResult = view !== "restore" || lastWork === kind;
    return <div className="flash-feedback" aria-live="polite">
      {!navigator.serial && <Alert type="warning" showIcon message="Web Serial is unavailable" description="Use a desktop browser with Web Serial over HTTPS or localhost. The Pill’s charging connector cannot flash its ESP32 directly." />}
      {showResult && error && <Alert type="error" showIcon message={error} description={errorDetails && <details className="flash-diagnostics"><summary>See ESP32 startup output</summary><pre>{errorDetails}</pre></details>} />}
      {showResult && message && <Alert type={finished || restored || kind === "switch-slot" ? "success" : "info"} showIcon message={message} />}
      {work === kind && transfer && <div className="transfer-status">
        <p>{transferStage === "inspect" || !transferStage ? "Checking the Pill’s firmware slots…" : transferStage === "write" ? "Writing firmware to the Pill…" : transferStage === "verify" ? "Reading it back to verify the copy…" : "Selecting the firmware for the next boot…"}</p>
        {transferStage && transferStage !== "inspect" && <><span>Writing</span><Progress percent={writeProgress} status={writeProgress === 100 ? "success" : "active"} />
          {(transferStage === "verify" || transferStage === "select") && <><span>Reading back and verifying</span><Progress percent={verifyProgress} status={verifyProgress === 100 ? "success" : "active"} /></>}</>}
      </div>}
      {work === kind && !transfer && kind !== "inspect-slots" && kind !== "switch-slot" && <Progress percent={progress} status="active" className="flash-progress" />}
    </div>;
  }

  return <ConfigProvider theme={{ token: {
    colorPrimary: "#2b7055", colorInfo: "#2b7055", colorSuccess: "#4e9f76",
    colorText: "#263c36", colorBgBase: "#fffefa", borderRadius: 12,
    fontFamily: '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif'
  } }}>
    <main className="app-shell flash-page">
      <header className="site-header"><div className="brand"><img src={sitePath("openpill.svg")} alt="" /><span>OpenPill</span></div><a className="header-link" href={routeUrl("/")} onClick={(event) => handleInternalLink(event, "/")}><ArrowLeftOutlined /> Your Pills</a></header>
      <div className="flash-heading"><h1>{view === "convert" ? "Convert your RAPT Pill to OpenPill" : "Restore your Pill"}</h1><p>{view === "convert" ? "This guided process uses an ESP32 development board to connect to your Pill. We strongly recommend saving a recovery copy before installing." : "Switch back to firmware already on your Pill, or restore from a recovery copy."}</p>
        <Button type="link" className="flash-view-link" disabled={!!work} onClick={() => { setError(""); setErrorDetails(""); setMessage(""); navigate(view === "convert" ? "/restore" : "/flash"); }}>{view === "convert" ? "Restore from a recovery copy" : "Back to conversion"}</Button></div>
      {view === "convert" && <Steps className="flash-steps" current={wizardStep} responsive items={[
        { title: "Prepare board" }, { title: "Connect Pill" },
        { title: skipBackup && wizardStep > 2 ? "Backup skipped" : "Backup", status: skipBackup && !backup && wizardStep > 2 ? "wait" : undefined },
        { title: "Install" }
      ]} />}

      {view === "convert" && wizardStep === 0 && <Card className="flash-card" title="1. Prepare the ESP32 bridge">
        <h3 className="flash-materials-heading">What you’ll need</h3>
        <ul className="flash-materials">
          <li>An original RAPT Pill and its charger/cable.</li>
          <li>An ESP32 development board.</li>
          <li>A USB data cable for the development board.</li>
          <li>Five female-to-male jumper wires for the Pill’s GND, E_RXD, E_TXD, EN, and IO0 holes.</li>
          <li>A computer with a desktop browser that supports Web Serial, such as Chrome or Edge.</li>
        </ul>
        <p>Connect the ESP32 development board to your computer with USB. Flashing the bridge replaces firmware on the <em>development board</em>, not the Pill.</p>
        <p>When the browser asks for a serial port, choose your ESP32 board’s USB-to-UART adapter. It may appear as <strong>COM3</strong> on Windows, <strong>/dev/cu.SLAB_USBtoUART</strong> or <strong>/dev/cu.usbserial-…</strong> on macOS, or <strong>/dev/ttyUSB0</strong> on Linux. The name may include <strong>CP2102</strong> or <strong>CH340</strong>. If unsure, unplug and reconnect the board, then choose the port that appeared.</p>
        {cardFeedback("bridge")}
        <div className="flash-navigation flash-navigation--end"><div className="flash-action-group"><Button onClick={() => void useExistingBridge()} disabled={!!work || !navigator.serial}>Use an already flashed bridge</Button>
          <Button type="primary" icon={<UsbOutlined />} onClick={() => void selectAndFlashBridge()} loading={work === "bridge"} disabled={!!work || !navigator.serial}>Select board and flash bridge</Button></div></div>
      </Card>}

      {view === "convert" && wizardStep === 1 && <Card className="flash-card" title="2. Connect the Pill">
        <p>Remove the Pill from its plastic housing. You’ll need five jumper wires. Unplug the ESP32 bridge from USB while making the connections, then plug the Pill into a charger.</p>
        <p className="flash-pinout-note flash-warning">ESP32 dev-board pinouts vary. Match the GPIO labels printed on your board.
          <Button type="link" className="flash-photo-link" onClick={() => setPhotoOpen(true)}>(example wiring photo)</Button></p>
        <FlashWiringDiagram />
        <Modal title="Pill programming pads" open={photoOpen} onCancel={() => setPhotoOpen(false)} footer={null} width={1100}>
          <img className="flash-photo" src={sitePath("pill-programming-pads.webp")} alt="Close-up of a RAPT Pill rev.3.1 PCB showing its programming holes labeled 3V3, EN, IO0, E_RXD, E_TXD, and GND from left to right." />
        </Modal>
        <details className="wire-details"><summary>Wiring details</summary><div className="wire-table" role="table" aria-label="Bridge to Pill wiring"><div role="row"><strong>ESP32 bridge</strong><strong>Pill pad</strong><strong>Purpose</strong></div>
          <div role="row"><span>GND</span><span>GND</span><span>Common ground</span></div>
          <div role="row"><span>GPIO16 (RX)</span><span>TX</span><span>Pill → bridge</span></div>
          <div role="row"><span>GPIO17 (TX)</span><span>RX</span><span>Bridge → Pill</span></div>
          <div role="row"><span>GPIO25</span><span>EN</span><span>Open-drain reset</span></div>
          <div role="row"><span>GPIO26</span><span>IO0</span><span>Open-drain boot select</span></div></div></details>
        <p>Reconnect the ESP32 board to USB, then check the connection.</p>
        {linked && <p className="flash-detail">Pill connected</p>}
        {cardFeedback("verify")}
        <div className="flash-navigation"><div className="flash-action-group"><Button onClick={() => showStep(0)} disabled={!!work}>Back</Button></div>
          <div className="flash-action-group"><Button type="primary" onClick={() => void checkConnection()} loading={work === "verify"} disabled={!bridgeReady || !!work}>Check connection</Button></div></div>
      </Card>}

      {view === "convert" && wizardStep === 2 && <Card className="flash-card" title="3. Save a recovery copy">
        <p>Read all 4 MiB of the Pill, including both firmware slots and settings. The copy is saved only in this browser; you can download each firmware slot from it too. The full copy may contain Wi-Fi credentials or account data, so keep it private. Browser storage can be cleared; download a second copy for reliable recovery.</p>
        {cardFeedback("backup")}
        <div className="flash-navigation"><div className="flash-action-group"><Button onClick={() => showStep(1)} disabled={!!work}>Back</Button></div>
          <div className="flash-action-group"><Popconfirm title="Skip the recovery backup?" description="Not recommended. Without it, your earlier firmware and settings may be unrecoverable." okText="Skip backup" cancelText="Go back" okButtonProps={{ danger: true }} onConfirm={() => { setBackup(null); setSkipBackup(true); setConfirmed(false); setChargingConfirmed(false); showStep(3); }}>
            <Button disabled={!linked || !!work || !!backup}>Skip backup</Button></Popconfirm>
            <Button type="primary" onClick={() => void makeBackup()} loading={work === "backup"} disabled={!linked || !!work}>Read and save full backup</Button></div></div>
      </Card>}

      {view === "convert" && wizardStep === 3 && <Card className="flash-card" title="4. Install OpenPill">
        <p>We’ll install OpenPill into the other firmware slot, check that it copied correctly, and restart your Pill. The installation won’t erase your existing settings or calibration.</p>
        {backup && <div className="saved-backups"><strong>Recovery copy saved in this browser</strong><p>Download a separate copy before installing. Keep the full backup private; it may contain credentials.</p>
          <div><span>{backup.mac} · {new Date(backup.createdAt).toLocaleString()}</span><span className="backup-downloads"><Button size="small" onClick={() => downloadBackup(backup)} disabled={!!work}>Full copy</Button><Button size="small" onClick={() => downloadOtaSlot(backup, 0)} disabled={!!work}>Slot 0</Button><Button size="small" onClick={() => downloadOtaSlot(backup, 1)} disabled={!!work}>Slot 1</Button></span></div></div>}
        <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={(!backup && !skipBackup) || !!work}>{backup ? "I have saved the recovery copy." : "I understand I won't have a recovery copy if this installation fails."}</Checkbox>
        <FlashPowerCheck chargerConfirmed={chargingConfirmed} onChargerChange={setChargingConfirmed} disabled={(!backup && !skipBackup) || !!work} />
        {finished && <p className="flash-detail">Done. You can now return to <a href={routeUrl("/")} onClick={(event) => handleInternalLink(event, "/")}>Your Pills</a> and connect over BLE when the green light breathes.</p>}
        {cardFeedback("flash")}
        <div className="flash-navigation"><div className="flash-action-group">{!finished && <Button onClick={() => showStep(2)} disabled={!!work}>Back</Button>}</div>
          <div className="flash-action-group"><Button type="primary" onClick={() => void convertPill()} loading={work === "flash"} disabled={(!backup && !skipBackup) || !confirmed || !chargingConfirmed || !!work || finished}>Install OpenPill</Button></div></div>
      </Card>}
      {view === "restore" && <Card className="flash-card" title="Switch to the other firmware slot">
        <p>Inspect the two firmware slots on your Pill. Switching back changes only which slot starts next; it does not copy firmware or change settings.</p>
        {!bridgeReady && <p>Prepare and connect the ESP32 bridge in the conversion guide first.</p>}
        {pillSlots && <div className="slot-list"><strong>Pill {pillSlots.mac}</strong>{pillSlots.slots.map((slot) =>
          <div key={slot.slot}><span>Slot {slot.slot}{slot.active ? " · Running" : " · Other"}</span><strong>{slot.valid ? `${slot.name} ${slot.version}` : "No readable firmware"}</strong></div>)}</div>}
        {pillSlots && <FlashPowerCheck chargerConfirmed={switchChargingConfirmed} onChargerChange={setSwitchChargingConfirmed} disabled={!!work} />}
        {cardFeedback("inspect-slots")}{cardFeedback("switch-slot")}
        <div className="flash-navigation flash-navigation--end"><div className="flash-action-group"><Button onClick={() => void inspectSlots()} loading={work === "inspect-slots"} disabled={!bridgeReady || !!work}>Inspect Pill</Button>
          {pillSlots && <Popconfirm title="Switch firmware?" description={`Start ${pillSlots.slots[1 - pillSlots.activeSlot].name} ${pillSlots.slots[1 - pillSlots.activeSlot].version} on the next boot. The current firmware remains in its slot.`} okText="Switch firmware" cancelText="Cancel" onConfirm={() => void switchSlot()}>
            <Button type="primary" loading={work === "switch-slot"} disabled={!bridgeReady || !switchChargingConfirmed || !pillSlots.slots[1 - pillSlots.activeSlot].valid || !!work}>Switch to slot {1 - pillSlots.activeSlot}</Button></Popconfirm>}</div></div>
      </Card>}
      {view === "restore" && <Card className="flash-card" title="Restore from a recovery copy">
        <p>Choose a full recovery copy, then pick the saved firmware from slot 0 or 1. We’ll install it into the Pill’s inactive slot, leaving its current settings and other firmware slot alone. You can also restore the complete 4 MiB copy, including settings.</p>
        {!bridgeReady && <Alert type="info" showIcon message="Prepare the ESP32 board first" description={<Button type="link" onClick={() => { showStep(0); navigate("/flash"); }}>Go to step 1</Button>} />}
        <div className="saved-backups"><strong>Recovery copies saved in this browser</strong>
          {backups.length === 0 && <p>No recovery copies saved here yet. You can choose a downloaded copy instead.</p>}
          {backups.map((item) => <div key={item.id}><span>{item.mac} · {new Date(item.createdAt).toLocaleString()}</span>
            <Button size="small" onClick={() => selectRestoreSource(item)}>Select</Button></div>)}
        </div>
        <input ref={restoreFileInput} type="file" accept=".bin,application/octet-stream" hidden onChange={(event) => { chooseRestoreFile(event.target.files?.[0]); event.target.value = ""; }} />
        {restoreSource && <p className="flash-detail">Selected recovery copy for {restoreSource.mac} · {new Date(restoreSource.createdAt).toLocaleString()}</p>}
        {restoreSource && <Radio.Group className="restore-choices" value={restoreChoice} onChange={(event) => { setRestoreChoice(event.target.value as RestoreChoice); setRestoreConfirmed(false); }} disabled={!!work}>
          <Radio value="ota_0" disabled={!availableSlots?.[0]}>Firmware saved in slot 0 <span>Current settings stay on the Pill.</span></Radio>
          <Radio value="ota_1" disabled={!availableSlots?.[1]}>Firmware saved in slot 1 <span>Current settings stay on the Pill.</span></Radio>
          <Radio value="full">Entire backup <span>Replaces both firmware slots and all settings.</span></Radio>
        </Radio.Group>}
        {restoreSource && availableSlots && !availableSlots.every(Boolean) && <p className="flash-detail">A firmware slot without a readable image cannot be selected.</p>}
        {restoreChoice && <div className="flash-confirm"><Checkbox checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)} disabled={!!work}>{restoreChoice === "full" ? "I understand this will replace all firmware and settings on the Pill." : "I understand this will replace the Pill’s inactive firmware slot and select it for the next boot."}</Checkbox></div>}
        {restoreChoice && <FlashPowerCheck chargerConfirmed={restoreChargingConfirmed} onChargerChange={setRestoreChargingConfirmed} disabled={!!work} />}
        {cardFeedback("restore")}
        <div className="flash-navigation"><div className="flash-action-group"><Button onClick={() => restoreFileInput.current?.click()} disabled={!!work}>Choose downloaded recovery file</Button></div>
          <div className="flash-action-group"><Button type="primary" danger={restoreChoice === "full"} onClick={() => void restoreBackup()} loading={work === "restore"} disabled={!bridgeReady || !restoreSource || !restoreChoice || !restoreConfirmed || !restoreChargingConfirmed || !!work}>Restore this Pill</Button></div></div>
      </Card>}
      <p className="flash-footer">For more detail, see the <a href="https://github.com/keredson/openpill/blob/main/docs/initial-conversion.md" target="_blank" rel="noopener noreferrer">initial conversion guide</a>. Prefer command-line recovery? See the <a href="https://github.com/keredson/openpill/blob/main/docs/recovery.md" target="_blank" rel="noopener noreferrer">recovery guide</a>. Browser flashing uses <a href="https://github.com/espressif/esptool-js" target="_blank" rel="noopener noreferrer">Espressif’s esptool-js</a>.</p>
    </main>
  </ConfigProvider>;
}
