# Flash layout and recovery

## Factory partition layout

| Name | Offset | Size | Purpose |
| --- | ---: | ---: | --- |
| `otadata` | `0x00d000` | `0x002000` | OTA boot selection |
| `phy_init` | `0x00f000` | `0x001000` | Radio PHY initialization |
| `ota_0` | `0x010000` | `0x180000` | Application slot 0 |
| `ota_1` | `0x190000` | `0x180000` | Application slot 1 |
| `nvs` | `0x310000` | `0x080000` | Vendor settings/calibration |

The bootloader and partition table precede these entries. Never assume that
the inactive slot contains a disposable image: each OTA install replaces it.

## Verified backups

Local working copies are stored under the Git-ignored `ignore/`
directory. They must remain untracked and must not be published:

| Contents | Path | SHA-256 |
| --- | --- | --- |
| Vendor RAPT 1.5.0 `ota_0` image | `ignore/rapt-pill-ota0-v1.5.0-2026-10-16.bin` | `463c98b50cf09b5b211c3257417223ac807e34839a7d128d655f0b6b872c9958` |
| Vendor RAPT 2.0.0 `ota_1` image | `ignore/rapt-pill-ota1-v2.0.0-2026-10-16.bin` | `3708947f021a676591d60eccb24a5ee07b0dd9f89921249455fe0b3018971398` |
| Second full 4 MiB flash read | `ignore/rapt-pill-full-2026-10-16-second.bin` | `b3e34163bd17f6f850a1cb39d600919aed10ccef47331a47f7cb3e997a44e52e` |
| OTA selector before custom tests | `ignore/rapt-pill-otadata-before-test-2026-10-16.bin` | `062f79dd9748aef0e56afddd5db3112af00549478e9d478e38137d5f3232f3a3` |

The full image was read twice and `esptool verify-flash` passed. The individual
application images were extracted and identified independently. Check hashes
again before any restoration.

At the end of the earlier test sequence, `ota_0` contained a custom UART test
image and the device had been switched back to vendor RAPT 2.0.0 in `ota_1`.
Installing the OpenPill bootstrap into `ota_0` preserves 2.0.0 initially. The
first web OTA from OpenPill then targets and replaces `ota_1`.

## Security state observed

- Secure Boot v1: disabled
- Secure Boot v2: disabled
- Flash encryption: disabled
- Anti-rollback secure version: 0
- UART download mode: enabled
- JTAG: enabled
- Key blocks: all zero at time of inspection

These are observations, not settings to modify. Never burn or change eFuses.

## Bridge commands

With the bridge firmware attached at `/dev/ttyUSB0` and 115200 baud:

- send `+++RAPT_BOOT\r` to assert IO0 during reset and enter the ROM downloader
- send `+++RAPT_RESET\r` for a normal restart

Use `esptool --port /dev/ttyUSB0 ...` only after confirming the bridge has put
the Pill in downloader mode. For an app-only write to slot 0, the target is
`0x10000`; use the exact built `firmware.bin`, not a merged image. OTA selection
is stored separately in `otadata`, so writing a slot alone does not select it.

Only when `ota_0` is confirmed inactive, an app-only write to that slot is:

```sh
esptool --port /dev/ttyUSB0 --baud 460800 \
  write-flash 0x10000 .pio/build/openpill/firmware.bin
```

Do **not** use `pio run --target upload` on the Pill unless its generated upload
map has first been audited. A normal PlatformIO ESP32 upload can include a new
bootloader, partition table, and initial OTA data, while OpenPill's bootstrap
only needs the application image written at `0x10000`.

After writing the application, explicitly select `ota_0` with ESP-IDF's
`otatool.py`, using this repository's `partitions.csv`, and then perform a normal
reset. The known local ESP-IDF tool path is:

```sh
IDF_PATH=/home/derek/.platformio/packages/framework-espidf \
/home/derek/.local/share/pipx/venvs/esptool/bin/python \
  /home/derek/.platformio/packages/framework-espidf/components/app_update/otatool.py \
  --port /dev/ttyUSB0 --baud 115200 \
  --partition-table-file /home/derek/projects/openpill/partitions.csv \
  --esptool-args before=no_reset after=no_reset -- \
  switch_ota_partition --slot 0
```

The bridge must remain in ROM download mode between the flash write and OTA
selection. Send `+++RAPT_RESET\r` afterward and monitor at 115200 baud. Expect
the `OPENPILL OTA` banner, project/version/partition details, SSID, password,
and web URL.

