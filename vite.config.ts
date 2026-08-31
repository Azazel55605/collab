import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'
import path from "path"

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(),tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Pre-bundle the heavy and lazily-imported dependencies up front in a single
  // pass. Without this, Vite discovers big deps like pdfjs, three, and nerdamer
  // on demand (when a PDF/canvas/math view first mounts) and re-runs the
  // optimizer mid-session, forcing a full page reload each time — the main cause
  // of the dev server feeling "mind-numbingly slow". Listing them here keeps the
  // cost to one cold prebundle that is then cached under node_modules/.vite.
  optimizeDeps: {
    // Every dependency that needs pre-bundling is listed below. Letting Vite
    // discover the same large graph again can exhaust Node's heap on a cold
    // dev start before the server answers its first request.
    noDiscovery: true,
    exclude: [
      "tesseract.js",
      "tesseract.js-core",
    ],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "zustand",
      "simple-icons",
      "lucide-react",
      "three",
      "highlight.js",
      "nerdamer/all",
      "pdfjs-dist",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "katex",
      "d3",
      "@xyflow/react",
      "date-fns",
      "react-day-picker",
      "radix-ui",
      "cmdk",
      "sonner",
      "dompurify",
      "markdown-it",
      "markdown-it-anchor",
      "markdown-it-container",
      "markdown-it-deflist",
      "markdown-it-footnote",
      "markdown-it-mark",
      "markdown-it-sub",
      "markdown-it-sup",
      "markdown-it-task-lists",
      "markdown-it-texmath",
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "@codemirror/language",
      "@codemirror/language-data",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore generated/native build trees
      ignored: [
        "**/src-tauri/**",
        "**/.flatpak-builder/**",
        "**/flatpak-build/**",
        "**/flatpak-repo/**",
        "**/dist-builds/**",
        "**/target/**",
      ],
    },
  },
}));
