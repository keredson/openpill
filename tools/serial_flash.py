#!/usr/bin/env python3
"""Install an app through the OpenPill ESP32 UART bridge without erasing NVS."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib

import serial

FLASH_SIZE = 0x400000
SLOT_SIZE = 0x180000
OTA_ADDRESS = 0xD000
ROOT = Path(__file__).resolve().parent.parent
APP_SLOTS = (("ota_0", 0x10000), ("ota_1", 0x190000))


def esptool(port: str, *args: str, capture: bool = False, connect_attempts: int | None = None) -> str:
    command = ["esptool", "--chip", "esp32", "--port", port, "--baud", "115200",
               "--before", "no-reset", "--after", "no-reset"]
    if connect_attempts is not None:
        command.extend(("--connect-attempts", str(connect_attempts)))
    command.extend(args)
    result = subprocess.run(command, check=False, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None)
    if result.returncode:
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        raise RuntimeError(f"esptool {args[0]} failed (exit {result.returncode}). The installer stopped before the next step.")
    return result.stdout or ""


def bridge_command(port: str, command: str) -> str:
    with serial.Serial(port, 115200, timeout=0.3) as connection:
        connection.dtr = False
        connection.rts = False
        time.sleep(1.5)
        connection.reset_input_buffer()
        connection.write(f"+++OPENPILL_{command}\r".encode())
        connection.flush()
        response = bytearray()
        deadline = time.monotonic() + 4
        expected = b"OPENPILL-BRIDGE/1" if command == "PING" else f"OPENPILL-BRIDGE {command}".encode()
        while time.monotonic() < deadline and expected not in response:
            response.extend(connection.read(256))
        if expected not in response:
            raise RuntimeError(f"The ESP32 bridge did not answer {command}. Check its USB cable and firmware.")
        return response.decode(errors="replace")


def partitions(table: bytes) -> dict[str, tuple[int, int]]:
    found = {}
    for offset in range(0, len(table), 32):
        entry = table[offset:offset + 32]
        if entry[:2] != b"\xaa\x50":
            break
        name = entry[12:28].split(b"\0", 1)[0].decode("ascii")
        found[name] = (int.from_bytes(entry[4:8], "little"), int.from_bytes(entry[8:12], "little"))
    return found


def validate_layout(bootloader: bytes, table: bytes) -> None:
    if not bootloader or bootloader[0] != 0xE9:
        raise RuntimeError("The Pill has an invalid bootloader; no flash write was attempted.")
    expected = {"otadata": (0xD000, 0x2000), "ota_0": (0x10000, SLOT_SIZE),
                "ota_1": (0x190000, SLOT_SIZE), "nvs": (0x310000, 0x80000)}
    found = partitions(table)
    for name, layout in expected.items():
        if found.get(name) != layout:
            raise RuntimeError(f"Unexpected {name} partition layout; no flash write was attempted.")


def validate_backup(image: bytes) -> None:
    if len(image) != FLASH_SIZE:
        raise RuntimeError("The full-flash recovery read is incomplete.")
    validate_layout(image[0x1000:0x2000], image[0x8000:0x9000])


def target_slot(otadata: bytes, app0: bytes, app1: bytes) -> tuple[int, int, int, int]:
    entries = []
    for sector in (0, 1):
        entry = otadata[sector * 0x1000:sector * 0x1000 + 32]
        sequence = int.from_bytes(entry[:4], "little")
        state = int.from_bytes(entry[24:28], "little")
        crc = int.from_bytes(entry[28:32], "little")
        valid = sequence not in (0, 0xFFFFFFFF) and state not in (3, 4) and crc == zlib.crc32(entry[:4])
        if valid:
            entries.append((sequence, sector))
    active = max(entries, default=None)
    active_slot = (active[0] - 1) % 2 if active else 0
    if (app0 if active_slot == 0 else app1)[0] != 0xE9:
        raise RuntimeError("The current app slot is unreadable; no flash write was attempted.")
    sequence = active[0] + 1 if active else 2
    if sequence >= 0xFFFFFFFF:
        raise RuntimeError("The OTA update counter is exhausted.")
    slot = 1 - active_slot
    address = 0x10000 if slot == 0 else 0x190000
    selector = OTA_ADDRESS + (1 - active[1] if active else 0) * 0x1000
    return slot, address, selector, sequence


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_flash(port: str, address: int, size: int, path: Path, expected_mac: str) -> bytes:
    for attempt in range(2):
        try:
            esptool(port, "read-flash", hex(address), hex(size), str(path))
            data = path.read_bytes()
            if len(data) != size:
                raise RuntimeError(f"Flash read at {address:#x} returned {len(data)} of {size} bytes.")
            return data
        except (OSError, RuntimeError) as error:
            if attempt:
                raise RuntimeError(
                    f"Flash read at {address:#x} failed twice. No subsequent flash write was attempted. "
                    "Check the charger, bridge wiring, and USB connection, then try again."
                ) from error
            print(f"Flash read at {address:#x} did not finish; reconnecting to the same Pill and retrying once...", flush=True)
            mac = prepare(port)
            if mac != expected_mac:
                raise RuntimeError(
                    "The Pill identity changed during the read. No subsequent flash write was attempted."
                ) from error
    raise AssertionError("unreachable")


def prepare(port: str) -> str | None:
    bridge_command(port, "PING")
    bridge_command(port, "BOOT")
    try:
        identity = esptool(port, "flash-id", capture=True, connect_attempts=5)
    except RuntimeError:
        print("The Pill did not answer. Asking the bridge to enter flashing mode once more...", flush=True)
        bridge_command(port, "PING")
        bridge_command(port, "BOOT")
        try:
            identity = esptool(port, "flash-id", capture=True, connect_attempts=5)
        except RuntimeError as error:
            raise RuntimeError(
                "The ESP32 bridge responds, but the Pill did not answer either boot attempt. "
                "Check that the Pill is powered, GND is shared, bridge GPIO16 goes to Pill TX, "
                "GPIO17 to RX, GPIO25 to EN, and GPIO26 to IO0. Close any browser tab or "
                "serial monitor using the bridge, then try again. No flash write was attempted."
            ) from error
    print(identity)
    if not re.search(r"ESP32-S0WD", identity) or not re.search(r"(?:Detected flash size|flash size):\s*4MB", identity, re.I):
        raise RuntimeError("Expected an ESP32-S0WD Pill with 4 MiB flash. No flash write was attempted.")
    mac_match = re.search(r"MAC:\s*([0-9a-f:]{17})", identity, re.I)
    if not mac_match:
        raise RuntimeError("Could not confirm the Pill's MAC address. No flash write was attempted.")
    return mac_match.group(1).replace(":", "").lower()


def confirm_flash_power() -> bool:
    print("Keep the Pill on its charger throughout bridge flashing.")
    while True:
        answer = input("Is the Pill on its charger? [Y/n]: ").strip().lower()
        if answer in ("", "y", "yes"):
            return True
        if answer in ("n", "no"):
            print("Cancelled; put the Pill on its charger before flashing.")
            return False
        print("Please answer yes or no.")


def flash_matches(port: str, address: int, path: Path) -> bool:
    command = ["esptool", "--chip", "esp32", "--port", port, "--baud", "115200",
               "--before", "no-reset", "--after", "no-reset",
               "verify-flash", hex(address), str(path)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout or ""
    if result.returncode == 0 and "Verification successful (digest matched)." in output:
        return True
    if "Verification failed (digest mismatch)." in output:
        return False
    raise RuntimeError(f"Could not compare the Pill's flash with {path.name}:\n{output}")


def save_partition_copy(source: Path, mac: str, name: str) -> Path:
    digest = hashlib.md5(source.read_bytes()).hexdigest()
    destination = ROOT / "ignore" / f"pill-{mac}-{name}-{digest}.bin"
    if destination.exists():
        if destination.stat().st_size != source.stat().st_size or hashlib.md5(destination.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"Existing backup {destination} does not match its name.")
        return destination
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return destination


def backup_full(port: str, mac: str, temporary_path: Path) -> None:
    backup_dir = ROOT / "ignore"
    print("Checking existing full-flash backups against the Pill...")
    match = None
    for candidate in sorted(backup_dir.glob(f"pill-{mac}-full-*.bin")):
        if candidate.stat().st_size != FLASH_SIZE:
            continue
        image = candidate.read_bytes()
        try:
            validate_backup(image)
        except RuntimeError:
            continue
        if candidate.stem.rsplit("-", 1)[-1] != hashlib.md5(image).hexdigest():
            continue
        if flash_matches(port, 0, candidate):
            match = candidate
            break
    if match is None:
        print("No matching full backup; reading all 4 MiB from the Pill.")
        match = temporary_path / "full.bin"
        image = read_flash(port, 0, FLASH_SIZE, match, mac)
        validate_backup(image)
    else:
        print("Matching full backup found; no download needed.")
        image = match.read_bytes()
    saved = save_partition_copy(match, mac, "full")
    print(f"Full recovery image: {saved} (MD5 {hashlib.md5(image).hexdigest()})")
    for name, address in APP_SLOTS:
        extracted = temporary_path / f"{name}.bin"
        extracted.write_bytes(image[address:address + SLOT_SIZE])
        slot_copy = save_partition_copy(extracted, mac, name)
        print(f"{name}: {slot_copy} (extracted from full recovery image)")


def inspect_slot(port: str, temporary_path: Path, mac: str) -> tuple[int, int, int, int]:
    bootloader = read_flash(port, 0x1000, 0x1000, temporary_path / "bootloader.bin", mac)
    table = read_flash(port, 0x8000, 0x1000, temporary_path / "partitions.bin", mac)
    validate_layout(bootloader, table)
    otadata = read_flash(port, OTA_ADDRESS, 0x2000, temporary_path / "otadata.bin", mac)
    app0 = read_flash(port, 0x10000, 0x1000, temporary_path / "app0-header.bin", mac)
    app1 = read_flash(port, 0x190000, 0x1000, temporary_path / "app1-header.bin", mac)
    return target_slot(otadata, app0, app1)


def backup_only(port: str) -> None:
    mac = prepare(port)
    if mac is None:
        return
    backup_dir = ROOT / "ignore"
    backup_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="openpill-serial-", dir=backup_dir) as temporary:
        backup_full(port, mac, Path(temporary))
    try:
        bridge_command(port, "RESET")
    except RuntimeError:
        print("Recovery backup saved, but the Pill did not restart automatically. Restart it manually.")


def install(port: str, image_path: Path) -> None:
    image = image_path.read_bytes()
    if not image or image[0] != 0xE9 or len(image) > SLOT_SIZE:
        raise RuntimeError("The OpenPill application image is invalid or too large for an OTA slot.")
    if not confirm_flash_power():
        return
    mac = prepare(port)
    if mac is None:
        return

    backup_dir = ROOT / "ignore"
    backup_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="openpill-serial-", dir=backup_dir) as temporary:
        temporary_path = Path(temporary)
        while True:
            choice = input("Back up the full 4 MiB flash and extract both firmware slots first? Recommended. [Y/n]: ").strip().lower()
            if choice in ("", "y", "yes", "n", "no"):
                break
            print("Please answer yes or no.")
        if choice in ("", "y", "yes"):
            backup_full(port, mac, temporary_path)
        else:
            print("Skipping the full recovery backup. Original firmware and settings may be unrecoverable if installation fails.")
        slot, address, selector_address, sequence = inspect_slot(port, temporary_path, mac)
        print(f"Target: inactive ota_{slot} at {address:#x}; current app and NVS stay untouched.")
        while True:
            choice = input("Install OpenPill in the inactive slot? [Y/n]: ").strip().lower()
            if choice in ("", "y", "yes", "n", "no"):
                break
            print("Please answer yes or no.")
        if choice in ("n", "no"):
            print("Cancelled; nothing was written to the Pill.")
            return

        esptool(port, "write-flash", "--flash-mode", "dio", "--flash-freq", "40m",
                "--flash-size", "4MB", hex(address), str(image_path))
        written = read_flash(port, address, len(image), temporary_path / "app-readback.bin", mac)
        if sha256(written) != sha256(image):
            raise RuntimeError("Application read-back did not match. Boot selection was not changed.")

        selector = bytearray(b"\xff" * 0x1000)
        selector[:4] = sequence.to_bytes(4, "little")
        selector[24:28] = (0).to_bytes(4, "little")
        selector[28:32] = zlib.crc32(selector[:4]).to_bytes(4, "little")
        selector_path = temporary_path / "selector.bin"
        selector_path.write_bytes(selector)
        esptool(port, "write-flash", hex(selector_address), str(selector_path))
        selected = read_flash(port, selector_address, len(selector), temporary_path / "selector-readback.bin", mac)
        if selected != selector:
            raise RuntimeError("OTA boot selection read-back did not match. Do not reset the Pill; restore from a recovery copy if available.")
        print(f"OpenPill verified in ota_{slot}; boot selector verified.")
    try:
        bridge_command(port, "RESET")
        print("Pill restarted. Keep any recovery copy safe.")
    except RuntimeError:
        print("Install and boot selection verified, but automatic restart did not respond. Restart the Pill manually.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "backup"))
    parser.add_argument("--port", default="/dev/ttyUSB0", help="ESP32 bridge serial port")
    parser.add_argument("--image", type=Path, help="OpenPill app image for install")
    args = parser.parse_args()
    try:
        if args.action == "backup":
            backup_only(args.port)
        elif args.image is None:
            parser.error("install requires --image")
        else:
            install(args.port, args.image)
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
