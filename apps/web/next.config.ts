import type { NextConfig } from "next";
import { SETTINGS_GROUP_REDIRECTS } from "./src/app/settings/groups";
import { CARD_ROUTE_REWRITES } from "./src/lib/redirects";

const nextConfig: NextConfig = {
  // Docker image serves this process. No standalone trace — monorepo-friendly.
  transpilePackages: ["@agent-board/db", "@agent-board/mcp-core"],
  // Hard rule: no external fonts, analytics, images, or phone-home.
  images: { unoptimized: true },
  poweredByHeader: false,
  // A card's address (/cards/OCL-12) is read by the board page (E3).
  rewrites: async () => CARD_ROUTE_REWRITES,
  // A Settings group with sections opens on its first one, as a real 307 so
  // an old link's #anchor survives the hop.
  redirects: async () => SETTINGS_GROUP_REDIRECTS,
};

export default nextConfig;
