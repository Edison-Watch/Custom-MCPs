import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests live in `test/` (outside `src/`) so the `tsc -p tsconfig.json`
    // build never compiles them into `dist/`. Helpers are imported from source.
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
