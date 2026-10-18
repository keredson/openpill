#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define HISTORY_PUBLIC_KEY_LENGTH 65
#define HISTORY_SIGNATURE_MAX 80

esp_err_t history_identity_init(void);
esp_err_t history_identity_reset(void);
bool history_identity_ready(void);
esp_err_t history_identity_public(uint8_t output[HISTORY_PUBLIC_KEY_LENGTH]);
esp_err_t history_identity_id(char output[65]);
esp_err_t history_identity_sign(const uint8_t digest[32],
                                uint8_t output[HISTORY_SIGNATURE_MAX], size_t *length);
