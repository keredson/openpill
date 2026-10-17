#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define APP_CONFIG_SSID_MAX 32
#define APP_CONFIG_PASSWORD_MAX 64
#define APP_CONFIG_URL_MAX 256

typedef struct {
    uint32_t schema_version;
    uint32_t wake_interval_s;
    uint32_t ble_window_s;
    uint32_t wifi_timeout_s;
    bool ble_telemetry;
    bool wifi_telemetry;
    bool auto_wifi_update;
    bool allow_http;
    char wifi_ssid[APP_CONFIG_SSID_MAX + 1];
    char wifi_password[APP_CONFIG_PASSWORD_MAX + 1];
    char endpoint_url[APP_CONFIG_URL_MAX + 1];
} app_config_t;

esp_err_t app_config_init(void);
void app_config_get(app_config_t *output);
esp_err_t app_config_stage_json(const char *json, app_config_t *output,
                                char *message, size_t message_size);
esp_err_t app_config_commit(const app_config_t *config);
esp_err_t app_config_public_json(char *output, size_t output_size);

