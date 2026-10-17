# OpenPill working instructions

This repository contains experimental firmware for an original ESP32-based
RAPT Pill. Treat the physical device and the recovered vendor images as
irreplaceable. Review `docs/hardware.md` and `docs/recovery.md` before changing
flash contents.

## Safety rules

- Never write ESP32 eFuses. Secure boot, flash encryption, JTAG disable, UART
  download disable, and anti-rollback settings must remain untouched.
- Never erase the whole flash. Write only an explicitly named application slot
  or the OTA data partition after checking its address and size.
- Preserve the vendor NVS partition at `0x310000`; OpenPill must not initialize,
  erase, or rewrite it unless the user explicitly requests a specific migration.
- Keep the verified full-flash and individual vendor application backups. Do
  not overwrite or regenerate files labeled as verified backups.
- Before a serial flash, confirm the detected chip is the classic single-core
  ESP32-S0WD and that the target address matches `partitions.csv`.
- Compile for a single core, 4 MiB flash, DIO mode, and 40 MHz flash frequency.

## Development workflow

- Build with `pio run` from the repository root.
- The uploadable app image is `.pio/build/openpill/firmware.bin`.
- The initial wired bootstrap belongs at `ota_0`, offset `0x10000`.
- After OpenPill boots, prefer its BLE OTA service documented in
  `docs/ble-ota.md`.
- An OTA upload always replaces the inactive 1.5 MiB application slot.
- Verify builds and serial writes. Keep UART output at 115200 baud for recovery.
- Commit completed, verified changes as you go in focused commits. Do not push
  unless the user asks.
- Use a descriptive subject and a detailed, multiline commit message where the
  scope of the change warrants it.

## Documentation and source wording

- Do not mention in project design or source code that facts were obtained by
  inspecting or recovering vendor firmware.
- Facts learned during investigation may be documented as hardware, protocol,
  compatibility, or behavior requirements without describing their provenance.

## Hardware control bridge

The attached ESP32 development board is a UART/control bridge, not the target:

- bridge GPIO16 (RX) receives Pill TX
- bridge GPIO17 (TX) drives Pill RX
- bridge GPIO25 controls Pill EN as open drain
- bridge GPIO26 controls Pill IO0 as open drain
- `+++RAPT_BOOT\r` enters the Pill ROM downloader
- `+++RAPT_RESET\r` performs a normal Pill reset
- bridge serial device: `/dev/ttyUSB0`

The Pill's exposed pads are `GND`, `TX`, `RX`, `IO0` (board label appears as
`100`), `EN`, and `3V3`. Cross TX/RX and share ground. Do not drive EN to 3V3;
EN and IO0 are controlled by pulling them low and otherwise releasing them.

