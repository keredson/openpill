import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Popconfirm } from "antd";
import type { HistoricalReading } from "./history";
import { firmwareCurve, interpolatedAngle, type CalibrationProfile } from "./physicsCalibration";
import { loadProfiles, resolvePendingProfiles, storeProfiles, syncProfiles, type SavedProfiles } from "./calibrationProfiles";

function localDateTime(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function newProfile(startsAt: number, massG: number | null): CalibrationProfile {
  return {
    id: Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")).join(""),
    startsAt, massG, points: []
  };
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
  const [profiles, setProfiles] = useState<CalibrationProfile[]>(() => loadProfiles(storageId).document.profiles);
  const [mass, setMass] = useState(() => loadProfiles(storageId).document.profiles.at(-1)?.massG?.toString() ?? "");
  const [time, setTime] = useState(() => localDateTime(Date.now()));
  const [gravity, setGravity] = useState("");
  const [tilt, setTilt] = useState("");
  const [message, setMessage] = useState("");
  const edited = useRef(false);
  const canEdit = !historyId || !!controlKey;
  const active = profiles.at(-1);

  function showProfiles(next: CalibrationProfile[]) {
    setProfiles(next);
    setMass(next.at(-1)?.massG?.toString() ?? "");
  }

  useEffect(() => {
    if (!open) return;
    edited.current = false;
    setMessage("");
    const local = loadProfiles(storageId);
    showProfiles(local.document.profiles);
    if (!historyId || !readKey) return;
    void syncProfiles(historyId, readKey, controlKey).then((next) => {
      if (!edited.current) showProfiles(next.document.profiles);
      onChange();
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not sync calibration."));
  }, [open, storageId, historyId, readKey, controlKey, onChange]);

  useEffect(() => {
    if (!open || !canEdit || !resolvePendingProfiles(storageId, readings)) return;
    const next = loadProfiles(storageId);
    if (!edited.current) showProfiles(next.document.profiles);
    onChange();
    if (historyId && readKey) void syncProfiles(historyId, readKey, controlKey).catch(() => {});
  }, [open, canEdit, storageId, readings, historyId, readKey, controlKey, onChange]);

  function updateActive(profile: CalibrationProfile) {
    if (!canEdit) return;
    edited.current = true;
    setProfiles((current) => [...current.slice(0, -1), profile]);
    setMessage("");
  }

  function addPoint() {
    if (!canEdit) return;
    let at = Date.parse(time);
    const sg = Number(gravity);
    const enteredTilt = tilt.trim() ? Number(tilt) : null;
    if (!Number.isSafeInteger(at) || !gravity.trim() || !Number.isFinite(sg) || sg < 0.7 || sg > 1.6) {
      setMessage("Enter a measurement time and a specific gravity from 0.700 to 1.600."); return;
    }
    if (enteredTilt != null && (!Number.isFinite(enteredTilt) || enteredTilt < 0 || enteredTilt > 90)) {
      setMessage("Enter a tilt from 0° to 90°, or leave it blank to use Pill readings."); return;
    }
    if (active && at < active.startsAt && active.startsAt - at < 60_000) at = active.startsAt;
    if (active && at < active.startsAt) {
      setMessage("The measurement must be after the current calibration began."); return;
    }
    if (active?.points.some((point) => point.at === at)) {
      setMessage("There is already a reference at that time."); return;
    }
    if ((active?.points.length ?? 0) >= 16) {
      setMessage("A calibration can hold up to 16 reference points."); return;
    }
    const profile = active ?? newProfile(at, null);
    const angle = enteredTilt ?? interpolatedAngle(readings, at);
    const next = { ...profile, points: [...profile.points, { at, sg, angle }].sort((a, b) => a.at - b.at) };
    edited.current = true;
    setProfiles(active ? [...profiles.slice(0, -1), next] : [...profiles, next]);
    setGravity("");
    setTilt("");
    setMessage(angle == null ? "Reference added. Tilt will fill in when nearby Pill readings arrive." : "");
  }

  function resetCalibration() {
    if (!canEdit) return;
    edited.current = true;
    const massG = mass.trim() && Number.isFinite(Number(mass)) ? Number(mass) : null;
    const previous = loadProfiles(storageId).document.profiles;
    const startsAt = Math.max(Date.now(), (previous.at(-1)?.startsAt ?? 0) + 1);
    setProfiles([...previous.slice(-15), newProfile(startsAt, massG)]);
    setGravity("");
    setTilt("");
    setTime(localDateTime(startsAt));
    setMessage("");
  }

  function save() {
    if (!canEdit) return;
    const massG = mass.trim() ? Number(mass) : null;
    if (massG != null && (!Number.isFinite(massG) || massG < 50 || massG > 180)) {
      setMessage("Enter a dry assembled mass from 50 to 180 g."); return;
    }
    const current = active ?? newProfile(Date.now(), massG);
    const { curve: _oldCurve, ...withoutCurve } = current;
    const last: CalibrationProfile = { ...withoutCurve, massG };
    const nextProfiles = active ? [...profiles.slice(0, -1), last] : [...profiles, last];
    last.curve = firmwareCurve(last);
    const previous = loadProfiles(storageId);
    const next: SavedProfiles = { ...previous, dirty: true, document: { version: 1, profiles: nextProfiles } };
    storeProfiles(storageId, next);
    showProfiles(nextProfiles);
    edited.current = false;
    onChange();
    setMessage("Calibration saved.");
    if (historyId && readKey) void syncProfiles(historyId, readKey, controlKey).then((result) => {
      if (!edited.current) showProfiles(result.document.profiles);
      setMessage(result.dirty ? "Calibration saved. Server sync is pending." : "Calibration saved and synced.");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not sync calibration."));
  }

  return <Modal open={open} title={`Calibration · ${name}`} onCancel={onClose}
    footer={<>{canEdit && <Popconfirm title="Reset calibration?" description="This clears the current reference points. Save to apply."
      onConfirm={resetCalibration}><Button danger>Reset calibration</Button></Popconfirm>}
      <Button type="primary" disabled={!canEdit} onClick={save}>Save</Button></>}
    width={680} destroyOnHidden className="calibration-modal">
    {historyId && !canEdit && <Alert type="info" showIcon message="This phone has the read key only. Import the control key to edit calibration." />}
    {message && <Alert type="info" showIcon message={message} style={{ marginBottom: 12 }} />}
    <label>Dry mass (g)<Input type="number" min={50} max={180} step="0.1" value={mass}
      disabled={!canEdit} onChange={(event) => { edited.current = true; setMass(event.target.value); }} placeholder="Optional" /></label>
    <div className="calibration-table-wrap">
      <table className="calibration-table">
        <thead><tr><th>Measured at</th><th>Gravity (SG)</th><th>Tilt</th><th /></tr></thead>
        <tbody>
          {active?.points.map((point) => <tr key={point.at}>
            <td>{new Date(point.at).toLocaleString()}</td>
            <td>{point.sg.toFixed(3)}</td>
            <td>{point.angle == null ? "Waiting for readings" : `${point.angle.toFixed(2)}°`}</td>
            <td>{canEdit && <Button size="small" danger onClick={() => updateActive({ ...active,
              points: active.points.filter((old) => old.at !== point.at) })}>Remove</Button>}</td>
          </tr>)}
          {!active?.points.length && <tr><td colSpan={4} className="calibration-empty">No reference points yet.</td></tr>}
        </tbody>
      </table>
    </div>
    {canEdit && <div className="calibration-add">
      <label>Measured at<Input type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} /></label>
      <label>Gravity (SG)<Input type="number" min={0.7} max={1.6} step="0.001" value={gravity} onChange={(event) => setGravity(event.target.value)} placeholder="1.050" /></label>
      <label>Tilt (°)<Input type="number" min={0} max={90} step="0.01" value={tilt} onChange={(event) => setTilt(event.target.value)} placeholder="From Pill" /></label>
      <Button onClick={addPoint}>Add reference</Button>
    </div>}
  </Modal>;
}
