// Types the `env` provided by cloudflare:test with this worker's bindings.
// (Excluded from `tsc --noEmit`; consumed by the editor / vitest.)
import type { Env } from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
