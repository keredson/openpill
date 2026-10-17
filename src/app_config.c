#include "app_config.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"

#define CONFIG_NAMESPACE "openpill"
#define CONFIG_SCHEMA_VERSION 1

static app_config_t active_config;
static SemaphoreHandle_t config_mutex;

static void defaults(app_config_t *config)
{
    memset(config, 0, sizeof(*config));
    config->schema_version = CONFIG_SCHEMA_VERSION;
    config->wake_interval_s = 3600;
    config->wifi_timeout_s = 15;
    config->ble_telemetry = true;
    config->auto_wifi_update = true;
}

static bool valid_text(const char *value, size_t maximum)
{
    return value != NULL && strnlen(value, maximum + 1) <= maximum;
}

static esp_err_t validate(const app_config_t *config, char *message, size_t size)
{
    const char *error = NULL;
    if (config->schema_version != CONFIG_SCHEMA_VERSION) {
        error = "unsupported configuration schema";
    } else if (config->wake_interval_s < 60 || config->wake_interval_s > 86400) {
        error = "wake interval must be between 60 and 86400 seconds";
    } else if (config->wifi_timeout_s < 5 || config->wifi_timeout_s > 60) {
        error = "Wi-Fi timeout must be between 5 and 60 seconds";
    } else if (!valid_text(config->wifi_ssid, APP_CONFIG_SSID_MAX) ||
               !valid_text(config->wifi_password, APP_CONFIG_PASSWORD_MAX) ||
               !valid_text(config->endpoint_url, APP_CONFIG_URL_MAX)) {
        error = "configuration text is too long";
    } else if (config->wifi_telemetry && config->wifi_ssid[0] == '\0') {
        error = "Wi-Fi telemetry requires an SSID";
    } else if (config->wifi_telemetry && config->endpoint_url[0] == '\0') {
        error = "Wi-Fi telemetry requires an endpoint URL";
    } else if (config->endpoint_url[0] != '\0' &&
               strncmp(config->endpoint_url, "https://", 8) != 0 &&
               !(config->allow_http &&
                 strncmp(config->endpoint_url, "http://", 7) == 0)) {
        error = "endpoint must use HTTPS unless HTTP is explicitly allowed";
    }

    if (error == NULL) {
        return ESP_OK;
    }
    if (message != NULL && size > 0) {
        snprintf(message, size, "%s", error);
    }
    return ESP_ERR_INVALID_ARG;
}

static void get_u32(nvs_handle_t handle, const char *key, uint32_t *value)
{
    uint32_t loaded;
    if (nvs_get_u32(handle, key, &loaded) == ESP_OK) {
        *value = loaded;
    }
}

static void get_bool(nvs_handle_t handle, const char *key, bool *value)
{
    uint8_t loaded;
    if (nvs_get_u8(handle, key, &loaded) == ESP_OK) {
        *value = loaded != 0;
    }
}

static void get_string(nvs_handle_t handle, const char *key, char *value, size_t capacity)
{
    size_t length = capacity;
    char loaded[APP_CONFIG_URL_MAX + 1];
    if (capacity <= sizeof(loaded) &&
        nvs_get_str(handle, key, loaded, &length) == ESP_OK) {
        memcpy(value, loaded, length);
    }
}

static bool import_blob_string(nvs_handle_t handle, const char *key, char *output,
                               size_t capacity)
{
    size_t length = 0;
    if (nvs_get_blob(handle, key, NULL, &length) != ESP_OK || length == 0 ||
        length > capacity) {
        return false;
    }
    uint8_t buffer[APP_CONFIG_PASSWORD_MAX + 1] = {0};
    if (length > sizeof(buffer) || nvs_get_blob(handle, key, buffer, &length) != ESP_OK) {
        return false;
    }
    size_t text_length = strnlen((const char *)buffer, length);
    if (text_length >= capacity) {
        return false;
    }
    memcpy(output, buffer, text_length);
    output[text_length] = '\0';
    return true;
}

static void import_defaults(app_config_t *config)
{
    nvs_handle_t handle;
    if (nvs_open("nvs", NVS_READONLY, &handle) == ESP_OK) {
        uint32_t interval;
        if (nvs_get_u32(handle, "interval", &interval) == ESP_OK && interval >= 60 &&
            interval <= 86400) {
            config->wake_interval_s = interval;
        }
        nvs_close(handle);
    }

    if (nvs_open("espwifimgr", NVS_READONLY, &handle) == ESP_OK) {
        (void)import_blob_string(handle, "ssid", config->wifi_ssid,
                                 sizeof(config->wifi_ssid));
        (void)import_blob_string(handle, "password", config->wifi_password,
                                 sizeof(config->wifi_password));
        nvs_close(handle);
    }
}

esp_err_t app_config_init(void)
{
    defaults(&active_config);
    config_mutex = xSemaphoreCreateMutex();
    if (config_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    esp_err_t error = nvs_flash_init();
    if (error != ESP_OK) {
        /* Deliberately do not erase or reformat a partition on init failure. */
        printf("Configuration: NVS unavailable: %s\n", esp_err_to_name(error));
        return error;
    }

    import_defaults(&active_config);
    nvs_handle_t handle;
    if (nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        printf("Configuration: defaults active; no OpenPill settings saved\n");
        return ESP_OK;
    }

    get_u32(handle, "schema_ver", &active_config.schema_version);
    get_u32(handle, "wake_interval_s", &active_config.wake_interval_s);
    get_u32(handle, "wifi_timeout_s", &active_config.wifi_timeout_s);
    get_bool(handle, "ble_telem", &active_config.ble_telemetry);
    get_bool(handle, "wifi_telem", &active_config.wifi_telemetry);
    get_bool(handle, "auto_update", &active_config.auto_wifi_update);
    get_bool(handle, "allow_http", &active_config.allow_http);
    get_string(handle, "wifi_ssid", active_config.wifi_ssid,
               sizeof(active_config.wifi_ssid));
    get_string(handle, "wifi_password", active_config.wifi_password,
               sizeof(active_config.wifi_password));
    get_string(handle, "endpoint_url", active_config.endpoint_url,
               sizeof(active_config.endpoint_url));
    nvs_close(handle);

    /* Retire credentials stored by firmware versions with Bearer auth. */
    if (nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle) == ESP_OK) {
        if (nvs_erase_key(handle, "endpoint_token") == ESP_OK) {
            esp_err_t erase_error = nvs_commit(handle);
            if (erase_error != ESP_OK) {
                printf("Configuration: could not remove old endpoint token: %s\n",
                       esp_err_to_name(erase_error));
            }
        }
        nvs_close(handle);
    }

    char message[96];
    if (validate(&active_config, message, sizeof(message)) != ESP_OK) {
        printf("Configuration: saved values invalid (%s); using imported defaults\n",
               message);
        defaults(&active_config);
        import_defaults(&active_config);
    }
    return ESP_OK;
}

void app_config_get(app_config_t *output)
{
    if (output == NULL) {
        return;
    }
    if (config_mutex != NULL &&
        xSemaphoreTake(config_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        *output = active_config;
        xSemaphoreGive(config_mutex);
    } else {
        *output = active_config;
    }
}

static esp_err_t json_u32(cJSON *root, const char *name, uint32_t *value)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (item == NULL) {
        return ESP_OK;
    }
    if (!cJSON_IsNumber(item) || item->valuedouble < 0 ||
        item->valuedouble > UINT32_MAX || item->valuedouble != item->valueint) {
        return ESP_ERR_INVALID_ARG;
    }
    *value = (uint32_t)item->valuedouble;
    return ESP_OK;
}

static esp_err_t json_bool(cJSON *root, const char *name, bool *value)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (item == NULL) {
        return ESP_OK;
    }
    if (!cJSON_IsBool(item)) {
        return ESP_ERR_INVALID_ARG;
    }
    *value = cJSON_IsTrue(item);
    return ESP_OK;
}

static esp_err_t json_string(cJSON *root, const char *name, char *value, size_t capacity)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (item == NULL) {
        return ESP_OK;
    }
    if (!cJSON_IsString(item) || item->valuestring == NULL ||
        strnlen(item->valuestring, capacity) >= capacity) {
        return ESP_ERR_INVALID_ARG;
    }
    snprintf(value, capacity, "%s", item->valuestring);
    return ESP_OK;
}

esp_err_t app_config_stage_json(const char *json, app_config_t *output,
                                char *message, size_t message_size)
{
    if (json == NULL || output == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    app_config_get(output);
    cJSON *root = cJSON_Parse(json);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        if (message != NULL && message_size > 0) {
            snprintf(message, message_size, "configuration is not valid JSON");
        }
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t error = ESP_OK;
#define APPLY_JSON(call) do { if (error == ESP_OK) { error = (call); } } while (0)
    APPLY_JSON(json_u32(root, "wake_interval_s", &output->wake_interval_s));
    APPLY_JSON(json_u32(root, "wifi_timeout_s", &output->wifi_timeout_s));
    APPLY_JSON(json_bool(root, "ble_telemetry", &output->ble_telemetry));
    APPLY_JSON(json_bool(root, "wifi_telemetry", &output->wifi_telemetry));
    APPLY_JSON(json_bool(root, "auto_wifi_update", &output->auto_wifi_update));
    APPLY_JSON(json_bool(root, "allow_http", &output->allow_http));
    APPLY_JSON(json_string(root, "wifi_ssid", output->wifi_ssid,
                           sizeof(output->wifi_ssid)));
    APPLY_JSON(json_string(root, "wifi_password", output->wifi_password,
                           sizeof(output->wifi_password)));
    APPLY_JSON(json_string(root, "endpoint_url", output->endpoint_url,
                           sizeof(output->endpoint_url)));
#undef APPLY_JSON
    cJSON_Delete(root);
    if (error != ESP_OK) {
        if (message != NULL && message_size > 0) {
            snprintf(message, message_size, "configuration contains an invalid value");
        }
        return error;
    }
    return validate(output, message, message_size);
}

esp_err_t app_config_commit(const app_config_t *config)
{
    char message[96];
    esp_err_t error = validate(config, message, sizeof(message));
    if (error != ESP_OK) {
        return error;
    }

    nvs_handle_t handle;
    error = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
#define SET_VALUE(call) do { if (error == ESP_OK) { error = (call); } } while (0)
    SET_VALUE(nvs_set_u32(handle, "schema_ver", config->schema_version));
    SET_VALUE(nvs_set_u32(handle, "wake_interval_s", config->wake_interval_s));
    SET_VALUE(nvs_set_u32(handle, "wifi_timeout_s", config->wifi_timeout_s));
    SET_VALUE(nvs_set_u8(handle, "ble_telem", config->ble_telemetry));
    SET_VALUE(nvs_set_u8(handle, "wifi_telem", config->wifi_telemetry));
    SET_VALUE(nvs_set_u8(handle, "auto_update", config->auto_wifi_update));
    SET_VALUE(nvs_set_u8(handle, "allow_http", config->allow_http));
    SET_VALUE(nvs_set_str(handle, "wifi_ssid", config->wifi_ssid));
    SET_VALUE(nvs_set_str(handle, "wifi_password", config->wifi_password));
    SET_VALUE(nvs_set_str(handle, "endpoint_url", config->endpoint_url));
    SET_VALUE(nvs_commit(handle));
#undef SET_VALUE
    nvs_close(handle);

    if (error == ESP_OK && config_mutex != NULL &&
        xSemaphoreTake(config_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        active_config = *config;
        xSemaphoreGive(config_mutex);
    }
    return error;
}

esp_err_t app_config_public_json(char *output, size_t output_size)
{
    if (output == NULL || output_size == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    app_config_t config;
    app_config_get(&config);
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddNumberToObject(root, "schema_version", config.schema_version);
    cJSON_AddStringToObject(root, "firmware_version",
                            esp_app_get_description()->version);
    char firmware_hash[65];
    static const char hex[] = "0123456789abcdef";
    const volatile uint8_t *elf_hash = esp_app_get_description()->app_elf_sha256;
    for (size_t index = 0; index < 32; ++index) {
        uint8_t byte = elf_hash[index];
        firmware_hash[index * 2] = hex[byte >> 4];
        firmware_hash[index * 2 + 1] = hex[byte & 0x0f];
    }
    firmware_hash[64] = '\0';
    cJSON_AddStringToObject(root, "firmware_elf_sha256", firmware_hash);
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running != NULL) {
        cJSON_AddStringToObject(root, "running_slot", running->label);
    }
    cJSON_AddNumberToObject(root, "wake_interval_s", config.wake_interval_s);
    cJSON_AddNumberToObject(root, "wifi_timeout_s", config.wifi_timeout_s);
    cJSON_AddBoolToObject(root, "ble_telemetry", config.ble_telemetry);
    cJSON_AddBoolToObject(root, "wifi_telemetry", config.wifi_telemetry);
    cJSON_AddBoolToObject(root, "auto_wifi_update", config.auto_wifi_update);
    cJSON_AddBoolToObject(root, "allow_http", config.allow_http);
    cJSON_AddStringToObject(root, "wifi_ssid", config.wifi_ssid);
    cJSON_AddBoolToObject(root, "has_wifi_password", config.wifi_password[0] != '\0');
    cJSON_AddStringToObject(root, "endpoint_url", config.endpoint_url);
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (json == NULL) {
        return ESP_ERR_NO_MEM;
    }
    size_t length = strlen(json);
    if (length >= output_size) {
        cJSON_free(json);
        return ESP_ERR_NO_MEM;
    }
    memcpy(output, json, length + 1);
    cJSON_free(json);
    return ESP_OK;
}
