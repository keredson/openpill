# Hardware notes

## Target

- Product: original RAPT Pill
- MCU: Espressif ESP32-S0WD revision 1.1
- CPU configuration: single core
- Flash: 4 MiB
- ROM serial downloader: accessible through the exposed UART, IO0, and EN pads
- Native USB: unavailable on this ESP32 generation

Connecting the Pill's USB connector produced no Linux USB device. The classic
ESP32 has no native USB peripheral and no USB-to-UART bridge is visible on the
board, so the connector is probably wired for charging/power only. This is more
likely a hardware limitation than firmware merely failing to enable USB.

## Exposed programming pads

The silkscreen/pad labels are `GND`, `TX`, `RX`, `100`, `EN`, and `3V3`.
`100` is understood to be `IO0`.

Current development-board bridge wiring:

| Bridge | Pill | Purpose |
| --- | --- | --- |
| GND | GND | Common reference |
| GPIO16 / RX | TX | Receive Pill UART |
| GPIO17 / TX | RX | Transmit to Pill UART |
| GPIO25 | EN | Open-drain reset control |
| GPIO26 | IO0 | Open-drain boot-mode control |

EN is active low. Grounding the development board's own EN pin resets the
bridge itself; it does not reliably hold the Pill in reset. Never jumper EN to
3V3 as a substitute for open-drain control.

## Sensors and power

- U1 is a Texas Instruments TMP1075-compatible digital temperature sensor at
  I2C address `0x48`. Its device ID is `0x7500`.
- U4 is an ST LIS3DH accelerometer at I2C address `0x19`. Its `WHO_AM_I` value
  is `0x33`. The sensor and temperature IC share I2C0 at 100 kHz on GPIO25
  (SDA) and GPIO26 (SCL).
- Battery voltage is routed through a nominal 3:1 divider to the LIS3DH's
  auxiliary ADC2 input. It is not connected to ESP32 ADC2. The vendor reads
  `OUT_ADC2_L/H` through its signed high byte and stores a charging endpoint in
  `nvs:adc_cal`. OpenPill imports that value through a direct
  read-only partition parser and reports both the raw value and calibrated
  millivolts. Missing or invalid calibration falls back to the nominal equation.
- GPIO23 is charger-present/USB detect and is active-low.
- GPIO34 is used as OpenPill's deep-sleep wake input from the LIS3DH interrupt
  line. Firmware tests that the sensor can assert this input before relying on
  it. The connection and wake reliability still need physical validation; a
  failed test enables a 60-second timer fallback.
- The board includes a `4056`-marked TP4056-compatible Li-ion charger, plus a
  switching/power section near the `2R2` inductor and discrete MOSFET/diodes.

## LEDs

- The one confirmed MCU-controlled status LED is on GPIO18. It is active-low;
  the vendor drives it with 5 kHz, 10-bit inverted PWM. OpenPill reserves it
  for firmware status: dim while advertising, brighter when connected, and
  full brightness while receiving an OTA image.
- The charge indicators associated with the TP4056-compatible charger are
  hardware-driven. No independent ESP32 control for them appears in the vendor
  firmware, so OpenPill does not attempt to drive them.

Reference PCB photo:

```text
/home/derek/Downloads/PXL_20261016_201736483.NIGHT.jpg
```

These assignments were recovered from the vendor application and cross-checked
against device identity registers. Do not assign other GPIOs from package
placement alone; confirm them by continuity testing or vendor-binary analysis.

