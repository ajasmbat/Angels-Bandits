// Yield one macrotask before every test.
//
// Vitest's worker talks to the runner over an RPC whose calls time out after
// 60 s, and a timer can only be cleared once the event loop reaches its poll
// phase and reads the reply. Synchronous tests awaited back to back chain
// through microtasks only, so a file of long sims (server/test/bots.test.ts:
// ~80 s of bot sim under a loaded box) never gets there. The pending
// onTaskUpdate timer then fires first, and the run exits 1 with
// "[vitest-worker]: Timeout calling onTaskUpdate" even though every test
// passed. One setImmediate per test lets the loop read pending replies
// between tests. It changes no test and costs microseconds.
import { beforeEach } from "vitest";

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
