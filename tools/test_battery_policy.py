import unittest
import struct
from unittest.mock import patch

import ble_ota
import serial_flash


class BatteryPolicyTests(unittest.TestCase):
    def test_hardware_sample_v2_includes_gravity(self):
        raw = struct.pack("<BBBBhhhhhHf", 2, 15, 1, 0, 1000, 0, 0, 2675, -127, 4189, 1.042)
        sample = ble_ota.parse_hardware_sample(raw)
        self.assertAlmostEqual(sample.gravity, 1.042, places=3)

    def test_hardware_sample_v2_accepts_earlier_scaled_gravity(self):
        raw = struct.pack("<BBBBhhhhhHf", 2, 15, 1, 0, 1000, 0, 0, 2675, -127, 4189, 1042.0)
        self.assertAlmostEqual(ble_ota.parse_hardware_sample(raw).gravity, 1.042, places=3)

    def test_hardware_sample_v2_rejects_upright_gravity(self):
        raw = struct.pack("<BBBBhhhhhHf", 2, 15, 1, 0, 1000, 0, 0, 2675, -127, 4189, -0.008)
        self.assertIsNone(ble_ota.parse_hardware_sample(raw).gravity)

    def test_hardware_sample_v1_remains_readable(self):
        raw = struct.pack("<BBBBhhhhhH", 1, 15, 1, 0, 1000, 0, 0, 2675, -127, 4189)
        sample = ble_ota.parse_hardware_sample(raw)
        self.assertIsNone(sample.gravity)

    def test_voltage_curve_brackets_policy_thresholds(self):
        self.assertLess(ble_ota.battery_percent_from_mv(3000), 10)
        self.assertGreater(ble_ota.battery_percent_from_mv(3200), 10)
        self.assertLess(ble_ota.battery_percent_from_mv(3400), 30)
        self.assertGreater(ble_ota.battery_percent_from_mv(3600), 30)

    def test_bridge_requires_charger_confirmation(self):
        with patch("builtins.input", side_effect=["n"]):
            self.assertFalse(serial_flash.confirm_flash_power())
        with patch("builtins.input", side_effect=[""]):
            self.assertTrue(serial_flash.confirm_flash_power())

    def test_bridge_reprompts_invalid_answer(self):
        with patch("builtins.input", side_effect=["maybe", "y"]):
            self.assertTrue(serial_flash.confirm_flash_power())


if __name__ == "__main__":
    unittest.main()
