import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";

// HTTPS + LAN so phones/iPads on the same Wi-Fi can use the camera.
// Multi-page: hub + one page per game.
export default defineConfig({
  base: "./", // relative paths: works at username.github.io/<any-repo-name>/
  plugins: [basicSsl()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        hub: resolve(__dirname, "index.html"),
        airDraw: resolve(__dirname, "air-draw/index.html"),
        spells: resolve(__dirname, "spells/index.html"),
        rps: resolve(__dirname, "rps/index.html"),
        enchanted: resolve(__dirname, "enchanted/index.html"),
      },
    },
  },
});
