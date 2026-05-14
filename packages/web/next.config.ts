import path from "node:path";
import type { NextConfig } from "next";

const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === "production" ? "https://jigeum.onrender.com" : undefined);

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DEV_DIST === "1" ? ".next-dev" : ".next",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
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
