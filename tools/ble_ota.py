#!/usr/bin/env python3
"""Upload an ESP32 application image to OpenPill over BLE on Linux/BlueZ."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError) as exc:  # pragma: no cover - host dependency
    raise SystemExit(
        "python3-gi is required (Ubuntu/Debian: sudo apt install python3-gi)"
    ) from exc

BLUEZ = "org.bluez"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
CHAR_IFACE = "org.bluez.GattCharacteristic1"

SERVICE_UUID = "369af8ff-2190-465f-b538-6df2fba7fcdc"
CONTROL_UUID = "84ef205e-52cc-4331-84a2-18cbaf9e0e56"
DATA_UUID = "1b3d644f-58b8-47f7-ba13-3e0878893b25"
STATUS_UUID = "1b23db1d-f22f-456d-82a4-0a35710139c1"
HARDWARE_SERVICE_UUID = "3cf82945-e436-4a1a-badc-bf55bcbffc59"
HARDWARE_SAMPLE_UUID = "dfaba240-7af2-4e73-ae91-1925685accd5"
CONFIG_INFO_UUID = "8f5f0001-bfc1-4d83-bf4b-28f27e63c700"

PROTOCOL_VERSION = 1
CONTROL_BEGIN = 0x01
CONTROL_COMMIT = 0x02
CONTROL_ABORT = 0x03
APP_DESC_MAGIC = 0xABCD5432
APP_ELF_SHA256_OFFSET = 0xB0
OTA_SLOT_SIZE = 0x180000
MAX_DATA_VALUE = 517
FLOW_WINDOW = 4096
CHARGER_THRESHOLD_PERCENT = 30.0
STOP_THRESHOLD_PERCENT = 10.0

BATTERY_CHARGE = (
    1, .9953, .9828, .9561, .9326, .9107, .8793, .8542, .8292, .7853,
    .7398, .6897, .6113, .5219, .4530, .4216, .3903, .3511, .3229,
    .2962, .2696, .2398, .2085, .1693, .1458, .1144, .0862, .0643,
    .0455, .0298, .0204, .0110, 0,
)
BATTERY_VOLTAGE = (
    4.1944, 4.1441, 4.1089, 4.0737, 4.0536, 4.0436, 4.0335, 4.0184,
    3.9933, 3.9430, 3.8927, 3.8425, 3.7721, 3.6816, 3.6162, 3.5911,
    3.5609, 3.5156, 3.4804, 3.4654, 3.4352, 3.3799, 3.3095, 3.2240,
    3.1687, 3.1134, 3.0480, 2.9726, 2.8872, 2.8067, 2.7363, 2.6358,
    2.5050,
)


def battery_percent_from_mv(millivolts: int) -> float:
    volts = millivolts / 1000
    if volts >= BATTERY_VOLTAGE[0]:
        return 100.0
    for index in range(1, len(BATTERY_VOLTAGE)):
        if volts >= BATTERY_VOLTAGE[index]:
            fraction = ((volts - BATTERY_VOLTAGE[index]) /
                        (BATTERY_VOLTAGE[index - 1] - BATTERY_VOLTAGE[index]))
            return 100 * (BATTERY_CHARGE[index] + fraction *
                          (BATTERY_CHARGE[index - 1] - BATTERY_CHARGE[index]))
    return 0.0

STATE_NAMES = {0: "idle", 1: "receiving", 2: "verifying", 3: "ready", 4: "error"}
ERROR_NAMES = {
    0: "none",
    1: "bad command",
    2: "bad image size",
    3: "no OTA partition",
    4: "OTA begin failed",
    5: "wrong protocol state",
    6: "unexpected image offset",
    7: "flash write failed",
    8: "incomplete image",
    9: "SHA-256 mismatch",
    10: "invalid ESP32 application image",
    11: "boot partition selection failed",
    12: "client disconnected",
    13: "charger required for OTA",
    14: "battery reading unavailable or invalid",
    15: "battery below 10%; charge before flashing",
}


class OtaError(RuntimeError):
    pass


@dataclass(frozen=True)
class Device:
    path: str
    address: str
    name: str
    rssi: int | None


@dataclass(frozen=True)
class Status:
    version: int
    state: int
    error: int
    accepted: int
    expected: int
    slot: int | None

    @property
    def state_name(self) -> str:
        return STATE_NAMES.get(self.state, f"unknown({self.state})")

    @property
    def error_name(self) -> str:
        return ERROR_NAMES.get(self.error, f"unknown({self.error})")

    @property
    def slot_name(self) -> str | None:
        return f"ota_{self.slot}" if self.slot is not None else None


@dataclass(frozen=True)
class HardwareSample:
    valid: int
    charger_connected: bool
    led_brightness: int
    accel_mg: tuple[int, int, int]
    temperature_c: float
    battery_adc_raw: int
    battery_mv: int
    gravity: float | None = None


def parse_hardware_sample(value: bytes | bytearray | list[int]) -> HardwareSample:
    raw = bytes(value)
    if len(raw) not in (16, 20):
        raise OtaError(f"device returned a {len(raw)}-byte hardware sample, expected 16 or 20")
    version, valid, charger, led, x, y, z, temp, battery_raw, battery_mv = struct.unpack_from(
        "<BBBBhhhh hH".replace(" ", ""), raw
    )
    if version not in (1, 2) or (version == 1 and len(raw) != 16) or (version == 2 and len(raw) != 20):
        raise OtaError(f"unsupported hardware sample version {version}")
    gravity = struct.unpack_from("<f", raw, 16)[0] if version == 2 else float("nan")
    if gravity > 10:
        gravity /= 1000
    return HardwareSample(valid, bool(charger), led, (x, y, z), temp / 100, battery_raw,
                          battery_mv, gravity if math.isfinite(gravity) and 0.7 <= gravity <= 1.6 else None)


def _deep_unpack(value: Any) -> Any:
    if isinstance(value, GLib.Variant):
        return _deep_unpack(value.unpack())
    if isinstance(value, dict):
        return {key: _deep_unpack(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return tuple(_deep_unpack(item) for item in value)
    if isinstance(value, list):
        return [_deep_unpack(item) for item in value]
    return value


def parse_status(value: bytes | bytearray | list[int]) -> Status:
    raw = bytes(value)
    if len(raw) != 12:
        raise OtaError(f"device returned a {len(raw)}-byte status, expected 12")
    version, state, error, slot_code, accepted, expected = struct.unpack("<BBBBII", raw)
    if version != PROTOCOL_VERSION:
        raise OtaError(
            f"unsupported OTA protocol version {version}; client supports {PROTOCOL_VERSION}"
        )
    return Status(version, state, error, accepted, expected,
                  slot_code - 1 if 1 <= slot_code <= 16 else None)


def validate_image(path: Path) -> tuple[bytes, bytes]:
    try:
        image = path.read_bytes()
    except OSError as exc:
        raise OtaError(f"cannot read firmware image {path}: {exc}") from exc
    if len(image) < APP_ELF_SHA256_OFFSET + 32:
        raise OtaError("firmware image is too short to be an ESP32 application")
    if len(image) > OTA_SLOT_SIZE:
        raise OtaError(
            f"firmware image is {len(image)} bytes; OTA slot limit is {OTA_SLOT_SIZE}"
        )
    if image[0] != 0xE9:
        raise OtaError("firmware image has no ESP32 image header (magic 0xe9)")
    if not 1 <= image[1] <= 16:
        raise OtaError(f"invalid ESP32 segment count {image[1]}")
    if struct.unpack_from("<I", image, 32)[0] != APP_DESC_MAGIC:
        raise OtaError(
            "image has no ESP-IDF application descriptor; use firmware.bin, "
            "not a merged flash image"
        )
    return image, hashlib.sha256(image).digest()


class BluezClient:
    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        try:
            self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        except GLib.Error as exc:
            raise OtaError(f"cannot connect to the system D-Bus: {exc.message}") from exc
        self.manager = self._proxy("/", OBJECT_MANAGER)

    def _proxy(self, path: str, interface: str) -> Gio.DBusProxy:
        try:
            return Gio.DBusProxy.new_sync(
                self.bus, Gio.DBusProxyFlags.NONE, None, BLUEZ, path, interface, None
            )
        except GLib.Error as exc:
            raise OtaError(f"cannot access BlueZ {interface}: {exc.message}") from exc

    def _call(
        self,
        proxy: Gio.DBusProxy,
        method: str,
        parameters: GLib.Variant | None = None,
        timeout_ms: int = 10_000,
    ) -> Any:
        try:
            result = proxy.call_sync(
                method, parameters, Gio.DBusCallFlags.NONE, timeout_ms, None
            )
        except GLib.Error as exc:
            raise OtaError(f"BlueZ {method} failed: {exc.message}") from exc
        return None if result is None else _deep_unpack(result)

    def objects(self) -> dict[str, dict[str, dict[str, Any]]]:
        return self._call(self.manager, "GetManagedObjects")[0]

    def _adapter_path(self) -> str:
        paths = [path for path, ifaces in self.objects().items() if ADAPTER_IFACE in ifaces]
        if not paths:
            raise OtaError("BlueZ has no Bluetooth adapter")
        return sorted(paths)[0]

    def _matching_devices(self, selector: str | None) -> list[Device]:
        found: list[Device] = []
        wanted = selector.casefold() if selector else None
        for path, ifaces in self.objects().items():
            props = ifaces.get(DEVICE_IFACE)
            if props is None:
                continue
            name = str(props.get("Name") or props.get("Alias") or "")
            address = str(props.get("Address", ""))
            matches = (
                name.startswith(("OpenPill-", "RAPT-Pill-"))
                if wanted is None
                else wanted in {name.casefold(), address.casefold()}
            )
            if matches:
                rssi = props.get("RSSI")
                found.append(Device(path, address, name, int(rssi) if rssi is not None else None))
        return sorted(found, key=lambda item: item.rssi or -999, reverse=True)

    def scan(self, selector: str | None) -> list[Device]:
        adapter = self._proxy(self._adapter_path(), ADAPTER_IFACE)
        started = False
        matches: list[Device] = []
        settle_at: float | None = None
        try:
            try:
                self._call(adapter, "StartDiscovery")
                started = True
            except OtaError as exc:
                if "InProgress" not in str(exc):
                    raise
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                matches = self._matching_devices(selector)
                now = time.monotonic()
                if matches and settle_at is None:
                    settle_at = min(deadline, now + (0.5 if selector else 2.0))
                if settle_at is not None and now >= settle_at:
                    break
                time.sleep(0.25)
        finally:
            if started:
                try:
                    self._call(adapter, "StopDiscovery")
                except OtaError:
                    pass
        if not matches:
            raise OtaError(
                f"did not find {selector or 'an OpenPill-* or RAPT-Pill-* advertiser'!r} "
                f"within {self.timeout:g} seconds"
            )
        return matches

    def discover(self, selector: str | None) -> Device:
        matches = self.scan(selector)
        return matches[0] if selector else choose_device(matches)

    def connect(self, device: Device) -> Gio.DBusProxy:
        proxy = self._proxy(device.path, DEVICE_IFACE)
        props = self.objects().get(device.path, {}).get(DEVICE_IFACE, {})
        if not props.get("Connected", False):
            self._call(proxy, "Connect", timeout_ms=20_000)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            props = self.objects().get(device.path, {}).get(DEVICE_IFACE, {})
            if props.get("ServicesResolved", False):
                # The Pill intentionally does not retain BLE bonds. BlueZ may
                # resolve cached services without starting security for an
                # encrypted characteristic read, leaving ReadValue pending
                # until its D-Bus timeout. Pair explicitly on each new link.
                if not props.get("Paired", False):
                    print("Establishing encrypted Bluetooth session...")
                    self._call(proxy, "Pair", timeout_ms=30_000)
                return proxy
            time.sleep(0.1)
        raise OtaError("connected, but BlueZ did not resolve GATT services")

    def disconnect(self, proxy: Gio.DBusProxy) -> None:
        try:
            self._call(proxy, "Disconnect", timeout_ms=5_000)
        except OtaError:
            pass

    def characteristics(
        self, device: Device
    ) -> dict[str, tuple[Gio.DBusProxy, dict[str, Any]]]:
        found: dict[str, tuple[Gio.DBusProxy, dict[str, Any]]] = {}
        required = {CONTROL_UUID, DATA_UUID, STATUS_UUID}
        wanted = required | {HARDWARE_SAMPLE_UUID, CONFIG_INFO_UUID}
        for path, ifaces in self.objects().items():
            props = ifaces.get(CHAR_IFACE)
            if props is None or not path.startswith(device.path + "/"):
                continue
            uuid = str(props.get("UUID", "")).lower()
            if uuid in wanted:
                found[uuid] = (self._proxy(path, CHAR_IFACE), props)
        missing = required - found.keys()
        if missing:
            raise OtaError("OTA service is missing " + ", ".join(sorted(missing)))
        return found

    def read_value(self, proxy: Gio.DBusProxy) -> bytes:
        result = self._call(proxy, "ReadValue", GLib.Variant("(a{sv})", ({},)))
        return bytes(result[0])

    def wait_for_gatt(self, proxy: Gio.DBusProxy) -> None:
        """Let BlueZ finish link pairing before the first application read."""
        deadline = time.monotonic() + 20
        while True:
            try:
                self.read_value(proxy)
                return
            except OtaError as exc:
                if not any(marker in str(exc) for marker in
                           ("InProgress", "already in progress", "NotPermitted", "NotAuthorized")):
                    raise
                if time.monotonic() >= deadline:
                    raise OtaError("could not establish an encrypted Bluetooth connection; reconnect the Pill and try again") from exc
                time.sleep(0.3)

    def write_value(self, proxy: Gio.DBusProxy, value: bytes, *, response: bool) -> None:
        kind = "request" if response else "command"
        params = GLib.Variant(
            "(aya{sv})", (value, {"type": GLib.Variant("s", kind)})
        )
        self._call(proxy, "WriteValue", params, timeout_ms=20_000)


def print_device(device: Device) -> None:
    suffix = f", RSSI {device.rssi} dBm" if device.rssi is not None else ""
    print(f"Device: {device.name} ({device.address}{suffix})")


def choose_device(devices: list[Device]) -> Device:
    print("Pills found:")
    for index, device in enumerate(devices, 1):
        signal = f", RSSI {device.rssi} dBm" if device.rssi is not None else ""
        print(f"  {index}. {device.name} ({device.address}{signal})")
    if not sys.stdin.isatty():
        raise OtaError("device selection requires a terminal; use --device for scripts")
    while True:
        choice = input(f"Select a Pill [1-{len(devices)}] (Enter to cancel): ").strip()
        if not choice:
            raise OtaError("selection cancelled")
        if choice.isdecimal() and 1 <= int(choice) <= len(devices):
            return devices[int(choice) - 1]
        print("Enter a number from the list.")


def read_status(client: BluezClient, proxy: Gio.DBusProxy) -> Status:
    status = parse_status(client.read_value(proxy))
    if status.state == 4 or status.error:
        raise OtaError(
            f"device reported {status.state_name}: {status.error_name} "
            f"at {status.accepted}/{status.expected} bytes"
        )
    return status


def command_probe(args: argparse.Namespace) -> None:
    client = BluezClient(args.scan_timeout)
    device = client.discover(args.device)
    print_device(device)
    connection = client.connect(device)
    try:
        chars = client.characteristics(device)
        client.wait_for_gatt(chars[STATUS_UUID][0])
        status = read_status(client, chars[STATUS_UUID][0])
        print(
            f"OTA protocol {status.version}: {status.state_name}, "
            f"accepted {status.accepted}/{status.expected} bytes"
        )
        if status.slot_name is not None:
            print(f"Target slot: {status.slot_name}")
        if CONFIG_INFO_UUID in chars:
            try:
                info = json.loads(client.read_value(chars[CONFIG_INFO_UUID][0]))
                if info.get("firmware_version"):
                    print(f"Firmware: {info['firmware_version']}")
                if info.get("running_slot"):
                    print(f"Running slot: {info['running_slot']}")
                if info.get("firmware_elf_sha256"):
                    print(f"Firmware ELF SHA256: {info['firmware_elf_sha256']}")
            except (OtaError, ValueError, UnicodeDecodeError):
                pass
        print(f"Service: {SERVICE_UUID}")
        if HARDWARE_SAMPLE_UUID in chars:
            print_hardware(parse_hardware_sample(
                client.read_value(chars[HARDWARE_SAMPLE_UUID][0])))
    finally:
        client.disconnect(connection)


def print_hardware(sample: HardwareSample) -> None:
    def value(bit: int, rendered: str) -> str:
        return rendered if sample.valid & bit else "unavailable"

    print(f"Accelerometer: {value(1, '%d, %d, %d mg' % sample.accel_mg)}")
    print(f"Temperature:   {value(2, f'{sample.temperature_c:.2f} C')}")
    print(f"Gravity:       {sample.gravity:.3f} SG" if sample.gravity is not None else "Gravity:       unavailable")
    print(f"Battery:      {value(4, f'{battery_percent_from_mv(sample.battery_mv):.0f}% ({sample.battery_mv} mV; ADC2 raw {sample.battery_adc_raw})')}")
    print(f"Charger:      {value(8, 'connected' if sample.charger_connected else 'disconnected')}")
    print(f"Status LED:   {sample.led_brightness}/255")


def command_read(args: argparse.Namespace) -> None:
    client = BluezClient(args.scan_timeout)
    device = client.discover(args.device)
    print_device(device)
    connection = client.connect(device)
    try:
        chars = client.characteristics(device)
        client.wait_for_gatt(chars[STATUS_UUID][0])
        if HARDWARE_SAMPLE_UUID not in chars:
            raise OtaError("device does not expose the hardware service")
        print_hardware(parse_hardware_sample(
            client.read_value(chars[HARDWARE_SAMPLE_UUID][0])))
    finally:
        client.disconnect(connection)


def confirm_upload(device: Device) -> None:
    if not sys.stdin.isatty():
        raise OtaError("refusing an unattended upload without --yes")
    if input(f"Upload to {device.name} ({device.address})? [y/N]: ").strip().casefold() != "y":
        raise OtaError("upload cancelled")


def command_upload(args: argparse.Namespace) -> None:
    image_path = Path(args.image)
    image, digest = validate_image(image_path)
    print(f"Image:  {image_path} ({len(image)} bytes)")
    print(f"SHA256: {digest.hex()}")
    print(f"ELF SHA256: {image[APP_ELF_SHA256_OFFSET:APP_ELF_SHA256_OFFSET + 32].hex()}")
    print("The updater will replace the selected Pill's inactive OTA slot. BLE link encryption does not authenticate the Pill or updater.")
    client = BluezClient(args.scan_timeout)
    device = client.discover(args.device)
    print_device(device)
    if args.device is not None and not args.yes:
        confirm_upload(device)

    connection = client.connect(device)
    begun = False
    committed = False
    commit_attempted = False
    control = None
    try:
        chars = client.characteristics(device)
        client.wait_for_gatt(chars[STATUS_UUID][0])
        control = chars[CONTROL_UUID][0]
        data, data_props = chars[DATA_UUID]
        status_proxy = chars[STATUS_UUID][0]
        if "write-without-response" not in set(data_props.get("Flags", [])):
            raise OtaError("firmware data characteristic has no write-command support")
        if HARDWARE_SAMPLE_UUID not in chars:
            raise OtaError("cannot read battery level; firmware upload is blocked")
        power_sample = parse_hardware_sample(
            client.read_value(chars[HARDWARE_SAMPLE_UUID][0])
        )
        if not power_sample.valid & 0x04 or not power_sample.valid & 0x08 or power_sample.battery_mv > 4300:
            raise OtaError("cannot verify battery level; firmware upload is blocked")
        battery_percent = battery_percent_from_mv(power_sample.battery_mv)
        print(f"Battery: {battery_percent:.0f}% ({power_sample.battery_mv} mV); charger {'connected' if power_sample.charger_connected else 'disconnected'}")
        if battery_percent < STOP_THRESHOLD_PERCENT:
            raise OtaError("battery below 10%; charge it before uploading firmware")
        if battery_percent < CHARGER_THRESHOLD_PERCENT and not power_sample.charger_connected:
            raise OtaError("battery below 30%; connect the charger before uploading firmware")

        mtu = int(data_props.get("MTU", 23))
        safe_payload = min(MAX_DATA_VALUE - 4, max(1, mtu - 7))
        chunk_size = args.chunk_size or safe_payload
        if chunk_size > safe_payload:
            raise OtaError(
                f"--chunk-size {chunk_size} exceeds safe payload {safe_payload} (MTU {mtu})"
            )

        begin = bytes([CONTROL_BEGIN]) + struct.pack("<I", len(image)) + digest
        try:
            client.write_value(control, begin, response=True)
        except OtaError as write_error:
            try:
                rejected = read_status(client, status_proxy)
            except OtaError as status_error:
                raise OtaError(
                    f"OTA Begin was rejected before any image bytes were sent: {write_error}; "
                    f"status read also failed: {status_error}"
                ) from write_error
            if rejected.error == 13 and not power_sample.charger_connected:
                raise OtaError(
                    "the Pill's installed firmware requires its charger for this OTA update. "
                    "Put it on the charger and retry; no image bytes were sent"
                ) from write_error
            raise OtaError(
                f"OTA Begin was rejected: {rejected.error_name} "
                f"(state {rejected.state_name}, {rejected.accepted}/{rejected.expected} bytes); "
                "no image bytes were sent"
            ) from write_error
        begun = True
        status = read_status(client, status_proxy)
        if status.state != 1 or status.accepted != 0 or status.expected != len(image):
            raise OtaError(
                f"device did not begin transfer: {status.state_name}, "
                f"{status.accepted}/{status.expected} bytes"
            )
        if status.slot_name is not None:
            print(f"Target slot: {status.slot_name}")

        started = time.monotonic()
        next_checkpoint = FLOW_WINDOW
        offset = 0
        while offset < len(image):
            payload = image[offset : offset + chunk_size]
            client.write_value(data, struct.pack("<I", offset) + payload, response=False)
            offset += len(payload)
            if offset >= next_checkpoint or offset == len(image):
                deadline = time.monotonic() + 10.0
                while True:
                    status = read_status(client, status_proxy)
                    if status.accepted >= offset:
                        break
                    if time.monotonic() >= deadline:
                        raise OtaError(
                            f"timed out waiting for device at {status.accepted}/{offset} bytes"
                        )
                    time.sleep(0.05)
                elapsed = max(time.monotonic() - started, 0.001)
                print(
                    f"\rUploading: {offset * 100 / len(image):6.2f}%  "
                    f"{offset}/{len(image)} bytes  {offset / elapsed / 1024:6.1f} KiB/s",
                    end="",
                    flush=True,
                )
                next_checkpoint = offset + FLOW_WINDOW

        print()
        commit_attempted = True
        try:
            client.write_value(control, bytes([CONTROL_COMMIT]), response=True)
        except OtaError as write_error:
            try:
                failed = parse_status(client.read_value(status_proxy))
            except OtaError as status_error:
                raise OtaError(
                    f"Commit response failed: {write_error}; status read also failed: "
                    f"{status_error}. The device may have rebooted successfully. "
                    "Reconnect and run make probe before retrying"
                ) from write_error
            if failed.state == 4 or failed.error:
                raise OtaError(
                    f"device rejected commit: {failed.error_name} "
                    f"at {failed.accepted}/{failed.expected} bytes"
                ) from write_error
            raise OtaError(
                f"{write_error}; device status is {failed.state_name} "
                f"at {failed.accepted}/{failed.expected} bytes. "
                "Run make probe before retrying"
            ) from write_error
        committed = True
        status = read_status(client, status_proxy)
        if status.state != 3:
            raise OtaError(f"commit returned unexpected state {status.state_name}")
        print("Upload verified; inactive slot selected. Device is restarting.")
    except BaseException:
        if begun and not committed and not commit_attempted and control is not None:
            try:
                client.write_value(control, bytes([CONTROL_ABORT]), response=True)
            except OtaError:
                pass
        raise
    finally:
        client.disconnect(connection)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe or update an OpenPill through its BLE OTA service"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def add_connection_options(command: argparse.ArgumentParser) -> None:
        command.add_argument("--device", metavar="NAME_OR_MAC")
        command.add_argument("--scan-timeout", type=float, default=30.0, metavar="SECONDS")

    probe = commands.add_parser("probe", help="discover a device and read OTA status")
    add_connection_options(probe)
    probe.set_defaults(func=command_probe)

    read = commands.add_parser("read", help="read accelerometer, temperature, and battery")
    add_connection_options(read)
    read.set_defaults(func=command_read)

    upload = commands.add_parser("upload", help="upload an ESP32 application image")
    upload.add_argument("image", help="ESP32 application firmware.bin")
    add_connection_options(upload)
    upload.add_argument("--chunk-size", type=int, metavar="BYTES")
    upload.add_argument("--yes", action="store_true", help="skip confirmation when --device is given")
    upload.set_defaults(func=command_upload)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.scan_timeout <= 0:
        parser.error("--scan-timeout must be positive")
    if getattr(args, "chunk_size", None) is not None and not 1 <= args.chunk_size <= 513:
        parser.error("--chunk-size must be between 1 and 513")
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\nInterrupted; transfer aborted.", file=sys.stderr)
        return 130
    except OtaError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
