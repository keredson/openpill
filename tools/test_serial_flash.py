import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import serial_flash


class SerialReadTests(unittest.TestCase):
    def test_failed_read_reenters_bootloader_and_retries_same_pill(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "read.bin"
            calls = 0

            def fake_esptool(_port, *_args):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("serial connection stopped")
                path.write_bytes(b"abcd")

            with patch.object(serial_flash, "esptool", side_effect=fake_esptool), \
                 patch.object(serial_flash, "prepare", return_value="aabbcc") as prepare:
                self.assertEqual(serial_flash.read_flash("port", 0x1000, 4, path, "aabbcc"), b"abcd")
            self.assertEqual(calls, 2)
            prepare.assert_called_once_with("port")

    def test_changed_pill_stops_before_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "read.bin"
            with patch.object(serial_flash, "esptool", side_effect=RuntimeError("serial connection stopped")) as esptool, \
                 patch.object(serial_flash, "prepare", return_value="different"):
                with self.assertRaisesRegex(RuntimeError, "identity changed"):
                    serial_flash.read_flash("port", 0x1000, 4, path, "aabbcc")
            esptool.assert_called_once()

    def test_second_failed_read_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "read.bin"
            with patch.object(serial_flash, "esptool", side_effect=RuntimeError("serial connection stopped")) as esptool, \
                 patch.object(serial_flash, "prepare", return_value="aabbcc"):
                with self.assertRaisesRegex(RuntimeError, "failed twice"):
                    serial_flash.read_flash("port", 0x1000, 4, path, "aabbcc")
            self.assertEqual(esptool.call_count, 2)


if __name__ == "__main__":
    unittest.main()
