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
- The battery measurement path currently selects the LIS3DH's auxiliary ADC2
  registers (`OUT_ADC2_L/H`), not ESP32 ADC2. The board also has a stored
  charging endpoint in `nvs:adc_cal`; OpenPill reads it without modifying NVS.
  The physical input routing and voltage conversion still need validation.
  On this Pill, ADC2 reads close to its negative limit while battery-terminal
  voltage changes, so its reported battery voltage and percentage are wrong.
- GPIO23 is charger-present/USB detect and is active-low.
- GPIO34 is used as OpenPill's deep-sleep wake input from the LIS3DH interrupt
  line. Firmware tests that the sensor can assert this input before relying on
  it. The connection and wake reliability still need physical validation; a
  failed test enables a 60-second timer fallback.
- The board includes a `4056`-marked TP4056-compatible Li-ion charger, plus a
  switching/power section near the `2R2` inductor and discrete MOSFET/diodes.

### Battery ADC investigation

The ADC diagnostic uses the LIS3DH's 10-bit, two's-complement results. Recent
measurements paired with a meter at the battery terminals were:

| Battery terminals | Charger | ADC1 | ADC2 | ADC3 |
| ---: | --- | ---: | ---: | ---: |
| about 3.38 V | disconnected | 62 | -508 | -172 |
| 3.45 V | connected | 42 | -508 | -199 |
| 3.56 V | disconnected | 18 | -508 | -197 |

The first pairing followed a charging/unplugging cycle, so its battery voltage
is less precise. ADC2 is effectively fixed near the -512 limit and currently
produces a false 4.189 V / 100% reading. ADC1 moves inversely as battery
voltage rises; ADC3 does not move consistently. That correlation does not yet
identify the battery divider's physical connection. Measure the divider node
and the LIS3DH input path before changing the selected channel or conversion.

With the battery terminals at 3.57 V, a meter read 3.56 V at R1's left pad,
3.18 V at the R1-right/R2-left junction, and 3.29 V at R2's right pad (all
relative to ground). These points do not show a simple two-resistor divider
from the battery to ground. The junction being below both outer pads also
means the readings alone cannot establish a passive series circuit; other
connections, circuit state, or measurement timing matter. Neither R1/R2 pad
shows the approximately 1.2 V input expected of a 3:1 battery divider. A
matching BLE ADC reading was unavailable because the Pill was not advertising.
After BLE advertising resumed with the charger connected, two readings a few
seconds apart reported ADC1/ADC2/ADC3 as `-265/-508/-243` and
`-296/-508/-496`; both reported 4.189 V / 100% battery. ADC1 and ADC3 can
change substantially over seconds while ADC2 remains at its negative limit,
so the earlier ADC1/battery correlation is insufficient to identify a battery
input. Battery-terminal voltage was not measured concurrently with these two
BLE readings.

With the charger still connected, the meter subsequently read 3.57 V at the
battery terminals. A contemporaneous BLE reading reported ADC1/ADC2/ADC3 as
`-296/-508/-231` and battery as 4.189 V / 100%, an error of +0.619 V against
the meter. ADC2 was still fixed at its negative limit.

With the battery terminals later at 3.64 V and the charger connected, two
consecutive BLE diagnostics reported ADC1/ADC2/ADC3 as `-508/-508/-310` and
`-508/-508/-508`. Both still reported 4.189 V / 100% battery. All three
auxiliary ADC channels can therefore reach the same near-limit value; this
observation alone does not identify a defective ADC2 input or a divider fault.

The battery read now waits for the LIS3DH's XYZ fresh-data flag, reads XYZ and
ADC2 four times, and averages the four ADC2 results. Each wait has an eight
RTOS-tick limit. If that sequence fails, a single direct ADC2 read preserves
BLE recovery; the sensor sample marks only a completed fresh sequence. Temperature
still comes from one TMP1075 register read; it does not share this sampling
sequence.

A BLE read after installing this sequence confirmed the four-sample flag and
still reported ADC2 raw `-127`, 4.189 V, and 100% with the charger connected.
Waiting for fresh XYZ samples and averaging ADC2 does not explain the incorrect
battery estimate on this Pill.

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

