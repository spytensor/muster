import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.MUSTER_SERVER ?? "http://127.0.0.1:7410";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    // The browser only ever talks to this origin; the API, sign-in and the
    // development identity provider are proxied to the server.
    proxy: Object.fromEntries(
      ["/api", "/auth", "/dev-idp"].map((path) => [path, { target: server }]),
    ),
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
