# OpenPill history service

OpenPill history is optional. Configuring Wi-Fi leaves uploads off. In Pill
settings, choose **OpenPill history (free)** and save to opt in. The Pill must
report no more often than every 15 minutes. Bluetooth readings continue to be
stored locally by the PWA. When a history read key is present, the PWA fetches
only server readings after its latest saved server timestamp. It shows Bluetooth
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

## Protocol v1

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
records as `application/vnd.openpill.history-v1`. Each record is an unsigned
8-byte big-endian Unix microsecond timestamp followed by the 25-byte body.
`X-Next-After` gives the next cursor. A successful empty response has zero
body bytes. The PWA saves pages in IndexedDB before advancing its cursor.

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

The SQLite worker keeps Pill metadata in `pills.sqlite` and readings in one
SQLite file per UTC day, keyed by a small integer Pill ordinal and timestamp.
Writes are grouped in RAM and committed every minute. A daily sweep
removes whole day files older than 90 days and old Pill metadata. An active
day's file uses WAL; the worker checkpoints it periodically. The 90-day limit
is approximate at day boundaries. No older readings are aggregated.

Run the local integration test with `npm test` from `server/`. Neither the
server nor firmware has been deployed merely by building this repository.
