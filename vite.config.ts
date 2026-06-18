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

  // PWA plugin — apenas em produção ou quando explicitamente ativado
  const pwaPlugins: any[] = [];
  if (process.env.VITE_PWA !== "false") {
    try {
      const { VitePWA } = await import("vite-plugin-pwa");
      pwaPlugins.push(
        VitePWA({
          registerType: "autoUpdate",
          includeAssets: ["favicon.ico", "icons/*.png", "icons/*.svg"],
          manifest: {
            name: "Integra 2.0",
            short_name: "Integra",
            description: "Sistema de gestão de vendas Integra",
            theme_color: "#10b981",
            background_color: "#0d1117",
            display: "standalone",
            orientation: "portrait-primary",
            scope: "/",
            start_url: "/",
            icons: [
              { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
              { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            ],
            categories: ["business", "productivity"],
          },
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
      rollupOptions: {
        output: {
          manualChunks: {
            vendor:   ["react", "react-dom"],
            router:   ["wouter"],
            ui:       ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-select"],
            charts:   ["recharts"],
            query:    ["@tanstack/react-query"],
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
    // Otimizações de performance
    optimizeDeps: {
      include: ["react", "react-dom", "wouter", "@tanstack/react-query"],
    },
  };
});
