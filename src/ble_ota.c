#include "ble_ota.h"

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "app_config.h"
#include "ble_secure.h"
#include "cJSON.h"
#include "esp_mac.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "hardware.h"
#include "mbedtls/sha256.h"
#include "mbedtls/platform_util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "telemetry.h"
#include "wifi_report.h"

#define OTA_PROTOCOL_VERSION 1
#define OTA_CONTROL_BEGIN 0x01
#define OTA_CONTROL_COMMIT 0x02
#define OTA_CONTROL_ABORT 0x03
#define OTA_BEGIN_LENGTH 37
#define OTA_DATA_HEADER_LENGTH 4
#define OTA_MAX_DATA_WRITE 517
#define OTA_STATUS_NOTIFY_INTERVAL 4096
#define OTA_POWER_RECHECK_INTERVAL 16384
#define OTA_RESTART_DISCONNECT_WAIT_MS 10000
#define OTA_CHARGER_THRESHOLD_PERCENT 30.0f
#define OTA_STOP_THRESHOLD_PERCENT 10.0f

#define CONFIG_PROTOCOL_VERSION 1
#define CONFIG_WRITE_BEGIN 0x01
#define CONFIG_WRITE_CHUNK 0x02
#define CONFIG_WRITE_FINISH 0x03
#define CONFIG_COMMAND_APPLY 0x01
#define CONFIG_COMMAND_DISCARD 0x02
#define CONFIG_COMMAND_WIFI 0x03
#define CONFIG_COMMAND_TEST 0x04
#define CONFIG_DOCUMENT_MAX 1024

#define BLE_DONE_BIT BIT0
#define TELEMETRY_BURST_MS 1000

static const ble_uuid128_t OTA_SERVICE_UUID =
    BLE_UUID128_INIT(0xdc, 0xfc, 0xa7, 0xfb, 0xf2, 0x6d, 0x38, 0xb5,
                     0x5f, 0x46, 0x90, 0x21, 0xff, 0xf8, 0x9a, 0x36);
static const ble_uuid128_t OTA_CONTROL_UUID =
    BLE_UUID128_INIT(0x56, 0x0e, 0x9e, 0xaf, 0xcb, 0x18, 0xa2, 0x84,
                     0x31, 0x43, 0xcc, 0x52, 0x5e, 0x20, 0xef, 0x84);
static const ble_uuid128_t OTA_DATA_UUID =
    BLE_UUID128_INIT(0x25, 0x3b, 0x89, 0x78, 0x08, 0x3e, 0x13, 0xba,
                     0xf7, 0x47, 0xb8, 0x58, 0x4f, 0x64, 0x3d, 0x1b);
static const ble_uuid128_t OTA_STATUS_UUID =
    BLE_UUID128_INIT(0xc1, 0x39, 0x01, 0x71, 0x35, 0x0a, 0xa4, 0x82,
                     0x6d, 0x45, 0x2f, 0xf2, 0x1d, 0xdb, 0x23, 0x1b);

static const ble_uuid128_t HARDWARE_SERVICE_UUID =
    BLE_UUID128_INIT(0x59, 0xfc, 0xbf, 0xbc, 0x55, 0xbf, 0xdc, 0xba,
                     0x1a, 0x4a, 0x36, 0xe4, 0x45, 0x29, 0xf8, 0x3c);
static const ble_uuid128_t HARDWARE_SAMPLE_UUID =
    BLE_UUID128_INIT(0xd5, 0xcc, 0x5a, 0x68, 0x25, 0x19, 0x91, 0xae,
                     0x73, 0x4e, 0xf2, 0x7a, 0x40, 0xa2, 0xab, 0xdf);

/* 8f5f0000-bfc1-4d83-bf4b-28f27e63c700 and characteristics 0001-0004. */
static const ble_uuid128_t CONFIG_SERVICE_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x00, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_INFO_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x01, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_WRITE_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x02, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_COMMAND_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x03, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_STATUS_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x04, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_WIFI_SCAN_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x05, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_SESSION_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x06, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_SECURE_REQUEST_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x07, 0x00, 0x5f, 0x8f);
static const ble_uuid128_t CONFIG_SECURE_RESPONSE_UUID =
    BLE_UUID128_INIT(0x00, 0xc7, 0x63, 0x7e, 0xf2, 0x28, 0x4b, 0xbf,
                     0x83, 0x4d, 0xc1, 0xbf, 0x08, 0x00, 0x5f, 0x8f);

enum ota_state {
    OTA_STATE_IDLE = 0,
    OTA_STATE_RECEIVING = 1,
    OTA_STATE_VERIFYING = 2,
    OTA_STATE_READY = 3,
    OTA_STATE_ERROR = 4,
};

enum ota_error {
    OTA_ERROR_NONE = 0,
    OTA_ERROR_BAD_COMMAND = 1,
    OTA_ERROR_BAD_SIZE = 2,
    OTA_ERROR_NO_PARTITION = 3,
    OTA_ERROR_BEGIN_FAILED = 4,
    OTA_ERROR_BAD_STATE = 5,
    OTA_ERROR_BAD_OFFSET = 6,
    OTA_ERROR_WRITE_FAILED = 7,
    OTA_ERROR_INCOMPLETE = 8,
    OTA_ERROR_HASH_MISMATCH = 9,
    OTA_ERROR_INVALID_IMAGE = 10,
    OTA_ERROR_BOOT_SELECTION = 11,
    OTA_ERROR_DISCONNECTED = 12,
    OTA_ERROR_EXTERNAL_POWER_REQUIRED = 13,
    OTA_ERROR_BATTERY_UNAVAILABLE = 14,
    OTA_ERROR_BATTERY_TOO_LOW = 15,
};

enum config_state {
    CONFIG_STATE_IDLE = 0,
    CONFIG_STATE_RECEIVING = 1,
    CONFIG_STATE_STAGED = 2,
    CONFIG_STATE_TESTING = 3,
    CONFIG_STATE_SAVED = 4,
    CONFIG_STATE_ERROR = 5,
    CONFIG_STATE_TESTED = 6,
};

struct ota_session {
    enum ota_state state;
    enum ota_error error;
    const esp_partition_t *partition;
    esp_ota_handle_t handle;
    uint32_t expected_size;
    uint32_t received;
    uint32_t last_notified_received;
    uint32_t next_power_check;
    uint8_t expected_sha256[32];
    mbedtls_sha256_context sha256;
    bool sha256_initialized;
};

static struct ota_session session = {.state = OTA_STATE_IDLE};
static enum config_state config_state = CONFIG_STATE_IDLE;
static char config_message[128] = "Ready";
static char config_document[CONFIG_DOCUMENT_MAX + 1];
static size_t config_document_length;
static app_config_t staged_config;
static bool staged_config_valid;
static uint8_t config_action;
static bool maintenance_mode;
static volatile bool client_connected;
static bool closing;
static bool led_animation_paused;
static uint32_t window_seconds;
static TickType_t idle_since;
static uint8_t own_addr_type;
static uint8_t advertisement_payload[TELEMETRY_PAYLOAD_LENGTH];
static EventGroupHandle_t ble_events;
static uint16_t status_value_handle;
static uint16_t config_status_value_handle;
static volatile uint8_t wifi_scan_state; /* 0 idle, 1 scanning, 2 ready, 3 error */
static char wifi_scan_result[1024] = "{\"state\":\"idle\"}";
static uint8_t secure_request[256];
static size_t secure_request_length;
static uint8_t secure_response[240];
static size_t secure_response_length;

static uint32_t read_le32(const uint8_t *value)
{
    return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
           ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static void write_le32(uint8_t *value, uint32_t number)
{
    value[0] = number & 0xff;
    value[1] = (number >> 8) & 0xff;
    value[2] = (number >> 16) & 0xff;
    value[3] = (number >> 24) & 0xff;
}

static void write_le16(uint8_t *value, uint16_t number)
{
    value[0] = number & 0xff;
    value[1] = (number >> 8) & 0xff;
}

static void touch_activity(void)
{
    idle_since = xTaskGetTickCount();
}

static void notify_ota_status(void)
{
    if (status_value_handle != 0) {
        ble_gatts_chr_updated(status_value_handle);
    }
}

static void notify_config_status(void)
{
    if (config_status_value_handle != 0) {
        ble_gatts_chr_updated(config_status_value_handle);
    }
}

static void set_config_status(enum config_state state, const char *message)
{
    config_state = state;
    snprintf(config_message, sizeof(config_message), "%s", message);
    touch_activity();
    notify_config_status();
}

static void close_session(enum ota_state state, enum ota_error error)
{
    if (session.handle != 0) {
        esp_ota_abort(session.handle);
        session.handle = 0;
    }
    if (session.sha256_initialized) {
        mbedtls_sha256_free(&session.sha256);
        session.sha256_initialized = false;
    }
    session.state = state;
    session.error = error;
    touch_activity();
    notify_ota_status();
}

static enum ota_error ota_power_error(void)
{
    hardware_sample_t sample = {0};
    (void)hardware_read(&sample);
    if (!(sample.valid & HARDWARE_VALID_BATTERY) ||
        !(sample.valid & HARDWARE_VALID_CHARGER) ||
        sample.battery_mv > 4300) {
        return OTA_ERROR_BATTERY_UNAVAILABLE;
    }
    float percent = telemetry_battery_percent(sample.battery_mv);
    if (percent < OTA_STOP_THRESHOLD_PERCENT) {
        return OTA_ERROR_BATTERY_TOO_LOW;
    }
    if (percent < OTA_CHARGER_THRESHOLD_PERCENT && !sample.charger_connected) {
        return OTA_ERROR_EXTERNAL_POWER_REQUIRED;
    }
    return OTA_ERROR_NONE;
}

static int begin_update(const uint8_t *command, uint16_t length)
{
    touch_activity();
    enum ota_error power_error = ota_power_error();
    if (power_error != OTA_ERROR_NONE) {
        close_session(OTA_STATE_ERROR, power_error);
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (length != OTA_BEGIN_LENGTH) {
        session.error = OTA_ERROR_BAD_COMMAND;
        notify_ota_status();
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (session.state == OTA_STATE_RECEIVING || session.state == OTA_STATE_VERIFYING) {
        session.error = OTA_ERROR_BAD_STATE;
        notify_ota_status();
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    session.partition = NULL;
    uint32_t image_size = read_le32(command + 1);
    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL) {
        session.state = OTA_STATE_ERROR;
        session.error = OTA_ERROR_NO_PARTITION;
        notify_ota_status();
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (image_size == 0 || image_size > partition->size) {
        session.state = OTA_STATE_ERROR;
        session.error = OTA_ERROR_BAD_SIZE;
        notify_ota_status();
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    memset(&session, 0, sizeof(session));
    session.state = OTA_STATE_RECEIVING;
    session.partition = partition;
    session.expected_size = image_size;
    session.next_power_check = OTA_POWER_RECHECK_INTERVAL;
    memcpy(session.expected_sha256, command + 5, sizeof(session.expected_sha256));
    esp_err_t error = esp_ota_begin(partition, OTA_WITH_SEQUENTIAL_WRITES, &session.handle);
    if (error != ESP_OK) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_BEGIN_FAILED);
        return BLE_ATT_ERR_UNLIKELY;
    }
    mbedtls_sha256_init(&session.sha256);
    session.sha256_initialized = true;
    if (mbedtls_sha256_starts(&session.sha256, 0) != 0) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_BEGIN_FAILED);
        return BLE_ATT_ERR_UNLIKELY;
    }
    printf("BLE OTA: receiving %" PRIu32 " bytes into %s\n", image_size,
           partition->label);
    notify_ota_status();
    return 0;
}

static int write_update_data(struct os_mbuf *om)
{
    touch_activity();
    uint16_t length = OS_MBUF_PKTLEN(om);
    uint8_t packet[OTA_MAX_DATA_WRITE];
    if (length <= OTA_DATA_HEADER_LENGTH || length > sizeof(packet) ||
        ble_hs_mbuf_to_flat(om, packet, sizeof(packet), NULL) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (session.state != OTA_STATE_RECEIVING || session.handle == 0) {
        session.error = OTA_ERROR_BAD_STATE;
        notify_ota_status();
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (session.received >= session.next_power_check) {
        enum ota_error power_error = ota_power_error();
        if (power_error != OTA_ERROR_NONE) {
            close_session(OTA_STATE_ERROR, power_error);
            return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        }
        session.next_power_check += OTA_POWER_RECHECK_INTERVAL;
    }
    uint32_t offset = read_le32(packet);
    uint32_t payload_length = length - OTA_DATA_HEADER_LENGTH;
    if (offset != session.received) {
        session.error = OTA_ERROR_BAD_OFFSET;
        notify_ota_status();
        return BLE_ATT_ERR_INVALID_OFFSET;
    }
    if (payload_length > session.expected_size - session.received) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    esp_err_t error = esp_ota_write(session.handle, packet + OTA_DATA_HEADER_LENGTH,
                                    payload_length);
    if (error != ESP_OK ||
        mbedtls_sha256_update(&session.sha256, packet + OTA_DATA_HEADER_LENGTH,
                              payload_length) != 0) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_WRITE_FAILED);
        return BLE_ATT_ERR_UNLIKELY;
    }
    session.received += payload_length;
    session.error = OTA_ERROR_NONE;
    if (session.received == session.expected_size ||
        session.received - session.last_notified_received >= OTA_STATUS_NOTIFY_INTERVAL) {
        session.last_notified_received = session.received;
        notify_ota_status();
    }
    return 0;
}

static void restart_task(void *unused)
{
    (void)unused;
    /* Keep GATT alive long enough to acknowledge Commit and let the client
     * read READY. Usually the client disconnects immediately afterward. */
    for (unsigned elapsed = 0;
         client_connected && elapsed < OTA_RESTART_DISCONNECT_WAIT_MS;
         elapsed += 100) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    led_animation_paused = true;
    hardware_led_flash(2, 150, 150);
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

static int commit_update(void)
{
    touch_activity();
    enum ota_error power_error = ota_power_error();
    if (power_error != OTA_ERROR_NONE) {
        close_session(OTA_STATE_ERROR, power_error);
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (session.state != OTA_STATE_RECEIVING || session.handle == 0) {
        session.error = OTA_ERROR_BAD_STATE;
        notify_ota_status();
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (session.received != session.expected_size) {
        session.error = OTA_ERROR_INCOMPLETE;
        notify_ota_status();
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    session.state = OTA_STATE_VERIFYING;
    notify_ota_status();
    uint8_t actual_sha256[32];
    if (mbedtls_sha256_finish(&session.sha256, actual_sha256) != 0) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_INVALID_IMAGE);
        return BLE_ATT_ERR_UNLIKELY;
    }
    mbedtls_sha256_free(&session.sha256);
    session.sha256_initialized = false;
    if (memcmp(actual_sha256, session.expected_sha256, sizeof(actual_sha256)) != 0) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_HASH_MISMATCH);
        return BLE_ATT_ERR_UNLIKELY;
    }
    esp_ota_handle_t handle = session.handle;
    session.handle = 0;
    esp_err_t error = esp_ota_end(handle);
    if (error != ESP_OK) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_INVALID_IMAGE);
        return BLE_ATT_ERR_UNLIKELY;
    }
    error = esp_ota_set_boot_partition(session.partition);
    if (error != ESP_OK) {
        close_session(OTA_STATE_ERROR, OTA_ERROR_BOOT_SELECTION);
        return BLE_ATT_ERR_UNLIKELY;
    }
    session.state = OTA_STATE_READY;
    session.error = OTA_ERROR_NONE;
    notify_ota_status();
    xTaskCreate(restart_task, "ota_restart", 2048, NULL, 5, NULL);
    return 0;
}

static int control_access(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }
    uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t command[OTA_BEGIN_LENGTH];
    if (length == 0 || length > sizeof(command) ||
        ble_hs_mbuf_to_flat(ctxt->om, command, sizeof(command), NULL) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    switch (command[0]) {
    case OTA_CONTROL_BEGIN:
        return begin_update(command, length);
    case OTA_CONTROL_COMMIT:
        return length == 1 ? commit_update() : BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    case OTA_CONTROL_ABORT:
        if (length != 1) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        close_session(OTA_STATE_IDLE, OTA_ERROR_NONE);
        memset(&session, 0, sizeof(session));
        notify_ota_status();
        return 0;
    default:
        session.error = OTA_ERROR_BAD_COMMAND;
        notify_ota_status();
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
}

static int data_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    return ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR
               ? write_update_data(ctxt->om)
               : BLE_ATT_ERR_READ_NOT_PERMITTED;
}

static int ota_status_access(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    /* Byte 3 was reserved: zero means unknown, otherwise OTA index + 1. */
    uint8_t slot = 0;
    if (session.partition != NULL &&
        session.partition->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_MIN &&
        session.partition->subtype < ESP_PARTITION_SUBTYPE_APP_OTA_MAX) {
        slot = session.partition->subtype - ESP_PARTITION_SUBTYPE_APP_OTA_MIN + 1;
    }
    uint8_t status[12] = {OTA_PROTOCOL_VERSION, session.state, session.error, slot};
    write_le32(status + 4, session.received);
    write_le32(status + 8, session.expected_size);
    return os_mbuf_append(ctxt->om, status, sizeof(status)) == 0
               ? 0
               : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int hardware_sample_access(uint16_t conn_handle, uint16_t attr_handle,
                                  struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    hardware_sample_t sample;
    (void)hardware_read(&sample);
    uint8_t value[20] = {sample.version, sample.valid, sample.charger_connected,
                         sample.led_brightness};
    write_le16(value + 4, (uint16_t)sample.accel_x_mg);
    write_le16(value + 6, (uint16_t)sample.accel_y_mg);
    write_le16(value + 8, (uint16_t)sample.accel_z_mg);
    write_le16(value + 10, (uint16_t)sample.temperature_centi_c);
    write_le16(value + 12, (uint16_t)sample.battery_adc_raw);
    write_le16(value + 14, sample.battery_mv);
    float gravity = telemetry_gravity(&sample) / 1000.0f;
    uint32_t gravity_bits;
    memcpy(&gravity_bits, &gravity, sizeof(gravity_bits));
    write_le32(value + 16, gravity_bits);
    return os_mbuf_append(ctxt->om, value, sizeof(value)) == 0
               ? 0
               : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int config_info_access(uint16_t conn_handle, uint16_t attr_handle,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    char json[768];
    if (app_config_public_json(json, sizeof(json)) != ESP_OK) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
               ? 0
               : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int config_write_packet(const uint8_t *packet, uint16_t length)
{
    touch_activity();
    switch (packet[0]) {
    case CONFIG_WRITE_BEGIN:
        if (length != 1 || config_state == CONFIG_STATE_TESTING) {
            return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        }
        config_document_length = 0;
        staged_config_valid = false;
        set_config_status(CONFIG_STATE_RECEIVING, "Receiving configuration");
        return 0;
    case CONFIG_WRITE_CHUNK: {
        size_t payload = length - 1;
        if (config_state != CONFIG_STATE_RECEIVING || payload == 0 ||
            payload > CONFIG_DOCUMENT_MAX - config_document_length) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        memcpy(config_document + config_document_length, packet + 1, payload);
        config_document_length += payload;
        return 0;
    }
    case CONFIG_WRITE_FINISH: {
        if (length != 1 || config_state != CONFIG_STATE_RECEIVING) {
            return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        }
        config_document[config_document_length] = '\0';
        char validation[128];
        if (app_config_stage_json(config_document, &staged_config, validation,
                                  sizeof(validation)) != ESP_OK) {
            staged_config_valid = false;
            set_config_status(CONFIG_STATE_ERROR, validation);
            return BLE_ATT_ERR_UNLIKELY;
        }
        staged_config_valid = true;
        set_config_status(CONFIG_STATE_STAGED, "Configuration ready to test");
        return 0;
    }
    default:
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
}

static int config_write_access(uint16_t conn_handle, uint16_t attr_handle,
                               struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t packet[OTA_MAX_DATA_WRITE];
    if (length < 1 || length > sizeof(packet) ||
        ble_hs_mbuf_to_flat(ctxt->om, packet, sizeof(packet), NULL) != 0)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    return config_write_packet(packet, length);
}

static void apply_config_task(void *unused)
{
    (void)unused;
    hardware_sample_t sample;
    (void)hardware_read(&sample);
    char message[128] = "Configuration saved";
    esp_err_t error = ESP_OK;
    if (config_action == CONFIG_COMMAND_WIFI) {
        error = wifi_report_test_connection(&staged_config, message, sizeof(message));
    } else if (config_action == CONFIG_COMMAND_TEST || staged_config.wifi_telemetry) {
        error = wifi_report_send(&staged_config, &sample, message, sizeof(message));
    }
    if (error == ESP_OK) {
        if (config_action != CONFIG_COMMAND_TEST) {
            error = app_config_commit(&staged_config);
        }
        if (error == ESP_OK) {
            staged_config_valid = false;
            if (config_action == CONFIG_COMMAND_TEST) {
                set_config_status(CONFIG_STATE_TESTED, "Test POST succeeded; settings not saved");
            } else {
                set_config_status(CONFIG_STATE_SAVED, config_action == CONFIG_COMMAND_WIFI
                                  ? "Wi-Fi connected and saved"
                                  : "Configuration tested and saved");
            }
            led_animation_paused = true;
            hardware_led_flash(2, 150, 150);
            led_animation_paused = false;
        } else {
            snprintf(message, sizeof(message), "Could not save configuration");
        }
    }
    if (error != ESP_OK) {
        set_config_status(CONFIG_STATE_ERROR, message);
        led_animation_paused = true;
        hardware_led_sos_twice();
        led_animation_paused = false;
    }
    vTaskDelete(NULL);
}

static int config_command_packet(uint8_t command)
{
    touch_activity();
    if (command == CONFIG_COMMAND_DISCARD) {
        if (config_state == CONFIG_STATE_TESTING) {
            return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        }
        staged_config_valid = false;
        config_document_length = 0;
        set_config_status(CONFIG_STATE_IDLE, "Staged configuration discarded");
        return 0;
    }
    if (command != CONFIG_COMMAND_APPLY && command != CONFIG_COMMAND_WIFI &&
        command != CONFIG_COMMAND_TEST) {
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
    if (!staged_config_valid || config_state != CONFIG_STATE_STAGED) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    if (command == CONFIG_COMMAND_WIFI) {
        app_config_t current;
        app_config_get(&current);
        if (staged_config.schema_version != current.schema_version ||
            staged_config.wake_interval_s != current.wake_interval_s ||
            staged_config.wifi_timeout_s != current.wifi_timeout_s ||
            staged_config.ble_telemetry != current.ble_telemetry ||
            staged_config.wifi_telemetry != current.wifi_telemetry ||
            staged_config.auto_wifi_update != current.auto_wifi_update ||
            staged_config.allow_http != current.allow_http ||
            strcmp(staged_config.endpoint_url, current.endpoint_url) != 0) {
            set_config_status(CONFIG_STATE_ERROR, "Wi-Fi setup can only change the network");
            return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
        }
    }
    config_action = command;
    set_config_status(CONFIG_STATE_TESTING,
                      command == CONFIG_COMMAND_WIFI ? "Connecting to Wi-Fi"
                      : command == CONFIG_COMMAND_TEST ? "Sending test POST"
                      : staged_config.wifi_telemetry ? "Testing Wi-Fi and endpoint"
                                                   : "Saving configuration");
    if (xTaskCreate(apply_config_task, "config_apply", 8192, NULL, 5, NULL) != pdPASS) {
        set_config_status(CONFIG_STATE_ERROR, "Could not start configuration test");
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return 0;
}

static int config_command_access(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR || OS_MBUF_PKTLEN(ctxt->om) != 1)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint8_t command;
    if (ble_hs_mbuf_to_flat(ctxt->om, &command, 1, NULL) != 0) return BLE_ATT_ERR_UNLIKELY;
    return config_command_packet(command);
}

static int config_status_access(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    char json[224];
    int length = snprintf(json, sizeof(json),
                          "{\"version\":%u,\"state\":%u,\"message\":\"%s\"}",
                          CONFIG_PROTOCOL_VERSION, config_state, config_message);
    if (length < 0 || (size_t)length >= sizeof(json)) {
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return os_mbuf_append(ctxt->om, json, length) == 0
               ? 0
               : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static void wifi_scan_task(void *unused)
{
    (void)unused;
    wifi_scan_network_t networks[WIFI_SCAN_MAX_NETWORKS] = {0};
    size_t count = 0;
    esp_err_t error = wifi_scan_networks(networks, &count);
    if (error == ESP_OK) {
        cJSON *root = cJSON_CreateObject();
        cJSON *items = root ? cJSON_AddArrayToObject(root, "networks") : NULL;
        for (size_t index = 0; items && index < count; ++index) {
            cJSON *item = cJSON_CreateObject();
            if (item == NULL) break;
            cJSON_AddStringToObject(item, "ssid", networks[index].ssid);
            cJSON_AddNumberToObject(item, "rssi", networks[index].rssi);
            cJSON_AddBoolToObject(item, "secure", networks[index].secure);
            cJSON_AddItemToArray(items, item);
        }
        if (root) cJSON_AddStringToObject(root, "state", "ready");
        char *json = root ? cJSON_PrintUnformatted(root) : NULL;
        if (json && strlen(json) < sizeof(wifi_scan_result)) {
            snprintf(wifi_scan_result, sizeof(wifi_scan_result), "%s", json);
        } else {
            error = ESP_ERR_NO_MEM;
        }
        if (json) cJSON_free(json);
        if (root) cJSON_Delete(root);
    }
    if (error != ESP_OK) {
        snprintf(wifi_scan_result, sizeof(wifi_scan_result),
                 "{\"state\":\"error\",\"message\":\"Wi-Fi scan failed (%s)\"}",
                 esp_err_to_name(error));
    }
    wifi_scan_state = error == ESP_OK ? 2 : 3;
    vTaskDelete(NULL);
}

static int start_wifi_scan(void)
{
    if (wifi_scan_state == 1 || config_state == CONFIG_STATE_TESTING)
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    wifi_scan_state = 1;
    if (xTaskCreate(wifi_scan_task, "wifi_scan", 6144, NULL, 5, NULL) != pdPASS) {
        wifi_scan_state = 3;
        snprintf(wifi_scan_result, sizeof(wifi_scan_result),
                 "{\"state\":\"error\",\"message\":\"Could not start Wi-Fi scan\"}");
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return 0;
}

static int config_wifi_scan_access(uint16_t conn_handle, uint16_t attr_handle,
                                   struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    touch_activity();
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *result = wifi_scan_state == 1
                                 ? "{\"state\":\"scanning\"}"
                                 : wifi_scan_result;
        return os_mbuf_append(ctxt->om, result, strlen(result)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR ||
        OS_MBUF_PKTLEN(ctxt->om) != 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint8_t command = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, &command, 1, NULL) != 0 || command != 1)
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    return start_wifi_scan();
}

/* v2 configuration tunnel. Its GATT attributes are deliberately unprotected:
 * the only secret-bearing bytes are inside per-connection AES-GCM records. */
static int secure_session_access(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint8_t key[66];
        if (ble_secure_public_key(key) != 0) return BLE_ATT_ERR_UNLIKELY;
        return os_mbuf_append(ctxt->om, key, sizeof(key)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t fragment[20];
    if (length < 2 || length > sizeof(fragment) ||
        ble_hs_mbuf_to_flat(ctxt->om, fragment, sizeof(fragment), NULL) != 0)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    secure_request_length = secure_response_length = 0;
    return ble_secure_accept_fragment(fragment, length) == 0 ? 0 : BLE_ATT_ERR_UNLIKELY;
}

static int secure_dispatch(const uint8_t *request, size_t length,
                           uint8_t *response, size_t *response_length)
{
    if (length < 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    touch_activity();
    *response_length = 0;
    switch (request[0]) {
    case 1:
        return config_write_packet(request + 1, length - 1);
    case 2:
        return length == 2 ? config_command_packet(request[1]) : BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    case 3:
    case 4: {
        if (length != 3) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        char json[1024];
        const char *source = json;
        if (request[0] == 3) {
            if (app_config_public_json(json, sizeof(json)) != ESP_OK) return BLE_ATT_ERR_UNLIKELY;
        } else {
            source = wifi_scan_state == 1 ? "{\"state\":\"scanning\"}" : wifi_scan_result;
        }
        size_t total = strlen(source);
        size_t offset = request[1] | ((size_t)request[2] << 8);
        if (offset > total || total > UINT16_MAX) return BLE_ATT_ERR_INVALID_OFFSET;
        size_t count = total - offset;
        if (count > 180) count = 180;
        write_le16(response, (uint16_t)total);
        memcpy(response + 2, source + offset, count);
        *response_length = count + 2;
        return 0;
    }
    case 5:
        return length == 1 ? start_wifi_scan() : BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    default:
        return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
    }
}

static int secure_request_access(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    uint8_t fragment[20];
    uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
    if (length < 3 || length > sizeof(fragment) ||
        ble_hs_mbuf_to_flat(ctxt->om, fragment, sizeof(fragment), NULL) != 0)
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    size_t total = fragment[0], offset = fragment[1], payload = length - 2;
    if (total < 21 || total > sizeof(secure_request) || offset != secure_request_length ||
        offset + payload > total) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    memcpy(secure_request + offset, fragment + 2, payload);
    secure_request_length += payload;
    if (secure_request_length != total) return 0;
    secure_request_length = 0;
    secure_response_length = 0;
    uint8_t plain[236], answer[182];
    size_t plain_length, answer_length;
    if (ble_secure_open(secure_request, total, plain, &plain_length) != 0)
        return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    int rc = secure_dispatch(plain, plain_length, answer, &answer_length);
    mbedtls_platform_zeroize(plain, sizeof(plain));
    if (rc != 0) {
        mbedtls_platform_zeroize(answer, sizeof(answer));
        return rc;
    }
    rc = ble_secure_seal(answer, answer_length, secure_response,
                         &secure_response_length);
    mbedtls_platform_zeroize(answer, sizeof(answer));
    return rc == 0 ? 0 : BLE_ATT_ERR_UNLIKELY;
}

static int secure_response_access(uint16_t conn_handle, uint16_t attr_handle,
                                  struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    if (secure_response_length == 0) return BLE_ATT_ERR_UNLIKELY;
    return os_mbuf_append(ctxt->om, secure_response, secure_response_length) == 0
        ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &OTA_SERVICE_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {.uuid = &OTA_CONTROL_UUID.u, .access_cb = control_access,
             .flags = BLE_GATT_CHR_F_WRITE},
            {.uuid = &OTA_DATA_UUID.u, .access_cb = data_access,
             .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP},
            {.uuid = &OTA_STATUS_UUID.u, .access_cb = ota_status_access,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
             .val_handle = &status_value_handle},
            {0},
        },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &HARDWARE_SERVICE_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {.uuid = &HARDWARE_SAMPLE_UUID.u, .access_cb = hardware_sample_access,
             .flags = BLE_GATT_CHR_F_READ},
            {0},
        },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &CONFIG_SERVICE_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {.uuid = &CONFIG_INFO_UUID.u, .access_cb = config_info_access,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC},
            {.uuid = &CONFIG_WRITE_UUID.u, .access_cb = config_write_access,
             .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC},
            {.uuid = &CONFIG_COMMAND_UUID.u, .access_cb = config_command_access,
             .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC},
            {.uuid = &CONFIG_STATUS_UUID.u, .access_cb = config_status_access,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
             .val_handle = &config_status_value_handle},
            {.uuid = &CONFIG_WIFI_SCAN_UUID.u, .access_cb = config_wifi_scan_access,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC |
                      BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC},
            {.uuid = &CONFIG_SESSION_UUID.u, .access_cb = secure_session_access,
             .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE},
            {.uuid = &CONFIG_SECURE_REQUEST_UUID.u, .access_cb = secure_request_access,
             .flags = BLE_GATT_CHR_F_WRITE},
            {.uuid = &CONFIG_SECURE_RESPONSE_UUID.u, .access_cb = secure_response_access,
             .flags = BLE_GATT_CHR_F_READ},
            {0},
        },
    },
    {0},
};

/* NimBLE's compiled-in pairing support checks this RAM-backed store even
 * when the application does not retain bonds between sessions. */
void ble_store_config_init(void);

static void advertise(void);

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            ble_secure_reset();
            client_connected = true;
            touch_activity();
            printf("BLE: client connected\n");
            /* Legacy config characteristics may initiate link pairing; v2
             * clients use the application-layer session instead. */
        } else if (!closing) {
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        ble_secure_reset();
        printf("BLE: client disconnected, reason %d\n", event->disconnect.reason);
        client_connected = false;
        touch_activity();
        if (session.state == OTA_STATE_RECEIVING || session.state == OTA_STATE_VERIFYING) {
            close_session(OTA_STATE_ERROR, OTA_ERROR_DISCONNECTED);
        }
        if (!closing && maintenance_mode) {
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        if (!maintenance_mode) {
            xEventGroupSetBits(ble_events, BLE_DONE_BIT);
        } else if (!closing && !client_connected) {
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_MTU:
        printf("BLE: negotiated MTU %d\n", event->mtu.value);
        return 0;
    case BLE_GAP_EVENT_ENC_CHANGE:
        printf("BLE: encryption change status %d\n", event->enc_change.status);
        /* A failed pairing attempt must not kill service discovery. The
         * encrypted characteristic flags continue to reject plain traffic. */
        return 0;
    default:
        return 0;
    }
}

static void advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.mfg_data = advertisement_payload;
    fields.mfg_data_len = sizeof(advertisement_payload);
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        printf("BLE: advertising data failed: %d\n", rc);
        xEventGroupSetBits(ble_events, BLE_DONE_BIT);
        return;
    }
    struct ble_hs_adv_fields response = {0};
    const char *name = ble_svc_gap_device_name();
    response.name = (uint8_t *)name;
    response.name_len = strlen(name);
    response.name_is_complete = 1;
    if (ble_gap_adv_rsp_set_fields(&response) != 0) {
        xEventGroupSetBits(ble_events, BLE_DONE_BIT);
        return;
    }
    struct ble_gap_adv_params parameters = {0};
    parameters.conn_mode = maintenance_mode ? BLE_GAP_CONN_MODE_UND
                                            : BLE_GAP_CONN_MODE_NON;
    parameters.disc_mode = BLE_GAP_DISC_MODE_GEN;
    parameters.itvl_min = 240;
    parameters.itvl_max = 240;
    int32_t duration = maintenance_mode ? BLE_HS_FOREVER : TELEMETRY_BURST_MS;
    int rc2 = ble_gap_adv_start(own_addr_type, NULL, duration, &parameters,
                                gap_event, NULL);
    if (rc2 != 0) {
        printf("BLE: advertising start failed: %d\n", rc2);
        xEventGroupSetBits(ble_events, BLE_DONE_BIT);
    }
}

static void window_task(void *unused)
{
    (void)unused;
    unsigned phase = 0;
    unsigned horizontal_idle_seconds = 0;
    while (!closing) {
        if (!led_animation_paused) {
            if (session.state == OTA_STATE_RECEIVING ||
                session.state == OTA_STATE_VERIFYING) {
                (void)hardware_set_led(phase % 2 ? 110 : 4);
            } else if (client_connected) {
                (void)hardware_set_led(14);
            } else {
                unsigned triangle = phase % 40;
                if (triangle > 20) {
                    triangle = 40 - triangle;
                }
                (void)hardware_set_led((uint8_t)(3 + triangle));
            }
        }
        bool idle = !client_connected && session.state != OTA_STATE_RECEIVING &&
                    session.state != OTA_STATE_VERIFYING &&
                    config_state != CONFIG_STATE_TESTING;
        /* Allow a brief reconnect after a restart or disconnect, then leave
         * maintenance if the unconnected Pill remains on its side. */
        if (idle && phase % 20 == 0) {
            hardware_sample_t sample;
            (void)hardware_read(&sample);
            horizontal_idle_seconds = hardware_orientation(&sample) ==
                                      HARDWARE_ORIENTATION_HORIZONTAL
                                          ? horizontal_idle_seconds + 1 : 0;
        } else if (!idle) {
            horizontal_idle_seconds = 0;
        }
        if (idle && (horizontal_idle_seconds >= 10 ||
                     xTaskGetTickCount() - idle_since >=
                         pdMS_TO_TICKS(window_seconds * 1000))) {
            if (horizontal_idle_seconds >= 10) {
                printf("BLE: closing idle maintenance window while horizontal\n");
            }
            closing = true;
            if (ble_gap_adv_active()) {
                (void)ble_gap_adv_stop();
            }
            (void)hardware_set_led(0);
            xEventGroupSetBits(ble_events, BLE_DONE_BIT);
            break;
        }
        ++phase;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    vTaskDelete(NULL);
}

static void on_sync(void)
{
    if (ble_hs_util_ensure_addr(0) != 0 ||
        ble_hs_id_infer_auto(0, &own_addr_type) != 0) {
        xEventGroupSetBits(ble_events, BLE_DONE_BIT);
        return;
    }
    advertise();
    if (maintenance_mode) {
        printf("BLE: maintenance window open for %" PRIu32 " seconds\n",
               window_seconds);
    }
}

static void on_reset(int reason)
{
    printf("BLE: NimBLE reset: %d\n", reason);
    xEventGroupSetBits(ble_events, BLE_DONE_BIT);
}

static void host_task(void *unused)
{
    (void)unused;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static esp_err_t start_ble(bool maintenance, uint32_t timeout_seconds,
                           const hardware_sample_t *sample)
{
    maintenance_mode = maintenance;
    window_seconds = timeout_seconds;
    client_connected = false;
    closing = false;
    led_animation_paused = false;
    idle_since = xTaskGetTickCount();
    memset(&session, 0, sizeof(session));
    config_state = CONFIG_STATE_IDLE;
    snprintf(config_message, sizeof(config_message), "Ready");
    staged_config_valid = false;
    config_document_length = 0;
    (void)telemetry_encode_sample(sample, advertisement_payload);
    ble_events = xEventGroupCreate();
    if (ble_events == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_err_t error = nimble_port_init();
    if (error != ESP_OK) {
        return error;
    }
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
    ble_hs_cfg.sm_bonding = 0;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_store_config_init();
    ble_svc_gap_init();
    ble_svc_gatt_init();
    int rc = ble_gatts_count_cfg(services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(services);
    }
    if (rc != 0) {
        return ESP_FAIL;
    }
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_BT));
    char name[24];
    snprintf(name, sizeof(name), "OpenPill-%02X%02X%02X", mac[3], mac[4], mac[5]);
    if (ble_svc_gap_device_name_set(name) != 0 || ble_att_set_preferred_mtu(517) != 0) {
        return ESP_FAIL;
    }
    nimble_port_freertos_init(host_task);
    if (maintenance &&
        xTaskCreate(window_task, "ble_window", 3072, NULL, 4, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t ble_ota_run_maintenance(uint32_t timeout_seconds,
                                  const hardware_sample_t *sample)
{
    esp_err_t error = start_ble(true, timeout_seconds, sample);
    if (error != ESP_OK) {
        return error;
    }
    xEventGroupWaitBits(ble_events, BLE_DONE_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
    return ESP_OK;
}

esp_err_t ble_ota_send_telemetry(const hardware_sample_t *sample)
{
    esp_err_t error = start_ble(false, 0, sample);
    if (error != ESP_OK) {
        return error;
    }
    xEventGroupWaitBits(ble_events, BLE_DONE_BIT, pdFALSE, pdFALSE,
                        pdMS_TO_TICKS(TELEMETRY_BURST_MS + 2000));
    return ESP_OK;
}
