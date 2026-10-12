// Let the worker read the runner's replies before every test.
//
// Vitest's worker talks to the runner over an RPC whose calls time out after
// 60 s, and a timer can only be cleared once the event loop reaches its poll
// phase and reads the reply. Synchronous tests awaited back to back chain
// through microtasks only, so a file of long sims (server/test/bots.test.ts:
// ~80 s of bot sim under a loaded box) never gets there. The pending
// onTaskUpdate timer then fires first, and the run exits 1 with
// "[vitest-worker]: Timeout calling onTaskUpdate" even though every test
// passed.
//
// One setImmediate per test was not enough on a box at load ~150: the runner
// (itself starved) had not replied yet when the loop came by, so a test that
// then ran synchronously for over a minute (U6's lane sweep, the director's
// 60-minute fight, bots vs the L2 movers — on main as on any branch) left the
// reply unread past the deadline. Vitest sends a task update as every test is
// prepared — at once, or within its 100 ms throttle — so the worker now waits
// for the next message from the runner (that update's reply) before the test
// body runs, at most REPLY_WAIT_MS so a lost reply can never hang a test. On a
// thread pool (no IPC) it falls back to the one-macrotask yield. It changes no
// test.
import { beforeEach } from "vitest";

/** Longest a test waits for the runner's reply, ms. */
const REPLY_WAIT_MS = 2000;

beforeEach(
  () =>
    new Promise<void>((resolve) => {
      if (typeof process.send !== "function") {
        setImmediate(resolve);
        return;
      }
      const done = () => {
        clearTimeout(timer);
        process.off("message", done);
        // One more turn so the RPC's own listener has handled the reply.
        setImmediate(resolve);
      };
      const timer = setTimeout(done, REPLY_WAIT_MS);
      process.on("message", done);
    }),
);
