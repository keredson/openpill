# BLE services

During a physically triggered maintenance window, the device advertises as
`OpenPill-xxxxxx` and exposes OTA, configuration, and diagnostics services.
The no-connection window is fixed at 300 seconds. A disconnected Pill that
remains horizontal closes it after about 10 seconds. Connecting pauses the
timer; disconnecting starts it again. Scheduled telemetry uses a short,
non-connectable advertising burst and does not expose GATT services.
Current firmware does not require operating-system BLE pairing for the PWA.
Sensors, OTA, and status are public GATT characteristics. Configuration values,
Wi-Fi scan results, and configuration writes use the v2 secure configuration
channel described below. Legacy configuration characteristics still require
BLE link encryption for older clients. Telemetry advertisements are public.

## Compatible telemetry advertisement

Manufacturer data begins with company ID `0x4152` (little-endian bytes `52 41`)
and the four-byte signature `RAPT`. Multi-byte telemetry fields are big-endian:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | 4 bytes | Signature, including company ID |
| 4 | `u8` | Format version (`2`) |
| 5 | `u8` | Reserved (`0`) |
| 6 | `u8` | Gravity-velocity valid (`0`) |
| 7 | `float32` | Gravity velocity (`0`) |
| 11 | `u16` | Temperature in kelvin multiplied by 128 |
| 13 | `float32` | Specific gravity multiplied by 1000 |
| 17 | `i16` | X acceleration multiplied by 16 |
| 19 | `i16` | Y acceleration multiplied by 16 |
| 21 | `i16` | Z acceleration multiplied by 16 |
| 23 | `i16` | Battery percentage multiplied by 256 |

## OTA service

| Attribute | UUID | Properties |
| --- | --- | --- |
| Service | `369af8ff-2190-465f-b538-6df2fba7fcdc` | Primary |
| Control | `84ef205e-52cc-4331-84a2-18cbaf9e0e56` | Public write |
| Firmware data | `1b3d644f-58b8-47f7-ba13-3e0878893b25` | Public write, write without response |
| Status | `1b23db1d-f22f-456d-82a4-0a35710139c1` | Public read, notify |

Protocol version 1 uses little-endian integers. Control messages are:

- Begin: `0x01`, image size (`u32`), SHA-256 digest (32 bytes).
- Commit: `0x02`.
- Abort: `0x03`.

Every firmware-data value contains the absolute image offset (`u32`) followed
by image bytes. Offsets must be contiguous. The 12-byte status value is:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | `u8` | Protocol version (`1`) |
| 1 | `u8` | Idle `0`, receiving `1`, verifying `2`, ready `3`, error `4` |
| 2 | `u8` | Error code; zero means none |
| 3 | `u8` | Target OTA slot plus one (`1` = `ota_0`, `2` = `ota_1`); `0` means unavailable (including older firmware) |
| 4 | `u32` | Contiguous bytes accepted |
| 8 | `u32` | Expected image size |

OTA is allowed on battery at 30% or above. From 10% to under 30%, the charger
must remain connected. Below 10%, or when the battery reading is unavailable
or invalid, OTA is blocked even if the charger is connected. The device checks
before Begin, during transfer, and before Commit. Status error code `13` means
the charger is required below 30%; `14` means battery reading unavailable or
invalid; `15` means battery below 10%. The Linux client also checks the hardware
sample before starting. Battery percentage is a voltage-based estimate.

The client sends Commit only after the accepted offset reaches the image size.
The device checks SHA-256, asks ESP-IDF to validate the image, selects the
inactive OTA slot, and reports ready. It restarts after the client disconnects,
or after 10 seconds if the connection remains open, so the Commit response and
final status read can complete. A disconnect during transfer aborts the write
without changing the selected boot partition.

## Configuration service

| Attribute | UUID | Properties |
| --- | --- | --- |
| Service | `8f5f0000-bfc1-4d83-bf4b-28f27e63c700` | Primary |
| Public configuration | `8f5f0001-bfc1-4d83-bf4b-28f27e63c700` | Encrypted read |
| Staging write | `8f5f0002-bfc1-4d83-bf4b-28f27e63c700` | Encrypted write |
| Command | `8f5f0003-bfc1-4d83-bf4b-28f27e63c700` | Encrypted write |
| Status | `8f5f0004-bfc1-4d83-bf4b-28f27e63c700` | Public read, notify |
| Wi-Fi scan | `8f5f0005-bfc1-4d83-bf4b-28f27e63c700` | Encrypted read and write |
| v2 session key | `8f5f0006-bfc1-4d83-bf4b-28f27e63c700` | Public read and write |
| v2 secure request | `8f5f0007-bfc1-4d83-bf4b-28f27e63c700` | Public write of ciphertext |
| v2 secure response | `8f5f0008-bfc1-4d83-bf4b-28f27e63c700` | Public read of ciphertext |

Public configuration is UTF-8 JSON and includes `firmware_version`,
`running_slot`, and `firmware_elf_sha256`, read from the running application.
The ELF hash is distinct from the SHA-256 of the entire firmware `.bin` file.
The Wi-Fi password is omitted; the document includes only a
`has_wifi_password` flag.

The staging-write framing is:

- `0x01`: begin a new document.
- `0x02` followed by bytes: append a JSON chunk.
- `0x03`: finish and validate the document.

The document is limited to 1024 bytes. Command `0x01` tests the staged Wi-Fi
and endpoint when Wi-Fi telemetry is enabled, then commits to NVS only on
success. Command `0x02` discards it. Command `0x03` tests and saves only Wi-Fi
network settings. Command `0x04` sends a test POST with staged settings without
saving them. Status is JSON with protocol `version`, numeric `state`, and a
human-readable `message`. States are ready `0`, receiving `1`, staged `2`,
testing `3`, saved `4`, error `5`, and tested without saving `6`.

## Hardware diagnostics service

| Attribute | UUID | Properties |
| --- | --- | --- |
| Service | `3cf82945-e436-4a1a-badc-bf55bcbffc59` | Primary |
| Sensor sample | `dfaba240-7af2-4e73-ae91-1925685accd5` | Public read |
| ADC diagnostics | `fa0e982a-4b71-472f-a91d-41109c547d22` | Public read |

The current 20-byte sensor record is little-endian. Version 1 was 16 bytes and
did not include the gravity field:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | `u8` | Format version (`2`) |
| 1 | `u8` | Valid flags: accel `0x01`, temperature `0x02`, battery `0x04`, power `0x08`; `0x10` means the battery value averaged four fresh ADC2 samples |
| 2 | `u8` | External power present |
| 3 | `u8` | Status LED brightness (`0`–`255`) |
| 4 | `i16` | X acceleration in mg |
| 6 | `i16` | Y acceleration in mg |
| 8 | `i16` | Z acceleration in mg |
| 10 | `i16` | Temperature in hundredths Celsius |
| 12 | `i16` | Signed high byte of auxiliary ADC2; battery input under investigation |
| 14 | `u16` | Battery millivolts calculated from ADC2; currently unreliable on the test Pill |
| 16 | `float32` | Calibrated specific gravity (NaN if acceleration is unavailable) |

The 11-byte ADC diagnostics record is little-endian. Byte 0 is version `1`;
bytes 1–4 are `STATUS_REG_AUX`, `CTRL_REG1`, `CTRL_REG4`, and `TEMP_CFG_REG`.
Bytes 5–10 are signed 16-bit ADC1, ADC2, and ADC3 results shifted right by
six from the sensor's left-aligned 10-bit output. The existing sensor sample
continues to carry the signed high byte of ADC2 for compatibility.

## Security boundary

The PWA and Pill exchange ephemeral P-256 public keys on configuration
characteristic `0006`; the PWA sends its 65-byte key in 19-byte fragments
prefixed with a one-byte offset. The Pill returns protocol byte `1` followed
by its 65-byte key after a short pending period while key generation runs off
the BLE host task. Both sides use HKDF-SHA256 on the ECDH shared secret,
with `SHA256(clientPublic || pillPublic)` as salt and `OpenPill config v1` as
info, to derive a client AES-256-GCM key and 12-byte IV base followed by a
server key and IV base. Each request on `0007` is `[sequenceLE32, ciphertext,
tag16]`, fragmented into 18-byte payloads with `[totalLength, offset]` headers;
the encrypted response is read from `0008`. Each direction has an independent
monotonically increasing sequence. The sequence bytes are GCM associated data,
and the last four IV bytes are XORed with the sequence. A new session is
established on every connection. Config JSON and Wi-Fi scan JSON are returned
in encrypted pages; config writes and commands are also encrypted.

This protects secrets from passive radio listeners, but the ephemeral key
exchange does not authenticate the Pill or user. As with Just Works, an active
nearby attacker can intercept or impersonate a connection. OTA firmware is
not encrypted and currently has only a SHA-256 transfer-integrity check, not
an image signature. Limit configuration and OTA to the physically triggered
maintenance window. Device identity and signed firmware are future work.
