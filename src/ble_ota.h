#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "hardware.h"

esp_err_t ble_ota_run_maintenance(uint32_t timeout_seconds,
                                  const hardware_sample_t *sample);
esp_err_t ble_ota_send_telemetry(const hardware_sample_t *sample);
