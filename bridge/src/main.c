#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define USB_UART UART_NUM_0
#define PILL_UART UART_NUM_2
#define PILL_RX GPIO_NUM_16
#define PILL_TX GPIO_NUM_17
#define PILL_EN GPIO_NUM_25
#define PILL_IO0 GPIO_NUM_26

static const char *const commands[] = {
    "+++OPENPILL_BOOT\r",
    "+++OPENPILL_RESET\r",
    "+++OPENPILL_PING\r"
};

static void release_pin(gpio_num_t pin) { gpio_set_level(pin, 1); }
static void pull_low(gpio_num_t pin) { gpio_set_level(pin, 0); }

static void pill_reset(bool downloader)
{
    if (downloader) pull_low(PILL_IO0);
    else release_pin(PILL_IO0);
    pull_low(PILL_EN);
    vTaskDelay(pdMS_TO_TICKS(100));
    release_pin(PILL_EN);
    vTaskDelay(pdMS_TO_TICKS(100));
    release_pin(PILL_IO0);
}

static void handle_command(unsigned command)
{
    if (command == 0) {
        pill_reset(true);
        uart_write_bytes(USB_UART, "OPENPILL-BRIDGE BOOT\n", 21);
    } else if (command == 1) {
        pill_reset(false);
        uart_write_bytes(USB_UART, "OPENPILL-BRIDGE RESET\n", 22);
    } else {
        uart_write_bytes(USB_UART, "OPENPILL-BRIDGE/1\n", 18);
    }
}

static void pc_to_pill(void *unused)
{
    (void)unused;
    uint8_t buffer[256];
    uint8_t forward[256];
    uint8_t pending[sizeof("+++OPENPILL_RESET\r")];
    size_t pending_length = 0;
    while (true) {
        int count = uart_read_bytes(USB_UART, buffer, sizeof(buffer), pdMS_TO_TICKS(20));
        size_t forward_length = 0;
        for (int i = 0; i < count; ++i) {
            pending[pending_length++] = buffer[i];
            bool prefix = false;
            for (unsigned command = 0; command < sizeof(commands) / sizeof(commands[0]); ++command) {
                size_t length = strlen(commands[command]);
                if (pending_length <= length &&
                    memcmp(pending, commands[command], pending_length) == 0) {
                    prefix = true;
                    if (pending_length == length) {
                        if (forward_length > 0) {
                            uart_write_bytes(PILL_UART, (const char *)forward, forward_length);
                            forward_length = 0;
                        }
                        pending_length = 0;
                        handle_command(command);
                    }
                    break;
                }
            }
            if (!prefix) {
                memcpy(forward + forward_length, pending, pending_length);
                forward_length += pending_length;
                pending_length = 0;
            }
        }
        if (forward_length > 0) {
            uart_write_bytes(PILL_UART, (const char *)forward, forward_length);
        }
    }
}

static void pill_to_pc(void *unused)
{
    (void)unused;
    uint8_t buffer[256];
    while (true) {
        int count = uart_read_bytes(PILL_UART, buffer, sizeof(buffer), pdMS_TO_TICKS(20));
        if (count > 0) uart_write_bytes(USB_UART, (const char *)buffer, count);
    }
}

void app_main(void)
{
    esp_log_level_set("*", ESP_LOG_NONE);
    gpio_config_t control = {
        .pin_bit_mask = (1ULL << PILL_EN) | (1ULL << PILL_IO0),
        .mode = GPIO_MODE_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&control);
    release_pin(PILL_EN);
    release_pin(PILL_IO0);

    uart_driver_install(USB_UART, 16384, 8192, 0, NULL, 0);
    uart_set_baudrate(USB_UART, 115200);
    uart_driver_install(PILL_UART, 8192, 16384, 0, NULL, 0);
    uart_set_pin(PILL_UART, PILL_TX, PILL_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    uart_set_baudrate(PILL_UART, 115200);
    xTaskCreate(pc_to_pill, "pc_to_pill", 4096, NULL, 10, NULL);
    xTaskCreate(pill_to_pc, "pill_to_pc", 4096, NULL, 10, NULL);
}
