#include <inttypes.h>
#include <stdio.h>

#include "app_config.h"
#include "bootloader_random.h"
#include "ble_ota.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_err.h"
#include "esp_ota_ops.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hardware.h"
#include "history_identity.h"
#include "vendor_calibration.h"
#include "wifi_report.h"

#define RTC_STATE_MAGIC 0x4f50494cU
#define ACCEL_WAKE_GPIO 34
#define SAFE_FALLBACK_WAKE_SECONDS 60
#define BLE_MAINTENANCE_WINDOW_SECONDS 300
#define UPDATE_WEEK_SECONDS (7U * 24U * 60U * 60U)
#define UPDATE_RETRY_SECONDS (24U * 60U * 60U)

typedef struct {
    uint32_t magic;
    bool vertical_latched;
    bool charger_known;
    bool charger_connected;
    bool update_enabled;
    uint32_t update_remaining_s;
    uint32_t planned_sleep_s;
} retained_state_t;

RTC_DATA_ATTR static retained_state_t retained;

static const char *orientation_name(hardware_orientation_t orientation)
{
    switch (orientation) {
    case HARDWARE_ORIENTATION_HORIZONTAL:
        return "horizontal";
    case HARDWARE_ORIENTATION_FLOATING:
        return "floating";
    case HARDWARE_ORIENTATION_VERTICAL:
        return "vertical";
    default:
        return "unknown";
    }
}

static void validate_running_image(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running == NULL) {
        return;
    }
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_ERROR_CHECK(esp_ota_mark_app_valid_cancel_rollback());
    }
}

static void enter_sleep(uint32_t timer_seconds, bool motion_wake)
{
    retained.planned_sleep_s = timer_seconds;
    (void)hardware_set_led(0);
    bool motion_ready = false;
    if (motion_wake && hardware_prepare_motion_wake() == ESP_OK) {
        if (esp_sleep_enable_ext1_wakeup(1ULL << ACCEL_WAKE_GPIO,
                                         ESP_EXT1_WAKEUP_ANY_HIGH) == ESP_OK) {
            motion_ready = true;
        }
    }
    if (timer_seconds > 0) {
        ESP_ERROR_CHECK(esp_sleep_enable_timer_wakeup((uint64_t)timer_seconds *
                                                       1000000ULL));
    } else if (!motion_ready) {
        printf("Power: motion wake unavailable; using %u second safety wake\n",
               SAFE_FALLBACK_WAKE_SECONDS);
        ESP_ERROR_CHECK(esp_sleep_enable_timer_wakeup(
            (uint64_t)SAFE_FALLBACK_WAKE_SECONDS * 1000000ULL));
    }
    printf("Power: deep sleep, timer=%" PRIu32 " s motion=%s\n", timer_seconds,
           motion_ready ? "enabled" : "unavailable");
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_deep_sleep_start();
}

static uint32_t next_timer(const app_config_t *config, uint32_t reporting_timer)
{
    if (!config->auto_wifi_update || config->wifi_ssid[0] == '\0') {
        return reporting_timer;
    }
    uint32_t update_timer = retained.update_remaining_s;
    if (update_timer == 0) update_timer = UPDATE_RETRY_SECONDS;
    return reporting_timer == 0 || update_timer < reporting_timer
               ? update_timer : reporting_timer;
}

static void check_updates_if_due(const app_config_t *config,
                                 const hardware_sample_t *sample)
{
    if (!config->auto_wifi_update || config->wifi_ssid[0] == '\0') {
        retained.update_enabled = false;
        retained.update_remaining_s = 0;
        return;
    }
    if (!retained.update_enabled) {
        retained.update_enabled = true;
        retained.update_remaining_s = 0;
    }
    if (retained.update_remaining_s != 0) return;
    esp_err_t result = wifi_update_check(config, sample);
    printf("Update: weekly check %s\n", esp_err_to_name(result));
    retained.update_remaining_s = result == ESP_OK
                                      ? UPDATE_WEEK_SECONDS : UPDATE_RETRY_SECONDS;
}

static void send_reports(const app_config_t *config,
                         const hardware_sample_t *sample)
{
    if (config->ble_telemetry) {
        hardware_led_flash(1, 90, 0);
        esp_err_t error = ble_ota_send_telemetry(sample);
        printf("Telemetry: BLE burst %s\n", esp_err_to_name(error));
    }
    if (config->wifi_telemetry || config->history_telemetry) {
        hardware_led_flash(1, 90, 0);
        char message[128];
        esp_err_t error = wifi_report_send(config, sample, message, sizeof(message));
        printf("Telemetry: Wi-Fi %s (%s)\n", esp_err_to_name(error), message);
    }
}

void app_main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_app_desc_t *app = esp_app_get_description();
    printf("\nOPENPILL\nproject=%s version=%s partition=%s\n", app->project_name,
           app->version, running != NULL ? running->label : "unknown");

    if (retained.magic != RTC_STATE_MAGIC) {
        retained = (retained_state_t){.magic = RTC_STATE_MAGIC};
    }
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_TIMER &&
        retained.planned_sleep_s != 0 && retained.update_remaining_s != 0) {
        retained.update_remaining_s =
            retained.planned_sleep_s >= retained.update_remaining_s
                ? 0 : retained.update_remaining_s - retained.planned_sleep_s;
    }
    retained.planned_sleep_s = 0;
    esp_err_t calibration_error = vendor_calibration_load();
    if (calibration_error != ESP_OK) {
        printf("Calibration: %s; using defaults where needed\n",
               esp_err_to_name(calibration_error));
    }
    esp_err_t config_error = app_config_init();
    if (config_error != ESP_OK) {
        printf("Configuration is read-only for this boot: %s\n",
               esp_err_to_name(config_error));
    }
    bootloader_random_enable();
    esp_err_t identity_error = history_identity_init();
    bootloader_random_disable();
    if (identity_error != ESP_OK) {
        printf("History identity unavailable: %s\n", esp_err_to_name(identity_error));
    }
    ESP_ERROR_CHECK(hardware_init());
    validate_running_image();

    app_config_t config;
    app_config_get(&config);
    hardware_sample_t sample;
    (void)hardware_read_stable(&sample);
    hardware_orientation_t orientation = hardware_orientation(&sample);
    float tilt = hardware_tilt_degrees(&sample);
    printf("Power: wake=%d orientation=%s tilt=%.1f external_power=%s\n",
           esp_sleep_get_wakeup_cause(), orientation_name(orientation), tilt,
           sample.charger_connected ? "yes" : "no");

    bool charger_inserted = sample.charger_connected &&
                            (!retained.charger_known || !retained.charger_connected);
    retained.charger_known = true;
    retained.charger_connected = sample.charger_connected;

    bool vertical_entry = orientation == HARDWARE_ORIENTATION_VERTICAL &&
                          !retained.vertical_latched;
    bool software_restart = esp_reset_reason() == ESP_RST_SW;
    if (orientation != HARDWARE_ORIENTATION_VERTICAL) {
        retained.vertical_latched = false;
    }

    if (charger_inserted || vertical_entry || software_restart) {
        retained.vertical_latched = orientation == HARDWARE_ORIENTATION_VERTICAL;
        printf("Power: maintenance requested by %s\n",
               charger_inserted ? "external power" :
               vertical_entry ? "orientation" : "software restart");
        esp_err_t error = ble_ota_run_maintenance(BLE_MAINTENANCE_WINDOW_SECONDS,
                                                  &sample);
        if (error != ESP_OK) {
            printf("BLE maintenance failed: %s\n", esp_err_to_name(error));
            hardware_led_sos_twice();
        }
        app_config_get(&config);
        (void)hardware_read_stable(&sample);
        orientation = hardware_orientation(&sample);
        retained.charger_connected = sample.charger_connected;
        if (orientation != HARDWARE_ORIENTATION_VERTICAL) {
            retained.vertical_latched = false;
        }
        check_updates_if_due(&config, &sample);
        if (orientation == HARDWARE_ORIENTATION_HORIZONTAL ||
            orientation == HARDWARE_ORIENTATION_VERTICAL) {
            enter_sleep(next_timer(&config, 0), true);
        }
        enter_sleep(next_timer(&config,
                               (config.ble_telemetry || config.wifi_telemetry)
                                   ? config.wake_interval_s : 0),
                    true);
    }

    if (orientation == HARDWARE_ORIENTATION_HORIZONTAL ||
        orientation == HARDWARE_ORIENTATION_VERTICAL) {
        retained.vertical_latched = orientation == HARDWARE_ORIENTATION_VERTICAL;
        check_updates_if_due(&config, &sample);
        enter_sleep(next_timer(&config, 0), true);
    }

    esp_sleep_wakeup_cause_t wake = esp_sleep_get_wakeup_cause();
    bool scheduled = wake != ESP_SLEEP_WAKEUP_EXT1;
    if (scheduled && (config.ble_telemetry || config.wifi_telemetry)) {
        send_reports(&config, &sample);
    } else if (!scheduled) {
        printf("Power: movement wake remained in reporting orientation; no early report\n");
    }
    check_updates_if_due(&config, &sample);
    enter_sleep(next_timer(&config,
                           (config.ble_telemetry || config.wifi_telemetry)
                               ? config.wake_interval_s : 0),
                true);
}
