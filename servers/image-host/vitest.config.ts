import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Integration tier: runs the real Worker inside workerd (via Miniflare) with
// real R2 + Durable Object bindings read from wrangler.jsonc. The fast offline
// pure-logic tier is `bun test test/unit` and is intentionally NOT run here.
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
          // wrangler.jsonc leaves PUBLIC_BASE_URL empty on purpose so the
          // integration tests exercise the request-origin fallback; provide the
          // bearer secret (a real deploy sets it via `wrangler secret put`).
          bindings: { AUTH_TOKEN: "test-token" },
        },
      },
    },
  },
});
