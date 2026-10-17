// Same voltage-to-charge curve used for BLE telemetry. This is an estimate,
// particularly while charging or under load.
const charge = [
  1, .9953, .9828, .9561, .9326, .9107, .8793, .8542, .8292, .7853,
  .7398, .6897, .6113, .5219, .4530, .4216, .3903, .3511, .3229,
  .2962, .2696, .2398, .2085, .1693, .1458, .1144, .0862, .0643,
  .0455, .0298, .0204, .0110, 0
];
const voltage = [
  4.1944, 4.1441, 4.1089, 4.0737, 4.0536, 4.0436, 4.0335, 4.0184,
  3.9933, 3.9430, 3.8927, 3.8425, 3.7721, 3.6816, 3.6162, 3.5911,
  3.5609, 3.5156, 3.4804, 3.4654, 3.4352, 3.3799, 3.3095, 3.2240,
  3.1687, 3.1134, 3.0480, 2.9726, 2.8872, 2.8067, 2.7363, 2.6358,
  2.5050
];

export function batteryPercentFromMv(millivolts: number): number {
  const volts = millivolts / 1000;
  if (volts >= voltage[0]) return 100;
  if (volts <= voltage[voltage.length - 1]) return 0;
  for (let i = 1; i < voltage.length; i++) {
    if (volts >= voltage[i]) {
      const fraction = (volts - voltage[i]) / (voltage[i - 1] - voltage[i]);
      return (charge[i] + fraction * (charge[i - 1] - charge[i])) * 100;
    }
  }
  return 0;
}
