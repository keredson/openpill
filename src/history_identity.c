#include "history_identity.h"

#include <stdio.h>
#include <string.h>

#include "esp_random.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/sha256.h"
#include "nvs.h"

#define HISTORY_NAMESPACE "ophistory"
#define HISTORY_KEY "signing_key"

static mbedtls_ecdsa_context identity;
static bool ready;

static int fill_random(void *unused, unsigned char *output, size_t length)
{
    (void)unused;
    esp_fill_random(output, length);
    return 0;
}

esp_err_t history_identity_init(void)
{
    if (ready) return ESP_OK;
    mbedtls_ecdsa_init(&identity);
    nvs_handle_t handle;
    esp_err_t error = nvs_open(HISTORY_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;

    uint8_t private_key[32];
    size_t size = sizeof(private_key);
    error = nvs_get_blob(handle, HISTORY_KEY, private_key, &size);
    if (error == ESP_ERR_NVS_NOT_FOUND) {
        int result = mbedtls_ecdsa_genkey(&identity, MBEDTLS_ECP_DP_SECP256R1,
                                          fill_random, NULL);
        if (result != 0 || mbedtls_mpi_write_binary(&identity.MBEDTLS_PRIVATE(d), private_key,
                                                    sizeof(private_key)) != 0) {
            nvs_close(handle);
            return ESP_FAIL;
        }
        error = nvs_set_blob(handle, HISTORY_KEY, private_key, sizeof(private_key));
        if (error == ESP_OK) error = nvs_commit(handle);
    } else if (error == ESP_OK && size == sizeof(private_key)) {
        int result = mbedtls_ecp_group_load(&identity.MBEDTLS_PRIVATE(grp), MBEDTLS_ECP_DP_SECP256R1);
        if (result == 0) result = mbedtls_mpi_read_binary(&identity.MBEDTLS_PRIVATE(d), private_key,
                                                          sizeof(private_key));
        if (result == 0) result = mbedtls_ecp_check_privkey(&identity.MBEDTLS_PRIVATE(grp), &identity.MBEDTLS_PRIVATE(d));
        if (result == 0) result = mbedtls_ecp_mul(&identity.MBEDTLS_PRIVATE(grp), &identity.MBEDTLS_PRIVATE(Q),
                                                  &identity.MBEDTLS_PRIVATE(d), &identity.MBEDTLS_PRIVATE(grp).G,
                                                  fill_random, NULL);
        if (result != 0) error = ESP_FAIL;
    } else if (error == ESP_OK) {
        error = ESP_ERR_INVALID_SIZE;
    }
    memset(private_key, 0, sizeof(private_key));
    nvs_close(handle);
    ready = error == ESP_OK;
    return error;
}

esp_err_t history_identity_reset(void)
{
    nvs_handle_t handle;
    esp_err_t error = nvs_open(HISTORY_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) return error;
    error = nvs_erase_key(handle, HISTORY_KEY);
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    if (error != ESP_OK) return error;
    ready = false;
    mbedtls_ecdsa_free(&identity);
    return history_identity_init();
}

bool history_identity_ready(void)
{
    return ready;
}

esp_err_t history_identity_public(uint8_t output[HISTORY_PUBLIC_KEY_LENGTH])
{
    if (!ready || output == NULL) return ESP_ERR_INVALID_STATE;
    size_t length = 0;
    int result = mbedtls_ecp_point_write_binary(&identity.MBEDTLS_PRIVATE(grp), &identity.MBEDTLS_PRIVATE(Q),
        MBEDTLS_ECP_PF_UNCOMPRESSED, &length, output, HISTORY_PUBLIC_KEY_LENGTH);
    return result == 0 && length == HISTORY_PUBLIC_KEY_LENGTH ? ESP_OK : ESP_FAIL;
}

esp_err_t history_identity_id(char output[65])
{
    if (output == NULL) return ESP_ERR_INVALID_ARG;
    uint8_t public_key[HISTORY_PUBLIC_KEY_LENGTH];
    if (history_identity_public(public_key) != ESP_OK) return ESP_ERR_INVALID_STATE;
    uint8_t digest[32];
    if (mbedtls_sha256(public_key, sizeof(public_key), digest, 0) != 0) return ESP_FAIL;
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < sizeof(digest); ++i) {
        output[i * 2] = hex[digest[i] >> 4];
        output[i * 2 + 1] = hex[digest[i] & 15];
    }
    output[64] = '\0';
    return ESP_OK;
}

esp_err_t history_identity_sign(const uint8_t digest[32],
                                uint8_t output[HISTORY_SIGNATURE_MAX], size_t *length)
{
    if (!ready || digest == NULL || output == NULL || length == NULL)
        return ESP_ERR_INVALID_STATE;
    int result = mbedtls_ecdsa_write_signature(&identity, MBEDTLS_MD_SHA256,
        digest, 32, output, HISTORY_SIGNATURE_MAX, length, fill_random, NULL);
    return result == 0 ? ESP_OK : ESP_FAIL;
}
