#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#include "app_config.h"
#include "esp_err.h"
#include "hardware.h"

esp_err_t wifi_report_send(const app_config_t *config,
                           const hardware_sample_t *sample,
                           char *message, size_t message_size);
esp_err_t wifi_report_test_connection(const app_config_t *config,
                                      char *message, size_t message_size);

#define WIFI_SCAN_MAX_NETWORKS 12
typedef struct {
    char ssid[33];
    int8_t rssi;
    bool secure;
} wifi_scan_network_t;

esp_err_t wifi_scan_networks(wifi_scan_network_t *networks, size_t *count);
esp_err_t wifi_update_check(const app_config_t *config,
                            const hardware_sample_t *sample);

