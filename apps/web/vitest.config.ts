import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Every integration test boots a fresh PGlite and replays the whole
    // migration folder. That grows with each migration and blows the 5s
    // default on a loaded machine, so give the boot real room.
    testTimeout: 30_000,
    // The boot is not always inside the test: insights.integration.test.ts
    // does it once in beforeAll, and hooks answer to hookTimeout, not to
    // testTimeout. Left at its 10s default that suite is the first to fall
    // over when the machine is busy, so both limits get the same room.
    hookTimeout: 30_000,
  },
});
