# OpenPill

OpenPill is open-source firmware and an app for the original
ESP32-based RAPT Pill hydrometer. It lets the Pill report temperature, specific
gravity, and battery level directly over Bluetooth, or send readings by Wi-Fi
as JSON to a POST URL you choose. No cloud account or service is required.

## Why OpenPill?

I started this project because the original rapt.io app felt laggy in my use.
The newer app also appeared to replace the free webhook workflow I had used
with an API that required a paid or premium account. I like open hardware and
software, and wanted a way to use the Pill without depending on a particular
cloud service or integration policy. OpenPill gives owners a direct connection
to the device and control over where its readings go. It is another option,
not a replacement for the whole RAPT platform.

## What it does

- Shows temperature, gravity, and battery readings in the browser when the
  Pill is nearby. The app keeps a local history while it receives data.
- Sends scheduled readings over Bluetooth, Wi-Fi, or both. Wi-Fi uploads are
  JSON HTTP POST requests to an endpoint you choose. Your readings do not pass
  through OpenPill servers.
- Lets you configure Wi-Fi, reporting intervals, and firmware updates from a
  browser. The web app is static and does not collect your credentials.
- Conserves battery by sleeping between reports. Position and movement open a
  short Bluetooth maintenance window for configuration and updates.
- Continues to broadcast RAPT-compatible telemetry updates over Bluetooth.

OpenPill does not need a RAPT account for its own reporting or configuration.
It does not reproduce RAPT's cloud features or integrations.

## Getting started

If your Pill is already running OpenPill, open the
[web app](https://keredson.github.io/openpill/) in a browser with Web Bluetooth
support, add the Pill, and use its Settings panel.

An original RAPT Pill needs a **one-time wired conversion** before the browser
can manage it this way. This requires an ESP32 development board, five
female-to-male jumper wires, the Pill's charger, and a desktop browser with
Web Serial support. Follow the [initial conversion guide](docs/initial-conversion.md)
and save a full recovery copy before installing. This process is reversible but
requires you to handle the Pill's bare circuit board, which always has some
risk of damage.

For firmware builds, command-line tools, and deployment, see
[DEVELOPMENT.md](DEVELOPMENT.md). The [recovery guide](docs/recovery.md)
covers failures and restoring a saved copy; [BLE OTA details](docs/ble-ota.md)
document the update protocol.

## Current status

This is experimental firmware, not a finished consumer product. Bluetooth
configuration uses an encrypted session but does not authenticate the nearby
device, and firmware images are not signed. Test the setup before relying on
it for a batch, keep your recovery copy private, and review the remaining
hardware validation work in [DESIGN.md](DESIGN.md).
