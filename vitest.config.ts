import { configDefaults, defineConfig } from "vitest/config";

// Suites that time a real clock or measure heap growth. With ~200 files
// contending for every core they fail with nothing wrong: the wire cadence
// read a 55.7 ms mean against its 55 ms bound, the W1 enemies took longer
// than 15 s of wall time to close, and the allocation probes picked up
// neighbours' GC churn (the lander's gate on #177, and the full suite on
// most Worker runs since mid-October). They run after everything else, one
// file at a time, so what they measure is their own code.
const TIMED = [
  "server/test/wire.test.ts",
  "server/test/waves-e2e.test.ts",
  "client/test/destruct-alloc.test.ts",
  "common/test/destruction.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    // Several suites walk the WHOLE seed-42 city per test (collision parity,
    // signage/garnish placement, roof clutter containment). Since C1 that is
    // ~650 buildings rather than 97, and with 45 files contending for cores
    // the slowest of them can take a few seconds — well inside vitest's 5 s
    // default on an idle machine, but not under load. This is flake headroom,
    // not an expected runtime. A2 measured 20 s running out too: on a shared
    // box at load 40–140 the whole-city suites (U5 renderer budget 10 s alone
    // → 21 s loaded; D8 standing layers; D2 solids parity; river portals; D5
    // scaffolding) crossed it with nothing wrong. 60 s still fails a hang.
    testTimeout: 60000,
    // Lets the worker's RPC replies land between long synchronous tests;
    // see the file for why that is what "Timeout calling onTaskUpdate" was.
    setupFiles: ["./vitest.setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "suite",
          include: [
            "common/test/**/*.test.ts",
            "server/test/**/*.test.ts",
            "client/test/**/*.test.ts",
            // The perf harness is plain ESM, not TypeScript, but its
            // arithmetic decides every frame-time number this repo publishes
            // — so it is tested like source, not treated as a script.
            "tools/perf/**/*.test.mjs",
          ],
          exclude: [...configDefaults.exclude, ...TIMED],
        },
      },
      {
        extends: true,
        test: {
          name: "timed",
          include: TIMED,
          sequence: { groupOrder: 1 },
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
