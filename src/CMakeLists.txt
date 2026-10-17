idf_component_register(
    SRCS "main.c" "app_config.c" "ble_ota.c" "ble_secure.c" "hardware.c" "telemetry.c"
         "vendor_calibration.c" "wifi_report.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES app_update bt driver esp_event esp_http_client esp_netif
                  esp_partition esp_wifi json mbedtls nvs_flash
)

