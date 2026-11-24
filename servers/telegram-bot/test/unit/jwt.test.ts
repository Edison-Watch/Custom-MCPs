import { expect, test } from "bun:test";

import * as shared from "../../../../shared/auth/ts/jwt";
import * as local from "../../src/jwt";

// The verifier is defined and tested once, in shared/auth/ts (see its
// jwt.test.ts). This pins that the server runs that module, not a stale fork.
test("src/jwt re-exports the shared fleet verifier", () => {
  expect(local.verifyEdisonJwt).toBe(shared.verifyEdisonJwt);
  expect(local.verifyJwtWithJwks).toBe(shared.verifyJwtWithJwks);
});
