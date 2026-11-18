import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The custom Node server (src/server/server.ts) already handles /git/* and /trpc.
  // Next only serves the UI. Websockets/SSE pass through the custom server.
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
