#include "vendor_calibration.h"

#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_partition.h"
#include "esp_rom_crc.h"

#define NVS_PAGE_SIZE 4096
#define NVS_BITMAP_OFFSET 32
#define NVS_ENTRY_OFFSET 64
#define NVS_ENTRY_SIZE 32
#define NVS_ENTRY_COUNT 126
#define NVS_STATE_WRITTEN 2
#define NVS_TYPE_U8 0x01
#define NVS_TYPE_U32 0x04
#define NVS_TYPE_STRING 0x21
#define GRAVITY_EXPRESSION_MAX 256
#define EXPRESSION_DEPTH_MAX 20

typedef struct __attribute__((packed)) {
    uint8_t namespace_index;
    uint8_t type;
    uint8_t span;
    uint8_t chunk_index;
    uint32_t crc32;
    char key[16];
    uint8_t data[8];
} nvs_item_t;

typedef struct {
    bool gravity_valid;
    bool battery_valid;
    float adc_calibration;
    char expression[GRAVITY_EXPRESSION_MAX];
} calibration_t;

typedef struct {
    const char *cursor;
    float angle;
    unsigned depth;
    bool valid;
} expression_parser_t;

static calibration_t calibration;

static uint32_t read_le32(const uint8_t *value)
{
    return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
           ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static uint8_t entry_state(const uint8_t *page, size_t index)
{
    return (page[NVS_BITMAP_OFFSET + index / 4] >> (2 * (index % 4))) & 3;
}

static bool item_crc_valid(const nvs_item_t *item)
{
    uint32_t crc = esp_rom_crc32_le(UINT32_MAX, (const uint8_t *)item, 4);
    crc = esp_rom_crc32_le(crc, (const uint8_t *)item->key,
                           sizeof(item->key) + sizeof(item->data));
    return crc == item->crc32;
}

static bool key_equals(const nvs_item_t *item, const char *key)
{
    size_t length = strnlen(item->key, sizeof(item->key));
    return length < sizeof(item->key) && strlen(key) == length &&
           memcmp(item->key, key, length) == 0;
}

static const nvs_item_t *item_at(const uint8_t *page, size_t index)
{
    return (const nvs_item_t *)(page + NVS_ENTRY_OFFSET + index * NVS_ENTRY_SIZE);
}

static bool page_is_readable(const uint8_t *page)
{
    uint32_t state = read_le32(page);
    return state != UINT32_MAX && state != 0;
}

static bool newer_sequence(uint32_t candidate, uint32_t current)
{
    return (int32_t)(candidate - current) > 0;
}

static esp_err_t find_namespace(const esp_partition_t *partition, uint8_t *namespace_index)
{
    uint8_t *page = malloc(NVS_PAGE_SIZE);
    if (page == NULL) {
        return ESP_ERR_NO_MEM;
    }

    bool found = false;
    uint32_t found_sequence = 0;
    for (size_t offset = 0; offset + NVS_PAGE_SIZE <= partition->size;
         offset += NVS_PAGE_SIZE) {
        esp_err_t error = esp_partition_read(partition, offset, page, NVS_PAGE_SIZE);
        if (error != ESP_OK) {
            free(page);
            return error;
        }
        if (!page_is_readable(page)) {
            continue;
        }
        uint32_t sequence = read_le32(page + 4);
        for (size_t i = 0; i < NVS_ENTRY_COUNT; ++i) {
            const nvs_item_t *item = item_at(page, i);
            if (entry_state(page, i) == NVS_STATE_WRITTEN &&
                item->namespace_index == 0 && item->type == NVS_TYPE_U8 &&
                item->span == 1 && item_crc_valid(item) && key_equals(item, "nvs") &&
                (!found || newer_sequence(sequence, found_sequence))) {
                *namespace_index = item->data[0];
                found_sequence = sequence;
                found = true;
            }
        }
    }
    free(page);
    return found ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static esp_err_t load_values(const esp_partition_t *partition, uint8_t namespace_index)
{
    uint8_t *page = malloc(NVS_PAGE_SIZE);
    if (page == NULL) {
        return ESP_ERR_NO_MEM;
    }

    bool expression_found = false;
    bool adc_found = false;
    uint32_t expression_sequence = 0;
    uint32_t adc_sequence = 0;
    for (size_t offset = 0; offset + NVS_PAGE_SIZE <= partition->size;
         offset += NVS_PAGE_SIZE) {
        esp_err_t error = esp_partition_read(partition, offset, page, NVS_PAGE_SIZE);
        if (error != ESP_OK) {
            free(page);
            return error;
        }
        if (!page_is_readable(page)) {
            continue;
        }
        uint32_t sequence = read_le32(page + 4);
        for (size_t i = 0; i < NVS_ENTRY_COUNT; ++i) {
            const nvs_item_t *item = item_at(page, i);
            if (entry_state(page, i) != NVS_STATE_WRITTEN ||
                item->namespace_index != namespace_index || !item_crc_valid(item)) {
                continue;
            }

            if (item->type == NVS_TYPE_U32 && item->span == 1 &&
                key_equals(item, "adc_cal") &&
                (!adc_found || newer_sequence(sequence, adc_sequence))) {
                uint32_t bits = read_le32(item->data);
                memcpy(&calibration.adc_calibration, &bits, sizeof(bits));
                adc_sequence = sequence;
                adc_found = true;
            } else if (item->type == NVS_TYPE_STRING && item->span > 1 &&
                       key_equals(item, "expr") &&
                       (!expression_found || newer_sequence(sequence,
                                                             expression_sequence))) {
                uint16_t length = (uint16_t)item->data[0] |
                                  ((uint16_t)item->data[1] << 8);
                size_t capacity = (size_t)(item->span - 1) * NVS_ENTRY_SIZE;
                if (i + item->span <= NVS_ENTRY_COUNT && length > 1 &&
                    length <= capacity && length <= sizeof(calibration.expression)) {
                    const uint8_t *data = (const uint8_t *)item_at(page, i + 1);
                    uint32_t expected_crc = read_le32(item->data + 4);
                    if (data[length - 1] == '\0' &&
                        esp_rom_crc32_le(UINT32_MAX, data, length) == expected_crc) {
                        memcpy(calibration.expression, data, length);
                        expression_sequence = sequence;
                        expression_found = true;
                    }
                }
            }
        }
    }
    free(page);

    calibration.gravity_valid = expression_found;
    float intercept = 1.4f + calibration.adc_calibration * 0.00078125f;
    calibration.battery_valid = adc_found && isfinite(intercept) &&
                                intercept >= 0.8f && intercept <= 1.6f;
    return (expression_found || adc_found) ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static void skip_spaces(expression_parser_t *parser)
{
    while (isspace((unsigned char)*parser->cursor)) {
        ++parser->cursor;
    }
}

static float parse_sum(expression_parser_t *parser);

static float parse_primary(expression_parser_t *parser)
{
    skip_spaces(parser);
    if (++parser->depth > EXPRESSION_DEPTH_MAX) {
        parser->valid = false;
        return 0.0f;
    }

    float result = 0.0f;
    if (*parser->cursor == '(') {
        ++parser->cursor;
        result = parse_sum(parser);
        skip_spaces(parser);
        if (*parser->cursor++ != ')') {
            parser->valid = false;
        }
    } else if (strncmp(parser->cursor, "angle", 5) == 0 &&
               !isalnum((unsigned char)parser->cursor[5]) && parser->cursor[5] != '_') {
        parser->cursor += 5;
        result = parser->angle;
    } else {
        char *end = NULL;
        result = strtof(parser->cursor, &end);
        if (end == parser->cursor) {
            parser->valid = false;
        } else {
            parser->cursor = end;
        }
    }
    --parser->depth;
    return result;
}

static float parse_unary(expression_parser_t *parser)
{
    skip_spaces(parser);
    if (*parser->cursor == '+') {
        ++parser->cursor;
        return parse_unary(parser);
    }
    if (*parser->cursor == '-') {
        ++parser->cursor;
        return -parse_unary(parser);
    }
    return parse_primary(parser);
}

static float parse_power(expression_parser_t *parser)
{
    float left = parse_unary(parser);
    skip_spaces(parser);
    if (*parser->cursor == '^') {
        ++parser->cursor;
        left = powf(left, parse_power(parser));
    }
    return left;
}

static float parse_product(expression_parser_t *parser)
{
    float result = parse_power(parser);
    for (;;) {
        skip_spaces(parser);
        char operation = *parser->cursor;
        if (operation != '*' && operation != '/') {
            return result;
        }
        ++parser->cursor;
        float right = parse_power(parser);
        if (operation == '/' && right == 0.0f) {
            parser->valid = false;
            return 0.0f;
        }
        result = operation == '*' ? result * right : result / right;
    }
}

static float parse_sum(expression_parser_t *parser)
{
    float result = parse_product(parser);
    for (;;) {
        skip_spaces(parser);
        char operation = *parser->cursor;
        if (operation != '+' && operation != '-') {
            return result;
        }
        ++parser->cursor;
        float right = parse_product(parser);
        result = operation == '+' ? result + right : result - right;
    }
}

static bool evaluate_expression(const char *expression, float angle, float *result)
{
    expression_parser_t parser = {
        .cursor = expression,
        .angle = angle,
        .valid = true,
    };
    float value = parse_sum(&parser);
    skip_spaces(&parser);
    if (!parser.valid || *parser.cursor != '\0' || !isfinite(value)) {
        return false;
    }
    *result = value;
    return true;
}

static float default_gravity(float angle)
{
    return (((((3.11683e-6f * angle - 0.000786275f) * angle + 0.07871266f) *
               angle - 3.916024112f) * angle + 98.73244f) * angle - 8.09818f);
}

esp_err_t vendor_calibration_load(void)
{
    memset(&calibration, 0, sizeof(calibration));
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "nvs");
    if (partition == NULL) {
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t namespace_index;
    esp_err_t error = find_namespace(partition, &namespace_index);
    if (error == ESP_OK) {
        error = load_values(partition, namespace_index);
    }

    float test;
    if (calibration.gravity_valid &&
        (!evaluate_expression(calibration.expression, 45.0f, &test) ||
         test < 500.0f || test > 1500.0f)) {
        calibration.gravity_valid = false;
    }

    printf("Vendor calibration (read-only): gravity=%s battery=%s\n",
           calibration.gravity_valid ? "loaded" : "default",
           calibration.battery_valid ? "loaded" : "nominal");
    return error;
}

bool vendor_calibration_has_gravity(void)
{
    return calibration.gravity_valid;
}

bool vendor_calibration_has_battery(void)
{
    return calibration.battery_valid;
}

float vendor_calibration_gravity(float angle_degrees)
{
    float result;
    if (calibration.gravity_valid &&
        evaluate_expression(calibration.expression, angle_degrees, &result)) {
        return result;
    }
    return default_gravity(angle_degrees);
}

uint16_t vendor_calibration_battery_mv(int16_t adc_raw)
{
    float adc_cal = calibration.battery_valid ? calibration.adc_calibration : 0.0f;
    float millivolts =
        (1.4f + (adc_cal - (float)adc_raw) * 0.00078125f) * 3000.0f;
    if (millivolts <= 0.0f) {
        return 0;
    }
    if (millivolts >= UINT16_MAX) {
        return UINT16_MAX;
    }
    return (uint16_t)lroundf(millivolts);
}

