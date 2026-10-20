#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

void openpill_calibration_clear(void);
bool openpill_calibration_apply(const uint8_t *data, size_t length);
float openpill_calibration_gravity(float angle_degrees);
