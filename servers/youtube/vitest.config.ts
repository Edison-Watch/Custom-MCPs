import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Integration tier: runs the real Worker inside workerd (via Miniflare) with
// the config read from wrangler.jsonc. It exercises routing, the auth gate and
// both MCP protocol eras through a real SDK client - the youtube_scrape tool makes a live Apify call, which is
// out of scope offline; its pure logic is covered by `bun test test/unit`.
export default defineWorkersConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      workers: {
        // The server is stateless (no Durable Object), so no storage to isolate.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The pool's bundled workerd supports compat dates up to 2025-04-17;
          // pin the test runtime there (production uses wrangler.jsonc's date).
          compatibilityDate: "2025-04-17",
          // Pin bearer mode so this tier stays deterministic regardless of the
          // production default (edison-jwt, which would 401 a static test token;
          // the JWT verify path has its own real-crypto coverage in
          // test/unit/jwt.test.ts).
          bindings: { AUTH_MODE: "bearer", AUTH_TOKEN: "test-token" },
        },
      },
    },
  },
});
