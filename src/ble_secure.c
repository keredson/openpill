#include "ble_secure.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecp.h"
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"

static uint8_t client_public[65];
static uint8_t server_public[65];
static uint8_t client_key[32], server_key[32];
static uint8_t client_iv[12], server_iv[12];
static size_t received;
static uint32_t client_sequence, server_sequence;
static bool ready;
static bool failed;
static uint32_t generation;
static portMUX_TYPE secure_lock = portMUX_INITIALIZER_UNLOCKED;

struct key_job {
    uint8_t client_public[65];
    uint32_t generation;
};

static int random_bytes(void *unused, unsigned char *output, size_t length)
{
    (void)unused;
    esp_fill_random(output, length);
    return 0;
}

void ble_secure_reset(void)
{
    portENTER_CRITICAL(&secure_lock);
    generation++;
    mbedtls_platform_zeroize(client_public, sizeof(client_public));
    mbedtls_platform_zeroize(server_public, sizeof(server_public));
    mbedtls_platform_zeroize(client_key, sizeof(client_key));
    mbedtls_platform_zeroize(server_key, sizeof(server_key));
    mbedtls_platform_zeroize(client_iv, sizeof(client_iv));
    mbedtls_platform_zeroize(server_iv, sizeof(server_iv));
    received = 0;
    client_sequence = server_sequence = 0;
    ready = false;
    failed = false;
    portEXIT_CRITICAL(&secure_lock);
}

static int derive_keys(const uint8_t shared[32], const uint8_t client[65],
                       const uint8_t server[65], uint8_t derived[88])
{
    const mbedtls_md_info_t *sha = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    const uint8_t info[] = "OpenPill config v1";
    uint8_t public_keys[130], salt[32], prk[32], previous[32], block[sizeof(info) + 32 + 1];
    memcpy(public_keys, client, 65);
    memcpy(public_keys + 65, server, 65);
    int rc = mbedtls_sha256(public_keys, sizeof(public_keys), salt, 0);
    if (rc == 0) rc = mbedtls_md_hmac(sha, salt, sizeof(salt), shared, 32, prk);
    size_t done = 0, previous_length = 0;
    for (uint8_t counter = 1; rc == 0 && done < 88; counter++) {
        memcpy(block, previous, previous_length);
        memcpy(block + previous_length, info, sizeof(info) - 1);
        block[previous_length + sizeof(info) - 1] = counter;
        rc = mbedtls_md_hmac(sha, prk, sizeof(prk), block,
                             previous_length + sizeof(info), previous);
        if (rc == 0) {
            size_t count = 88 - done;
            if (count > 32) count = 32;
            memcpy(derived + done, previous, count);
            done += count;
            previous_length = 32;
        }
    }
    mbedtls_platform_zeroize(public_keys, sizeof(public_keys));
    mbedtls_platform_zeroize(salt, sizeof(salt));
    mbedtls_platform_zeroize(prk, sizeof(prk));
    mbedtls_platform_zeroize(previous, sizeof(previous));
    mbedtls_platform_zeroize(block, sizeof(block));
    return rc;
}

static void key_task(void *argument)
{
    struct key_job *job = argument;
    mbedtls_ecp_group group;
    mbedtls_ecp_point peer, own;
    mbedtls_mpi private, shared;
    mbedtls_ecp_group_init(&group);
    mbedtls_ecp_point_init(&peer);
    mbedtls_ecp_point_init(&own);
    mbedtls_mpi_init(&private);
    mbedtls_mpi_init(&shared);
    uint8_t shared_bytes[32], public_key[65], material[88];
    size_t written = 0;
    int rc = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1);
    if (rc == 0) rc = mbedtls_ecp_point_read_binary(&group, &peer, job->client_public, 65);
    if (rc == 0) rc = mbedtls_ecp_check_pubkey(&group, &peer);
    if (rc == 0) rc = mbedtls_ecdh_gen_public(&group, &private, &own, random_bytes, NULL);
    if (rc == 0) rc = mbedtls_ecp_point_write_binary(&group, &own,
        MBEDTLS_ECP_PF_UNCOMPRESSED, &written, public_key, 65);
    if (rc == 0 && written != 65) rc = -1;
    if (rc == 0) rc = mbedtls_ecdh_compute_shared(&group, &shared, &peer,
                                                   &private, random_bytes, NULL);
    if (rc == 0) rc = mbedtls_mpi_write_binary(&shared, shared_bytes, 32);
    if (rc == 0) rc = derive_keys(shared_bytes, job->client_public, public_key, material);
    portENTER_CRITICAL(&secure_lock);
    if (job->generation == generation) {
        if (rc == 0) {
            memcpy(server_public, public_key, 65);
            memcpy(client_key, material, 32);
            memcpy(client_iv, material + 32, 12);
            memcpy(server_key, material + 44, 32);
            memcpy(server_iv, material + 76, 12);
            ready = true;
        } else {
            failed = true;
        }
    }
    portEXIT_CRITICAL(&secure_lock);
    mbedtls_platform_zeroize(shared_bytes, sizeof(shared_bytes));
    mbedtls_platform_zeroize(material, sizeof(material));
    mbedtls_platform_zeroize(public_key, sizeof(public_key));
    mbedtls_ecp_group_free(&group);
    mbedtls_ecp_point_free(&peer);
    mbedtls_ecp_point_free(&own);
    mbedtls_mpi_free(&private);
    mbedtls_mpi_free(&shared);
    mbedtls_platform_zeroize(job, sizeof(*job));
    free(job);
    vTaskDelete(NULL);
}

int ble_secure_accept_fragment(const uint8_t *data, size_t length)
{
    if (length < 2 || length > 20 || data[0] != received ||
        received + length - 1 > sizeof(client_public)) return -1;
    if (received == 0) ble_secure_reset();
    memcpy(client_public + received, data + 1, length - 1);
    received += length - 1;
    if (received != sizeof(client_public)) return 0;
    struct key_job *job = malloc(sizeof(*job));
    if (job == NULL) return -1;
    memcpy(job->client_public, client_public, 65);
    job->generation = generation;
    if (xTaskCreate(key_task, "ble_key", 8192, job, 3, NULL) != pdPASS) {
        free(job);
        return -1;
    }
    return 0;
}

int ble_secure_public_key(uint8_t output[66])
{
    portENTER_CRITICAL(&secure_lock);
    int result = failed ? -1 : 0;
    memset(output, 0, 66);
    if (ready) {
        output[0] = 1;
        memcpy(output + 1, server_public, 65);
    }
    portEXIT_CRITICAL(&secure_lock);
    return result;
}

static void nonce(uint8_t output[12], const uint8_t base[12], const uint8_t sequence[4])
{
    memcpy(output, base, 12);
    for (size_t i = 0; i < 4; ++i) output[8 + i] ^= sequence[i];
}

int ble_secure_open(const uint8_t *packet, size_t length,
                    uint8_t *plain, size_t *plain_length)
{
    if (!ready || length < 21 || length > 256) return -1;
    uint32_t sequence = (uint32_t)packet[0] | ((uint32_t)packet[1] << 8) |
        ((uint32_t)packet[2] << 16) | ((uint32_t)packet[3] << 24);
    if (sequence == 0 || sequence != client_sequence + 1) return -1;
    uint8_t iv[12];
    nonce(iv, client_iv, packet);
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, client_key, 256);
    if (rc == 0) rc = mbedtls_gcm_auth_decrypt(&gcm, length - 20, iv, 12,
        packet, 4, packet + length - 16, 16, packet + 4, plain);
    mbedtls_gcm_free(&gcm);
    if (rc != 0) return rc;
    client_sequence = sequence;
    *plain_length = length - 20;
    return 0;
}

int ble_secure_seal(const uint8_t *plain, size_t length,
                    uint8_t *packet, size_t *packet_length)
{
    if (!ready || length > 220 || server_sequence == UINT32_MAX) return -1;
    uint32_t sequence = server_sequence + 1;
    for (size_t i = 0; i < 4; ++i) packet[i] = sequence >> (i * 8);
    uint8_t iv[12];
    nonce(iv, server_iv, packet);
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, server_key, 256);
    if (rc == 0) rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT,
        length, iv, 12, packet, 4, plain, packet + 4, 16, packet + 4 + length);
    mbedtls_gcm_free(&gcm);
    if (rc != 0) return rc;
    server_sequence = sequence;
    *packet_length = length + 20;
    return 0;
}
