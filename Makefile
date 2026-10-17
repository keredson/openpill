PIO ?= pio
PYTHON ?= python3
DEVICE ?=
UPLOAD_FLAGS ?=
ESP32_PORT ?= /dev/ttyUSB0
FIRMWARE := .pio/build/openpill/firmware.bin
DEVICE_ARG = $(if $(strip $(DEVICE)),--device $(DEVICE),)

.DEFAULT_GOAL := help
.PHONY: help build bridge flash-bridge web-assets flash-pill-via-ble flash-pill-via-bridge backup-pill probe read deploy-major deploy-minor deploy-point

help:
	@printf 'make build                 Build the firmware\n'
	@printf 'make web-assets            Build firmware/bridge and stage browser flasher images\n'
	@printf 'make flash-bridge          Build and flash the USB ESP32 bridge (ESP32_PORT=/dev/ttyUSB0)\n'
	@printf 'make flash-pill-via-bridge  Build and install to the Pill through the wired ESP32 bridge\n'
	@printf 'make flash-pill-via-ble     Build, scan, select a Pill, and upload over BLE\n'
	@printf 'make backup-pill           Save full 4 MiB recovery image and extract both OTA slots\n'
	@printf 'make probe                 Check BLE OTA status\n'
	@printf 'make read                  Read sensors over BLE\n'
	@printf 'make deploy-major          Reserved: major version release (not implemented)\n'
	@printf 'make deploy-minor          Reserved: minor version release (not implemented)\n'
	@printf 'make deploy-point          Reserved: point version release (not implemented)\n'
	@printf 'For scripts: DEVICE=<name-or-MAC> UPLOAD_FLAGS=--yes.\n'

build:
	$(PIO) run -e openpill

bridge:
	$(PIO) run -d bridge -e openpill-bridge

flash-bridge:
	$(PIO) run -d bridge -e openpill-bridge -t upload --upload-port $(ESP32_PORT)

web-assets: build bridge
	mkdir -p web/public/firmware
	cp $(FIRMWARE) web/public/firmware/openpill.bin
	cp bridge/.pio/build/openpill-bridge/bootloader.bin web/public/firmware/bridge-bootloader.bin
	cp bridge/.pio/build/openpill-bridge/partitions.bin web/public/firmware/bridge-partitions.bin
	cp bridge/.pio/build/openpill-bridge/firmware.bin web/public/firmware/bridge-app.bin

flash-pill-via-ble: build
	$(PYTHON) tools/ble_ota.py upload $(FIRMWARE) $(DEVICE_ARG) $(UPLOAD_FLAGS)

flash-pill-via-bridge: build
	$(PYTHON) tools/serial_flash.py install --port $(ESP32_PORT) --image $(FIRMWARE)

backup-pill:
	$(PYTHON) tools/serial_flash.py backup --port $(ESP32_PORT)

probe:
	$(PYTHON) tools/ble_ota.py probe $(DEVICE_ARG)

read:
	$(PYTHON) tools/ble_ota.py read $(DEVICE_ARG)

deploy-major deploy-minor deploy-point:
	@printf '%s is not implemented; no version, build, tag, or release was changed.\n' '$@'
	@exit 1
