import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { PROD_API_BASE, validateApiBase } from "./src/config-shared";

/**
 * Content-Security-Policy for the bundled app (build only — the dev server's
 * React Refresh preamble is an inline script). The bundle talks to exactly one
 * origin: the configured Klorn API.
 */
function contentSecurityPolicy(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const api = validateApiBase(env.VITE_KLORN_API_URL) ?? PROD_API_BASE;
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    `connect-src 'self' ${new URL(api).origin}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
  return {
    name: "klorn-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      },
    ],
  };
}

// The bundled mobile SPA. Capacitor copies `dist/` into the native projects
// (`webDir` in capacitor.config.ts), so everything the app needs at runtime —
// fonts included — is emitted here; nothing is fetched from a CDN.
//
// `@klorn/contract` is reachable only as a TYPE (tsconfig `paths` +
// `verbatimModuleSyntax`): a value import would survive compilation and fail
// to resolve here, so runtime code from other packages cannot leak in.
export default defineConfig(({ mode }) => ({
  plugins: [react(), contentSecurityPolicy(mode)],
  // Absolute base: the router uses real paths (/mail/:id), and a relative
  // base would resolve ./assets against the deep path on a cold load.
  base: "/",
  build: {
    outDir: "dist",
    // Capacitor 8's floor: iOS 15 WKWebView and an evergreen Android WebView.
    target: ["es2020", "safari15", "chrome100"],
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4317, strictPort: true },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
}));
