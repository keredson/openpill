# OpenPill firmware design

## Purpose

OpenPill is low-power replacement firmware for the original ESP32-based Pill
hardware. It measures tilt/gravity, temperature, and battery voltage, then can
report the reading over BLE, Wi-Fi, both, or neither.

Normal operation must not leave a connectable radio running. Significant
movement, physical orientation, and charger insertion open a temporary
maintenance window for configuration and OTA updates.

This document describes intended product behavior and known safety gaps. The
current OTA path is for development only; it is not yet safe as a routine
update mechanism for users without a wired recovery setup.

## Hardware inputs

- LIS3DH accelerometer on I2C, including its low-power interrupt functions
- TMP1075-compatible temperature sensor on I2C
- LIS3DH auxiliary ADC selected for battery sensing; the board's physical
  routing and voltage conversion still need validation
- Active-low external-power/charger-present signal on GPIO23
- Active-low firmware status LED on GPIO18
- Probable LIS3DH interrupt signal on GPIO34

GPIO23 indicates that external charging power is present. It does not
distinguish active charging from a full battery.

GPIO34 must be verified as the LIS3DH interrupt connection before storage mode
is allowed to sleep indefinitely. GPIO23 itself is not an ESP32 deep-sleep
wake-capable pin, so inserting the charger may not wake a completely stationary
device. In normal use, handling the Pill while connecting it should cause the
accelerometer interrupt, but this must not be treated as guaranteed until the
hardware behavior has been tested.

## Orientation modes

Orientation is classified from ten acceleration samples over about 1.8 seconds.
The angle is measured from the absolute long-axis acceleration, so either end
can be uppermost. At most 15 degrees is vertical, at least 78 degrees is
horizontal, and the range between them is the floating/reporting zone. These
initial thresholds still require physical validation.

### Storage

When the Pill is lying horizontally and stable, it is in storage mode:

- Do not advertise BLE telemetry.
- Do not make Wi-Fi reports.
- Turn the status LED off.
- Put the ESP32 into deep sleep without a periodic timer wake-up.
- Leave the LIS3DH in a low-power configuration capable of waking the ESP32
  when the Pill is moved significantly. That movement opens a temporary BLE
  window, after which a still-horizontal Pill returns to storage sleep.

### Reporting

A stable orientation between the horizontal and vertical zones represents a
floating Pill. It wakes at the configured reporting interval, measures once,
sends the reading through each enabled transport, and returns to deep sleep.

### Maintenance

Standing the Pill on end for a stable two to three seconds opens a connectable
BLE maintenance window. This is edge-triggered: leaving the Pill standing does
not repeatedly reopen BLE after the window expires. The trigger is rearmed only
after the Pill leaves the vertical zone.

Detecting a newly connected charger also opens one maintenance window. Remaining
plugged in does not keep BLE available and does not repeatedly reopen the
window.

A significant accelerometer interrupt wakes the Pill to recheck its orientation,
but motion alone does not open a maintenance window. The wake threshold is about
0.25 g at the sensor's ±2 g range and needs physical tuning to reject ordinary
bumps. Firmware checks
that the sensor's interrupt reaches the ESP32 wake pin before sleeping without
a timer; if it cannot confirm the line, it uses a 60-second safety wake instead.

## BLE maintenance window

The no-connection maintenance limit is fixed at five minutes, not configurable.

- A BLE connection suspends the no-connection timer.
- Disconnecting restarts the five-minute timer.
- Active configuration and OTA operations cannot time out midway through their
  transaction.
- When the timer expires, connectable advertising stops and the device returns
  to the mode selected by its orientation.
- A disconnected Pill that stays horizontal leaves maintenance after about ten
  seconds, without waiting for the five-minute limit.
- Moving away from vertical and standing the Pill up again opens a new window.
- A new charger-insertion event opens a new window.

The maintenance service provides diagnostics, configuration, and OTA. Scheduled
BLE telemetry is non-connectable and does not expose this service.

The initial OTA implementation remains an unauthenticated development
mechanism. A custom UUID identifies a protocol; it is not authentication. The
short, physically triggered window reduces exposure but does not by itself make
unauthenticated OTA suitable for a production device.
OTA may start and continue on battery at 30% or above. From 10% to under 30%,
the charger must stay connected. Below 10%, or when the battery reading is
unavailable or invalid, firmware rejects or aborts the transfer. The BLE CLI
checks the same policy before starting. Percentage is estimated from voltage,
so it is less reliable while charging or under load.

## Update safety and recovery

Most users cannot reasonably attach a serial bridge to recover a Pill. A
firmware image that boots but breaks BLE pairing, service discovery, or the OTA
service is therefore a failed update, even if its checksum and boot sequence
are valid. The wired bridge is a development and last-resort repair tool, not
the user recovery design.

Before OTA can be considered user-safe, all of these must hold:

1. Keep the previously working application slot intact while trying the new
   image. Enable the ESP-IDF bootloader's pending-verification/rollback flow;
   do not mark a new image valid merely because `app_main` started.
2. After reboot, keep a maintenance window open long enough for the updater to
   reconnect. The updater must establish an encrypted connection, discover the
   expected services, read the new version and image identity, and exercise the
   configuration and OTA status paths before declaring success. Merely seeing
   advertisements or a breathing LED is insufficient.
3. Mark the new image valid only after that end-to-end check is acknowledged by
   the initiating updater. If validation fails, times out, or the Pill restarts
   before confirmation, boot the previous application automatically and report
   the rollback on the next connection. The UI must distinguish **uploaded**,
   **restarting**, **verifying**, **installed**, and **rolled back**; it must not
   report success at the OTA commit response.
4. Provide and test a user-accessible way to return to the previous verified
   slot without a serial bridge if an application is running but its BLE stack
   is unusable. A physical gesture is a possible interface, but it must be
   specified and validated on the hardware before relying on it. Automatic
   bootloader rollback covers images that crash or fail startup, not every
   running application with broken communications.
5. Preserve the last known-good slot until the new one is verified. Do not let
   another update overwrite the only working image or a needed recovery image
   while verification is pending. Keep NVS and user settings untouched by
   rollback.

An unattended Wi-Fi update has no browser present to perform the BLE check.
Automatic **installation** must remain unavailable to users until an equally
reliable unattended validation and recovery mechanism has been demonstrated;
automatic download/checking alone is not evidence that an image is safe to
boot. This is a release gate even when the user opts in to automatic updates.

Current implementation does **not** meet these requirements: bootloader app
rollback is disabled, startup marks a pending image valid immediately, and BLE
clients treat commit/restart as completion without proving that the new image
can be reached. These are known blockers, not optional future polish.
Bootloader rollback cannot be added by an application-only OTA image; the
initial conversion process must verify that the installed bootloader supports
it or provision a compatible bootloader with a separately reviewed recovery
plan. Until then, do not claim the rollback requirement is implemented.

## LED behavior

The LED is off during deep sleep. Firmware indications are:

| State | Indication |
| --- | --- |
| BLE maintenance available | Dim breathing animation |
| BLE client connected | Steady dim light |
| Scheduled BLE or Wi-Fi report | One short bright flash |
| OTA transfer | Rapid pulse, changing every 50 ms |
| Successful configuration, or OTA image accepted for reboot | Two short flashes; OTA is not yet verified |
| Terminal operation failure | Morse SOS repeated exactly twice, then off |

A reporting flash represents one outbound telemetry operation, not every BLE
advertising frame or Wi-Fi packet.

## Scheduled telemetry

One sensor sample is shared by all enabled transports. The normal wake sequence
is:

1. Initialize the sensors and determine orientation and charger presence.
2. If the device is horizontal and stable, enter storage mode.
3. Read acceleration, temperature, and battery voltage.
4. Calculate tilt and gravity using the saved calibration.
5. If BLE telemetry is enabled, send a short advertisement burst.
6. Stop BLE before starting Wi-Fi when practical.
7. If Wi-Fi telemetry is enabled, make one bounded report attempt.
8. Shut down the radios and enter deep sleep until the next interval.

### BLE telemetry

BLE telemetry uses non-connectable advertisements in the official-compatible
manufacturer-data format. A report is a small fixed burst over the three BLE
advertising channels rather than a multi-second connectable session. Repeating
the advertisement makes reception more reliable without leaving BLE active.

### Wi-Fi telemetry

Wi-Fi reporting sends a versioned payload to an arbitrary configured HTTP(S)
endpoint. HTTPS certificate validation is the default. Plain HTTP, if
supported, must require an explicit opt-in for trusted local networks.

Wi-Fi association, DNS, connection, and request processing must share a strict
timeout, initially 15 seconds. Failure must not leave Wi-Fi running or prevent
the device from returning to sleep. Persistent offline queuing is outside the
initial design because frequent flash writes would increase complexity and
wear.

An initial JSON representation may include:

```json
{
  "schema": 1,
  "device_id": "56642E",
  "gravity": 1.042,
  "temperature_c": 20.4,
  "battery_mv": 4090,
  "external_power": false
}
```

A timestamp is included only when the device has a trustworthy time source.
The receiving endpoint can otherwise timestamp the request.

BLE and Wi-Fi reporting are independently optional. If both are disabled,
there is no reason for a periodic timer wake; movement can still wake the
device for orientation classification and maintenance.

## Browser configuration

OpenPill provides an installable static PWA served from an HTTPS website.
The Pill does not host the PWA and does not create a private Wi-Fi access point.
After its first load, the PWA should cache the application for offline use.

The PWA uses Web Bluetooth to connect to the configuration GATT service during
a maintenance window. Web Bluetooth requires a secure browser context, an
explicit user action, and user selection of the device. Because browser support
is not universal, the command-line BLE client remains a supported OTA and
diagnostics client. It is not a recovery fallback when the Pill itself cannot
establish a usable encrypted GATT connection.
The PWA may watch telemetry advertisements from previously permitted Pills
without a GATT connection while its page is visible. It must not imply that
it scans all nearby devices or collects readings while closed or in the
background; unsupported browsers retain manual connected readings.
The PWA keeps previously selected Pills and timestamped sensor history in local
browser storage. Temperature, gravity, and battery percentage are recorded from
broadcasts; connected reads provide calibrated gravity, temperature, estimated
battery percentage, tilt, and external-power status. History is not synchronized between browsers
or devices.
The PWA displays the installed firmware version and checks the latest public
release in `keredson/openpill` when the user requests it. It links to release
details and performs BLE OTA from the firmware image hosted by this PWA.
The CLI remains a fallback when Web Bluetooth is unavailable.
Initial wired conversion is a separate `/flash` page. It programs an ESP32
bridge, checks the wired link, and strongly recommends a full local recovery
copy. After verifying the Pill's ROM UART identity and partition layout, it
writes the non-booted OTA slot and updates only the inactive boot-selector
record. A backup may be explicitly skipped. The page can also restore a full
recovery image to the matching Pill, including its settings. Wired
installation, restore, and slot switching require the Pill to remain on its
charger. The ROM downloader cannot report charger status through the bridge,
so the user confirms this before a write. The wired flow does not ask for a
battery percentage; BLE OTA retains its separate battery policy.

The configuration service exposes these logical operations:

| Operation | Access |
| --- | --- |
| Capabilities and protocol version | Read |
| Non-secret configuration | Read |
| Credential staging | Write only |
| Test and commit command | Write |
| Progress and result | Read and notify |

Wi-Fi provisioning is transactional:

1. The PWA writes a candidate SSID, password, endpoint, and optional endpoint
   token into RAM.
2. The user requests `test and save`.
3. The Pill attempts the Wi-Fi report while retaining the BLE connection.
4. On success, it atomically commits the candidate configuration to NVS.
5. On failure, it keeps the previous saved configuration, notifies the PWA,
   and displays SOS twice.

Passwords and tokens are never returned by a read operation, included in an
advertisement, or printed to the serial log. Public configuration may indicate
that a credential exists without exposing its value.

## Configuration and NVS

Existing Wi-Fi credentials use the `esp32-wifi-manager` storage format in the
`espwifimgr` NVS namespace. OpenPill may import the existing SSID and password
as initial defaults, but it must not rewrite that namespace or depend on its
private `settings` blob format.

OpenPill configuration belongs in a new `openpill` namespace in the existing
NVS partition. Initial keys are:

| Key | Type | Initial behavior |
| --- | --- | --- |
| `schema_ver` | `u32` | Configuration schema version, initially 1 |
| `wake_interval_s` | `u32` | Import an existing compatible interval when available; otherwise 900 |
| `ble_telem` | `u8` | Enable scheduled BLE telemetry |
| `wifi_telem` | `u8` | Enable scheduled Wi-Fi telemetry |
| `auto_update` | `u8` | Development-only opt-in to weekly Wi-Fi checks and installation; do not expose automatic installation to users until the recovery gate above is met |
| `wifi_ssid` | string/blob | OpenPill Wi-Fi network name |
| `wifi_password` | string/blob | Write-only Wi-Fi password |
| `endpoint_url` | string | Wi-Fi report destination |
| `endpoint_token` | string/blob | Optional write-only authorization token |
| `wifi_timeout_s` | `u32` | Total Wi-Fi attempt timeout, initially 15 |
| `allow_http` | `u8` | Explicit opt-in for plain HTTP endpoints |

NVS is a namespaced key/value store logically, but all namespaces share the
same physical log and garbage collection. The implementation must therefore:

- Write only the `openpill` namespace.
- Leave vendor, account, cloud, radio, BLE-bonding, calibration, and
  `espwifimgr` entries untouched.
- Never erase the NVS partition as an error-recovery fallback.
- Preserve the old committed OpenPill configuration until a replacement has
  been tested successfully.
- Make writes only during an intentional maintenance transaction, preferably
  while external power is present.

Vendor gravity and battery calibration remain imported from `expr` and
`adc_cal` respectively.

## Security boundaries

- Configuration writes are accepted only during a physically triggered
  maintenance window.
- All OpenPill application GATT reads and writes, including OTA and sensor
  diagnostics, require an encrypted BLE connection. Protected characteristic
  access initiates non-bonded Just Works pairing; service discovery must not
  be cut off by an eager pairing attempt. Compatible telemetry advertisements
  remain public and unencrypted.
- BLE link encryption without authenticated pairing does not prevent an active
  nearby man-in-the-middle attack. The physical trigger and short window are
  acceptable for development, but stronger device authentication is needed
  before treating provisioning or OTA as production-secure.
- Endpoint tokens and Wi-Fi passwords are never exposed through telemetry or
  diagnostic reads.
- URLs, intervals, credential lengths, payload sizes, and commands are
  validated before use or persistence.
- OTA continues to validate image structure and the complete image SHA-256
  before changing the boot selection.

## State priority

Operations that are already in progress take priority over orientation changes:

1. An OTA write completes or fails before any sleep transition.
2. A connected configuration transaction completes or disconnects.
3. An open maintenance window runs until its no-connection timeout.
4. A scheduled report completes within its bounded timeout.
5. Stable orientation selects storage, reporting, or a new maintenance window.

This prevents moving the device or unplugging it from interrupting a flash
commit or partially written OTA image.

## Validation required

Before any user-facing firmware release or automatic installation:

- Exercise OTA on real hardware from both the PWA and CLI, then reconnect after
  reboot and read encrypted configuration, sensor, and OTA status
  characteristics. Test from a fresh browser/host as well as one that has
  previously connected.
- Prove that pairing failure, failed GATT discovery, missing or changed
  characteristics, boot crash, and lost confirmation all restore the previous
  working slot without opening the Pill or attaching a bridge.
- Verify that the PWA and CLI report a completed update only after post-boot
  confirmation, and clearly report a rollback or unresolved outcome.
- Verify the user-accessible previous-slot recovery procedure on the actual
  hardware, including when the new application boots but BLE cannot connect.
- Keep automatic Wi-Fi installation off until its unattended recovery path
  passes the same tests.

Before relying on the complete power state machine unattended:

- Verify GPIO34 is driven by the LIS3DH interrupt output and wakes from deep
  sleep.
- Record accelerometer values in horizontal, vertical, and floating positions.
- Verify a still horizontal Pill produces no BLE traffic and no timer wakes,
  while a deliberate jolt opens one maintenance window.
- Verify vertical entry opens exactly one five-minute window.
- Verify charger insertion opens one window but remaining plugged in does not
  keep BLE active.
- Verify the no-connection timer pauses during a connection and OTA.
- Verify failed Wi-Fi credentials leave the previous configuration usable.
- Measure current in storage, periodic reporting, BLE maintenance, and Wi-Fi
  reporting modes.
- Confirm the official-compatible advertisement remains accepted by existing
  receivers.
