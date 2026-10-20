#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* Reads the vendor NVS partition directly. This module has no write path and
 * deliberately does not initialize the ESP-IDF NVS subsystem. */
esp_err_t vendor_calibration_load(void);
bool vendor_calibration_has_gravity(void);
bool vendor_calibration_has_battery(void);
float vendor_calibration_gravity(float angle_degrees);
uint16_t vendor_calibration_battery_mv(int16_t adc_raw_10bit);

