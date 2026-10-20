import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Popconfirm } from "antd";
import type { HistoricalReading } from "./history";
import { fitPhysicalProfile, firmwareCurve, gravityFromAngle, interpolatedAngle, type CalibrationProfile } from "./physicsCalibration";
import { loadProfiles, storeProfiles, syncProfiles, type SavedProfiles } from "./calibrationProfiles";

function localDateTime(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export default function CalibrationModal({ open, name, storageId, historyId, readKey, controlKey, readings, onClose, onChange }: {
  open: boolean;
  name: string;
  storageId: string;
  historyId?: string;
  readKey: string | null;
  controlKey: string | null;
  readings: HistoricalReading[];
  onClose: () => void;
  onChange: () => void;
}) {
  const [saved, setSaved] = useState<SavedProfiles>(() => loadProfiles(storageId));
  const [time, setTime] = useState(() => localDateTime(Date.now()));
  const [gravity, setGravity] = useState("");
  const [mass, setMass] = useState("");
  const [message, setMessage] = useState("");
  const canEdit = !historyId || !!controlKey;
  const active = saved.document.profiles.at(-1);
  const fit = useMemo(() => active ? fitPhysicalProfile(active) : null, [active]);

  useEffect(() => {
    if (!open) return;
    const local = loadProfiles(storageId);
    setSaved(local);
    if (!historyId || !readKey) return;
    void syncProfiles(historyId, readKey, controlKey).then((next) => {
      setSaved(next);
      onChange();
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not sync calibration."));
  }, [open, storageId, historyId, readKey, controlKey, onChange]);

  useEffect(() => {
    if (!open || !canEdit) return;
    const current = loadProfiles(storageId);
    let changed = false;
    const profiles = current.document.profiles.map((profile) => ({ ...profile, points: profile.points.map((point) => {
      if (point.angle != null) return point;
      const angle = interpolatedAngle(readings, point.at);
      if (angle == null) return point;
      changed = true;
      return { ...point, angle };
    }) }));
    if (!changed) return;
    const next = { ...current, dirty: true, document: { version: 1 as const, profiles } };
    storeProfiles(storageId, next);
    setSaved(next);
    onChange();
    if (historyId && readKey) void syncProfiles(historyId, readKey, controlKey).then(setSaved).catch(() => {});
  }, [open, canEdit, storageId, readings, historyId, readKey, controlKey, onChange]);

  function update(profile: CalibrationProfile) {
    const profiles = saved.document.profiles.map((old) => old.id === profile.id ? profile : old);
    persist(profiles);
  }

  function persist(profiles: CalibrationProfile[]) {
    profiles = profiles.map((profile, index) => {
      const { curve: _oldCurve, ...rest } = profile;
      return index === profiles.length - 1 ? { ...rest, curve: firmwareCurve(profile) } : rest;
    });
    const next: SavedProfiles = { ...saved, dirty: true, document: { version: 1, profiles } };
    storeProfiles(storageId, next);
    setSaved(next);
    onChange();
    setMessage(historyId ? "Saved on this phone; waiting for server sync." : "Saved on this phone.");
    if (historyId && readKey) void syncProfiles(historyId, readKey, controlKey).then((result) => {
      setSaved(result);
      setMessage(result.dirty ? "Saved on this phone. Connect the Pill to authorize control, then sync." : "Calibration saved to the server.");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not sync calibration."));
  }

  function startProfile() {
    if (!canEdit || saved.document.profiles.length >= 16) return;
    const startsAt = Date.parse(time);
    if (!Number.isSafeInteger(startsAt) || startsAt <= (active?.startsAt || 0)) {
      setMessage("Choose a start time after the previous calibration began."); return;
    }
    const massG = mass.trim() ? Number(mass) : active?.massG ?? null;
    if (massG != null && (massG < 50 || massG > 180)) {
      setMessage("Enter a dry assembled mass from 50 to 180 g."); return;
    }
    persist([...saved.document.profiles, { id: Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")).join(""), startsAt, massG, points: [] }]);
  }

  function addPoint() {
    if (!active || !canEdit) return;
    const at = Date.parse(time), sg = Number(gravity);
    if (!Number.isSafeInteger(at) || at < active.startsAt || !gravity.trim() || sg < 0.7 || sg > 1.6) {
      setMessage("Enter a reference time after this calibration began and an SG from 0.700 to 1.600."); return;
    }
    if (active.points.length >= 16) { setMessage("This calibration already has 16 points."); return; }
    const angle = interpolatedAngle(readings, at);
    update({ ...active, points: [...active.points, { at, sg, angle }].sort((a, b) => a.at - b.at) });
    setGravity("");
    if (angle == null) setMessage("Reference saved. Its tilt will resolve after nearby readings arrive.");
  }

  return <Modal open={open} title={`Calibration · ${name}`} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} width={600} destroyOnHidden className="calibration-modal">
    <p>Open or change the Pill? Start a new calibration at that time. Older history keeps its previous profile.</p>
    {historyId && !canEdit && <Alert type="info" showIcon message="This phone has the read key only. Import the control key to edit calibration." />}
    {message && <Alert type="info" showIcon message={message} style={{ marginBottom: 12 }} />}
    <label>Reference or new calibration time<Input type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} /></label>
    <label>Dry, fully assembled mass in grams (optional)<Input type="number" min={50} max={180} step="0.1" value={mass} onChange={(event) => setMass(event.target.value)} placeholder={active?.massG?.toString() || "Unknown"} /></label>
    <Button onClick={startProfile} disabled={!canEdit || saved.document.profiles.length >= 16}>Start new calibration</Button>
    {active && <section style={{ marginTop: 18 }}>
      <p><strong>Current profile</strong> · since {new Date(active.startsAt).toLocaleString()} · mass {active.massG == null ? "fitted from references" : `${active.massG} g`}</p>
      <Button size="small" disabled={!canEdit} onClick={() => {
        const entered = mass.trim() ? Number(mass) : null;
        if (entered != null && (entered < 50 || entered > 180)) {
          setMessage("Enter a dry assembled mass from 50 to 180 g."); return;
        }
        update({ ...active, massG: entered });
      }}>Set mass for this profile</Button>
      <label>Measured specific gravity<Input type="number" min={0.7} max={1.6} step="0.001" value={gravity} onChange={(event) => setGravity(event.target.value)} placeholder="1.050" /></label>
      <Button type="primary" onClick={addPoint} disabled={!canEdit}>Add reference point</Button>
      <div style={{ marginTop: 12 }}>
        {active.points.map((point, index) => <div key={`${point.at}-${index}`} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <span>{new Date(point.at).toLocaleString()} · SG {point.sg.toFixed(3)} · {point.angle == null ? "waiting for tilt" : `${point.angle.toFixed(2)}°`}</span>
          {canEdit && <Popconfirm title="Remove this reference point?" onConfirm={() => update({ ...active, points: active.points.filter((_, i) => i !== index) })}><Button size="small" danger>Remove</Button></Popconfirm>}
        </div>)}
      </div>
      {fit ? <p>Physical fit: {active.massG == null ? "effective fitted mass" : "measured mass"} {fit.massG.toFixed(1)} g, {fit.lengthMm.toFixed(1)} mm effective length, center of gravity ({fit.cgXmm.toFixed(1)}, {fit.cgZmm.toFixed(1)}) mm. Balance error {fit.rmseMm.toFixed(2)} mm. {active.points.filter((point) => point.angle != null).map((point) => {
        const predicted = gravityFromAngle(point.angle!, fit);
        return predicted == null ? "" : ` ${point.sg.toFixed(3)}→${predicted.toFixed(3)}`;
      }).join(" · ")}</p> : <p>Physical fit needs {active.massG == null ? "at least five" : "at least four"} resolved points spanning at least 8° of tilt.</p>}
    </section>}
    <p style={{ marginTop: 14, fontSize: 12 }}>The model balances displaced liquid weight and buoyancy torque for an approximate 37 mm housing with rounded ends. Measured mass lets it fit effective length; otherwise it uses the nominal 125 mm length and fits effective mass.</p>
  </Modal>;
}
