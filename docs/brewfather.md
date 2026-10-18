# Brewfather reporting

For a direct OpenPill integration, use Brewfather's **Custom Stream** endpoint.
The owner enables **Settings → Power-ups → Custom Stream** in Brewfather and
copies the logging ID from the generated URL. Send an HTTPS POST to
`https://log.brewfather.net/stream?id=<logging-id>` with
`Content-Type: application/json` and a body such as:

```json
{
  "name": "OpenPill-1234",
  "temp": 20.3,
  "temp_unit": "C",
  "gravity": 1.042,
  "gravity_unit": "G"
}
```

`name` is required and must distinguish each device. At least one measured
value is required. `gravity` is specific gravity when `gravity_unit` is `G`;
`temp` is Celsius when `temp_unit` is `C`. Optional fields include `battery`
**in volts**, `angle`, and `rssi`. Do not put OpenPill's battery percentage
in Brewfather's `battery` field. The logging ID is a credential and should
be kept private.

Brewfather ignores Custom Stream updates sent more often than once every
15 minutes **per device name**. For our planned history service, accept at
most one report per Pill every 15 minutes too. This is separate from the
server's RAM-to-SQLite flush timer; the local benchmark found little CPU
difference across 1–300-second flushes and suggests starting at 5 seconds.

The existing RAPT Cloud power-up uses **Pill → RAPT Cloud → Brewfather**.
Brewfather documents its setup and logged fields, but does not specify the
power-up's request body. Custom Stream is the documented direct interface.
OpenPill's current configurable Wi-Fi POST sends its own JSON schema
(`device_id`, `temperature_c`, `battery_percent`, and `gravity`), so pointing
that endpoint at Custom Stream is not yet a complete Brewfather integration.
The proposed 25-byte binary upload to our history service likewise needs
conversion to Brewfather JSON before forwarding.

Sources:

- [Brewfather Custom Stream](https://docs.brewfather.app/integrations/custom-stream)
- [Brewfather RAPT Cloud integration](https://docs.brewfather.app/integrations/rapt)
