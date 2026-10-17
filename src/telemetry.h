#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "hardware.h"

/* Complete manufacturer-specific value, including RAPT's 0x4152 company ID. */
#define TELEMETRY_PAYLOAD_LENGTH 25

esp_err_t telemetry_encode(uint8_t output[TELEMETRY_PAYLOAD_LENGTH]);
esp_err_t telemetry_encode_sample(const hardware_sample_t *sample,
                                  uint8_t output[TELEMETRY_PAYLOAD_LENGTH]);
float telemetry_gravity(const hardware_sample_t *sample);
float telemetry_battery_percent(uint16_t millivolts);

