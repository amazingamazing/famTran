import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "anacorn.png"],
      manifest: {
        name: "Family Translation",
        short_name: "FamTranslate",
        display: "standalone",
        start_url: "/",
        background_color: "#070b10",
        theme_color: "#111827",
        icons: [
          {
            src: "anacorn.png",
            sizes: "1024x1024",
            type: "image/png",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        runtimeCaching: []
      }
    })
  ]
});
