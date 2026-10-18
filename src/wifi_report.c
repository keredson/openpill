#include "wifi_report.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_sntp.h"
#include "history_identity.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "mbedtls/sha256.h"
#include "telemetry.h"

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAILED_BIT BIT1
#define UPDATE_MANIFEST_URL "https://keredson.github.io/openpill/firmware/latest.json"
#define UPDATE_IMAGE_URL "https://keredson.github.io/openpill/firmware/openpill.bin"
#define UPDATE_MANIFEST_MAX 512
#define UPDATE_READ_SIZE 2048
#define HISTORY_POST_URL "https://openpill.yeast.win/v1/readings"

static const uint8_t history_signing_prefix[] = "OpenPill history upload v1";

static bool encode_base64url(const uint8_t *input, size_t length,
                             char *output, size_t capacity)
{
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t needed = (length * 8 + 5) / 6;
    if (capacity <= needed) return false;
    size_t position = 0;
    for (size_t i = 0; i < length; i += 3) {
        uint32_t value = (uint32_t)input[i] << 16;
        if (i + 1 < length) value |= (uint32_t)input[i + 1] << 8;
        if (i + 2 < length) value |= input[i + 2];
        output[position++] = alphabet[(value >> 18) & 63];
        output[position++] = alphabet[(value >> 12) & 63];
        if (i + 1 < length) output[position++] = alphabet[(value >> 6) & 63];
        if (i + 2 < length) output[position++] = alphabet[value & 63];
    }
    output[position] = '\0';
    return true;
}

static bool parse_hash(const char hex[65], uint8_t output[32])
{
    for (size_t i = 0; i < 32; ++i) {
        int pair[2];
        for (size_t j = 0; j < 2; ++j) {
            char digit = hex[i * 2 + j];
            pair[j] = digit >= '0' && digit <= '9' ? digit - '0' :
                      digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : -1;
            if (pair[j] < 0) return false;
        }
        output[i] = (uint8_t)((pair[0] << 4) | pair[1]);
    }
    return hex[64] == '\0';
}

typedef struct {
    char body[UPDATE_MANIFEST_MAX + 1];
    size_t length;
    bool overflow;
} update_manifest_response_t;

typedef struct {
    char version[33];
    char sha256[65];
    size_t size;
} update_manifest_t;

static EventGroupHandle_t wifi_events;
static esp_netif_t *station_netif;
static portMUX_TYPE wifi_guard = portMUX_INITIALIZER_UNLOCKED;
static bool wifi_in_use;
static bool update_clock_ready(void);

static bool claim_wifi(void)
{
    portENTER_CRITICAL(&wifi_guard);
    bool available = !wifi_in_use;
    if (available) wifi_in_use = true;
    portEXIT_CRITICAL(&wifi_guard);
    return available;
}

static void release_wifi(void)
{
    portENTER_CRITICAL(&wifi_guard);
    wifi_in_use = false;
    portEXIT_CRITICAL(&wifi_guard);
}

static void set_message(char *output, size_t size, const char *message)
{
    if (output != NULL && size > 0) {
        snprintf(output, size, "%s", message);
    }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        (void)esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupSetBits(wifi_events, WIFI_FAILED_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(wifi_events, WIFI_CONNECTED_BIT);
    }
}

static esp_err_t network_stack_init(void)
{
    esp_err_t error = esp_netif_init();
    if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
        return error;
    }
    error = esp_event_loop_create_default();
    if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
        return error;
    }
    if (station_netif == NULL) {
        station_netif = esp_netif_create_default_wifi_sta();
        if (station_netif == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    if (wifi_events == NULL) {
        wifi_events = xEventGroupCreate();
        if (wifi_events == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    return ESP_OK;
}

static esp_err_t wifi_connect(const app_config_t *config,
                              esp_event_handler_instance_t *wifi_handler,
                              esp_event_handler_instance_t *ip_handler)
{
    esp_err_t error = network_stack_init();
    if (error != ESP_OK) {
        return error;
    }
    xEventGroupClearBits(wifi_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    if ((error = esp_wifi_init(&init)) != ESP_OK) {
        return error;
    }
    if ((error = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK ||
        (error = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                      wifi_event, NULL,
                                                      wifi_handler)) != ESP_OK ||
        (error = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                      wifi_event, NULL,
                                                      ip_handler)) != ESP_OK) {
        goto fail;
    }

    wifi_config_t station = {0};
    memcpy(station.sta.ssid, config->wifi_ssid,
           strnlen(config->wifi_ssid, sizeof(station.sta.ssid)));
    memcpy(station.sta.password, config->wifi_password,
           strnlen(config->wifi_password, sizeof(station.sta.password)));
    station.sta.threshold.authmode = config->wifi_password[0]
                                         ? WIFI_AUTH_WPA2_PSK
                                         : WIFI_AUTH_OPEN;
    station.sta.pmf_cfg.capable = true;
    station.sta.pmf_cfg.required = false;
    if ((error = esp_wifi_set_mode(WIFI_MODE_STA)) != ESP_OK ||
        (error = esp_wifi_set_config(WIFI_IF_STA, &station)) != ESP_OK ||
        (error = esp_wifi_start()) != ESP_OK) {
        goto fail;
    }

    EventBits_t result = xEventGroupWaitBits(
        wifi_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT, pdTRUE, pdFALSE,
        pdMS_TO_TICKS(config->wifi_timeout_s * 1000));
    return result & WIFI_CONNECTED_BIT ? ESP_OK : ESP_ERR_TIMEOUT;

fail:
    if (*wifi_handler != NULL) {
        (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                     *wifi_handler);
        *wifi_handler = NULL;
    }
    if (*ip_handler != NULL) {
        (void)esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                     *ip_handler);
        *ip_handler = NULL;
    }
    (void)esp_wifi_stop();
    (void)esp_wifi_deinit();
    return error;
}

static void wifi_disconnect(esp_event_handler_instance_t wifi_handler,
                            esp_event_handler_instance_t ip_handler)
{
    (void)esp_wifi_stop();
    if (wifi_handler != NULL) {
        (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                     wifi_handler);
    }
    if (ip_handler != NULL) {
        (void)esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                     ip_handler);
    }
    (void)esp_wifi_deinit();
}

static char *make_payload(const hardware_sample_t *sample)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return NULL;
    }
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    char id[7];
    snprintf(id, sizeof(id), "%02X%02X%02X", mac[3], mac[4], mac[5]);
    cJSON_AddNumberToObject(root, "schema", 1);
    cJSON_AddStringToObject(root, "device_id", id);
    if (sample->valid & HARDWARE_VALID_ACCEL) {
        cJSON_AddNumberToObject(root, "gravity", telemetry_gravity(sample) / 1000.0f);
    }
    if (sample->valid & HARDWARE_VALID_TEMPERATURE) {
        cJSON_AddNumberToObject(root, "temperature_c",
                               sample->temperature_centi_c / 100.0);
    }
    if (sample->valid & HARDWARE_VALID_BATTERY) {
        cJSON_AddNumberToObject(root, "battery_percent",
                               telemetry_battery_percent(sample->battery_mv));
    }
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return payload;
}

static esp_err_t history_post(const app_config_t *config,
                              const hardware_sample_t *sample,
                              char *message, size_t message_size)
{
    if (!history_identity_ready()) {
        set_message(message, message_size, "History signing key unavailable");
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t payload[TELEMETRY_PAYLOAD_LENGTH];
    uint8_t read_hash[32];
    uint8_t public_key[HISTORY_PUBLIC_KEY_LENGTH];
    if (telemetry_encode_sample(sample, payload) != ESP_OK ||
        !parse_hash(config->history_read_hash, read_hash) ||
        history_identity_public(public_key) != ESP_OK) {
        set_message(message, message_size, "Could not prepare history report");
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t signed_bytes[sizeof(history_signing_prefix) + sizeof(read_hash) +
                         sizeof(payload)];
    memcpy(signed_bytes, history_signing_prefix, sizeof(history_signing_prefix));
    memcpy(signed_bytes + sizeof(history_signing_prefix), read_hash,
           sizeof(read_hash));
    memcpy(signed_bytes + sizeof(history_signing_prefix) + sizeof(read_hash),
           payload, sizeof(payload));
    uint8_t digest[32];
    if (mbedtls_sha256(signed_bytes, sizeof(signed_bytes), digest, 0) != 0) {
        set_message(message, message_size, "Could not hash history report");
        return ESP_FAIL;
    }
    uint8_t signature[HISTORY_SIGNATURE_MAX];
    size_t signature_length = 0;
    if (history_identity_sign(digest, signature, &signature_length) != ESP_OK) {
        set_message(message, message_size, "Could not sign history report");
        return ESP_FAIL;
    }
    char key_header[96];
    char signature_header[112];
    if (!encode_base64url(public_key, sizeof(public_key), key_header,
                          sizeof(key_header)) ||
        !encode_base64url(signature, signature_length, signature_header,
                          sizeof(signature_header))) {
        return ESP_FAIL;
    }
    esp_http_client_config_t http_config = {
        .url = HISTORY_POST_URL,
        .timeout_ms = (int)config->wifi_timeout_s * 1000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return ESP_ERR_NO_MEM;
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/octet-stream");
    esp_http_client_set_header(client, "X-OpenPill-Key", key_header);
    esp_http_client_set_header(client, "X-OpenPill-Signature", signature_header);
    esp_http_client_set_header(client, "X-OpenPill-Read-Hash",
                               config->history_read_hash);
    esp_http_client_set_post_field(client, (const char *)payload, sizeof(payload));
    esp_err_t error = esp_http_client_perform(client);
    int status = error == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    esp_http_client_cleanup(client);
    if (error == ESP_OK && status != 202 && status != 429) error = ESP_FAIL;
    if (error == ESP_OK) {
        set_message(message, message_size,
                    status == 429 ? "History report already current" :
                                    "History report accepted");
    } else if (status != 0 && message != NULL && message_size > 0) {
        snprintf(message, message_size, "History service returned HTTP %d", status);
    } else {
        set_message(message, message_size, "History report failed");
    }
    return error;
}

static esp_err_t wifi_report_send_unlocked(const app_config_t *config,
                                           const hardware_sample_t *sample,
                                           char *message, size_t message_size)
{
    if (config == NULL || sample == NULL || config->wifi_ssid[0] == '\0' ||
        (!config->history_telemetry && config->endpoint_url[0] == '\0')) {
        set_message(message, message_size, "Wi-Fi configuration is incomplete");
        return ESP_ERR_INVALID_ARG;
    }

    esp_event_handler_instance_t wifi_handler = NULL;
    esp_event_handler_instance_t ip_handler = NULL;
    esp_err_t error = wifi_connect(config, &wifi_handler, &ip_handler);
    if (error != ESP_OK) {
        if (wifi_handler != NULL || ip_handler != NULL) {
            wifi_disconnect(wifi_handler, ip_handler);
        }
        set_message(message, message_size, "Could not connect to the Wi-Fi network");
        return error;
    }

    if (config->history_telemetry) {
        if (!update_clock_ready()) {
            set_message(message, message_size, "Could not set clock for HTTPS");
            error = ESP_ERR_TIMEOUT;
        } else {
            error = history_post(config, sample, message, message_size);
        }
        wifi_disconnect(wifi_handler, ip_handler);
        return error;
    }

    char *payload = make_payload(sample);
    if (payload == NULL) {
        wifi_disconnect(wifi_handler, ip_handler);
        set_message(message, message_size, "Could not allocate telemetry payload");
        return ESP_ERR_NO_MEM;
    }

    esp_http_client_config_t http_config = {
        .url = config->endpoint_url,
        .timeout_ms = (int)config->wifi_timeout_s * 1000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) {
        cJSON_free(payload);
        wifi_disconnect(wifi_handler, ip_handler);
        set_message(message, message_size, "Could not create HTTP client");
        return ESP_ERR_NO_MEM;
    }

    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, payload, strlen(payload));
    error = esp_http_client_perform(client);
    int status = error == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    if (error == ESP_OK && (status < 200 || status >= 300)) {
        error = ESP_FAIL;
    }
    esp_http_client_cleanup(client);
    cJSON_free(payload);
    wifi_disconnect(wifi_handler, ip_handler);

    if (error == ESP_OK) {
        set_message(message, message_size, "Wi-Fi report accepted");
    } else if (status != 0) {
        if (message != NULL && message_size > 0) {
            snprintf(message, message_size, "Endpoint returned HTTP %d", status);
        }
    } else {
        set_message(message, message_size, "Wi-Fi report failed");
    }
    return error;
}

esp_err_t wifi_report_send(const app_config_t *config,
                           const hardware_sample_t *sample,
                           char *message, size_t message_size)
{
    if (!claim_wifi()) {
        set_message(message, message_size, "Wi-Fi is busy; try again");
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t error = wifi_report_send_unlocked(config, sample, message, message_size);
    release_wifi();
    return error;
}

esp_err_t wifi_report_test_connection(const app_config_t *config,
                                      char *message, size_t message_size)
{
    if (config == NULL || config->wifi_ssid[0] == '\0') {
        set_message(message, message_size, "Choose a Wi-Fi network");
        return ESP_ERR_INVALID_ARG;
    }
    if (!claim_wifi()) {
        set_message(message, message_size, "Wi-Fi is busy; try again");
        return ESP_ERR_INVALID_STATE;
    }
    esp_event_handler_instance_t wifi_handler = NULL;
    esp_event_handler_instance_t ip_handler = NULL;
    esp_err_t error = wifi_connect(config, &wifi_handler, &ip_handler);
    if (wifi_handler != NULL || ip_handler != NULL) {
        wifi_disconnect(wifi_handler, ip_handler);
    }
    release_wifi();
    set_message(message, message_size, error == ESP_OK
                    ? "Wi-Fi connected" : "Could not connect to the Wi-Fi network");
    return error;
}

esp_err_t wifi_scan_networks(wifi_scan_network_t *networks, size_t *count)
{
    if (networks == NULL || count == NULL) return ESP_ERR_INVALID_ARG;
    *count = 0;
    if (!claim_wifi()) return ESP_ERR_INVALID_STATE;

    esp_err_t error = network_stack_init();
    bool initialized = false;
    bool started = false;
    if (error != ESP_OK) goto done;
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    error = esp_wifi_init(&init);
    if (error != ESP_OK) goto done;
    initialized = true;
    if ((error = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK ||
        (error = esp_wifi_set_mode(WIFI_MODE_STA)) != ESP_OK ||
        (error = esp_wifi_start()) != ESP_OK) goto done;
    started = true;
    error = esp_wifi_scan_start(NULL, true);
    if (error != ESP_OK) goto done;

    wifi_ap_record_t records[WIFI_SCAN_MAX_NETWORKS] = {0};
    uint16_t found = WIFI_SCAN_MAX_NETWORKS;
    error = esp_wifi_scan_get_ap_records(&found, records);
    if (error != ESP_OK) goto done;
    for (uint16_t index = 0; index < found; ++index) {
        if (records[index].ssid[0] == '\0') continue;
        wifi_scan_network_t *network = &networks[*count];
        memcpy(network->ssid, records[index].ssid, 32);
        network->ssid[32] = '\0';
        network->rssi = records[index].rssi;
        network->secure = records[index].authmode != WIFI_AUTH_OPEN;
        ++*count;
    }

done:
    if (started) (void)esp_wifi_stop();
    if (initialized) (void)esp_wifi_deinit();
    release_wifi();
    return error;
}

static esp_err_t update_manifest_event(esp_http_client_event_t *event)
{
    if (event->event_id != HTTP_EVENT_ON_DATA) return ESP_OK;
    update_manifest_response_t *response = event->user_data;
    if (event->data_len < 0 ||
        (size_t)event->data_len > UPDATE_MANIFEST_MAX - response->length) {
        response->overflow = true;
        return ESP_FAIL;
    }
    memcpy(response->body + response->length, event->data, event->data_len);
    response->length += event->data_len;
    response->body[response->length] = '\0';
    return ESP_OK;
}

static bool parse_version(const char *value, unsigned parts[3])
{
    char extra;
    return value != NULL &&
           sscanf(value, "%u.%u.%u%c", &parts[0], &parts[1], &parts[2],
                  &extra) == 3;
}

static bool version_is_newer(const char *candidate, const char *installed)
{
    unsigned next[3], current[3];
    if (!parse_version(candidate, next) || !parse_version(installed, current)) {
        return false;
    }
    for (size_t index = 0; index < 3; ++index) {
        if (next[index] != current[index]) return next[index] > current[index];
    }
    return false;
}

static bool read_update_manifest(update_manifest_t *manifest, uint32_t timeout_s)
{
    update_manifest_response_t response = {0};
    esp_http_client_config_t request = {
        .url = UPDATE_MANIFEST_URL,
        .timeout_ms = (int)timeout_s * 1000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = update_manifest_event,
        .user_data = &response,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&request);
    if (client == NULL) return false;
    esp_http_client_set_header(client, "Cache-Control", "no-cache");
    esp_err_t error = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (error != ESP_OK || status != 200 || response.overflow) {
        printf("Update: manifest request failed (%s, HTTP %d)\n",
               esp_err_to_name(error), status);
        return false;
    }
    cJSON *root = cJSON_Parse(response.body);
    if (!cJSON_IsObject(root)) { cJSON_Delete(root); return false; }
    cJSON *version = cJSON_GetObjectItemCaseSensitive(root, "version");
    cJSON *sha = cJSON_GetObjectItemCaseSensitive(root, "sha256");
    cJSON *size = cJSON_GetObjectItemCaseSensitive(root, "size");
    bool valid = cJSON_IsString(version) && cJSON_IsString(sha) &&
                 cJSON_IsNumber(size) && version->valuestring != NULL &&
                 sha->valuestring != NULL &&
                 strlen(version->valuestring) < sizeof(manifest->version) &&
                 strlen(sha->valuestring) == 64 &&
                 size->valuedouble > 0 && size->valuedouble <= 0x180000 &&
                 size->valuedouble == (size_t)size->valuedouble;
    unsigned parsed[3];
    valid = valid && parse_version(version->valuestring, parsed);
    if (valid) {
        for (size_t index = 0; index < 64; ++index) {
            char digit = sha->valuestring[index];
            if (!((digit >= '0' && digit <= '9') ||
                  (digit >= 'a' && digit <= 'f'))) valid = false;
        }
    }
    if (valid) {
        snprintf(manifest->version, sizeof(manifest->version), "%s",
                 version->valuestring);
        snprintf(manifest->sha256, sizeof(manifest->sha256), "%s",
                 sha->valuestring);
        manifest->size = (size_t)size->valuedouble;
    }
    cJSON_Delete(root);
    return valid;
}

static bool update_power_ok(void)
{
    hardware_sample_t sample = {0};
    (void)hardware_read(&sample);
    if (!(sample.valid & HARDWARE_VALID_BATTERY) ||
        !(sample.valid & HARDWARE_VALID_CHARGER) || sample.battery_mv > 4300) {
        return false;
    }
    float percent = telemetry_battery_percent(sample.battery_mv);
    return percent >= 10.0f &&
           (percent >= 30.0f || sample.charger_connected);
}

static bool update_clock_ready(void)
{
    time_t now = time(NULL);
    if (now >= 1704067200) return true; /* 2024-01-01 UTC */
    bool started = !esp_sntp_enabled();
    if (started) {
        esp_sntp_setservername(0, "pool.ntp.org");
        esp_sntp_init();
    }
    for (unsigned attempt = 0; attempt < 20; ++attempt) {
        vTaskDelay(pdMS_TO_TICKS(500));
        now = time(NULL);
        if (now >= 1704067200) break;
    }
    if (started) esp_sntp_stop();
    return now >= 1704067200;
}

static esp_err_t install_update(const update_manifest_t *manifest,
                                uint32_t timeout_s)
{
    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL || manifest->size > partition->size) return ESP_ERR_INVALID_SIZE;
    esp_http_client_config_t request = {
        .url = UPDATE_IMAGE_URL,
        .timeout_ms = (int)timeout_s * 1000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&request);
    if (client == NULL) return ESP_ERR_NO_MEM;
    esp_err_t error = esp_http_client_open(client, 0);
    if (error != ESP_OK) goto done;
    (void)esp_http_client_fetch_headers(client);
    if (esp_http_client_get_status_code(client) != 200 ||
        (esp_http_client_get_content_length(client) >= 0 &&
         esp_http_client_get_content_length(client) != manifest->size)) {
        error = ESP_FAIL;
        goto done;
    }
    esp_ota_handle_t handle = 0;
    error = esp_ota_begin(partition, manifest->size, &handle);
    if (error != ESP_OK) goto done;
    mbedtls_sha256_context digest;
    mbedtls_sha256_init(&digest);
    if (mbedtls_sha256_starts(&digest, 0) != 0) {
        error = ESP_FAIL;
        goto abort_update;
    }
    uint8_t buffer[UPDATE_READ_SIZE];
    size_t received = 0;
    unsigned idle_reads = 0;
    while (received < manifest->size) {
        if (!update_power_ok()) { error = ESP_ERR_INVALID_STATE; break; }
        int length = esp_http_client_read(client, (char *)buffer,
                                         (int)((manifest->size - received < sizeof(buffer))
                                             ? manifest->size - received : sizeof(buffer)));
        if (length < 0 || (length == 0 && ++idle_reads >= 3)) {
            error = ESP_FAIL;
            break;
        }
        if (length == 0) continue;
        idle_reads = 0;
        if (mbedtls_sha256_update(&digest, buffer, length) != 0 ||
            (error = esp_ota_write(handle, buffer, length)) != ESP_OK) {
            error = ESP_FAIL;
            break;
        }
        received += length;
    }
    uint8_t calculated[32];
    if (error == ESP_OK && mbedtls_sha256_finish(&digest, calculated) != 0) {
        error = ESP_FAIL;
    }
    mbedtls_sha256_free(&digest);
    if (error != ESP_OK) goto abort_update;
    static const char hex[] = "0123456789abcdef";
    char actual[65];
    for (size_t index = 0; index < 32; ++index) {
        actual[index * 2] = hex[calculated[index] >> 4];
        actual[index * 2 + 1] = hex[calculated[index] & 15];
    }
    actual[64] = '\0';
    if (strcmp(actual, manifest->sha256) != 0 || !update_power_ok()) {
        error = ESP_ERR_INVALID_CRC;
        goto abort_update;
    }
    error = esp_ota_end(handle);
    if (error != ESP_OK) goto done;
    esp_app_desc_t image;
    error = esp_ota_get_partition_description(partition, &image);
    if (error == ESP_OK &&
        (strcmp(image.project_name, "openpill") != 0 ||
         strcmp(image.version, manifest->version) != 0)) {
        error = ESP_ERR_INVALID_VERSION;
    }
    if (error == ESP_OK) {
        error = update_power_ok() ? esp_ota_set_boot_partition(partition)
                                  : ESP_ERR_INVALID_STATE;
    }
    goto done;
abort_update:
    (void)esp_ota_abort(handle);
done:
    esp_http_client_cleanup(client);
    return error;
}

esp_err_t wifi_update_check(const app_config_t *config,
                            const hardware_sample_t *sample)
{
    if (config == NULL || sample == NULL || !config->auto_wifi_update ||
        config->wifi_ssid[0] == '\0') return ESP_ERR_INVALID_ARG;
    if (!update_power_ok()) {
        printf("Update: battery too low or unavailable; skipping\n");
        return ESP_ERR_INVALID_STATE;
    }
    if (!claim_wifi()) return ESP_ERR_INVALID_STATE;
    esp_event_handler_instance_t wifi_handler = NULL, ip_handler = NULL;
    esp_err_t error = wifi_connect(config, &wifi_handler, &ip_handler);
    bool installed = false;
    if (error == ESP_OK) {
        if (!update_clock_ready()) {
            printf("Update: could not set clock for HTTPS verification\n");
            error = ESP_ERR_INVALID_STATE;
        }
    }
    if (error == ESP_OK) {
        update_manifest_t manifest = {0};
        if (!read_update_manifest(&manifest, config->wifi_timeout_s)) {
            error = ESP_FAIL;
        } else if (version_is_newer(manifest.version,
                                    esp_app_get_description()->version)) {
            printf("Update: installing %s in inactive slot\n", manifest.version);
            error = install_update(&manifest, config->wifi_timeout_s);
            installed = error == ESP_OK;
            if (error == ESP_OK) printf("Update: installed %s; restarting\n",
                                        manifest.version);
        } else {
            printf("Update: current version is up to date\n");
        }
    }
    if (wifi_handler != NULL || ip_handler != NULL) {
        wifi_disconnect(wifi_handler, ip_handler);
    }
    release_wifi();
    if (installed) esp_restart();
    return error;
}
