import { defineConfig } from "vite";

// ES2022 (matches tsconfig.base) — the join flow uses top-level await, which
// vite's default lowest-common-denominator target refuses to build.
export default defineConfig({
  build: { target: "es2022" },
});
