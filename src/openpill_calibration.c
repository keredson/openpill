#include "openpill_calibration.h"

#include <math.h>
#include <stdbool.h>
#include <string.h>

#include "esp_attr.h"
#include "vendor_calibration.h"

#define CURVE_MAGIC 0x4f504331U
#define CURVE_SAMPLES 91

typedef struct {
    uint32_t magic;
    uint16_t gravity_x10000[CURVE_SAMPLES];
} retained_curve_t;

RTC_DATA_ATTR static retained_curve_t retained_curve;

void openpill_calibration_clear(void)
{
    retained_curve.magic = 0;
}

bool openpill_calibration_apply(const uint8_t *data, size_t length)
{
    if (data == NULL || length < 4) return false;
    if (length == 4 && memcmp(data, "OPC0", 4) == 0) {
        openpill_calibration_clear();
        return true;
    }
    if (length != 4 + CURVE_SAMPLES * 2 || memcmp(data, "OPC1", 4) != 0)
        return false;
    uint16_t values[CURVE_SAMPLES];
    for (size_t index = 0; index < CURVE_SAMPLES; ++index) {
        uint16_t value = ((uint16_t)data[4 + 2 * index] << 8) | data[5 + 2 * index];
        if (value != 0 && (value < 7000 || value > 16000)) return false;
        values[index] = value;
    }
    memcpy(retained_curve.gravity_x10000, values, sizeof(values));
    retained_curve.magic = CURVE_MAGIC;
    return true;
}

float openpill_calibration_gravity(float angle_degrees)
{
    if (retained_curve.magic == CURVE_MAGIC && isfinite(angle_degrees) &&
        angle_degrees >= 0 && angle_degrees <= 90) {
        unsigned lower = (unsigned)angle_degrees;
        unsigned upper = lower < 90 ? lower + 1 : 90;
        uint16_t a = retained_curve.gravity_x10000[lower];
        uint16_t b = retained_curve.gravity_x10000[upper];
        if (a != 0 && b != 0) {
            float fraction = angle_degrees - lower;
            return (a + fraction * (b - a)) / 10.0f;
        }
    }
    return vendor_calibration_gravity(angle_degrees);
}
