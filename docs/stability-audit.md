# A2 stability audit — what was found and fixed

A2 audited everything built up to F10 (#131) for errors, leaks, desyncs, flaky
tests and dead code. Each finding below gives its evidence and what happened
to it: **fixed**, **no change needed**, or **follow-up** when the fix is bigger
than this audit's "small and safe" budget or lands in a running sibling's area
(W1 carrier waves, D9 destruction, DT1/DT2 detail).

## The tools

- **Whole-room soak: `tools/perf/polish.mjs --soak 30 --peers 1 --phone --lab --parity`.**
  Each client gets its own headless browser:
  - a 1280×720 desktop client
  - a 640×360 peer that runs the scripted spectacle (tunnel glides, a staged
    cave-in, a staged carrier belly and catapult launch, the carrier
    break-up)
  - a touch phone profile (844×390, DPR 3)

  All three fly random stick, fire and boost against the real server with its
  default bots and constant chaos. Every client crashes on a staggered
  3-minute cycle (death, kill-cam, respawn) and opens settings. Two extra pages
  join during the run:
  - **Flight Lab visits** at minutes 10 and 20. Afterwards, every per-room map
    in `/debug/rooms` must have dropped the lab room.
  - **Late joiners** at minutes 11 and 21. Each compares its destruction
    (destroyed/fallen counts, collapse records), boss raid and HP, cave-ins
    and chaos with the long-lived client's state and with the server's
    damage counts.

  The pass criteria:
  - **Every client:** no console error, pageerror or unallowed warning; heap
    (forced GC) no more than +15 % over minute 5; DOM nodes within ±5 %;
    `renderer.info` geometries and textures within ±10 %; programs not
    growing; no stuck UI.
  - **Server:** alive; nothing on stderr; heapUsed after a forced GC no more
    than +20 %; a median minute-to-minute RSS step under 1 MB/min over the
    last 15 minutes. RSS is V8's reservation: it steps and is never handed
    back, so heapUsed is the leak signal.

  The report is `<out>/<label>-report.json`, with one verdict per client plus
  the server, lab and parity. It passes only if every verdict passes.
- **`/debug/rooms`** (test-only, `AB_DEBUG_ROOMS=1`) now also lists
  `caveInsByRoom`, which U6 added without adding it here. It also reports the
  server's memory after a GC and each room's damage counts.
- **Heap-snapshot diffs** (scratch tooling, not committed) of one client and
  the server between minute 3 and minute 13, and again after a full-city tour.
  Objects were attributed by retainer path.

All of this ran on a shared 16-core box, using SwiftShader, at load 50–140.
The clients drew 0.1–3 fps. **No frame time here means anything.** What the
soak decides is errors, memory, liveness and parity.

## Soak results

| run | build | errors / warnings / pageerrors | heap vs minute 5 (desktop · peer · phone) | server | lab | parity |
| --- | --- | --- | --- | --- | --- | --- |
| A (30 min, load ~50) | `main` + guard (no gameplay change) | 0 / 0 / 0 on all three | +10.8 % · +14.4 % · +13.2 % | up, stderr empty, heap +8 % | both visits clean | 2/2 clean |
| B (30 min, load ~140, 0.1–0.6 fps) | this branch | 0 / 0 / 0 on all three | +11.4 % · +12.6 % · +14.2 % | up, stderr empty, heap +7 % | both visits clean | 1/2 (see below) |
| D (30 min, load ~120, 0.3–0.7 fps) | this branch | 0 / 0 / 0 on all three, nothing stuck | +13.2 % · **+15.7 %** · +14.7 % | up, stderr empty, heap +8 %, RSS median step 0.12 MB/min | both visits clean | 1/2 (bomber-run prune lag, see below) |
| E (30 min, load ~40–100, 0.2–1.3 fps) | this branch, final harness | 0 / 0 / 0 on all three | **+16.0 % · +16.8 % · +16.2 %** (warm-up, see below) | up, stderr empty, heap +8 %, RSS median step 0.13 MB/min | both visits clean | **2/2 clean** |

Run A's two failed verdicts were both the harness, not the game. The fix to
each is in `polish.mjs`:

- **The phone's settings tap timed out (5 s).** Playwright's click waits for
  two animation frames of a stable box, and the DPR-3 phone on SwiftShader drew
  about 1 fps. The panel therefore wasn't built until minute 15, which read as
  +40 % DOM growth. The fix: UI waits are now 30 s, and every client opens
  settings once before the baseline.
- **Server RSS rose +21 %.** That was one +25 MB step around minute 9, with
  heapUsed flat at 26–27.7 MB from minute 10 to 29. RSS is now judged by its
  median minute-to-minute step over the last 15 minutes, which was
  0.12 MB/min.

Run B was flown at 0.1–0.6 fps on a box at load ~140, and three more harness
artifacts showed up. Each is now judged correctly:

- **The death fade (`fadeDead`) held more than 15 s.** `flashFade` clears it
  after two `requestAnimationFrame`s, which is 20 s at 0.1 fps. Stuck limits
  now have a floor of three frames at the client's measured fps.
- **One parity mismatch in live cave-ins** (2 against 3). The client prunes
  settled cave-ins once per frame, so a page drawing 0.1 fps holds them for
  seconds. The ids and counts of destruction, collapses, boss, HP and fires
  matched on every try. Parity now compares the cave-in ids still live at one
  server instant: the `caveIns` QA hook lists each held id with the time it
  ends.
- **Server RSS: one +28 MB step, flat on both sides of it** (heapUsed fell
  back). V8 keeps a new high-water mark. Twelve lab rooms created and dropped
  in turn against a bare server held heapUsed at 18 → 20 MB, so a lab room
  leaves nothing behind. RSS is now judged by its median minute-to-minute step.

In run D, minute 21 flagged one bomber run that the long-lived client held
and the late joiner didn't. Both sides keep a finished run for its 5 s tail
(`RUN_TAIL_MS`), but the client prunes once per frame. Parity now compares
bomber runs and quakes by the ids live at one server instant, the same way as
cave-ins: the `chaos` QA hook lists them.

Run D's spectacle peer finished at +15.7 % heap, 0.7 points over the
heuristic. That is the client that teleports through tunnels and stages a
carrier every few minutes. See the memory section: its growth is the
per-building caches filling as it reaches more of the city.

A third run (C) died in the harness at minute 10: the lab pilot's random mouse
click hit the Flight Lab panel's EXIT link, which is a real navigation to `/`.
The lab pilot now flies with keys only.

Run E is the final build with the final harness: every verdict passed except
client heap, which all three clients finished just over the 15 % heuristic.
The death fade also stalled once, during one long frame early on. The
plateau measurement below settles the heap question: it is warm-up, not a
leak. At 0.2–1.3 fps the soak clients take longer than the 30-minute window
to warm up, so a minute-5 baseline catches them early.

### Memory: what grows, and whether it is bounded

**The client heap plateaus.** A single client flying alone (load ~40, so it
renders more frames) read **43.86 MB at minute 20 and 43.98 MB at minute 35**:
+0.12 MB in 15 minutes, after forced GC. The growth in the soaks is the first
20 minutes of warm-up, stretched out by the soak clients' low frame rates. The
server's snapshot over the same window went from 32.9 to 33.7 MB, inside the
±1 MB band its heapUsed showed across every soak.

- **Client.** The minute-5→30 growth is 11–16 %, and it decelerates: about
  0.5 MB/min early, 0.1–0.15 MB/min after minute 10. Snapshot diffs put the
  growth in three places:
  - V8's own optimised code
  - boxed numbers and small objects in the per-building `boxes(index)` caches
    (facade detail, garnish, signage, roof clutter, citylife, standing
    layers), filled lazily as new buildings come into view
  - the `byBlock` street caches, which `pruneBlockCache` holds to the window
    (their "new" objects are churn, not growth)

  Every per-building cache is keyed by building index, so it is bounded by the
  city (about 560 buildings, times about 8 layers). Measured by retainer path,
  their total entries went from about 480 to about 2,200 between minutes 3 and
  13 of a single-client run, and were still filling well under that ceiling.
  The same diff also caught the pre-fix `BlastLedger.seen` Set gaining 151
  keys in 10 minutes (one per death). Browser timeline buffers are capped by
  Chromium. The unbounded app structures found are fixed below (blast ledger,
  pass buckets). `renderer.info` geometries (108), textures (45–49) and programs
  (96–97) were flat for all 30 minutes on every client.
- **Server.** heapUsed after a forced GC was flat from minute 10 to 30 (about
  26–27.7 MB). The snapshot growth is the per-`Building` `WeakMap`s
  (`linkCache` support graphs, `damagedCache` solids) and live damage state,
  all bounded by the city and the destroy cap. Room disposal frees every
  per-room map (checked after each lab visit).

## Findings

### Fixed

1. **Flaky `wire.test.ts` "pose timestamps (O2)".** I found two real root
   causes in the code. Fake timers can't help here, because the test drives a
   real server process.
   - **Window race.** `from = peer.snapshots.length` is counted client-side,
     so the first snapshots of the window can still carry the last SETTLE
     pose's stamp. That stamp is not in the measured set.
   - **Clamp under load.** A pose the server handles more than
     POSE_AGE_MAX_MS − 37 ms after it was sent is clamped to
     `arrival − POSE_AGE_MAX_MS` (that clamp is tested separately). Its age
     then sits at or past the bound rather than on a stamp.

   The test now accepts settle ∪ measured stamps for entries under the bound
   and still requires age ≥ 37 ms (never the tick's time). It also requires at
   least 5 entries that exactly match a measured stamp.

   *Evidence:* 20/20 isolated runs while a full `npm test` ran alongside, and
   that full run passed. Then 5 consecutive full `npm test` runs passed
   (2393 passed, 1 skipped, each at load 33–52).
2. **A throw anywhere in `tick()` killed the server, and every room with it.**
   The tick runs off a bare `setTimeout`. `server/src/tick-guard.ts`
   `createGuard` now contains it, and its log is rate-limited: the first
   failure, then one line per 10 s with a count, so a fault that throws every
   tick cannot flood stderr. The soak fails on any such line. *Test:*
   `server/test/tick-guard.test.ts`.
3. **A same-room W2 resume kept the stale news heli, missed wrecks and
   skipped city events** (`main.ts` `applyResume` only took them from a
   welcome into another room). The heli is solid to the own crash check, so a
   resumed player could die to a heli nobody else saw. It now runs on every
   resume (`client/src/game/resume-world.ts`), and every step is idempotent.
   *Test:* `client/test/resume-world.test.ts`.
4. **A same-room resume merged strikes instead of replacing them.** A bomb
   called off during the drop (`bombsOff`) kept falling locally: its whistle,
   blast and shake played anyway. The welcome's strikes and shells now always
   replace what was held (`socket.ts`). *Test:* `client/test/connect.test.ts`.
5. **A W2 drop wiped the pilot's boss damage credit.**
   `BossDirector.forget` deleted `damageBy`, so a pilot who resumed and
   finished the boss got no kill and no SKY-BOSS SLAYER. The credit now stays
   for the raid. `bossDowned` already credits only members still in the room,
   and each raid starts the ledger over. *Test:* `server/test/boss.test.ts`.
6. **Respawn into danger: the join spawn was checked at join, not at
   go-live.** The plane only enters the world on its first pose, up to
   `BOOT_TIMEOUT_MS` later. By then a raid or bomber run could be on the
   spawn: measured, 6/200 spawns were unclear after a 3 s boot. `goLive` now
   re-checks it through `respawnIfUnsafe` (`server/src/respawn.ts`), heading
   included, and re-places it with a `respawn` if needed. *Test:*
   `server/test/boss.test.ts`.
7. **The S4 test "pickRespawn never hands out a spawn pointed into the hull"
   checked nothing.** It passed the hull check as `avoid` (3rd argument), not
   `clear` (4th). Its heading arrived undefined, every candidate read as
   avoided, and the far fallback won, so the test passed with the guard
   deleted. The test is repaired.
8. **The client blast ledger kept one key per death for the whole
   session.** `BlastLedger.seen` now forgets a death 2× SMOKE_LIFE_MS after it
   happened, once no welcome can replay it. The sweep is gated on the oldest
   key, so there is still no per-frame allocation. *Test:*
   `client/test/impacts.test.ts`.
9. **`CityReactor.passBucket` kept a row for every plane ever seen.** Bot ids
   are never reused. The row is now dropped on `playerLeft`. This matters more
   once W1 launches fresh enemies from the carrier.
10. **Dead code.** I ran `tsc --noUnusedLocals --noUnusedParameters` and
    `knip` once each. The unused imports were removed from
    `client/src/render/trails.ts`, `server/src/combat.ts` and
    `server/src/director.ts`. There was no stale `__ab` hook in the tooling,
    no stale URL knob, and no gallery view of a removed feature (every one of
    the 57 views names a live system). The "PULL UP" leftovers were already
    gone.

### No change needed

- **`npm test` without `client/dist`.** The full suite passes both with and
  without a built client (165 files each way). The one dist-sensitive
  assertion (`/debug/rooms` in `wire.test.ts`) already accepts either answer.
- **Join-time state against incremental messages.** Chunks, collapses and
  rebuilds come out right: the tick is synchronous, so a welcome and a batch
  cannot interleave, and re-applied damage is a no-op. Cave-ins, chaos,
  director, boss HP, break-up and launches are all replaced per welcome.
- **The torus seam in the new systems:**
  - U6 cave-ins: tunnel 2 crosses the z seam, and placement, collision,
    pruning and the renderer all wrap.
  - S9 carrier: the hull, pieces, ray hits, flak, launch release and falling
    pieces all wrap.
  - F10 camera and roll: viewer-local maths around the plane's own image, and
    angles only.
- **Clock parity.** Nothing in `common/` reads a clock or `Math.random`.
- **Cave-in counts.** The live counts can differ by one for a moment, because
  the long-lived client prunes on its render clock, one interpolation delay
  behind the server. That is never a persistent mismatch.

### Follow-ups (not fixed here)

- **A solo human's network blip resets the whole room.** Any close runs
  `handleLeave`, and at `humanCount === 0` the city, chaos and cave-ins are
  reset, even though a resume record exists. The resumed player comes back to
  a clean city. That contradicts "a drop is not a death", but whether it is
  intended is a design call. Suggested fix: count an unexpired resume record
  as a human present.
- **Human respawns don't check falling plane wrecks.** `spawnClearOfBoss`
  checks the boss and bombers only.
- **Flak has no staleness guard.** Shells that piled up while a tab was
  hidden all burst in one frame on return. Missiles have `MISSILE_STALE_MS`
  for this.
- **One room that throws every tick also costs the rooms after it their
  tick.** The guard is on the whole `tick()`, so as not to re-indent it while
  W1 rewrites it. Per-room guards should follow once W1 lands.
- **W1:** server per-bot-id maps (`tunnelSeen` in `bots.ts`) should forget a
  bot that leaves, if carrier launches mint fresh ids.
- **Unused locals left alone because they sit in a running sibling's files:**
  - DT1/DT2: `boss-hull.ts` `yt`, `citylife.ts` `TAG_HIGH`,
    `facade-garnish.ts` `BLOCK_PITCH`, `facade-life.ts` `MAX_PROTRUSION`,
    `roofs.ts` `EMISSIVE_SIGN`, `street-paint.ts` `WORDS`, `train.ts`
    `PART_PLAIN`, `planelights.ts` `heroPeakLuminance`
  - W1: `common/src/boss.ts` `sweepAt`

  `knip` also lists about 400 exported-but-unimported constants, mostly tuning
  values exported for their doc comments and tests. Not worth the churn.
- **CPU-heavy whole-city tests time out under extreme load.** One earlier
  batch of five ran alongside a 4-browser soak at load 86–140, and 3 of its
  runs failed. Each failure was a different CPU-bound test exceeding its
  20 s or 30 s budget (`standing-layers`, `underground`, `bots` long-sim,
  scaffolding, `solids` parity, river portals), never `wire.test.ts`. They
  usually take a few seconds. Those budgets are flake headroom for a loaded
  box, and at 9× oversubscription the headroom runs out.
- **A3:** soak on a machine with a GPU, where the per-frame paths actually
  run at speed and warm-up finishes inside the window. A multi-hour server
  soak would pin down the server's last ±1 MB.
