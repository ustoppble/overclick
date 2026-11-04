import type { NextConfig } from "next";
import { CARD_ROUTE_REWRITES } from "./src/lib/redirects";

const nextConfig: NextConfig = {
  // Docker image serves this process. No standalone trace — monorepo-friendly.
  transpilePackages: ["@agent-board/db", "@agent-board/mcp-core"],
  // Hard rule: no external fonts, analytics, images, or phone-home.
  images: { unoptimized: true },
  poweredByHeader: false,
  // A card's address (/cards/OCL-12) is read by the board page (E3).
  rewrites: async () => CARD_ROUTE_REWRITES,
};

export default nextConfig;
