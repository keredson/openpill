import { Input, Select } from "antd";
import { CAP_COLORS, type CapColor } from "./savedPills";

export default function PillAppearanceFields({ customName, capColor, onNameChange, onCapColorChange }: {
  customName: string;
  capColor?: CapColor;
  onNameChange: (value: string) => void;
  onCapColorChange: (value: CapColor | undefined) => void;
}) {
  return <div className="pill-appearance-fields">
    <label className="settings-detail-row"><span><strong>Name</strong><small>Leave blank to use the Pill's default name</small></span>
      <Input aria-label="Pill name" maxLength={64} value={customName} onChange={(event) => onNameChange(event.target.value)} placeholder="Default name" /></label>
    <label className="settings-detail-row"><span><strong>Cap color</strong></span>
      <Select aria-label="Pill cap color" value={capColor ?? "none"} onChange={(value) => onCapColorChange(value === "none" ? undefined : value as CapColor)}
        options={[{ value: "none", label: "Not set" }, ...CAP_COLORS.map((color) => ({ value: color.value, label: color.label }))]} /></label>
  </div>;
}
