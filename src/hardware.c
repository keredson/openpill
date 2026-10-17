#include "hardware.h"

#include <stdbool.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/ledc.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "vendor_calibration.h"

#define SENSOR_I2C_PORT I2C_NUM_0
#define SENSOR_I2C_SDA GPIO_NUM_25
#define SENSOR_I2C_SCL GPIO_NUM_26
#define SENSOR_I2C_HZ 100000

#define LIS3DH_ADDRESS 0x19
#define LIS3DH_WHO_AM_I 0x0f
#define LIS3DH_WHO_AM_I_VALUE 0x33
#define LIS3DH_TEMP_CFG_REG 0x1f
#define LIS3DH_CTRL_REG1 0x20
#define LIS3DH_CTRL_REG2 0x21
#define LIS3DH_CTRL_REG3 0x22
#define LIS3DH_CTRL_REG4 0x23
#define LIS3DH_CTRL_REG5 0x24
#define LIS3DH_REFERENCE 0x26
#define LIS3DH_INT1_CFG 0x30
#define LIS3DH_INT1_SRC 0x31
#define LIS3DH_INT1_THS 0x32
#define LIS3DH_INT1_DURATION 0x33
#define LIS3DH_OUT_ADC2_L 0x0a
#define LIS3DH_OUT_X_L 0x28
#define LIS3DH_AUTO_INCREMENT 0x80

#define TMP1075_ADDRESS 0x48
#define TMP1075_TEMPERATURE_REG 0x00
#define TMP1075_DEVICE_ID_REG 0x0f
#define TMP1075_DEVICE_ID 0x7500

#define CHARGER_PRESENT_GPIO GPIO_NUM_23
#define ACCEL_INTERRUPT_GPIO GPIO_NUM_34
#define STATUS_LED_GPIO GPIO_NUM_18
#define STATUS_LED_TIMER LEDC_TIMER_0
#define STATUS_LED_CHANNEL LEDC_CHANNEL_0
#define STATUS_LED_MAX_DUTY 1023

static bool lis3dh_available;
static bool tmp1075_available;
static uint8_t led_brightness;
static SemaphoreHandle_t sensor_mutex;

static esp_err_t i2c_read(uint8_t address, uint8_t reg, uint8_t *data, size_t length)
{
    return i2c_master_write_read_device(SENSOR_I2C_PORT, address, &reg, 1, data,
                                        length, pdMS_TO_TICKS(100));
}

static esp_err_t i2c_write_u8(uint8_t address, uint8_t reg, uint8_t value)
{
    uint8_t command[2] = {reg, value};
    return i2c_master_write_to_device(SENSOR_I2C_PORT, address, command,
                                      sizeof(command), pdMS_TO_TICKS(100));
}

static int16_t read_le_i16(const uint8_t *value)
{
    return (int16_t)((uint16_t)value[0] | ((uint16_t)value[1] << 8));
}

static esp_err_t init_lis3dh(void)
{
    uint8_t who_am_i = 0;
    esp_err_t error = i2c_read(LIS3DH_ADDRESS, LIS3DH_WHO_AM_I, &who_am_i, 1);
    if (error != ESP_OK) {
        return error;
    }
    if (who_am_i != LIS3DH_WHO_AM_I_VALUE) {
        printf("Hardware: LIS3DH returned WHO_AM_I=0x%02x\n", who_am_i);
        return ESP_ERR_INVALID_RESPONSE;
    }

    /* 25 Hz, XYZ enabled, block-data update, high-resolution +/-2 g, and
     * auxiliary ADC enabled. */
    if ((error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG1, 0x37)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG4, 0x88)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_TEMP_CFG_REG, 0x80)) != ESP_OK) {
        return error;
    }
    return ESP_OK;
}

static esp_err_t init_tmp1075(void)
{
    uint8_t id[2] = {0};
    esp_err_t error = i2c_read(TMP1075_ADDRESS, TMP1075_DEVICE_ID_REG, id, sizeof(id));
    if (error != ESP_OK) {
        return error;
    }
    uint16_t device_id = ((uint16_t)id[0] << 8) | id[1];
    if (device_id != TMP1075_DEVICE_ID) {
        printf("Hardware: TMP1075 returned device ID 0x%04x\n", device_id);
        return ESP_ERR_INVALID_RESPONSE;
    }
    return ESP_OK;
}

esp_err_t hardware_set_led(uint8_t brightness)
{
    /* LEDC output inversion makes duty 0 off and duty 1023 fully on even
     * though the board's status LED is wired active-low. */
    uint32_t duty = ((uint32_t)brightness * STATUS_LED_MAX_DUTY + 127) / 255;
    esp_err_t error = ledc_set_duty_and_update(LEDC_LOW_SPEED_MODE,
                                               STATUS_LED_CHANNEL, duty, 0);
    if (error == ESP_OK) {
        led_brightness = brightness;
    }
    return error;
}

uint8_t hardware_get_led(void)
{
    return led_brightness;
}

bool hardware_external_power_present(void)
{
    return gpio_get_level(CHARGER_PRESENT_GPIO) == 0;
}

esp_err_t hardware_init(void)
{
    sensor_mutex = xSemaphoreCreateMutex();
    if (sensor_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    gpio_config_t charger = {
        .pin_bit_mask = 1ULL << CHARGER_PRESENT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&charger), "hardware", "charger GPIO");

    gpio_config_t accel_interrupt = {
        .pin_bit_mask = 1ULL << ACCEL_INTERRUPT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&accel_interrupt), "hardware",
                        "accelerometer interrupt GPIO");

    ledc_timer_config_t led_timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = STATUS_LED_TIMER,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_RETURN_ON_ERROR(ledc_timer_config(&led_timer), "hardware", "LED timer");
    ledc_channel_config_t led_channel = {
        .gpio_num = STATUS_LED_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = STATUS_LED_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = STATUS_LED_TIMER,
        .duty = 0,
        .hpoint = 0,
        .flags.output_invert = 1,
    };
    ESP_RETURN_ON_ERROR(ledc_channel_config(&led_channel), "hardware", "LED channel");
    ESP_RETURN_ON_ERROR(ledc_fade_func_install(0), "hardware", "LED fade service");

    i2c_config_t i2c = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = SENSOR_I2C_SDA,
        .scl_io_num = SENSOR_I2C_SCL,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = SENSOR_I2C_HZ,
        .clk_flags = 0,
    };
    ESP_RETURN_ON_ERROR(i2c_param_config(SENSOR_I2C_PORT, &i2c), "hardware", "I2C config");
    ESP_RETURN_ON_ERROR(i2c_driver_install(SENSOR_I2C_PORT, I2C_MODE_MASTER, 0, 0, 0),
                        "hardware", "I2C install");

    esp_err_t accel_error = init_lis3dh();
    lis3dh_available = accel_error == ESP_OK;
    printf("Hardware: LIS3DH at 0x%02x: %s\n", LIS3DH_ADDRESS,
           lis3dh_available ? "ready" : esp_err_to_name(accel_error));

    esp_err_t temp_error = init_tmp1075();
    tmp1075_available = temp_error == ESP_OK;
    printf("Hardware: TMP1075 at 0x%02x: %s\n", TMP1075_ADDRESS,
           tmp1075_available ? "ready" : esp_err_to_name(temp_error));
    printf("Hardware: status LED GPIO18; charger detect GPIO23 active-low\n");

    return (lis3dh_available || tmp1075_available) ? ESP_OK : ESP_FAIL;
}

esp_err_t hardware_read(hardware_sample_t *sample)
{
    if (sample == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (sensor_mutex == NULL ||
        xSemaphoreTake(sensor_mutex, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    memset(sample, 0, sizeof(*sample));
    sample->version = HARDWARE_SAMPLE_VERSION;
    sample->led_brightness = led_brightness;
    sample->charger_connected = hardware_external_power_present();
    sample->valid |= HARDWARE_VALID_CHARGER;

    esp_err_t first_error = ESP_OK;
    if (lis3dh_available) {
        uint8_t xyz[6];
        uint8_t reg = LIS3DH_OUT_X_L | LIS3DH_AUTO_INCREMENT;
        esp_err_t error = i2c_read(LIS3DH_ADDRESS, reg, xyz, sizeof(xyz));
        if (error == ESP_OK) {
            /* In high-resolution +/-2 g mode, the left-aligned 12-bit result
             * has a sensitivity of 1 mg/LSB. */
            sample->accel_x_mg = read_le_i16(xyz) >> 4;
            sample->accel_y_mg = read_le_i16(xyz + 2) >> 4;
            sample->accel_z_mg = read_le_i16(xyz + 4) >> 4;
            sample->valid |= HARDWARE_VALID_ACCEL;
        } else {
            first_error = error;
        }

        uint8_t adc[2];
        reg = LIS3DH_OUT_ADC2_L | LIS3DH_AUTO_INCREMENT;
        error = i2c_read(LIS3DH_ADDRESS, reg, adc, sizeof(adc));
        if (error == ESP_OK) {
            /* The battery divider is connected to LIS3DH auxiliary ADC2. Its
             * calibrated representation uses the signed high byte of this
             * left-aligned sample. */
            int16_t raw = (int8_t)adc[1];
            sample->battery_adc_raw = raw;
            sample->battery_mv = vendor_calibration_battery_mv(raw);
            sample->valid |= HARDWARE_VALID_BATTERY;
        } else if (first_error == ESP_OK) {
            first_error = error;
        }
    }

    if (tmp1075_available) {
        uint8_t temperature[2];
        esp_err_t error = i2c_read(TMP1075_ADDRESS, TMP1075_TEMPERATURE_REG,
                                   temperature, sizeof(temperature));
        if (error == ESP_OK) {
            int16_t raw = (int16_t)(((uint16_t)temperature[0] << 8) | temperature[1]);
            sample->temperature_centi_c = (int16_t)(((int32_t)raw * 100) / 256);
            sample->valid |= HARDWARE_VALID_TEMPERATURE;
        } else if (first_error == ESP_OK) {
            first_error = error;
        }
    }

    xSemaphoreGive(sensor_mutex);
    return first_error;
}

esp_err_t hardware_read_stable(hardware_sample_t *sample)
{
    if (sample == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    int32_t x = 0;
    int32_t y = 0;
    int32_t z = 0;
    hardware_sample_t latest = {0};
    unsigned valid_samples = 0;
    for (unsigned i = 0; i < 10; ++i) {
        /* A temperature or auxiliary-ADC error must not discard a valid
         * accelerometer reading used to select the power state. */
        (void)hardware_read(&latest);
        if (latest.valid & HARDWARE_VALID_ACCEL) {
            x += latest.accel_x_mg;
            y += latest.accel_y_mg;
            z += latest.accel_z_mg;
            ++valid_samples;
        }
        if (i + 1 < 10) {
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }
    if (valid_samples == 0) {
        *sample = latest;
        return ESP_FAIL;
    }
    *sample = latest;
    sample->accel_x_mg = (int16_t)(x / (int32_t)valid_samples);
    sample->accel_y_mg = (int16_t)(y / (int32_t)valid_samples);
    sample->accel_z_mg = (int16_t)(z / (int32_t)valid_samples);
    sample->valid |= HARDWARE_VALID_ACCEL;
    return ESP_OK;
}

float hardware_tilt_degrees(const hardware_sample_t *sample)
{
    if (sample == NULL || !(sample->valid & HARDWARE_VALID_ACCEL)) {
        return NAN;
    }
    float x = sample->accel_x_mg;
    float y = sample->accel_y_mg;
    float z = sample->accel_z_mg;
    float angle = atan2f(sqrtf(y * y + z * z), fabsf(x)) * 57.29577951308232f;
    return angle > 90.0f ? 90.0f : angle;
}

hardware_orientation_t hardware_orientation(const hardware_sample_t *sample)
{
    float angle = hardware_tilt_degrees(sample);
    if (!isfinite(angle)) {
        return HARDWARE_ORIENTATION_UNKNOWN;
    }
    if (angle <= 15.0f) {
        return HARDWARE_ORIENTATION_VERTICAL;
    }
    if (angle >= 78.0f) {
        return HARDWARE_ORIENTATION_HORIZONTAL;
    }
    return HARDWARE_ORIENTATION_FLOATING;
}

esp_err_t hardware_prepare_motion_wake(void)
{
    if (!lis3dh_available) {
        return ESP_ERR_INVALID_STATE;
    }

    /* First prove that the LIS3DH interrupt actually reaches the ESP32 wake
     * input. With the high-pass filter off, gravity must exceed a 1/16 g
     * threshold on at least one axis, irrespective of its sign. */
    esp_err_t error;
    if ((error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG3, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_CFG, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG1, 0x37)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG2, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG5, 0x08)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_THS, 0x01)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_DURATION, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_CFG, 0x3f)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG3, 0x40)) != ESP_OK) {
        return error;
    }
    vTaskDelay(pdMS_TO_TICKS(100));
    bool wake_line_connected = gpio_get_level(ACCEL_INTERRUPT_GPIO) == 1;
    uint8_t source = 0;
    error = i2c_read(LIS3DH_ADDRESS, LIS3DH_INT1_SRC, &source, 1);
    if (error != ESP_OK) {
        return error;
    }
    if (!wake_line_connected) {
        printf("Power: LIS3DH interrupt did not reach GPIO34 (source=0x%02x)\n",
               source);
        return ESP_ERR_INVALID_RESPONSE;
    }

    /* Re-arm at 25 Hz with a 250 mg threshold and no extra duration. Reset
     * the high-pass reference to the current orientation before enabling the
     * interrupt so a stationary Pill does not immediately wake itself. */
    uint8_t reference = 0;
    if ((error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG3, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_CFG, 0x00)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG2, 0x01)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_THS, 0x10)) != ESP_OK ||
        (error = i2c_read(LIS3DH_ADDRESS, LIS3DH_REFERENCE, &reference, 1)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_INT1_CFG, 0x3f)) != ESP_OK ||
        (error = i2c_write_u8(LIS3DH_ADDRESS, LIS3DH_CTRL_REG3, 0x40)) != ESP_OK) {
        return error;
    }
    vTaskDelay(pdMS_TO_TICKS(40));
    error = i2c_read(LIS3DH_ADDRESS, LIS3DH_INT1_SRC, &source, 1);
    if (error != ESP_OK) {
        return error;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
    if (gpio_get_level(ACCEL_INTERRUPT_GPIO) != 0) {
        printf("Power: LIS3DH wake line remained asserted (source=0x%02x)\n",
               source);
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}

void hardware_led_flash(unsigned count, uint32_t on_ms, uint32_t off_ms)
{
    for (unsigned i = 0; i < count; ++i) {
        (void)hardware_set_led(180);
        vTaskDelay(pdMS_TO_TICKS(on_ms));
        (void)hardware_set_led(0);
        if (i + 1 < count) {
            vTaskDelay(pdMS_TO_TICKS(off_ms));
        }
    }
}

void hardware_led_sos_twice(void)
{
    const uint32_t unit = 120;
    for (unsigned repeat = 0; repeat < 2; ++repeat) {
        for (unsigned group = 0; group < 3; ++group) {
            uint32_t on = group == 1 ? unit * 3 : unit;
            for (unsigned pulse = 0; pulse < 3; ++pulse) {
                (void)hardware_set_led(180);
                vTaskDelay(pdMS_TO_TICKS(on));
                (void)hardware_set_led(0);
                if (pulse < 2) {
                    vTaskDelay(pdMS_TO_TICKS(unit));
                }
            }
            if (group < 2) {
                vTaskDelay(pdMS_TO_TICKS(unit * 3));
            }
        }
        if (repeat == 0) {
            vTaskDelay(pdMS_TO_TICKS(unit * 7));
        }
    }
    (void)hardware_set_led(0);
}
