#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define HARDWARE_SAMPLE_VERSION 2

#define HARDWARE_VALID_ACCEL (1U << 0)
#define HARDWARE_VALID_TEMPERATURE (1U << 1)
#define HARDWARE_VALID_BATTERY (1U << 2)
#define HARDWARE_VALID_CHARGER (1U << 3)

typedef struct {
    uint8_t version;
    uint8_t valid;
    uint8_t charger_connected;
    uint8_t led_brightness;
    int16_t accel_x_mg;
    int16_t accel_y_mg;
    int16_t accel_z_mg;
    int16_t temperature_centi_c;
    int16_t battery_adc_raw;
    uint16_t battery_mv;
} hardware_sample_t;

typedef struct {
    uint8_t status;
    uint8_t ctrl1;
    uint8_t ctrl4;
    uint8_t temp_cfg;
    int16_t adc[3];
} hardware_adc_diagnostics_t;

typedef enum {
    HARDWARE_ORIENTATION_UNKNOWN = 0,
    HARDWARE_ORIENTATION_HORIZONTAL,
    HARDWARE_ORIENTATION_FLOATING,
    HARDWARE_ORIENTATION_VERTICAL,
} hardware_orientation_t;

esp_err_t hardware_init(void);
esp_err_t hardware_read(hardware_sample_t *sample);
esp_err_t hardware_read_adc_diagnostics(hardware_adc_diagnostics_t *diagnostics);
esp_err_t hardware_read_stable(hardware_sample_t *sample);
bool hardware_external_power_present(void);
hardware_orientation_t hardware_orientation(const hardware_sample_t *sample);
float hardware_tilt_degrees(const hardware_sample_t *sample);
esp_err_t hardware_prepare_motion_wake(void);
esp_err_t hardware_set_led(uint8_t brightness);
uint8_t hardware_get_led(void);
void hardware_led_flash(unsigned count, uint32_t on_ms, uint32_t off_ms);
void hardware_led_sos_twice(void);
