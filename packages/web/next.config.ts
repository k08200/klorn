import path from "node:path";
import type { NextConfig } from "next";

const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === "production" ? "https://klorn-api.onrender.com" : undefined);

// CSP only makes sense against the production API origin; in dev the API host
// varies (localhost/127.0.2.x) and React Refresh needs eval, so we skip it there.
const apiWsUrl = apiUrl?.replace("https://", "wss://").replace("http://", "ws://");
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; without a nonce setup
  // 'unsafe-inline' is required for the app to boot at all.
  // Paddle.js (hosted checkout overlay) is an allowed external script.
  "script-src 'self' 'unsafe-inline' https://cdn.paddle.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiUrl ?? ""} ${apiWsUrl ?? ""} https://*.sentry.io https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.paddle.com`,
  "media-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src https://*.paddle.com https://*.paddle.io",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
]
  .join("; ")
  .replace(/\s+/g, " ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // The app is same-origin (the API lives on its own host with its own CORS
  // allowlist), so no resource here needs to be readable cross-origin. Pin
  // Access-Control-Allow-Origin to our own origin to override Vercel's default
  // wildcard on static assets — the wildcard is the #1 CASA Tier 2 DAST finding
  // for Vercel apps (security hardening for Google restricted-scope review 2026-07-20).
  { key: "Access-Control-Allow-Origin", value: "https://app.klorn.ai" },
  { key: "Vary", value: "Origin" },
  // Suppress framework/server fingerprinting (information disclosure finding).
  { key: "X-Powered-By", value: "" },
  ...(process.env.NODE_ENV === "production"
    ? [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
      ]
    : []),
];

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DEV_DIST === "1" ? ".next-dev" : ".next",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  async headers() {
    // Authenticated app pages must not be cached by proxies/shared browsers —
    // even though the HTML itself carries no PII (data is fetched client-side),
    // CASA/DAST flags any cacheable authenticated route. Static assets keep
    // their own immutable caching (this only matches these page prefixes).
    const noStore = [{ key: "Cache-Control", value: "private, no-store" }];
    const authedPrefixes =
      "inbox|briefing|calendar|chat|email|graph|settings|billing|admin|onboarding|playground";
    return [
      { source: "/(.*)", headers: securityHeaders },
      { source: `/:path(${authedPrefixes})`, headers: noStore },
      { source: `/:path(${authedPrefixes})/:rest*`, headers: noStore },
    ];
  },
  async redirects() {
    return [
      { source: "/dashboard", destination: "/inbox", permanent: false },
      { source: "/tasks", destination: "/inbox", permanent: false },
      { source: "/notes", destination: "/files", permanent: false },
      { source: "/contacts", destination: "/email/candidates", permanent: false },
      { source: "/reminders", destination: "/inbox", permanent: false },
      { source: "/skills", destination: "/settings/memory", permanent: false },
      { source: "/notifications", destination: "/briefing", permanent: false },
      { source: "/workspace", destination: "/files", permanent: false },
    ];
  },
  allowedDevOrigins: [
    "127.0.0.1",
    "127.0.0.1:8001",
    "127.0.2.2",
    "127.0.2.2:8001",
    "127.0.2.3",
    "127.0.2.3:8001",
  ],
  env: apiUrl ? { NEXT_PUBLIC_API_URL: apiUrl } : {},
  images: {
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
