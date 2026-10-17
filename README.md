# OpenPill

For build, command-line flashing, and PWA setup, see
[DEVELOPMENT.md](DEVELOPMENT.md).

OpenPill is low-power firmware and a browser configurator for the ESP32-based
Pill hydrometer. It reads acceleration, temperature, battery voltage, and
external-power presence. Scheduled readings can be broadcast over BLE, pushed
as JSON over Wi-Fi, or both.

Normal operation is orientation driven:

- Horizontal: storage mode, with radios and the periodic timer off.
- Floating: wake on the configured interval, report, and return to sleep.
- Standing on end: open a five-minute connectable BLE maintenance window.
- A significant movement: open the same temporary BLE window, even if the Pill
  remains horizontal.
- Newly detected external power: open one maintenance window, not permanent
  advertising.

The maintenance LED breathes dimly. It is steady while connected, pulses
quickly during OTA, flashes twice on success, and sends SOS twice on a terminal
failure.

## Firmware

Install PlatformIO and build from the repository root:

```sh
make build
```

The application image is `.pio/build/openpill/firmware.bin`. Configuration is
stored only in the `openpill` NVS namespace. Existing calibration and compatible
Wi-Fi values are imported without rewriting their namespaces; NVS is never
erased as an error-recovery action.

Stand the Pill on end, then use the Linux/BlueZ command-line client. OTA works
on battery at 30% or above; from 10% to under 30%, connect the charger. Below
10%, charge the Pill before flashing.
`make flash-pill-via-ble` builds, scans for nearby Pills, and asks you to select one:

```sh
make probe
make read
make flash-pill-via-ble
```

The OTA service verifies the complete SHA-256 and ESP application image before
selecting the inactive slot and restarting. The wire format is documented in
[docs/ble-ota.md](docs/ble-ota.md).

## PWA

The `web/` directory contains a Vite + React PWA. It reads sensors, configures
reporting and credentials, tests Wi-Fi before committing settings, displays the
installed firmware version, and checks `keredson/openpill` for a newer GitHub
release. Firmware upload is available in the PWA or with the command-line client.
The PWA remembers Pills in this browser and stores timestamped sensor readings
locally for history graphs while the page is receiving data.
Its `/flash` guide can program an ESP32 development-board bridge, check the
Pill over UART, save a recommended recovery backup, install OpenPill into the
other application slot, and restore a saved recovery copy using
the browser's Web Serial API. Use a desktop Chromium browser; conversion is
separate from normal BLE configuration.

```sh
cd web
yarn install
yarn dev
```

Web Bluetooth requires a supporting browser, a secure context, and a user
gesture. `localhost` is accepted for development. Production must be served by
HTTPS.

Pills running firmware before 0.2.0 still need the old BLE pairing path for
their first PWA connection and upgrade. Once 0.2.2 or later is installed, the
PWA configures them without `bluetoothctl` or another helper. If a 0.2.0 or 0.2.1 Pill
fails during secure configuration reads, use **Settings → Update firmware**;
that path can use only the public battery and OTA characteristics.
Build the firmware before the production PWA so the site's bundled OTA image is
the new version.

If a Pill was updated from older firmware but the PWA still tries to read
"legacy configuration," the computer may have cached the old GATT attribute
list. On Linux, disconnect the PWA, run
`bluetoothctl remove <PILL_MAC>` (using that Pill's address),
then reload the PWA and select the Pill again. This clears the computer's
Bluetooth record; it does not erase Pill settings or PWA readings. Other
platforms can remove the Pill in Bluetooth settings before reselecting it.

The Pages workflow in `.github/workflows/pages.yml` builds `web/` on pushes to
`main`. In the GitHub repository settings, select **GitHub Actions** as the
Pages source and configure the custom domain there. The Vite build uses `/` as
its base because a custom-domain site is served from the domain root. Add the
domain's DNS records separately; no repository-specific `CNAME` is guessed.

The PWA is cached after its first successful load, so it can subsequently open
without Internet access. The page itself is static and never receives device
credentials; browser JavaScript talks directly to the nearby device.

## Security status

This remains development firmware. The current PWA encrypts configuration
reads and writes with an ephemeral app-layer session, without requiring OS
pairing. Passwords and endpoint tokens are write-only and absent from telemetry.
HTTPS endpoint validation is enabled by default. The BLE session has no device
authentication, and OTA has no image signature. Physical activation and a short
maintenance window reduce exposure but are not production-grade authentication.

Before relying on the power state machine, complete the hardware validation
checklist in [DESIGN.md](DESIGN.md), especially GPIO34 motion wake and current
measurements.
