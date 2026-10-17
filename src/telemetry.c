#include "telemetry.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "hardware.h"
#include "vendor_calibration.h"

#define RAPT_PACKET_VERSION 2
#define DEGREES_PER_RADIAN 57.29577951308232f

static const float battery_charge[] = {
    1.0000f, 0.9953f, 0.9828f, 0.9561f, 0.9326f, 0.9107f, 0.8793f,
    0.8542f, 0.8292f, 0.7853f, 0.7398f, 0.6897f, 0.6113f, 0.5219f,
    0.4530f, 0.4216f, 0.3903f, 0.3511f, 0.3229f, 0.2962f, 0.2696f,
    0.2398f, 0.2085f, 0.1693f, 0.1458f, 0.1144f, 0.0862f, 0.0643f,
    0.0455f, 0.0298f, 0.0204f, 0.0110f, 0.0000f,
};

static const float battery_voltage[] = {
    4.1944f, 4.1441f, 4.1089f, 4.0737f, 4.0536f, 4.0436f, 4.0335f,
    4.0184f, 3.9933f, 3.9430f, 3.8927f, 3.8425f, 3.7721f, 3.6816f,
    3.6162f, 3.5911f, 3.5609f, 3.5156f, 3.4804f, 3.4654f, 3.4352f,
    3.3799f, 3.3095f, 3.2240f, 3.1687f, 3.1134f, 3.0480f, 2.9726f,
    2.8872f, 2.8067f, 2.7363f, 2.6358f, 2.5050f,
};

static void write_be16(uint8_t *output, uint16_t value)
{
    output[0] = (uint8_t)(value >> 8);
    output[1] = (uint8_t)value;
}

static void write_be_float(uint8_t *output, float value)
{
    uint32_t bits;
    memcpy(&bits, &value, sizeof(bits));
    output[0] = (uint8_t)(bits >> 24);
    output[1] = (uint8_t)(bits >> 16);
    output[2] = (uint8_t)(bits >> 8);
    output[3] = (uint8_t)bits;
}

static int16_t clamp_i16(int32_t value)
{
    if (value > INT16_MAX) {
        return INT16_MAX;
    }
    if (value < INT16_MIN) {
        return INT16_MIN;
    }
    return (int16_t)value;
}

float telemetry_battery_percent(uint16_t millivolts)
{
    float voltage = millivolts / 1000.0f;
    size_t count = sizeof(battery_voltage) / sizeof(battery_voltage[0]);
    if (voltage >= battery_voltage[0]) {
        return 100.0f;
    }
    if (voltage <= battery_voltage[count - 1]) {
        return 0.0f;
    }

    for (size_t i = 1; i < count; ++i) {
        if (voltage >= battery_voltage[i]) {
            float fraction = (voltage - battery_voltage[i]) /
                             (battery_voltage[i - 1] - battery_voltage[i]);
            float charge = battery_charge[i] +
                           fraction * (battery_charge[i - 1] - battery_charge[i]);
            return charge * 100.0f;
        }
    }
    return 0.0f;
}

float telemetry_gravity(const hardware_sample_t *sample)
{
    if (sample == NULL || !(sample->valid & HARDWARE_VALID_ACCEL)) {
        return NAN;
    }
    float x = sample->accel_x_mg;
    float y = sample->accel_y_mg;
    float z = sample->accel_z_mg;
    float angle = atan2f(sqrtf(y * y + z * z), x) * DEGREES_PER_RADIAN;
    if (angle > 90.0f) {
        angle = 90.0f;
    }
    return vendor_calibration_gravity(angle);
}

esp_err_t telemetry_encode_sample(const hardware_sample_t *sample,
                                  uint8_t output[TELEMETRY_PAYLOAD_LENGTH])
{
    if (sample == NULL || output == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(output, 0, TELEMETRY_PAYLOAD_LENGTH);

    /* 0x4152 is encoded little-endian by BLE, followed by "PT". Parsers see
     * the four-byte signature "RAPT" at the start of manufacturer data. */
    memcpy(output, "RAPT", 4);
    output[4] = RAPT_PACKET_VERSION;
    output[5] = 0; /* Reserved. */
    output[6] = 0; /* Gravity velocity is not yet available. */
    write_be_float(output + 7, 0.0f);

    if (sample->valid & HARDWARE_VALID_TEMPERATURE) {
        int32_t kelvin_128 = ((int32_t)sample->temperature_centi_c + 27315) * 128;
        kelvin_128 = (kelvin_128 + 50) / 100;
        write_be16(output + 11, (uint16_t)kelvin_128);
    }

    if (sample->valid & HARDWARE_VALID_ACCEL) {
        write_be_float(output + 13, telemetry_gravity(sample));
        write_be16(output + 17, (uint16_t)clamp_i16((int32_t)sample->accel_x_mg * 16));
        write_be16(output + 19, (uint16_t)clamp_i16((int32_t)sample->accel_y_mg * 16));
        write_be16(output + 21, (uint16_t)clamp_i16((int32_t)sample->accel_z_mg * 16));
    }

    if (sample->valid & HARDWARE_VALID_BATTERY) {
        int32_t encoded = lroundf(telemetry_battery_percent(sample->battery_mv) * 256.0f);
        write_be16(output + 23, (uint16_t)clamp_i16(encoded));
    }
    return ESP_OK;
}

esp_err_t telemetry_encode(uint8_t output[TELEMETRY_PAYLOAD_LENGTH])
{
    hardware_sample_t sample;
    esp_err_t error = hardware_read(&sample);
    esp_err_t encode_error = telemetry_encode_sample(&sample, output);
    return error != ESP_OK ? error : encode_error;
}

