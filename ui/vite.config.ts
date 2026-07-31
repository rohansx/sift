import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Root is ui/. The build lands in dist/ui, alongside the server's tsc output in
// dist/ — package.json "files": ["dist"] then ships it, so the compiled UI is in
// the tarball and React never appears at runtime.
export default defineConfig({
  // Vite's root defaults to process.cwd(), not the config file's directory, and the
  // build is driven from the repo root via --config. Without this it would look for
  // index.html one level up and build nothing.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "../dist/ui",
    // Vite refuses to empty an outDir outside its root without this. Omit it and
    // every build leaves the previous run's content-hashed assets behind, which
    // then get published.
    emptyOutDir: true,
  },
  server: {
    // `sift serve` listens on 4318; the dev server proxies so the browser talks to
    // the real receiver instead of a mock.
    proxy: { "/api": "http://127.0.0.1:4318" },
  },
});
