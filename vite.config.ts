import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Plugins Replit — apenas em ambiente Replit
const IS_REPLIT = !!process.env.REPL_ID;

export default defineConfig(async () => {
  const replitPlugins: any[] = [];

  if (IS_REPLIT) {
    const { default: runtimeErrorOverlay } = await import("@replit/vite-plugin-runtime-error-modal");
    replitPlugins.push(runtimeErrorOverlay());

    if (process.env.NODE_ENV !== "production") {
      const { cartographer } = await import("@replit/vite-plugin-cartographer");
      replitPlugins.push(cartographer());
    }
  }

  // PWA plugin — usa manifest.webmanifest estático de client/public/
  const pwaPlugins: any[] = [];
  if (process.env.VITE_PWA !== "false") {
    try {
      const { VitePWA } = await import("vite-plugin-pwa");
      pwaPlugins.push(
        VitePWA({
          registerType: "autoUpdate",
          manifest: false,
          includeAssets: ["icons/icon.svg", "icons/*.png"],
          workbox: {
            globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
            runtimeCaching: [
              {
                urlPattern: /^\/api\//,
                handler: "NetworkFirst",
                options: {
                  cacheName: "api-cache",
                  expiration: { maxEntries: 50, maxAgeSeconds: 300 },
                  networkTimeoutSeconds: 10,
                },
              },
              {
                urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
                handler: "StaleWhileRevalidate",
                options: { cacheName: "google-fonts-stylesheets" },
              },
              {
                urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
                handler: "CacheFirst",
                options: {
                  cacheName: "google-fonts-webfonts",
                  expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
                },
              },
            ],
          },
          devOptions: { enabled: false },
        })
      );
    } catch {
      // vite-plugin-pwa não instalado — PWA desabilitado silenciosamente
    }
  }

  return {
    plugins: [react(), ...replitPlugins, ...pwaPlugins],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "client", "src"),
        "@shared": path.resolve(__dirname, "shared"),
        "@assets": path.resolve(__dirname, "attached_assets"),
      },
    },
    root: path.resolve(__dirname, "client"),
    build: {
      outDir: path.resolve(__dirname, "dist/public"),
      emptyOutDir: true,
      chunkSizeWarningLimit: 3000,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor:     ["react", "react-dom"],
            router:     ["wouter"],
            ui:         ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-select"],
            charts:     ["recharts"],
            query:      ["@tanstack/react-query"],
            pdf:        ["jspdf", "html2canvas"],
            "xlsx-lib": ["xlsx"],
          },
        },
      },
    },
    server: {
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom", "wouter", "@tanstack/react-query"],
    },
  };
});
