import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Several suites walk the WHOLE seed-42 city per test (collision parity,
    // signage/garnish placement, roof clutter containment). Since C1 that is
    // ~650 buildings rather than 97, and with 45 files contending for cores
    // the slowest of them can take a few seconds — well inside vitest's 5 s
    // default on an idle machine, but not under load. This is flake headroom,
    // not an expected runtime.
    testTimeout: 20000,
    include: [
      "common/test/**/*.test.ts",
      "server/test/**/*.test.ts",
      "client/test/**/*.test.ts",
      // The perf harness is plain ESM, not TypeScript, but its arithmetic
      // decides every frame-time number this repo publishes — so it is
      // tested like source, not treated as a script.
      "tools/perf/**/*.test.mjs",
    ],
  },
});
