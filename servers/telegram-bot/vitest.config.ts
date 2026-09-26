import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Integration tier: runs the real Worker inside workerd (via Miniflare) and
// drives /mcp over the stateless streamable-HTTP transport. Telegram itself is
// mocked with `fetchMock` from cloudflare:test, so no live Bot API call is made;
// the pure helpers are covered by `bun test test/unit`.
export default defineWorkersConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The MCP SDK pulls in ajv (schema validation), whose CJS
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
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The pool's bundled workerd supports compat dates up to 2025-04-17;
          // pin the test runtime there (production uses wrangler.jsonc's date).
          compatibilityDate: "2025-04-17",
          bindings: { AUTH_MODE: "open" },
        },
      },
    },
  },
});
