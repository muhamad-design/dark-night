import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The popup is loaded from a file:// style extension URL, so every asset
// reference has to be relative. MV3 also forbids remote code, hence no CDN and
// no dev server - the extension always loads the built bundle.
export default defineConfig({
  root: "popup",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./popup/src", import.meta.url)) }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome111",
    rollupOptions: { input: fileURLToPath(new URL("./popup/index.html", import.meta.url)) }
  }
});
