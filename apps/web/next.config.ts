import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The custom Node server (src/server/server.ts) already handles /git/* and internal hooks.
  // Next only serves the UI. Websockets/SSE pass through the custom server.
  reactStrictMode: true,
};

export default nextConfig;
