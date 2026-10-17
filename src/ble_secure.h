#pragma once

#include <stddef.h>
#include <stdint.h>

/* Ephemeral, unauthenticated P-256 ECDH. Protects configuration from passive
 * listeners; as with Just Works pairing, it does not authenticate the Pill. */
void ble_secure_reset(void);
int ble_secure_accept_fragment(const uint8_t *data, size_t length);
int ble_secure_public_key(uint8_t output[66]);
int ble_secure_open(const uint8_t *packet, size_t length,
                    uint8_t *plain, size_t *plain_length);
int ble_secure_seal(const uint8_t *plain, size_t length,
                    uint8_t *packet, size_t *packet_length);
