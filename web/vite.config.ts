// Node runtime APIs are available to Vite; this project does not bundle Node typings.
// @ts-ignore -- Node typings are optional for the browser application.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// @ts-ignore -- Node typings are optional for the browser application.
import { createHash } from "node:crypto";
// @ts-ignore -- Node typings are optional for the browser application.
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const localFirmware = fileURLToPath(new URL("../.pio/build/openpill/firmware.bin", import.meta.url));
const stagedFirmware = fileURLToPath(new URL("./public/firmware/openpill.bin", import.meta.url));
const stagedManifest = fileURLToPath(new URL("./public/firmware/latest.json", import.meta.url));

function firmwareManifest(image: Uint8Array) {
  if (image[0] !== 0xe9 || new DataView(image.buffer, image.byteOffset, image.byteLength).getUint32(0x20, true) !== 0xabcd5432) {
    throw new Error("The local firmware has no valid ESP32 application descriptor.");
  }
  const version = new TextDecoder().decode(image.subarray(0x30, 0x50)).split("\0", 1)[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The local firmware needs a semantic version.");
  return { version, size: image.length, sha256: createHash("sha256").update(image).digest("hex") };
}

function serveLocalFirmware(): Plugin {
  return {
    name: "serve-local-openpill-firmware",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const { url, method } = request as { url?: string; method?: string };
        if (url?.split("?")[0] !== "/firmware/openpill.bin" ||
            !existsSync(localFirmware)) return next();
        try {
          const image = readFileSync(localFirmware);
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Content-Length", image.length);
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-OpenPill-Firmware-Source", "local-build");
          response.end(method === "HEAD" ? undefined : image);
        } catch (error) {
          next(error as Error);
        }
      });
      server.middlewares.use((request, response, next) => {
        const { url } = request as { url?: string };
        if (url?.split("?")[0] !== "/firmware/latest.json" ||
            !existsSync(localFirmware)) return next();
        try {
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(firmwareManifest(readFileSync(localFirmware))));
        } catch (error) { next(error as Error); }
      });
    }
  };
}

export default defineConfig(({ command }) => {
  const base = command === "build" ? "/openpill/" : "/";
  if (command === "build") {
    if (existsSync(localFirmware)) {
      mkdirSync(fileURLToPath(new URL("./public/firmware/", import.meta.url)), { recursive: true });
      copyFileSync(localFirmware, stagedFirmware);
    }
    if (existsSync(stagedFirmware)) {
      writeFileSync(stagedManifest, JSON.stringify(firmwareManifest(readFileSync(stagedFirmware))));
    }
  }
  return {
    base,
    build: { rollupOptions: { input: ["index.html", "flash/index.html", "restore/index.html"] } },
    plugins: [
      react(),
      serveLocalFirmware(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["openpill.svg"],
        workbox: {
          globIgnores: ["**/firmware/**", "**/vendor/**"]
        },
        manifest: {
          name: "OpenPill",
          short_name: "OpenPill",
          description: "Configure and read an OpenPill hydrometer",
          theme_color: "#234b3f",
          background_color: "#f8f6f0",
          display: "standalone",
          start_url: base,
          scope: base,
          icons: [
            {
              src: "openpill.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable"
            }
          ]
        }
      })
    ]
  };
});
