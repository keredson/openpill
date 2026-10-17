import { Checkbox } from "antd";

export default function FlashPowerCheck({ chargerConfirmed, onChargerChange, disabled }: {
  chargerConfirmed: boolean;
  onChargerChange: (confirmed: boolean) => void;
  disabled: boolean;
}) {
  return <div className="flash-power-check">
    <Checkbox checked={chargerConfirmed} onChange={(event) => onChargerChange(event.target.checked)} disabled={disabled}>My Pill is on its charger. I’ll leave it there until this finishes.</Checkbox>
  </div>;
}
