import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Integration tier: runs the real Worker inside workerd (via Miniflare) with
// the real R2 binding read from wrangler.jsonc, driving both MCP protocol eras
// through a real SDK client. The fast offline pure-logic tier is
// `bun test test/unit` and is intentionally NOT run here.
export default defineWorkersConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      workers: {
        // The server is stateless (no Durable Object). R2 objects are shared
        // across tests in the file; each test seeds the objects it asserts on.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The pool's bundled workerd supports compat dates up to 2025-04-17;
          // pin the test runtime there (production uses wrangler.jsonc's date).
          compatibilityDate: "2025-04-17",
          // PUBLIC_BASE_URL is pinned to the custom domain in wrangler.jsonc
          // for production; blank it here so the integration tests keep
          // exercising the request-origin fallback. Provide the bearer secret
          // (a real deploy sets it via `wrangler secret put`).
          // AUTH_MODE is pinned to bearer so this tier stays deterministic
          // regardless of the production default in wrangler.jsonc (now
          // edison-jwt, which would 401 the static test token; the JWT verify
          // path has its own real-crypto coverage in test/unit/jwt.test.ts).
          bindings: { AUTH_MODE: "bearer", AUTH_TOKEN: "test-token", PUBLIC_BASE_URL: "" },
        },
      },
    },
  },
});
