import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Integration tier: runs the real Worker inside workerd (via Miniflare) with
// the Durable Object binding read from wrangler.jsonc. It exercises routing and
// the auth gate only - the linkedin_scrape tool makes a live Apify call, which is
// out of scope offline; its pure logic is covered by `bun test test/unit`.
export default defineWorkersConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    // The MCP initialize response is a long-lived SSE stream that holds a
    // connection open for the session's lifetime; give tool calls headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The MCP SDK pulls in ajv (outputSchema validation), whose CJS
    // `require('./refs/data.json')` the workerd module loader can't resolve on
    // its own. Pre-bundle the SDK graph with esbuild so the JSON is inlined.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["ajv", "ajv-formats"],
        },
      },
    },
    poolOptions: {
      workers: {
        // One MCP session is established in beforeAll and reused, so state must
        // persist across tests in the file rather than reset per-test.
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
