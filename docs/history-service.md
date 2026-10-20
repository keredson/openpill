# OpenPill history service

OpenPill history is optional. Configuring Wi-Fi leaves uploads off. In Pill
settings, choose **OpenPill history (free)** and save to opt in. The Pill must
report no more often than every 15 minutes. Bluetooth readings continue to be
stored locally by the PWA. When a history read key is present, the PWA fetches
only server events after its latest saved server timestamp. It shows Bluetooth
and server readings together and hides a server reading that matches a nearby
local reading.

The Pill generates a P-256 signing key in the `ophistory` namespace of the
existing NVS partition. The partition table is unchanged. The PWA generates a
separate 32-byte read key and keeps it in this browser's local storage. Only its
SHA-256 hash is sent to the Pill. The Pill signs each upload with its private
key. Anyone with the read key can read and share that Pill's history; copy the
key in Pill settings and import it on another phone. Losing every copy of the
read key means losing access to the existing server history. **Start new
history** in Pill settings rotates its signing identity and read key binding;
old history expires normally and cannot be recovered with the new key.

## Upload protocol v1 and history sync v2

`POST /v1/readings` uses `Content-Type: application/octet-stream` and an
exactly 25-byte body containing the complete BLE manufacturer value, including
`RAPT` and version 2. Headers:

- `X-OpenPill-Key`: base64url uncompressed 65-byte P-256 public key
- `X-OpenPill-Read-Hash`: lowercase SHA-256 hex of the read key
- `X-OpenPill-Signature`: base64url DER ECDSA signature over SHA-256 of
  `OpenPill history upload v1\0` + 32-byte read hash + 25-byte body

The server derives the history ID as SHA-256 hex of the public key. It returns
`202` after placing a valid reading in its RAM write queue and `429` for another
upload within 15 minutes. A queued reading can be lost if the server stops
before the next flush, normally within one minute. The server assigns the
receipt timestamp; Pill wall-clock time and sequence numbers are unnecessary.

`GET /v1/history/<history-id>?after=<microseconds>` requires
`Authorization: Bearer <base64url-read-key>`. It returns up to 1024 chronological
events as `application/vnd.openpill.history-v2`. Each event has an unsigned
8-byte big-endian Unix microsecond server timestamp, a one-byte type, a
two-byte big-endian payload length, then the payload. Type 0 carries the
unchanged 25-byte reading. Type 1 carries a four-byte big-endian profile
revision followed by the full UTF-8 JSON profile document. `X-Record-Count`
reports the number of events and `X-Next-After` the last timestamp. The PWA
saves one cursor for both event types in IndexedDB after applying the page.
An empty response has zero body bytes.

## Calibration profiles

The PWA derives tilt from the three acceleration values already present in the
25-byte reading. It keeps the original packet unchanged. Calibration profiles
contain a start time, optional dry assembled mass, and timestamped reference
gravity points. A point entered without Bluetooth uses linear interpolation
between nearby readings before and after its measurement time. It remains
pending until a later reading arrives. A new profile begins when the Pill is
opened or its balance changes; older readings use the earlier profile.

The PWA fits a floating-body force and torque model to the points. Its starting
housing geometry is an approximate 37 mm diameter, 125 mm long rounded capsule.
Measured mass lets the fit vary effective length to account for cap closure;
without measured mass, it fixes length at 125 mm and fits effective mass. The
physical fit should be checked against reference gravities spread across the
intended range. The housing contour has not been measured precisely.

`pills.sqlite` holds the current profile document and revision in a `profiles`
table keyed to the Pill's metadata row. Daily SQLite files have separate
`readings` and `profile_events` tables, both indexed by Pill and server timestamp.
History sync merges the two tables by timestamp. Profile changes are full
documents so the PWA can replace its local copy and recalculate historical
gravity. When a profile event has aged out with its daily file, a new phone
receives the current document from the metadata snapshot on its first sync.
`GET /v1/profiles/<history-id>` uses the read key and returns a versioned JSON
document with an `ETag` revision. `PUT` uses a separate control key, requires
`If-Match` with the last revision, and is limited to 16 KiB, 16 profiles, and
16 reference points per profile. The PWA caches profiles locally and retries a
local pending change when it next syncs. Normal history sync delivers profile
changes without a separate profile GET. The profile GET remains available for
editing and conflict resolution. The PWA applies profiles to historical raw
tilt readings locally; the server does not calculate gravity.

To bind or rotate a control key, a phone with physical Bluetooth access gets a
five-minute, one-use challenge from `GET /v1/control/<history-id>` using the read
key. It asks the Pill to sign `OpenPill history control v1\0` followed by the
32-byte SHA-256 hash of the control key and the 32-byte challenge. It sends the
hash, challenge, and DER signature to `PUT /v1/control/<history-id>`. The server verifies the Pill's signing key and
stores only the control-key hash. Sharing the read key grants history access;
sharing both keys grants calibration control.

The latest fitted profile carries a 91-sample gravity curve derived from the
physical model at integer tilt degrees. A history POST response contains
`OPC1` followed by 91 big-endian 16-bit SG values multiplied by 10,000. Zero
means the model has no result at that angle. `OPC0` clears the previous curve
when a new profile is pending. The Pill interpolates the curve on later readings
and retains it through deep sleep in RTC memory; a full power loss requires a
new history connection to reload it. The previous gravity calculation remains
the fallback where no fitted sample is available. No new NVS data is written
for calibration or control keys.

## Server operation

Run Node 22.13 or newer:

```sh
cd server
npm start
```

`OPENPILL_BIND` defaults to `127.0.0.1`, `OPENPILL_PORT` to `8040`, and
`OPENPILL_DATA_DIR` to `server/data`. Keep the data directory on persistent
storage and back it up if desired. Restrict the local listener to loopback and
route `openpill.yeast.win` through Cloudflare Tunnel to `http://127.0.0.1:8040`.
The default CORS origins are the GitHub Pages PWA, the service hostname, and
local Vite development; override with `OPENPILL_ORIGINS` if the PWA moves.
Protect the public endpoint with Cloudflare rate limiting because each newly
generated signing key can start a new history.

The SQLite worker keeps Pill metadata and current calibration profiles in
`pills.sqlite`; readings and profile events live in one SQLite file per UTC day,
keyed by a small integer Pill ordinal and timestamp.
Writes are grouped in RAM and committed every minute. A daily sweep
removes whole day files older than 90 days and old Pill metadata. An active
day's file uses WAL; the worker checkpoints it periodically. The 90-day limit
is approximate at day boundaries. No older readings are aggregated.

Run the local integration test with `npm test` from `server/`. Neither the
server nor firmware has been deployed merely by building this repository.
