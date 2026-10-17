# OpenPill development

Run commands from the repository root unless a section says otherwise. The
normal firmware update path is BLE OTA; the serial bridge is for initial
installation or recovery.

`make deploy-major`, `make deploy-minor`, and `make deploy-point` are reserved
release targets. They currently fail without changing a version, build, tag,
or release.

## Prerequisites

- PlatformIO and its ESP32/ESP-IDF packages for firmware builds.
- `esptool` and `pyserial` for wired installation through the ESP32 bridge.
- A Linux laptop with BlueZ, a working Bluetooth adapter, and `python3-gi` for
  the command-line BLE client. The client uses the system D-Bus and does not
  require a Python package installation from PyPI.
- Node.js 22 and Yarn (via Corepack) for the Vite/React PWA.

## Build the firmware

The Makefile provides the usual build and BLE upload workflow. `make flash-pill-via-ble`
builds first, scans for nearby Pills, and shows a numbered list; select one
number to upload. Open the Pill's Bluetooth connection window before uploading.
At 30% battery or above, no charger is required; from 10% to under 30%, keep
it on the charger. Uploads are blocked below 10%.

```sh
make build
make flash-pill-via-ble
```

For an initial wired installation, flash the separate ESP32 development-board
bridge, connect it to the Pill as shown in the `/flash` browser flow, then run:

```sh
make flash-bridge
make flash-pill-via-bridge
```

Set `ESP32_PORT` if the bridge is not `/dev/ttyUSB0`. `make flash-pill-via-bridge` uses
the bridge, checks the Pill's identity and partitions, writes the inactive OTA
slot, verifies it by reading it back, then changes and verifies the boot
selector. It asks whether to save a full 4 MiB recovery image first. If an
existing full image for this Pill matches the device flash, it is reused without
downloading again. Both OTA firmware slot images are extracted from the full
image. Skipping the backup reads only the small regions needed for safety
checks. To back up without installing, use `make backup-pill`. All recovery
files are saved under Git-ignored `ignore/`. The full image includes the
bootloader, partition table, boot selector, and settings; the separate OTA
images do not. Keep the Pill on its charger throughout wired flashing; the CLI
asks for charger confirmation before writing. The bridge cannot measure charger
status while the Pill is in ROM flashing mode. The browser installation and
restore flows also require charger confirmation, but do not ask for a battery
percentage.
`make flash-pill-via-ble` remains the BLE OTA
path for a Pill already running OpenPill.

For scripts, `make flash-pill-via-ble DEVICE=<name-or-MAC> UPLOAD_FLAGS=--yes` bypasses the
menu and confirmation; the battery policy still applies. `make probe` and
`make read` also offer the numbered list when `DEVICE` is omitted.

The equivalent direct build command is:

```sh
pio run
ls -lh .pio/build/openpill/firmware.bin
sha256sum .pio/build/openpill/firmware.bin
```

Upload only `.pio/build/openpill/firmware.bin`, the ESP32 application image.
The application partitions are 1.5 MiB each; the build must fit one slot.
`platformio.ini` selects the single-core ESP32 target, 4 MiB flash, DIO mode,
and 40 MHz flash frequency.

## Flash over BLE from the command line

The CLI reads the Pill's battery and charger status before starting. The
firmware repeats the check during transfer: below 10% it stops, and from 10%
to under 30% it requires the charger. At 30% or above, battery power is enough.
Stand the Pill on end to
open the connectable maintenance window. Newly
detected external power also opens one window. By default, advertising ends
after five minutes without a connection; leaving it plugged in does not keep
the window open. If it has expired, move the Pill out of the vertical position
and stand it up again.

You can use the same interactive selection without Make:

```sh
python3 tools/ble_ota.py probe
python3 tools/ble_ota.py read
python3 tools/ble_ota.py upload .pio/build/openpill/firmware.bin
```

When `--device` is supplied, the uploader uses that name or MAC and asks for a
yes/no confirmation. Add `--yes` to skip that prompt in a script:

```sh
python3 tools/ble_ota.py upload .pio/build/openpill/firmware.bin \
  --device 64:B7:08:56:64:2E --yes
```

The updater validates the input image, writes the
inactive application slot, checks the full SHA-256 digest, selects that slot,
and restarts. A transfer failure leaves the previous boot selection in place.
Current firmware starts Just Works pairing on connection and requires an
encrypted link for OTA, configuration, and sensor GATT values. The CLI waits
for the first encrypted read before transferring. Pairing encrypts the link
but does not authenticate the nearby peer; the compatible telemetry broadcast
remains public. Older firmware may accept an unencrypted OTA upload until it
has been updated.
The uploader prints the target slot after Begin when the device reports it;
older firmware does not provide the slot number.
After restart, reopen a maintenance window and run `probe` or `read` again to
confirm the device is reachable. Newer firmware lets `make probe` show the
running slot and ELF SHA-256; compare the latter with the uploader's `ELF SHA256`
line if Commit lost its Bluetooth response. Do not retry an ambiguous Commit
until you have checked which image is running. Firmware and BLE wire details are in
[`docs/ble-ota.md`](docs/ble-ota.md).

If discovery fails, check that the Pill's status LED is breathing and that the
laptop's Bluetooth adapter is enabled. The CLI requires access to the system
BlueZ D-Bus; a container or restricted shell without that access cannot scan
or upload. `--scan-timeout 30` gives discovery more time when needed.

## Serial installation and recovery

Use the serial bridge only when BLE OTA is unavailable. Read
[`docs/hardware.md`](docs/hardware.md) and
[`docs/recovery.md`](docs/recovery.md) before touching the bridge or flash.
The bridge appears as `/dev/ttyUSB0` and controls the Pill's EN and IO0 lines.
Confirm the detected chip and the target slot before writing. The browser
flasher selects the non-booted OTA slot. The manual example below uses `ota_0`
at `0x10000`; run it only after confirming `ota_0` is inactive.

The app-only write command is:

```sh
esptool --port /dev/ttyUSB0 --baud 460800 \
  write-flash 0x10000 .pio/build/openpill/firmware.bin
```

The bridge must first place the Pill in ROM download mode. A serial write to
`ota_0` does not select that slot for the next boot; follow the OTA selection
and reset procedure in `docs/recovery.md`. Do not use a full-flash erase or
`pio run --target upload` for this board: those paths can affect the
bootloader, partition table, OTA selection, or NVS. Never modify eFuses.

## Develop the PWA

```sh
cd web
corepack enable
yarn install
yarn dev
```

Open the local URL printed by Vite. `localhost` is a secure context for Web
Bluetooth. Use a browser with Web Bluetooth support. The PWA can read sensors,
change configuration, test a Wi-Fi endpoint before saving, display the installed
firmware version, compare the connected Pill's firmware hash with this site's
image, check `keredson/openpill` for the latest GitHub release, and install the
firmware image served by this site over BLE from Settings.
It uses Ant Design cards for multiple Pills and opens each Pill's settings in a
modal. Previously selected Pills are saved locally and can reappear without
reselecting them. Where supported, the page watches their telemetry
advertisements while visible, without a GATT connection. Browsers do not offer
reliable background scanning after the page is hidden or closed, and the PWA
cannot monitor Pills that this site has not been granted access to.
The `/flash` page performs an initial wired conversion. Settings provides BLE
updates for a connected Pill; the Linux CLI remains a fallback for OTA and
diagnostics. Browser OTA checks the battery, shows accepted-byte progress,
verifies the image on the Pill, and keeps the previous slot if interrupted.
It requires Web Bluetooth support and the OTA service permission; a previously
saved Pill may need to be selected again through Add a Pill to grant that
permission. Keep the page open during transfer. The firmware image must be
published at `/openpill/firmware/openpill.bin` on GitHub Pages (or
`/firmware/openpill.bin` on localhost); GitHub release checks
are informational and do not automatically substitute a release download.

Before using `/flash` locally, stage the ESP32 bridge firmware packages once:

```sh
make web-assets
```

This builds the Pill and ESP32 bridge, then copies only their build outputs into
the Git-ignored `web/public/firmware/` directory. On the Vite localhost server,
`/firmware/openpill.bin` is served directly from the latest local Pill build, so
subsequent Pill firmware builds do not need another staging step. A production
`yarn build` also stages the latest local Pill image when one exists. The Pages
workflow builds and stages both images before deploying. The browser flasher's
bundled Espressif esptool-js v0.7.0
is in `web/public/vendor/` under its Apache-2.0 license. Web Serial requires a
desktop Chromium browser and a user-selected USB serial port. The recovery
copy is stored locally in IndexedDB, can be downloaded, and may contain private
settings or credentials. Both 1.5 MiB OTA firmware slot images can be downloaded
separately from the saved 4 MiB copy. A backup can be skipped with an explicit
warning, but is strongly recommended. The browser conversion writes the
non-booted OTA application slot and its boot selector; it does not erase the
full flash or touch NVS. Browser restore accepts a full recovery copy for the
same Pill (matching MAC address). The user can restore either saved OTA image
into the current inactive slot, preserving current settings and the other slot,
or explicitly restore the entire 4 MiB image including settings. The restore
page can also inspect both on-device OTA slots (project and version from each
application header) and select the inactive slot without copying an image.
Writes are read back and verified before restarting the Pill.

If a newly flashed Pill still appears to lack the Wi-Fi scan characteristic,
disconnect and reconnect it. The PWA compares the Pill's reported firmware
ELF hash with the firmware image served by the site; a matching image with a
missing characteristic points to an older Bluetooth service list cached by the
browser or operating system. Restart Bluetooth and the browser before retrying.

Build the production PWA with `yarn build`; output is in `web/dist/`. The
GitHub Pages workflow deploys that directory from `main` to
`https://keredson.github.io/openpill/`. In the repository's Pages settings,
select **GitHub Actions** as the publishing source. The PWA's shell is available
offline after an initial successful
load, while BLE still requires a nearby Pill with an open maintenance window.

Optional automatic Wi-Fi firmware updates use the image and SHA-256 manifest at
`https://keredson.github.io/openpill/firmware/`. The PWA build generates
`latest.json` from the exact image it publishes. A Pill with this option enabled
checks roughly every seven days while asleep, and retries failures the next
day. A power cycle may cause an earlier check. Newer semantic versions are
downloaded into the inactive OTA slot, checked against the manifest hash and
application descriptor, then booted. This overwrites any old image in that
slot, including an original image if one remains. Back up the Pill before
enabling automatic updates if recovery matters. The update requires at least
10% battery, and below 30% also requires external power. Until signed firmware
releases are implemented, this feature trusts the TLS-protected Pages site and
its manifest; it does not protect against a compromised publishing account.

## Device behavior while testing

- Horizontal: storage sleep, with no scheduled report. Movement wakes the Pill
  to reassess orientation but does not by itself open connectable BLE.
- Floating: report on the configured interval (15 minutes by default), then
  sleep. BLE and Wi-Fi reports are independently optional.
- Vertical entry or newly detected external power: one maintenance window.
  An active BLE connection pauses its fixed five-minute no-connection limit;
  disconnecting restarts it. A disconnected horizontal Pill closes the window
  after about ten seconds.
- GPIO23 detects external power but cannot itself wake the ESP32 from deep
  sleep. Charger insertion from stationary storage may need movement to
  trigger the accelerometer wake line.

The GPIO34 motion wake connection and orientation thresholds need physical
validation before unattended use. The full checklist is in [`DESIGN.md`](DESIGN.md).
