# The game host runs in the browser

Since SOLO the whole server simulation — rooms, bots, waves, fleet,
destruction, chaos, AA, bombs, strikes, director, snapshots — is the
**GameHost** (`server/src/host.ts`, `createGameHost(options)`). It runs
unchanged in two places: the Node shell (`server/src/index.ts`, the ws rooms
behind `?mp=1`) and the page's sim worker (`client/src/sim/worker.ts`, the
default single-player game). Two things follow, and each has sites that must
agree.

**Nothing on the host's path may need Node.** No `node:` import, no `ws`,
no `fs`, no `process`, no `Buffer`. Configuration is `GameHostOptions`
(`server/src/host-options.ts`): the Node shell maps `process.env` through
`hostOptionsFromEnv`, the worker maps the page's `?sim=KEY:VALUE,…` through
the same function. Frames leave as UTF-8 bytes through a `Transport`
(`TextEncoder`, not `Buffer`), and ids come from `crypto.getRandomValues`
(`randomId`). An import that breaks this still builds and passes every
server test, then breaks every player's game.
`client/test/sim-worker-bundle.test.ts` bundles the worker entry for the
browser and fails on any of it.

**Host time is `clock()`, never `Date.now()`.** A solo pause
(`GameHost.setPaused`) freezes the host clock and stops the tick, so every
wall-clock schedule in the world (waves, strikes, respawns, the director,
liveness) resumes exactly where it stopped. A `Date.now()` inside the host
would keep running through a pause and fire its whole backlog on resume.
The page takes the same pause out of its own clock (`GameSocket.pause` →
`unpaused()`, used by the clock sync and `tickRenderClock`), so the
offset estimate and the render clock see no jump. The two pause lengths
differ by a message's latency, which the clock sync absorbs. A pause is
solo only: `pausable` is off in the Node shell, where a room is shared.

**How to catch it:** the bundle test above;
`node tools/perf/solo-smoke.mjs` (no snapshots while paused, then the
tick resumes); and every `server/test/*` suite,
which still boots the Node shell, so the host runs against the ws
transport.
