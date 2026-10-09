# `tools/perf` — the frame-time harness

One command, from a clean checkout:

```sh
npm run perf:setup   # once per machine — downloads Playwright's Chromium
npm run perf
```

`perf:setup` is a separate step on purpose. Playwright is a devDependency
with no `postinstall`, because this repo builds a Fly image and an
unconditional ~150 MB Chromium download would land in every deploy. If you
skip it the harness stops before measuring anything and names this command.

It builds the client, boots the real server on a free port, joins headless in
GPU-backed Chromium, flies a fixed path, and prints **p50 / p95 / p99 / worst
frame and draw calls per segment** — plus a JSON report at
`tools/perf/last.json`.

Nothing here is player-facing. The client changes it depends on are a few
read-only `window.__ab` hooks and three URL query knobs; the game's default
configuration is exactly what a plain visit gets.

---

## Read this before you read a number

**Mean fps is never reported, on purpose.** A 2 % frame at 200 ms averages
away and is precisely the stutter players call lag. Every headline here is
p50, p95, p99 and the single worst frame.

**The reported row is one real pass, never a mix of columns.** With `--runs N`
each segment reports the MEDIAN pass, chosen by its **GPU p50** — the column
every claim rests on — and the whole row comes from that one pass. Assembling
a row column-by-column would let it publish a `gpuP95` below its own `gpuP50`,
or a `worst` beside draw calls from a different pass, and an impossible row is
worse than a noisy one. **Prefer an odd `--runs`**: with an even count "the
median" is a choice between two passes rather than a reading.

**A skipped GPU frame is shouted about, not swallowed.** The timer holds a
pool of queries and the pool empties exactly when the GPU is behind — i.e. on
the expensive frames p95/p99/worst are made of. If any frame went unmeasured
the report says so and those columns must not be quoted.

**Vsync is disabled** (`--disable-gpu-vsync --disable-frame-rate-limit`).
With vsync on, an M3 renders this scene in ~10 ms and *reports* 16.7 ms,
because 16.7 ms is when the next frame is allowed to start — every
optimisation would measure as exactly zero. So the numbers below are **frame
costs, not the frame rate a player sees**. A p50 of 8 ms means "60 fps with
2× headroom"; a p50 of 20 ms means the player is already dropping frames.

**The pixel ratio is pinned** (default `2` — a Retina panel). The adaptive
scaler would otherwise change the workload mid-measurement and silently turn
every comparison into a comparison of two different resolutions. Measure the
scaler with `--res auto`; measure anything *else* with it pinned.

**The GPU is real.** `--use-angle=metal --enable-gpu` puts Chromium on Apple
Metal. Without those flags it falls back to SwiftShader, which collapses to
~9 fps under the bloom chain and tells you nothing about a real machine.

**The first pass is thrown away.** Every arm flies one complete, identical,
discarded pass before anything is counted. Two things make an un-warmed first
pass a liar, and the second needs a pass this long: ANGLE/Metal cache
translated shaders and compiled pipeline states at the *browser* level (a
short lap fixes that), and the GPU's own clock ramps under sustained load (a
short lap does not). With the caches warm, a 3-pass run still read pass 1 high
on every segment and then settled — core `10.24 → 7.49 → 7.64`, plaza `8.63 →
6.83 → 6.68` — uniform, monotone, draw calls identical. Discarding pass 1 took
the worst spread from **2.76 ms (36.8 %) to 0.38 ms (5.1 %)**.

**The GPU columns are contention-*resistant*, not contention-proof.** They are
far steadier than wall clock, but a saturated machine does move them. Every
report prints and stores its `loadavg`; check it before trusting a small
delta. Numbers recorded here at load ~3 are repeatable to ~5 %, and the same
build at load ~220 is not repeatable at all.

**And the GPU has a state of its own, which no `loadavg` reading shows.** The
same build, same seed, same path, identical draw calls and a wall-clock p50
inside 5 % has been measured on this M3 at both ~7 ms and ~19 ms of GPU p50 on
different days. Nothing about the scene changed; the GPU was charging a
different price for the same work. Two consequences, and they are the whole
reason `--ab` exists:

- **An absolute number is only comparable to numbers recorded in the same
  session.** Do not read a committed baseline against a fresh run and call the
  difference a regression. The determinism check says which case it is: if it
  fails while draw calls held and wall clock did not move, that is the GPU
  state, not the build, and the harness now says so instead of blaming the
  pinning.
- **A paired `--ab` delta survives it**, because the two arms are interleaved
  through whatever state the machine is in. Quote the delta. That is the
  claim.

**There is a measurement floor at roughly 4 ms of GPU time.** Below it the
timer query is measuring its own overhead and the queue depth as much as the
scene: pinned to `--res 1` the scene costs ~2–4 ms and three passes read core
`1.98 → 3.90 → 3.12` with draw calls identical every time. Absolute numbers
from a cheap configuration are indicative only. A paired `--ab` delta still
survives — both arms sit in the same state — but quote the conservative end.

---

## Why a fixed path measures anything at all

This game is unusually benchmarkable, and it is not luck — it falls out of
contracts the project already holds:

- the city is generated from a seeded PRNG with **no `Math.random` anywhere**,
  and the server hands every client the same `CITY_SEED`;
- the storm schedule is a **pure function of (seed, time)**;
- street traffic is a **pure function of the synced server clock**.

Same seed plus the same viewpoint therefore means the same scene, down to the
instance counts. The harness exploits that and pins both: the seed comes from
the server (unchanged), the viewpoint from `segments.mjs`, and it sets the
room's bot count to **0** before measuring — bots are a live sim whose poses
depend on wall-clock timing and would smear every segment.

**And since O4 it pins the clock as well.** Every segment calls
`__ab.pinWorld(t)` before it flies: the client then renders its whole world
(traffic, signage, living windows, movers and the news heli, the train,
drones, airliners, birds, fireworks, the storm schedule, reactions, and the
crash check, which reads the same latched time) at `t`, advancing from
there by the sim's own step (the flight model's clamped `dt`), so the world
and the plane move in lockstep: frame *n* of a pass is the same scene on a
software rasteriser at 3 fps as on a GPU, where `dt` is never clamped and
this is simply real time. Segment *i* is pinned to `WORLD_EPOCH_MS + i × 30 s`
(`segments.mjs`), the warm-up lap flies the same spots earlier on the same
clock, so the world only ever moves forward within a page. Every segment also
pins its weather (`clear` unless it names one) and the sky is pinned to deep
night (`?sky=night`). Remote planes keep the real network clock, which is why
the furball, whose fake pilots fly on their own wall clock, stays the one
exception. A build without the hook (an older `--ab-ref`) flies on the live
clock and the first-sight table prints `NOT PINNED` for it.

### The path

| segment  | what it stresses                                                   |
| -------- | ------------------------------------------------------------------ |
| `core`   | dense midtown at facade height — signage, lamps, traffic, windows   |
| `plaza`  | the open plaza block — sparse geometry, wide ground plane           |
| `sky`    | high and level — the whole skyline inside `FOG_DISTANCE` at once    |
| `canyon` | low down the `x = 200` street — closest geometry, most overdraw     |
| `storm`  | a scheduled strike inside the window — bolt, flash, fog, reveals    |
| `street` | street level (`x = 600`, 32 m) in a pinned **downpour** — rain streaks, wet streets, traffic, headlight cones, the full crowd |
| `furball`| a **full 12-plane room** in a downpour at street level: the page holds a fixed view down `x = 400` while 11 fake pilots (`pilots.mjs`) weave and fire 80–380 m ahead |

`street` and `furball` (O3) are appended after the original five, so an older
report still lines up segment by segment. Both are collision-checked offline
against the shared crash code — buildings, trees, the viaduct, bridges and
every mover at any server time — for 1000 m of travel at 25–45 m. The fake
pilots send `join`/`pose`/`fire` but never a hit claim, so they cannot hurt
the page; the harness asserts the room really held 12 planes for the whole
window (the `room` verdict).

Every segment is crash-proof by construction (`segments.mjs` documents the
two rules), and the harness **shouts if the plane died during one** — a dead
plane renders a kill-cam, not the scene you meant to measure.

### Determinism, and its one honest exception

`--runs N` flies the whole path N times in fresh pages and reports the
agreement:

```
determinism over 2 passes: worst p50 spread 3.4%, draw calls identical per segment
```

**Stated tolerance — declared in `run.mjs` as `TOLERANCE`, checked by the
harness itself, and printed as PASS/FAIL:**

| number         | tolerance                             | why                                                                    |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| draw calls     | **identical** per segment              | Scene identity — an integer count of what was submitted, so it cannot drift for timing reasons. If it moves, the harness stopped pinning the scene and nothing measured against it is trustworthy. |
| GPU p50        | **within 10 % or 1.0 ms**, whichever is looser, **per segment** | The render cost. Every optimisation claim in a PR rests on this number. The two halves are checked segment by segment: taking the worst percentage and the worst millisecond figure across all segments and then OR-ing them could FAIL a run in which every single segment passed. |
| wall-clock p50 | reported, **not asserted**             | It includes the sim, the socket, JS GC and whatever else the machine is running. |

The "or 1.0 ms" half is the load-bearing part, and it is not a fudge factor —
it is the shape a timing tolerance has to have. A pure percentage band gets
*stricter the faster the scene renders*: the same 0.9 ms of run-to-run drift
is 5 % of an 18 ms `legacy` frame and 12 % of the 7.4 ms frame that replaced
it, so shipping win A would have "broken" determinism by making the game
faster. What this harness can honestly claim is a **resolution** — it tells
two configurations apart when they differ by more than about a millisecond.
For scale, win A measured **5.0 ms**; the band it has to clear is 1.0.

Wall-clock p50 is left out of the verdict on purpose, not to make the check
easier to pass. Measured here on a box at **load average ~100** (parallel
agent worktrees), one pass ran a uniform ~30 % slower in wall clock across
*every* segment while its GPU cost and draw calls held — the unmistakable
signature of the machine rather than the build. Asserting that would make the
harness fail for reasons unrelated to the code under test, and a check that
fails for unrelated reasons gets disabled and then ignored. **Read the GPU
columns for render changes.**

`--strict` turns a FAIL into exit code 1; without it the harness reports and
returns 0 (see "Should this gate CI?" below).

**Before O4, two segments were honest exceptions, and both for the same
reason.** The harness pinned the seed and the path, but it could not pin the
*server clock* without a server change. With `__ab.pinWorld` the client
renders its world at a pinned time instead, so `determinism()` now holds
every segment except `furball` to identical draw calls and the GPU band
(`UNPINNED_WORLD_PINNED` / `DRAWS_FLOAT_WORLD_PINNED` in `run.mjs`). The
exemptions below still apply to an arm that does NOT report its world pinned
(a build from before O4):

- `storm` — strike *positions* are a function of absolute time, so which cell
  gets hit varies between runs. The viewpoint is fixed and the flash/fog/
  reveal work is global, so the cost is stable, but its draw calls are
  excluded from the "identical" check.
- `canyon` — the most expensive viewpoint on the path and the least
  repeatable. At `y=45` the camera is at street level, where instanced
  traffic and its headlights fill more of the frame than anywhere else, and
  traffic pose is a pure function of the synced server clock. The signature
  shows up in every multi-pass run: canyon's GPU p50 swings (`10.2 → 14.0 →
  9.9 ms`) while its **wall** p50 falls monotonically (`7.6 → 7.4 → 7.2`) and
  its draw calls stay pinned at 107. Contention would push wall and GPU up
  together; more GPU work at constant draw calls is a fuller frame, not a
  busier machine. Read canyon's paired `--ab` delta, not its absolute number.

- `street` and `furball` (O3) — street level, where the server-clock traffic
  and the synced-clock rain and crowd fill the frame (canyon's reason), and
  the furball's pilots fly on *their* wall clock. Their tracer bursts and
  headlight cones come and go, so their draw counts are reported, not held
  to identity. Judge them on a paired `--ab`/`--ab-ref` delta and on the
  p99/p50 ratio, never on an absolute GPU p50.

Everything else is pinned.

---

## Flags

| flag                 | default            | meaning                                        |
| -------------------- | ------------------ | ---------------------------------------------- |
| `--label <name>`     | `run`              | recorded in the report; shows in the table      |
| `--aa <mode>`        | client default     | `legacy` \| `msaa` \| `smaa`                    |
| `--res <r\|auto>`    | `2`                | pin the pixel ratio, or hand it to the scaler   |
| `--runs <n>`         | `1`                | passes; the reported segment is the **median pass**, ranked by GPU p50. Prefer an odd number |
| `--out <file>`       | `tools/perf/last.json` | where the JSON report goes                 |
| `--baseline`         | off                | also overwrite `tools/perf/baseline.json`       |
| `--ab "<query>"`     | —                  | second arm, **interleaved** with the first      |
| `--compare <file>`   | —                  | print a delta table against an earlier report   |
| `--no-build`         | off                | reuse the existing `client/dist`                |
| `--port <n>`         | a free port        | server port                                     |
| `--headed`           | off                | watch it fly                                    |
| `--strict`           | off                | exit 1 if the determinism check FAILs (needs `--runs` >= 2) |
| `--samples`          | off                | keep every per-frame time (wall **and** GPU) in the JSON |
| `--quality <tier>`   | `high`             | the graphics tier every arm runs (`auto` \| `high` \| `medium` \| `low` \| `mobile`); pinned so Auto can never step down mid-run |
| `--device <name>`    | `desktop`          | M3: the page every arm opens as — `desktop` (1280×720 @2) or `phone` (844×390 @3, touch, mobile viewport) |
| `--cpu-throttle <r>` | `1`                | M3: CDP `Emulation.setCPUThrottlingRate` on every page — its JS runs r× slower (a phone-CPU stand-in) |
| `--segments <a,b>`   | all                | M3: fly only these segments (by name; the report matches them by name) |
| `--soak <seconds>`   | —                  | instead of the path: hold the full-room `furball` that long and report the tier Auto ended on (exit 1 if it stepped down) |
| `--ab-ref <git-ref>` | —                  | second arm is **another build**: that commit, checked out to its own worktree with its own `npm ci`, built and served on its own port, interleaved like `--ab` |
| `--trace <dir>`      | —                  | O5: one Chrome trace per measured segment (`<pass>-<segment>.json`, page main thread + V8 CPU samples), and every wall spike over 4× the window's median split into **gc / script / GL wait / outside JS** (`trace-spikes.mjs`; the warm-up pass is never traced) |
| `--heap`             | off                | S8: a V8 sampling heap profile over each measured segment (settle + window): bytes allocated per frame, and the top sites, in the table and the JSON (`heap`) |

`--ab` takes a URL **query**. A bare commit hash there fails fast and names
`--ab-ref` — it used to be read as the query `86e5982=`, an arm identical to
the first, reported as a paired comparison. `--ab-ref` keeps its worktree
(under the OS temp dir, keyed by commit) so a second run skips the install
and build; the harness prints the `git worktree remove` line. An older build
lacks some hooks: it still measures every segment, but a segment it cannot
reproduce (no `__ab.weather` before L4, so no downpour) prints **no
baseline** in the delta table instead of a comparison of rain against clear
skies.

`AB_CHROME` / `AB_CHROME_ARGS` point the harness at another headless shell
and other GPU flags (default: Playwright's Chromium with
`--use-angle=metal --enable-gpu`). On a GPU-less Linux box,
`AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader"` runs
the whole path — useful for draw calls, the `room` check and CPU-side
numbers, meaningless for GPU time.

**`--ab` is how you measure a render change you actually trust.** It runs a
second arm with the given query-string overrides and **interleaves** the
passes (A, B, A, B) instead of running all of A then all of B. The GPU's
clock state drifts over a run — a straight A-then-B comparison once showed
pass 2 reading ~40 % different on *identical* work — so alternating puts that
drift into both arms equally and makes the delta paired. Prefer `--ab` over
`--compare` whenever both arms can be produced from the same build:

```sh
npm run perf -- --runs 3 --label "aa=off (ships)" --ab "aa=legacy"
```

`--aa legacy` reproduces the pre-P1 wiring — `WebGLRenderer({antialias:
true})` and a plain composer target — out of the *current* build, so a
before/after can be measured without checking out an old commit.

### Recipes

```sh
# Record a fresh baseline (three passes, median reported)
npm run perf -- --runs 3 --label baseline --baseline

# Did my change cost anything?
npm run perf -- --label my-change --compare tools/perf/baseline.json

# Which antialiasing mode is cheaper on this machine? (paired — preferred)
npm run perf -- --runs 3 --label "aa=off" --ab "aa=legacy"

# How much does the scaler recover when it backs off a step?
npm run perf -- --runs 3 --res 1.5 --label "res=1.5" --ab "res=2"

# Watch the adaptive scaler instead of pinning the ratio
npm run perf -- --res auto --label scaler
```

---

## The client hooks it uses

All read-only except the QA writes (`teleport`, `setPixelRatio`, `setBots`, `weather`, `pinWorld`, `qaDestruction`, `qaBoss`, `qaCourseGhost`), all on `window.__ab`:

| hook                             | used for                                    |
| -------------------------------- | ------------------------------------------- |
| `teleport(x, z, y, yaw)`         | the scripted path                           |
| `perfReset()` / `perfStats()`    | one segment's frame-time window             |
| `perfSamples()`                  | raw per-frame times, for histograms         |
| `gpuStats()` / `gpuSamples()`    | the same window on the GPU clock            |
| `render()`                       | AA mode, pixel ratio, drawing-buffer size   |
| `setPixelRatio(r \| "auto")`     | pin or release the scaler at runtime        |
| `setBots(0)`                     | empty the room so the scene is reproducible |
| `storm()` / `net()` / `combat()` | strike timing, clock, alive check, death cause |
| `pinWorld(t \| null)` (O4)       | render the world at server time `t` (a QA write) |
| `weather(phase)` / `quality()`   | the pinned weather, the tier the window ran at |
| `qaDestruction(spec \| null)` (D6) | stage a segment's destruction on this client (a QA write) |
| `destruction()` (D6)             | what destruction is on screen and what it costs the renderer |
| `drawSplit()` (S8)               | the window's median draws without, and of, the S6 reflection probe |
| `qaBoss(spec \| null)` (S8)      | stage a boss raid + flak on the pinned world clock (a QA write) |
| `qaCourseGhost(theme, speed \| null)` (S8) | stage the record ghost a course run plays (a QA write) |
| `boss()` / `course()` (S8)       | what was staged and drawn, read at both ends of a window |

The same `FrameMeter` (`client/src/render/perfmeter.ts`) feeds `perfStats()`,
the in-game dev HUD and the adaptive resolution controller, so the number in
this report and the number on screen can never disagree.

## The dev HUD

Press **`P`** in a dev build (or visit any build with `?perf=1`) for a live
overlay of fps, p50/p95/p99, worst frame, draw calls and the current pixel
ratio. It is off by default and hidden behind `body.perf`, the same toggle
idiom free-look and fullscreen use. It exists because a benchmark cannot
catch *felt* hitching — percentiles plus a live overlay covers both halves.

Those two doors are the *only* ones. `bindPerfHudKey` takes an `enabled`
flag and registers no keydown listener at all when it is false, so a
production visit without `?perf=1` does not answer `P` — a player who happens
to press it gets nothing, and pays not even a predicate per keystroke. This
used to be bound unconditionally while the module's own doc comment claimed
otherwise; the code now matches the comment
(`client/src/ui/perfhud.ts`, `client/test/perfhud.test.ts`).

## What the worst frame is, and is not

P1 §5 asked for an allocation audit driven by evidence rather than intuition, on the
theory that GC pauses would show up as worst-frame spikes. The evidence says they do
not — the single worst frame in this scene is not a build property at all.

Eight runs on one afternoon, same seed, same path, all reporting the `core` segment:

| run | loadavg | p99 | worst |
| --- | --- | --- | --- |
| `aa=off` | 86.1 | 12.0 | **53.6** |
| `aa=legacy` | 86.1 | 15.2 | **16.8** |
| `res=1.7` | 55.8 | 11.6 | **40.5** |
| `res=2` | 55.8 | 34.0 | **72.9** |
| `aa=off` | 40.3 | 15.3 | **136.2** |
| `aa=off` | 41.7 | 14.7 | **149.2** |
| `aa=off` | 11.5 | 13.8 | **164.5** |
| `aa=off`, previous build | 24.3 | 16.6 | **25.1** |

**p99 is stable across every one of them (12–34 ms). The single worst frame moves by an
order of magnitude and tracks nothing** — not load (164.5 ms at load 11.5, 16.8 ms at
load 86), not the build (the previous client shows 25.1; the same current build shows
both 16.8 and 164.5), not the configuration.

That is the signature of a **one-shot event** — one frame in roughly 550 — rather than a
per-frame allocation problem. Sustained garbage would raise p99, and p99 does not move.

So: **quote p99 as the tail, and read `worst` as the single sample it is.** It is worth
printing because a genuine regression would eventually show there too, but on this
evidence it does not justify touching any render module. Several of those modules build
module-scope `THREE.Vector3`/`Euler` scratch; that is the correct pattern and rewriting
it on the strength of a `worst` column would be exactly the intuition-driven change this
harness exists to prevent.

### Where the spikes actually land — the answer

That table left one thing open: `worst` says a 200 ms frame *happened*, never
*where*. A spike at frame 3 is first sight of a segment (shader compilation,
pipeline state, texture upload); the same spike spread through the window is
something per-frame; one anywhere, moving run to run, is the machine. Those
want opposite fixes, so the report now persists the raw per-frame samples
(`--samples`) and prints a **spike summary** under every table.

A spike is a frame over **4×** its own segment's p50 — not 2× (p95 sits near
1.6× p50 and p99 near 1.8× in this scene, so 2× would sweep in the ordinary
shoulder and count noise) and not 10× (which sees only the catastrophic frame
and misses the 30–50 ms ones that are the interesting middle).

Two three-pass runs of the same build, same seed, same path, `aa=off
res=2`, draw calls pinned at 107:

| | run A (load 99) | run B (load 241) |
| --- | --- | --- |
| `core` wall spikes | **5** of 476 frames | **1** of 587 frames |
| `core` worst | 203.0 ms at 18 % | 64.9 ms at 44 % |
| `core` positions | 11 %, 18 %, 29 %, 75 %, 76 % | 44 % |
| `core` p99 | 35.6 ms | 14.7 ms |
| `core` spike cost | +334 ms of 5004 (6.7 %) | +57 ms of 5001 (1.1 %) |
| `core` GPU worst | **117.5 ms** (p95 10.9) | 17.5 ms (p95 12.6) |
| `storm` wall spikes | 4, clustered at 24–28 % | **0** |
| spikes in the first 10 % | **0**, every segment | **0**, every segment |

Four readings, and they converge:

**1. It is not first sight.** Zero spikes in the opening tenth of the window,
in all ten segment-windows across both runs. The discarded warm-up lap plus
the 900 ms unmeasured settle after each teleport absorb compilation and
upload completely. That was item 1's leading suspect and it is dead.

**2. It is not the scene.** Identical seed, identical path, identical draw
calls — and `core` moves from five spikes to one, `storm` from four to none,
with no position repeating between runs. A scene cost recurs at the same
place in the window every time; nothing here does. `storm`'s run-A cluster
sits at 24 % and the harness lines a strike up at `STRIKE_LEAD_MS` (1200 ms
of a 5000 ms window = 24 %), which looks damning until run B flies the same
window with *seven* strikes and spikes on none of them.

**3. It is not sustained garbage.** The spikes are isolated single frames,
never a run of adjacent ones, and the whole tail is 6.7 % of wall time at its
very worst and 1.1 % typically. Sustained allocation pressure would raise
p99, and p99 is 14.7 ms in the run with the worse machine load.

**4. The clock even changes between runs — which is the tell.** Run A's
`core` spike is charged to the GPU as well (117.5 ms against that window's
own GPU p95 of 10.9 — eleven times it, with `gpuStarved` 0, so nothing went
unmeasured). Run B's is charged to the GPU not at all: the wall frame is
64.9 ms at 44 % while the GPU's own worst is an ordinary 17.5 ms at 42 % —
the same moment, with the GPU idle through it. That is a main-thread pause
one run and a genuine GPU-side stall the next, from one build. **A single
cause picks one clock.** Two different clocks on two runs is contention:
the compositor, other GPU clients, other processes.

A third run made the point in one pass, without needing two:

```
  core    wall   1 of 579  worst 37.1 ms at 52%  0 in the first 10%  +29 ms of 4999
           gpu   1 of 579  worst 38.0 ms at 51%
  plaza   wall   1 of 626  worst 40.9 ms at 94%  0 in the first 10%  +33 ms of 5006
           gpu   0 of 627  worst 12.9 ms at 44%
```

`core`'s spike is in both rows at the same moment and almost the same size —
the GPU genuinely stalled. `plaza`'s is in the wall row only, 40.9 ms against
a GPU worst of 12.9 ms — the main thread paused with the GPU idle. Two
different mechanisms, one build, one run, five seconds apart.

**Verdict: the machine.** Nothing in `client/src/render/` is implicated and
nothing there was changed for it. The honest limitation is that this box was
never quiet — loadavg 99 and 241, against P1's own 116–130 — and a genuinely
idle machine was not available to measure on. That weakens nothing here: the
finding *is* that the spikes are contention artefacts, and the two negative
results (no early clustering, no reproducible position) hold at any load.
Re-run `--samples` on a quiet box if you want to watch them disappear.

### Reading the spike rows

```
  core    wall   1 of 587  worst 64.9 ms at 44%  0 in the first 10%  +57 ms of 5001
           gpu   0 of 587  worst 17.5 ms at 42%
```

The `gpu` line under the `wall` line is a diagnosis, not a second reading of
the same number. A spike in the wall row and **not** the GPU row is a pause
on this thread — GC, a long script — with the GPU idle through it, and it is
JavaScript's to fix. A spike in **both** is the GPU or the compositor
actually stalling, and no JavaScript change will touch it. Compare the two
rows **by position**, never sample by sample: a timer query resolves a frame
or two after the frame it measured and a starved frame never resolves at all,
so the windows cover the same wall time with different sample counts. A spike
at the same *fraction* is the same event.

`+57 ms of 5001` is the point of proportion: it is what the spikes cost over
and above what those frames would have cost at p50, against the whole window.
A `worst` of 203 ms reads like a catastrophe and is 6.7 % of the run.

## Should this gate CI?

Not yet — **report now, gate later**. The baseline needs a few PRs of trust
first, and a flaky gate gets disabled and then ignored. `--compare` gives a
reviewer the delta table today, which is the part that actually changes
behaviour.

**The recommendation, with its reasons.** Three preconditions, and today none
of them holds:

1. **A CI runner with a real GPU.** `--use-angle=metal --enable-gpu` is the
   difference between an M3 and SwiftShader, and SwiftShader collapses to
   ~9 fps under the bloom chain. A hosted Linux runner has no GPU, so a gate
   there would compare two software rasterisers and gate nothing about the
   game. This repo has no `.github/workflows` at all, so the question is not
   "which job" but "on what hardware".
2. **A machine quiet enough to be repeatable.** Numbers here are repeatable
   to ~5 % at load ~3 and not repeatable at all at load ~220 — and the
   section above measured loadavg 99 and 241 on the *developer's own* box.
   A shared runner is a contended runner. Worse, the GPU has a clock state
   no `loadavg` shows: the same build has read 7 ms and 19 ms of GPU p50 on
   different days.
3. **A baseline with history.** `baseline.json` is one recording from one
   afternoon on one machine. A threshold set against a single sample is a
   guess with a number on it.

**What to gate on when they do hold**, in the order they become safe:

- **`--strict` first, and it works today.** It asserts nothing about
  absolute cost — only that three passes of the *same* build agree (draw
  calls identical, GPU p50 within 10 % or 1.0 ms). It is machine-relative,
  so it survives a slow runner, and it catches the class of change that
  makes frame cost depend on something unpinned. This is the one gate worth
  wiring on a GPU-less runner, because a determinism failure is real there
  too.
- **Then GPU p50 per segment, paired.** Only ever as `--ab` against the same
  build — never a `--compare` against a committed number, which is a
  comparison across machines and days and would fire on the GPU's mood. A
  paired delta cancels exactly that.
- **Never `worst`, and never wall-clock p50.** Read the section above:
  `worst` moves by an order of magnitude between two runs of one build, and
  wall p50 carries every other process on the box.

Until then the harness stays report-only, and the reviewer's `--compare`
table is the gate — a human who can read the `loadavg` line, which is
precisely the judgement a threshold cannot make.

## `?res=` and what a pinned ratio means

`readRenderOptions` clamps a pinned `?res=<n>` to `defaultLimits(devicePixelRatio)`
— the panel's own limits, the same ones the adaptive controller uses — and not
to the `RESOLUTION_FLOOR`/`RESOLUTION_CEILING` module constants. On a 1×
display the constants used to let `?res=2` through, and the client then drew
**four times** the pixels the same URL drew on a Retina panel, under a
five-level bloom chain. Somebody repeating P1's before/after on a non-Retina
monitor would have compared two different workloads and called the difference
a render win.

**This did not move any committed baseline.** The harness pins
`DEVICE_SCALE_FACTOR = 2`, and `defaultLimits(2)` is `{floor: 0.75, ceiling: 2}`
— identical to the constants. Verified rather than assumed: both runs above
report `requestedPixelRatio 2`, `pixelRatio 2`, `pixelRatioHonoured true` and a
2560×1440 drawing buffer, exactly matching `baseline.json`. So `baseline.json`
is untouched and stays comparable.

Every report now records the ratio **requested** beside the ratio **applied**,
and both the table and stderr shout when they differ:

```
!! --res 2 was NOT applied: the client drew at 1, clamped to this panel's own
   limits (devicePixelRatio 1). This run measured a different pixel count than
   the flag says and is not comparable to one recorded at 2.
```

A pixel count *is* the workload, so a run whose ratio was quietly changed is
not comparable to one whose was not — and that is now visible rather than a
mystery in a delta table. (Reports carrying these fields, and the per-segment
spike summary, are `version: 2`. Nothing reads the version to compare, and no
existing field changed meaning, so a `version: 1` baseline still compares
correctly.)

---

## O3: the final gate — budgets, quality tiers, flicker

### The budgets every segment is judged on

`segments.mjs` exports `BUDGETS`, and every table now ends with one verdict
row per segment (`segmentVerdicts` in `run.mjs`; also in the JSON as
`verdicts`):

| verdict | passes when | why this number |
| ------- | ----------- | --------------- |
| `60fps` | GPU p50 ≤ **14 ms** | a 16.7 ms frame minus the compositor's and the CPU's share. GPU, because with vsync off the wall clock is the CPU's pace, not the frame's cost |
| `hitch` | wall p99 ≤ **2×** wall p50 | "no hitches": the slow 1 % of frames stays within double a typical one |
| `draws` | `core` median draw calls ≤ **120** | the densest everyday view. Over budget, cut in this order: sign spill pools, rooftop string lights, fountains, headlight pools (each one draw, all dressing) |
| `room`  | the furball held all **12** planes for the whole window | otherwise it measured a smaller fight than it claims |

A verdict reads `n/a` when the run could not measure it (no GPU timer, or no
budget defined for that segment). The table also prints the **tier** each
segment ran at and its pinned **weather** (`NOT PINNED` on a build too old
to pin it).

### Quality tiers

`client/src/render/quality.ts` owns them. The player picks **Auto / High /
Medium / Low** with **G** or the `GFX …` entry under the radio toggle; it is
saved in localStorage, and `?quality=` (what the harness pins) wins over the
saved pick without overwriting it. Defaults ship: a plain visit gets Auto,
which starts at High.

Two rules every tier obeys:

1. **A switch never compiles a shader.** Tiers only flip `.visible`, instance
   and draw counts, and uniforms (living windows sit behind a uniform guard,
   not a `#define`), so O2's boot pre-warm stays complete and Auto can step
   down mid-fight without the very hitch it is stepping down to avoid.
2. **Visibility parity.** Fog, haze, the storm, the cloud deck and every
   solid thing are identical on every tier, so Low never sees further or
   through anything High cannot. Rain streaks are near-field dressing; the
   weather's haze is the visibility mechanism and it does not change.

| | High | Medium | Low | Mobile (M3) |
| --- | --- | --- | --- | --- |
| pixel-ratio ceiling for the scaler | 2 | 1.5 | 1 | 1 (0.75 at thermal level 2) |
| L1 alarms, lit windows, responders | full | full | full | full |
| L1 smoke columns | full | full | half the puffs | a third of the puffs |
| L1 pedestrians | full | 70 % | 40 % | 30 %, one block out |
| L1 steam, signals, sparks | full | full | full (already altitude-gated) | one block out; half the steam |
| L2 soundscape | full | full | full (audio) | full |
| L3 living windows | full | full | off (static grid) | off |
| L4 rain streaks | full | 50 % | 35 % (haze unchanged) | 25 % |
| L4 wet streets, puddles | full | full | full (uniforms) | full |
| L5 train + viaduct | full | full | full (solid) | full |
| T2 stations, cars, signs, doors | full | full | full (solid; shader skin) | full |
| T2 platform people | full | full | off | off |
| T2 train sparks + lights | full | full | sparks 50 %, lamps ≤ 500 m | sparks off, lamps ≤ 500 m |
| L6 traffic | full | full | full (feeds audio and reactions) | full |
| L6 headlight cones | full | full | off (ground pools stay) | off |
| L7 signage animation | full | full | full (a uniform clock) | off: each sign's static art (uniform guard) |
| L7 sign light spill | full | full | off | off |
| L8 rooftop props | full | full | full | full |
| L8 rooftop string lights | full | full | off | off |
| L9 tree sway | full | full | off (crowns hold still) | off |
| L9 fountains | full | half the spray | off | off |
| L9 birds | full | full | half of each flock | half of each flock |
| L10 airliners | full | full | contrails half as long | contrails half as long |
| L10 news heli, drone shows | full | full | full (solid / shared light cloud) | full |
| L11 river, bridges, boats | full | full | full (solid) | full |
| L12 sky cycle | full | full | full (uniforms) | full |
| L13 facade detail | full | full | off (dressing, not solid) | off |
| bloom | full | full | full | half-res chain (cheaper via the ceiling); off from thermal level 1 |
| final grade | full | full | full | off |
| window interiors (parallax rooms; G1 lit lobbies) | full | full | full | off: the room's mean light (uniform guard) |
| A1 city life (riders, crossers, groups, performers, stations, balconies) | full | 70 % | 45 % | 30 %, one block out |
| A1 facade life (laundry, facade flags, pigeons) | full | full | off | off |
| G1 street furniture, parked cars | full | full | 70 % | 40 %, one block out |
| G1 fine street paint (wear, manholes, words, ramps) | full | full | full | off: the S1 paint alone (uniform guard) |
| H2 hole interiors (murals, signs, fans, lobby glass) | full | full | full | off (folded by a uniform) |
| H2 hole guidance (chevrons, LED strips, mouth frame) | full | full | full | full (how a pilot finds a hole) |
| R2 roof structures (penthouses, tanks, billboards, masts) | full | full | full (solid) | full (solid) |
| R2 roof dressing, fine detail (drains, hatches, rods, dishes) | full | full | off | off (HVAC, ducts, solar, davits stay) |
| S1 jumbotrons + headline tickers | full | full | full | full (ticker crawl off with sign animation) |
| S1 LAST KILL replay shot | full | full | full | off: the static livery card (uniform flip) |
| S1 leader follow spot | full | full | full | full (visibility parity) |
| S1 kill feed + match headlines (HUD) | full | full | full | full (DOM, no draw) |
| S2 dynamic soundtrack (procedural score) | full | full | full | full (audio, no draw) |
| S3 stunt course rings | full | full | full | full (guidance) |
| S3 course record ghost | full | full | full | off |
| S3 course HUD — run timer, splits, records board | full | full | full | full (DOM, no draw) |
| S4 sky boss — the zeppelin, weak points, lights, flak shells | full | full | full | full (solid; the flak's telegraph) |
| S4 sky boss — flak bursts, falling-section fire and smoke | full | 75 % | 50 % | 35 % |
| S4 boss HUD — weak-point bar, radio calls, warning screens | full | full | full | full (DOM and audio, no draw) |
| S5 fog banks (drifting haze between the towers) | full | full | full | full (visibility parity; one instanced draw) |
| S5 wind litter (paper, leaves, wrappers; low-pass kick) | full | full | 50 % | 34 %, one block out |
| S5 moon light shafts | full | full | full | off (pass skipped) |
| S5 searchlight rays (haze striations in the beams) | full | full | full | full (shader only) |
| S5 heat shimmer over exhaust stacks | full | full | full | off |
| S5 glare — lens flares and streaks | full | full | full | off |
| S5 wet-roof sign reflections | full | full | full | full (shader only) |
| S6 glass reflections — neon skyline in glass, puddles, river | 1 probe face a frame | ½ a face | ⅓ of a face | off (no probe pass; faked reflections) |
| S7 kill-streak smoke | full | full | 50 % of the puffs | 50 % of the puffs |
| S7 medals, announcer, streak callouts | full | full | full | full (DOM and audio, no draw) |
| F5/F6 flight feel | — | — | — | — (no render cost: no row in `FEATURE_TIERS`) |

**Auto** starts at High and only ever steps **down**: a feature popping back
in is far more visible than one resolution rung, and a player who wants it
back picks a tier. The adaptive resolution scaler stays the first line of
defence; Auto acts above it. It reads the scaler's own frame window, at the
scaler's cadence (before the scaler, so the scaler emptying the window on a
step cannot hide it). A window is **pressure** when ≥ 10 % of its frames miss
the budget AND pixels can no longer help: either the scaler is already at
≤ 1.0, or the window's median *pre-render* JS cost is ≥ 80 % of the budget,
i.e. the frame is CPU-bound. The render call itself is not timed, because a
driver may block in it waiting on the GPU and a GPU-bound frame would then
read as CPU-bound. 3 s of unbroken pressure drops one tier. The drop keeps
the current ratio but clears the scaler's latch, so the cheaper tier can earn
pixels back, and a 5 s settle follows. A hidden tab, death or respawn, a
resize and a teleport each restart the pressure clock. Picking a tier by hand
restarts the scaler at that tier's ceiling.

What that buys, replayed through the real `stepResolution` +
`stepAutoQuality` on synthetic vsync'd frame traces:

| trace | result |
| --- | --- |
| M3: GPU 8.5 ms at ratio 2, 10 min | **High**, ratio 2, never moved |
| M3 + a 200 ms GC pause every 2 s, 10 min | **High**, ratio 2 |
| M3 + a 4 s burst of 40 ms frames | **High**; the scaler dips to 1.25 and relaxes back |
| GPU-bound laptop, 40 ms at ratio 2 | **High** at ratio 1: pixels alone fix it |
| very weak GPU, 90 ms at ratio 2 | the scaler reaches 0.75, then **Medium** at 22 s and **Low** at 31 s |
| CPU-bound: 22 ms of JS on High | **Medium** at 9 s (the CPU path, before the scaler bottoms out), **Low** at 18 s |
| JS 14 ms with 20 ms spikes (holds 60) | **High** |

Known limit: the shipped game has no GPU timer, so Auto cannot see GPU
headroom directly. A GPU-bound machine spends the scaler's rungs before it
spends features. That order is deliberate (resolution steps are the cheaper
loss), but it means such a machine takes about 20 s to reach its tier.

### Flicker

`tools/perf/flicker.mjs` is O1's temporal flicker metric, committed so it can
be re-run. It captures 30 frames on Playwright's fake clock at exactly 1/60 s
a step, at 640×360, ratio 1, with the network held and the weather pinned
clear and dry. Every build is captured at **the same world instant**. Each
server is started on one fixed epoch (`fixed-epoch.mjs`, a `Date.now`
preload; not a server change). The page clock is then stepped onto the same
server time, +130 s, to within a frame. Searchlight sweeps, helicopters,
aircraft and the storm schedule are all pure functions of (seed, time), so
both builds frame the same moving lights. Without the alignment, those
lights dominated a frozen view and its score swung 2× between runs of one
build. A capture that catches a storm strike's full-sky flash (a step over
1.0) fails loudly instead of being scored. It scores the mean per-pixel |Δluma| between consecutive
frames:

- `frozen` — camera pinned over midtown from 300 m. This is the **pass/fail**
  number: with ~16 ms of animation per step, what changes is shimmer.
- `pan` — the same view sliding 1.5 m a frame (O1's pan). There is no motion
  compensation, so it is mostly the motion itself: **indicative only**.

`--ref <git-ref>` measures another build the same way, right after, and
judges "not worse": HEAD frozen ≤ ref frozen + max(5 %, 0.01). It exits 1 on
a FAIL. Against `--ref 0b90284` (O1's merge) that is O3's acceptance
check. `0b90284` already carries every Living City ticket except L4, and
weather is pinned dry, so the two builds draw the same city.

### Commands for the M3 (run with the machine otherwise idle)

```sh
npm run perf:setup   # once

# 1. The gate: every segment against the pre-Living-City baseline. Read the
#    verdict rows (60fps / hitch / draws / room) and the delta table; street
#    and furball print "no baseline" (86e5982 has no weather), so judge
#    them on their own verdicts.
node tools/perf/run.mjs --runs 3 --label O3 --ab-ref 86e5982

# 2. Low vs High, each at its own ratio (High pins 2, Low pins 1): the
#    "Low >= 2x cheaper GPU in core" number. Then the features-only delta,
#    with both at ratio 2.
node tools/perf/run.mjs --runs 3 --res 2 --label high --ab "quality=low&res=1"
node tools/perf/run.mjs --runs 3 --res 2 --label high --ab "quality=low"

# 3. Auto never forces a lower tier on the M3: hold the full-room furball for
#    10 minutes on Auto with the scaler live; exits 1 if Auto stepped down.
node tools/perf/run.mjs --soak 600 --quality auto --res auto

# 4. Flicker against O1's merged build.
node tools/perf/flicker.mjs --ref 0b90284

# 5. One Chrome performance trace for the per-frame JS top 10: DevTools →
#    Performance → record 5 s of the `core` view at ?quality=high, then
#    Bottom-Up, grouped by function, sorted by self time.
```

### What the runner could and could not measure (O3)

O3 ran on a GPU-less Linux box: Chromium there gets SwiftShader, so every
GPU and wall-clock number it produces is the CPU rasterising, not the game.
What it *can* measure honestly is GPU-independent:

- **Draw calls per segment** (a count, not a time). Final pass at ratio
  0.75 on High: core 80 (budget 120), plaza 77, sky 68, canyon 81, storm 73,
  street 80. The furball with all 11 pilots in view (profiled separately,
  because the full pass loses them to the liveness reap below) draws a
  median 178, 234 worst. That is down from 223/277 before O3's single-pass
  fix. The extra ~100 calls over `street` are 11 near-LOD airframes at about
  9 each. If the furball misses 60 fps on the M3,
  look at `PLANE_LOD_DISTANCE` (plane.ts) first.
- **The `room` check.** All 11 fake pilots arrive (a standalone repro reads
  11 targets). Under SwiftShader the server's 4 s liveness timeout then drops
  the page as its frames slow, so the runner's furball reads 1 plane. That is
  runner-only, and the verdict flags it rather than measuring a smaller fight.
- **Per-frame JS**, from a CDP sampling profile at the `core` view
  (SwiftShader, so the CPU is shared with the rasteriser: treat the numbers
  as a ranking, not absolutes). The top 10 before and after O3's fixes, ms
  per frame, self time:

  | before | | after | |
  | --- | --- | --- | --- |
  | `ImageCache.update` | 0.90 | `Pedestrians.update` | 0.76 |
  | `Pedestrians.update` | 0.78 | GC | 0.32 |
  | `Signage.place` | 0.77 | `Signage.place` | 0.18 |
  | GC | 0.69 | `sphereHitsBox` (crash and camera-arm probes) | 0.18 |
  | `pedestrianPoseInto` | 0.25 | `frame` (the loop body) | 0.18 |
  | `frame` | 0.24 | three `renderBufferDirect` | 0.15 |
  | `Color.setHex` (crowd coats) | 0.15 | three `arraysEqual` (uniform cache) | 0.15 |
  | `Signals.update` | 0.14 | `InstancedMesh.setColorAt` | 0.15 |
  | `sphereHitsBox` | 0.14 | `Signals.update` | 0.13 |
  | three `setProgram` | 0.11 | three `setProgram` | 0.13 |

  Fixed, because each was avoidable:
  - `ImageCache` re-checks only the instances whose half-world line the
    viewer crossed.
  - Signage's emissive boost is computed once instead of every frame.
  - The crowd writes its matrices and pre-linearised coat colours directly.
  - Eight systems that pack a prefix of a worst-case buffer now upload only
    that prefix. That brought the core view from ~600 KB of `bufferSubData`
    a frame to ~235 KB.
  - Five flat transparent double-sided materials (trails, the cloud ceiling,
    rotors, each plane's glass and prop blur) draw in one pass instead of
    three's back-then-front pair. The pair flagged them `needsUpdate` twice
    a frame, which cost two program re-checks and an extra draw each. In the
    furball, ×12 planes, that was 45 draw calls.
  - Signals and the cloud deck place without allocating.
  - Lightning bolts are built in place, not cloned and merged: ~2 MB of
    garbage and a frame spike per strike.

  Left as they are: `Pedestrians.update` poses every walker every frame by
  design; Medium and Low thin the crowd to 70 % / 40 %. The GC remainder is
  mostly short-lived boxes in the shared collision code (`common/`, also run
  by the server and bots), which O3 does not touch.
- **Flicker** (`flicker.mjs --ref 0b90284 --repeat 2`, see above), every
  capture aligned to server time +120 s:

  | run | frozen | pan |
  | --- | --- | --- |
  | HEAD | 0.020, 0.020 | 6.268, 6.273 |
  | O1 (`0b90284`) | 0.018, 0.012 (the second 250 ms off the instant) | 6.272, 6.246 |

  Verdict on the medians: frozen 0.020 against 0.018, limit 0.028, a
  **PASS**. The pans agree to 0.4 %. HEAD repeats itself to the third
  decimal. Before the epoch alignment the same pair swung 0.04–0.09, set by
  whichever searchlight or helicopter was in frame; a fair comparison needs
  the alignment.

## M3: the Mobile tier

`quality.ts` adds **Mobile**, last in the G / `GFX` cycle (pickable on any
device, a weak laptop included). The table above gives its column. Three
things besides the table:

- **A 30 fps budget.** On the Mobile tier, the scaler, Auto and the thermal
  step-down count a frame as missed only past 50 ms (1.5 × 33.3 ms), and the
  CPU-bound line moves to 26.7 ms. Against a 60 fps budget, iOS Low Power
  Mode's 30 Hz rAF cap, or any phone holding a steady 30, reads as every
  frame missing, and the scaler would sit on its 0.75 floor for good. A phone
  that does better still draws as fast as it can; only the miss line moves.
- **Auto starts at Mobile on a coarse-pointer device.** That is M2's touch
  rule (`ui/mobile.ts` `coarsePointer()`). A touchscreen laptop keeps a fine
  primary pointer, so it starts at High, as before.
- **Thermal step-down** applies only to Auto on Mobile. No browser exposes a
  temperature, so throttling is read by its symptom: Auto's own pressure
  test (misses in ≥ 10 % of the window while pixels can no longer help),
  against the 30 fps budget.
  - **Trigger and settle.** 10 s of unbroken pressure steps one level, then
    a 30 s settle follows.
  - **Level 1** drops bloom (and caps the scaler at 1.0, Mobile's own
    ceiling today).
  - **Level 2** caps it at 0.75, the floor, on purpose.
  - **Levels never step back**, so nothing oscillates. The cap is also what
    stops the scaler's latch-relax probes climbing back into the heat.
  - **Reset.** A reload, or picking any tier by hand, starts over at level 0.
  - **Transients.** A hidden tab, a death, a resize and a teleport each
    restart the pressure clock, as for Auto.

Every Mobile switch obeys O3's rule 1, and nothing compiles a shader:

- Sign animation and window interiors are uniform guards (`uSignAnimOn`,
  `uWinInterior`) in the programs pre-warmed at boot.
- Bloom and grade are `pass.enabled`.
- Radii and densities are draw counts inside buffers that are still sized for
  High.

### Commands

```sh
# On the runner (no GPU): the CPU-cost proxy. High at its own ratio vs Mobile
# at its own ceiling (1), as a landscape phone, JS throttled 4x, core view only.
# Read the "cost:" block: fragment proxy and draws × pixels ratios, JS p50.
AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader" \
  node tools/perf/run.mjs --device phone --cpu-throttle 4 --segments core \
  --res 2 --label high --ab "quality=mobile&res=1"

# On the M3 (real GPU), machine otherwise idle: Mobile at ratio 1 as a phone.
# GPU p50 <= 5 ms is the target: an ASSUMED proxy for a phone GPU ~4x
# slower than the M3, not a measurement of one.
node tools/perf/run.mjs --runs 3 --device phone --quality mobile --res 1 --label mobile
# The same, paired against High at its own ratio, for the GPU ratio.
node tools/perf/run.mjs --runs 3 --device phone --res 2 --label high --ab "quality=mobile&res=1"
```

### What the runner measured (M3)

GPU-less Linux box, SwiftShader (Vulkan), `--device phone --cpu-throttle 4
--segments core`, one interleaved pass each, load average ~17. SwiftShader's
GPU and wall times are the CPU rasterising, so read only the
GPU-independent rows:

| core view | High, ratio 2 | Mobile, ratio 1 | Mobile cheaper by |
| --- | --- | --- | --- |
| drawing buffer | 1688×780 | 844×390 | 4× pixels |
| full-screen-pass equivalents | 5.17 (bloom, grade) | 4.17 (bloom, no grade) | |
| fragment proxy | 6.80 Mpx·passes | 1.37 Mpx·passes | **4.96×** |
| draw calls | 79 | 73 | |
| draws × pixels | | | **4.33×** |
| pre-render JS p50 (4× throttled) | 8.50 ms | 5.40 ms | 1.57× |

Mobile was first measured at a 1.25 ceiling: fragment proxy 3.18×, but
draws × pixels only 2.77×. Draw calls barely move between tiers (80 → 74),
so pixels carry the ratio, and M3's 3× bar set the ceiling to 1. Neither
arm logged a page error, so both shader paths (the uniform guards on and
off) compiled and ran.

---

## O4: Retina 60 fps — pinned scene, first sight, the post chain

O4 ran on the same GPU-less Linux runner as O3, so its claims split in two.
**Counts and images** (draw calls, programs linked, buffers allocated,
fragments per pixel, PSNR) are GPU-independent and were measured here.
**Milliseconds on a real GPU** were not, and are left to the M3 commands at
the end of this section.

### A harness that pins the scene

- **The world clock is pinned.** `__ab.pinWorld(t)` makes the client render
  every time-driven system at server time `t`, advancing with the sim's step (see
  "Why a fixed path measures anything" above). Each segment gets its own
  instant (`segmentWorldMs(i)` in `segments.mjs`) and its weather (`clear`
  unless it names one), and the pinned clock advances by the sim's step.
  Three-pass runs on the runner at ratio 0.75 (draw calls per pass): one run
  read **identical draw calls in all seven segments**, furball included (core
  77, plaza 74, sky 66, canyon 78, storm 71, street 78, furball 78), and
  every run held core, sky, canyon and street identical. What still moved
  was one draw in one segment: storm 71/70/70 before the clock advanced by
  the sim step (it is fixed since), and plaza 73/74/73 on a run that shared
  the box with a flicker capture. That residue is the runner's own limit: at
  2–4 fps a 5 s wall-clock window holds 15–40 frames, so the median draw
  count flips when the frame count shifts across a visibility toggle. On the
  M3 a window holds ~500 frames. Before O4 the storm, canyon, street and
  furball were all exempt. The final run on the merged branch (3 passes)
  held all six pinned segments identical: core 77, plaza 73, sky 66, canyon
  78, storm 71, street 78. Every segment was alive, and there were no page
  errors. The furball, exempt, read 78/239/78: its fake pilots were reaped
  by the server's liveness timeout in two of the passes, which is O3's known
  runner limit.
- **The storm no longer waits.** It used to wait for the live clock's next
  strike, up to ~15 s of unpiloted flight from 380 m (the plane sinks or
  climbs with no input). It now pins its world time so the strike lands
  `STRIKE_LEAD_MS` into the window, and the segment is as short as the
  others. (The lead is world time, so on a machine whose frames exceed the
  sim's 50 ms clamp, e.g. SwiftShader, the strike lands seconds later, often
  after the window. On a GPU it lands 1.2 s in.) Every segment records whether the plane was alive at both ends and
  why it died (`lastDeath.cause`).
- **A pin is a jump**, so it re-primes the two `[last, now)` feeds (storm
  strikes, fireworks). Without that, the first pin (from today's clock to
  the 2033 epoch) made the fireworks feed enumerate seven years of buckets:
  ~5 GB of garbage and a 4.5 s frame, found by a heap profile.
- Each window also checks that the pixel ratio and tier held
  (`workloadStable`).

### No first-sight freezes

The harness counts, through an init-script probe (`installGlProbe`), every
program link, texture allocation and buffer allocation, and prints them per
segment for the settle and the window (`first sight` table). Before O4 the
probe read 4 buffers in every window that had a strike in it. Now it reads
**0 programs and 0 textures in every settle and every window**, and 0
buffers everywhere except the full-room furball. There, each remote plane's
own scarf mesh (the one per-plane geometry; the rest of the airframe is
shared) uploads a few KB the first time that plane comes inside
`PLANE_LOD_DISTANCE` (21 buffers in the settle and 6 in the window on the
one runner pass that held all 12 planes). The fixes:

- **The pre-warm compiled the wrong variants.** three keys a program on the
  bound render target (tone mapping and output colour space), and
  `prewarmScene` ran with no target bound. So it compiled "ACES + sRGB to the
  screen" for everything hidden, while the game draws through the
  composer's linear HalfFloat target. Every hidden object compiled AGAIN on
  first sight: the canyon's micro tier, the storm, birds, tracers. It now
  compiles with the composer target bound, then draws one real composer
  frame with everything shown and culling off, behind the boot fade, so
  textures, buffers and the driver's pipeline states exist too.
- **Lightning reused nothing.** Every strike built two new tube geometries,
  i.e. fresh GL buffers on the flash frame. Each bolt slot now owns one
  geometry at full capacity and rewrites its position prefix.
- **Signage allocated its instance colours lazily**, after boot, so the
  pre-warm drew it in a colour-less variant its patched shader cannot
  compile. They are allocated at construction now.

The probe cannot see what a Metal driver does lazily on its own, which is
why the pre-warm now *draws* rather than only compiling. "0 wall spikes in
the first 10 %" is a Metal number; read it from `--samples` on the M3. On
the runner, the first frame of the `core` and `plaza` windows (sometimes
the furball's) read 1.6–10 s of wall time with no GPU-timer spike and
nothing allocated, while the frames around it read 1–16 ms. That pattern
fits SwiftShader's GPU process draining a queued backlog behind one
blocking GL call, rather than a main-thread or first-sight cost. In one
core window the wall frames sum to 11.4 s against 4.8 s of GPU-timed work,
so frame 0 is paying for the settle's queued frames. It is not the post
chain (the same build on `?post=legacy` shows it, 5.8 s) nor the depth
discard (a build without it shows 6.4 s). The pin-only build queues too
(wall frames shorter than GPU frames) but did not spike on this box. It
stays **unresolved** here; the M3's `--samples` run (command 3) is the
deciding number.

### GPU cost at ratio 2

Measured on the runner as counts, images, and SwiftShader's GPU timer as a
*proxy* (a CPU rasteriser, so the ratio is evidence, not a Metal number):

| change | what it removes at 2560×1440 | evidence here |
| --- | --- | --- |
| **Fused final pass** (`render/post.ts` `FinalPass`): bloom add + ACES + sRGB + grade in one pass | two full-res RGBA16F read+write passes (the bloom's additive blend into the scene target, and the separate grade pass), −2 draws | SwiftShader GPU p50, ABBA: core **−10 %** (0.894, 0.904), plaza **−13 %** (0.874, 0.862) |
| **Bloom at CSS density** (`AbBloomPass`): bright pass and mip 0 at a quarter of the buffer per axis at ratio 2, blur taps at their old screen offsets, 4-tap box bright pass | 3/4 of the bloom chain's pixels at ratio 2 (unchanged at ratio ≤ 1) | included in the row above |
| bloom targets without depth buffers; the scene's depth `invalidateFramebuffer`d after the scene pass | 11 depth clears/stores a frame; a full-res depth write-back on a tile GPU | — (no SwiftShader effect) |
| building shader: per-window detail (temperature, TV, parallax room) skipped where a window cell is sub-pixel | ~8 hashes and the interior ray-cast on every far-field facade fragment | old vs new pinned frames at the capture's own noise floor (below) |

`?post=legacy` rebuilds the old chain out of the same build (like
`?aa=legacy`), so the M3 can measure the post-chain win as a paired `--ab`.

In M3's fill proxy (`fragmentProxy`, full-screen-pass equivalents × pixels),
High at ratio 2 drops from **5.17 to 2.29 pass-equivalents**, 2.25× less
post-processing fill. The proxy now prices the fused chain
(`fusedBloomPassEquiv`) when the build reports `render().post`, and the
legacy chain otherwise. M3's Mobile tier still switches bloom with
`pass.enabled`, and a disabled bloom feeds the final pass nothing. On the
fused chain the grade switch is a uniform inside `FinalPass` (`uGradeOn`)
instead, since that pass also tone-maps and cannot be the one disabled.

**Looks.** Pinned world, fixed `qaCamera`, living-window clock pinned, ratio
2 on SwiftShader. Legacy vs fused post chain: **60.4 dB** PSNR at core and
**58.0 dB** at canyon; 0.007 % / 0.029 % of pixels differ by more than 8/255.
The same build captured twice reads 59–64 dB, so the difference sits at the
capture's own noise floor. The old shader (`86a4c09`) vs the new, both on the
legacy chain: 59.8 / 67.7 / 61.6 dB at core / canyon / plaza, against 60.8 dB
for the old build against itself. The shader change is exact by construction
(`mix(mean, x, 0.0)` already returned `mean`), but this capture is not
bit-repeatable, so "identical to the noise floor" is what was shown.

**Shimmer.** `node tools/perf/flicker.mjs --ref a487412 --repeat 2` (ratio
1, 30 frames, interleaved): frozen **0.018** against main's 0.031, limit
0.041, a **PASS**. That tool captures at ratio 1, where the bloom chain is
unchanged, so a ratio-2 copy of it (DPR 2, `?res=2`, 15 frames) compared the
two post chains on the same build, in legacy-fused-legacy-fused order:
frozen 0.028 / 0.030 and 0.022 / 0.021. The pairs agree to the run's own
noise; the CSS-density bloom adds no measurable shimmer.

**Blended overdraw** (a counting pass per transparent mesh at pinned views,
fragments per pixel, each mesh's ~0.04 clear-colour floor subtracted).
Street in a downpour totals ~0.45 layers: rain 0.11, searchlight beams
0.09, the sky's airliner points 0.17, headlight cones and pools under 0.01
each. Plaza from 300 m totals ~1.1, mostly the cloud deck's puffs (0.57) and
the beams (0.26). Opaque overdraw is close to free under
Apple's hidden-surface removal, and nothing here is wasted fill, so nothing
was cut.

### The furball

Profiled on the runner with 11 fake pilots in view (CDP CPU profile plus
sampling heap profile). The per-frame garbage came mostly from code paths
that scale with planes and bullets, and those now allocate nothing per
frame: bullets step in place (and the hit loop no longer copies the list),
the near-miss test (`closestApproach`, per enemy bullet per frame) goes axis
by axis, trail ribbons read their points in place, and the crowd wraps
positions without a Vec3 (`wrapCoord`, a scalar torus helper in
`common/world`). The remaining garbage is spread thin, ~20 KB a frame per
site (snapshot decode, movers, birds, steam). Whether p99/p50 reaches ≤ 2 is a
Metal number.

### Commands for the M3 (O4)

```sh
# 1. The gate, against a PINNED baseline: 86a4c09 is main plus only the
#    pinning and probe (no render change), so both arms fly the same pinned
#    scene and the delta is the render work. Read the 60fps / hitch / room
#    rows and the delta table. (If the branch has been squash-merged, fetch
#    the commit with: git fetch origin pull/<PR>/head.)
node tools/perf/run.mjs --runs 3 --label O4 --ab-ref 86a4c09

# 2. The post chain alone, paired, out of one build.
node tools/perf/run.mjs --runs 3 --label fused --ab "post=legacy"

# 3. Determinism and first sight: draw calls identical in every segment,
#    the first-sight table 0/0/0, and "0 in the first 10%" on every spike row.
node tools/perf/run.mjs --runs 3 --samples --strict

# 4. Flicker not worse than main, and Auto never stepping down on the M3.
node tools/perf/flicker.mjs --ref a487412
node tools/perf/run.mjs --soak 600 --quality auto --res auto
```

## O5: flicker hunt and smoothness

### The flicker grid (`flicker.mjs --grid`)

O1's metric looked at one view. The grid scores **38 views**: every static
gallery view (`gallery-views.mjs`, now shared with `gallery.mjs`) plus 20
`mulberry32`-seeded poses at 10–300 m, skewed low (`flicker-grid.mjs`; a pose
is kept only if its eye clears every shared solid by 6 m and the first 60 m
of the view are open). Each view is captured on one page at **its own world
instant** — `__ab.pinWorld`, ~37 s apart, each in a gap of the storm
schedule — with the plane held 18 m behind the eye at its height (so the
street tier streams and the atmosphere is the eye's), three ways:

- **frozen** — camera pinned, world advancing 1/60 s a frame (10 frames);
- **still** — camera AND world pinned (the world re-pinned every frame, 4
  frames): what still moves is not animation at all;
- **pan** — sliding sideways 1.5 m a frame (8 frames), indicative.

Per capture it reports `score` (mean |Δluma|), `hot` (share of pixels moving
> 8 in a step) and **`jitter`**: the share of pixels whose step reverses sign
at least twice (brighter, darker, brighter). That last one is the flicker
number. A car, a train, a sweeping beam brightens a pixel and darkens it —
one reversal; shimmer, z-fighting, a strobing sub-pixel light or a popping
LOD keeps reversing. `score` and `hot` cannot tell the city's motion from
flicker, and on the frozen views the heat maps (`--shots`: a `*-heat.png`
per capture, red = moved) show the motion is most of it: traffic and its
headlights, the T2 trains, searchlight sweeps, helicopters and airliners,
fountains.

`--ref <commit>` captures another build on the same views and instants,
interleaved, and prints the per-view table and verdict (frozen: halve any
view over the tool's resolution, never worse, none over 0.041 — O3's
recorded limit for the midtown frozen view).

### What O5 changed

- **Point-light size floor** (`client/src/render/point-floor.ts`): every
  glowing GL point — MoverLights (aviation, helicopter, blimp, drones),
  plane nav lights, rooftop bulbs (reconciling their old 2.5 px floor),
  airliners — is drawn at ≥ 2 px with alpha paying for the floor (true area
  / drawn area) and fading linearly below 1 px. Stars became a soft round
  dot at ≥ 2.5 px with the same rule (they were 1.6 px hard squares that
  twinkled whenever the view turned).
- **Rain streaks** never thinner than 1.5 px, alpha-paid.
- **Searchlight beams**: the silhouette fade now reaches 0 *on* the 18-gon
  cone's drawn outline (it left ~12 % alpha there — a hard line that crawled
  with the sweep).
- **Broken neon**: raised-cosine dips instead of a square wave (same depth,
  still ≤ 3 per second), and rarer (`STUTTER_CHANCE` 0.45 → 0.3). **TV
  windows**: scene crossfade 1 s → 1.5 s. Living-window toggles were already
  3 s (`LIVE.fade`).
- **Audited, unchanged**: the plane LOD band (5 % hysteresis), the micro gate
  (linear 100–140 m), facade detail (GPU shrink 260–380 m), the resolution
  scaler (600 ms down / 6 s up cooldowns, quarter rungs).
- **Allocation-free shared collision** (`common/src/collision.ts`,
  `city/movers.ts`, `city/river.ts`, `world`'s new `wrapDeltaInto`): no
  per-probe arrays, temporaries or closures; byte-identical on 120 000
  seeded probes against main (R2's roof structures included). Per call,
  warmed, ESM (what the server and the client bundle run), heap delta, main
  at `91c89ab`:

  | query            | main     | O5      |
  | ---------------- | -------- | ------- |
  | collideCity      | 185 B    | 0       |
  | collideNature    | 373 B    | 0       |
  | collideMovers    | 387 B    | ~9 B    |
  | collideBotMovers | 219 B    | ~9 B    |
  | losClear         | 36 B     | ~5 B    |
  | hitsGround       | 0        | 0       |

  Two V8 rules carried it. A double handed to — or returned from — a call
  V8 does not inline is boxed, so the hot paths pass objects (scratch boxes,
  `wrapDeltaInto`) rather than freshly computed coordinates. And the loads
  must stay monomorphic: R2 added `roof` to only the buildings that have
  structures, which split `Building` into two shapes and cost ~56 B a
  collideCity call in boxed field loads; `generateCity` now sets `roof` on
  every building (`undefined` when bare). The movers' residue is the same
  boxing inside the crane and train math (`train.ts`, T2's), ~1 HeapNumber
  a call; nothing is built per call.
- **Per-frame**: the street systems (pedestrians, signals, steam, street
  furniture) reuse their block window (`blockWindowInto`) instead of 25 new
  objects a frame each; steam places its vents without per-vent objects.

### Wall spikes (`run.mjs --trace`)

`--trace <dir>` records each measured segment (page main thread plus V8 CPU
samples) and `trace-spikes.mjs` splits every interval over 4× the window's
median frame into gc / script / **GL wait** (busy time whose samples sit
inside a WebGL call) / outside JS. On the runner (SwiftShader, load ~20–40)
pass 1 of `--runs 3 --samples --res 0.75` gave 48 spikes over 7 segments:
**0 caused by GC**, 41 GL wait / outside JS (the software rasteriser's queue
draining, 0.4–2.3 s), 7 counted as script (1 in plaza, 6 in the furball)
that sit within a loaded box's descheduling noise; passes 2–3 could not join
(the page boots slower than the server's 4 s liveness on a box this busy).

Re-run after merging H2, on a quiet 16-core runner, all three passes joined
(`--runs 3 --samples --res 0.75 --trace`): the run's own spike table —
frames over 4× their segment's p50 — reads **none, in any segment**, p99/p50
1.06–1.25, and the traces show **0 spikes caused by GC** in 21 segment
traces (GC 0–35 ms per segment in total). trace-spikes labels every
SwiftShader frame (350–750 ms of software rasterising inside the rAF task)
"script" against the short gaps between frames, so on this runner its
per-interval split says nothing about JS; `joinGame` now prints who is left
in the room when it times out. The M3 is where this is decided.

### Commands for the M3 (O5)

```sh
# 1. The flicker grid against main before O5 (the merge of main + the tool
#    only): per-view table, verdict, heat maps to look at.
node tools/perf/flicker.mjs --grid --ref 7ebd93a --shots /tmp/o5-shots

# 2. Wall spikes with attribution: every spike row must read "GL wait" or
#    "outside JS", none "gc"; a "script" row names its top functions.
node tools/perf/run.mjs --runs 3 --samples --trace /tmp/o5-traces

# 3. The same on the phone stand-in (the mobile tier, a 4x slower CPU).
node tools/perf/run.mjs --runs 3 --device phone --quality mobile \
  --cpu-throttle 4 --trace /tmp/o5-traces-phone

# 4. The render cost of the floors (should be inside the noise): paired.
node tools/perf/run.mjs --runs 3 --label O5 --ab-ref 7ebd93a
```

---

## P2: the Realism batch gate — trains, holes, streets, roofs, life

P2 measures the game after the Realism & Feel batch (F5/F6 flight feel, T2
trains, G1 street detail, R2 roofs, H2 holes, A1 city life) on the same
GPU-less runner as O3/O4. It can count draws, liveness, determinism and GL
allocations; **milliseconds are for the M3** (commands at the end).

### Three new segments

Appended after `furball`, so the seven older segments keep their index and
their measured world instants (the warm-up lap's instants shift, since
`warmupWorldMs` counts the path). Each spot was checked offline against the
shared collision (`touchesSolid`: ground, buildings and their holes, trees,
viaducts and stations, and every mover sampled every 100 ms over 15 minutes
of world time around `WORLD_EPOCH_MS`): clear.

| segment | what | how it stays repeatable |
| --- | --- | --- |
| `station` | line 0's station at (1300, 1000), two trains side by side in it — one standing, one pulling in or out on the other track — platforms, canopy, doors, platform people | the world clock slides from the segment's own instant to the first moment two trains on opposite tracks are both within 8 m of the station's centre, found on the pure schedule (`__ab.train(t)`). It lands at +2.25 s; the harness prints the moment and refuses a slide past `TRAINS_SLIDE_MAX_MS`. The plane is held 80 m east, 44 m up, nose down the line |
| `hole` | a glide through the street-level row tunnel (x = 303.5, mouths at z = 1220 and 1380) — chevrons, the lit mouth, LED strips, murals, fans | re-teleported every frame along the tunnel's axis at 42 m/s of **wall** time from 63 m out, so the path is the same length on any machine; three quarters of the window is inside. Clear from 120 m before the entry to 150 m past the exit; the glide stops 107 m past it |
| `sidewalk` | G1's curb skim at (810, 8, 1380): furniture, parked cars, road paint, lit lobbies, the crowd | held every frame (at 8 m an unpiloted plane would sink into the street) |

Each has a draw-call budget in `BUDGETS` (runner High + ~10 %): station 90,
hole 92, sidewalk 90. An `--ab-ref` build that cannot fly one of them (no
two-train read-back before T2, no tunnel before H2, so it dies) prints
**no baseline** for that segment instead of a delta.

### Two harness bugs the batch exposed

- **Every flown segment was diving.** The click on Join left the cursor
  parked on the button, and the mouse-aim instructor flies the pipper onto
  the cursor. Core lost 7 m and canyon 7 m inside the runner's ~1 s of sim
  time; on the M3's ~6 s, `street` sank onto T2's new x = 600 viaduct and
  crashed (it read `alive: NO` on main). After joining, the harness now
  tells the page the pointer left the window, which is the input's
  attitude hold: each segment flies level from its teleport, as P1 laid the
  path out (core holds 89.7 m, canyon 45.0, street 32.0). Positions now
  differ from O4-era reports for the flown segments.
- **The furball's bullets leaked into the next segment.** Its pilots leave
  ~200 bullets in flight, and a bullet ages by the sim step, which is
  clamped at 50 ms a frame. On a 3 fps renderer their tracers (one draw
  each) crossed `station`'s view for tens of seconds: 88/86/83 draws over
  three passes against 82 when it was flown alone. The harness now waits for
  the room and the sky to empty after any segment with pilots (a new
  read-only `__ab.combat().bullets`), and prints how long that took; if it
  never empties it says what was left and measures on. On the M3 the
  bullets expire inside the 0.9 s settle, but only just.

### What the runner measured (P2)

GPU-less Linux box, SwiftShader (Vulkan), `--res 0.75` unless stated, on
main after O5 merged (load average ~14, another ticket's harness sharing
the box). SwiftShader's GPU and wall times are the CPU rasterising, so only
the GPU-independent rows below are claims; the `60fps` and `hitch` verdicts
all read FAIL here for that reason and say nothing about the M3.

**The gate, `--runs 3`, High:**

| segment | draws (3 passes) | budget | alive | first sight (window) |
| --- | --- | --- | --- | --- |
| core | 82 / 82 / 82 | 120 | yes | 0p 0t 0b |
| plaza | 79 / 79 / 79 | — | yes | 0p 0t 0b |
| sky | 70 / 70 / 70 | — | yes | 0p 0t 0b |
| canyon | 83 / 83 / 83 | — | yes | 0p 0t 0b |
| storm | 75 / 75 / 75 | — | yes | 0p 0t 0b |
| street | 83 / 83 / 83 | — | yes | 0p 0t 0b |
| furball (not asserted) | 228 / 229 / 235 | — | yes, 12 planes | 0p 0t 15b (per-plane scarves, as in O4) |
| station | 82 / 82 / 82 | 90 | yes | 0p 0t 0b |
| hole | 83 / 83 / 83 | 92 | yes | 0p 0t 0b |
| sidewalk | 82 / 82 / 82 | 90 | yes | 0p 0t 0b |

Determinism **PASS**: draw calls identical in every pinned segment, GPU
p50 within 8.4 %. No page errors, no deaths. The station found its moment
at +2.25 s on every pass (trains `0#2` and `1#2`). The furball's bullets
took 7–10 s of this box's time to drain before `station`. `core` sits at 82
draws against O4's 77 (+5 for the whole batch) and the 120 budget; nothing
breached, so nothing was cut.

One residue to know about: `plaza` read 79 / 79 / 78 on an earlier run
(the same harness, before O5's merge). Something comes into view at a fixed point along its flight
(78 → 79), and at 3 fps the share of the window before that point moves
from pass to pass, so the median can land on either side. That is O4's
documented runner limit; on the M3 a window holds hundreds of frames.

**Fragment proxy, High at ratio 2** (`--res 2 --quality high --segments
core`): 3,686,400 px × **2.292** pass-equivalents, the same as O4's 2.29.
The proxy prices the post chain's passes × pixels. Scene overdraw (the
crowd, tunnel glass, platform people) is not in it; that is a GPU-time
question for the M3.

**Mobile.** One `--quality mobile` pass flew every segment alive, with 0/0/0
first sight outside the furball. Draws: core 76, plaza 72, sky 67, canyon
76, storm 70, street 77, furball 229, station 76, hole 76, sidewalk 76.
The phone proxy (`--device phone --cpu-throttle 4 --segments core`, High
at ratio 2 vs Mobile at ratio 1, `--runs 3`):

| core view | High, ratio 2 | Mobile, ratio 1 | Mobile cheaper by |
| --- | --- | --- | --- |
| fragment proxy | 3.02 Mpx·passes | 1.04 Mpx·passes | 2.90× |
| draw calls | 82 | 76 | |
| draws × pixels | | | **4.32×** (M3: 4.33×) |
| pre-render JS p50 (4× throttled) | 12.9 ms | 16.1 ms | — |

The JS row is not game code. A CDP CPU profile of the same view puts the
game bundle's own self time level across the tiers (High 20.5–23.0 ms a
frame, Mobile 23.3–24.3 ms, 4× throttled), while SwiftShader's GL calls
(buffer and uniform uploads blocking on the rasteriser) take hundreds of ms
a frame and run more often at Mobile's lighter frames. A sampling heap
profile finds ~1–2 KB a frame allocated on either tier, nearly all inside
three's uniform upload, so there is no per-frame garbage from the batch.
The phone's real JS and GPU cost come from the M3 commands below (and O5's
`--trace` run on the phone stand-in).

### Quality tiers

Every batch module with a render cost has a `setQuality` hook and a row in
`FEATURE_TIERS` (the tier table above now lists them): A1 city life and
facade life, G1 furniture and fine paint (its lit lobbies ride the window
interiors switch), H2 hole interiors and guidance, R2 structures and fine
dressing, T2 stations, platform people and sparks. A1's look-up reaction
(`lookup.ts`) is a GLSL chunk inside the figure meshes, so it costs what the
crowd costs and thins with it. F5/F6 change flight feel only: no render
cost, no row.

### Commands for the M3 (P2)

Run on main after this merges, with the machine otherwise idle.
`d23d23a` is O4's merge, the last measured state before the batch.

```sh
npm run perf:setup   # once

# 1. The gate: every segment against O4's merge. Read the 60fps / hitch /
#    draws / room verdicts and the delta table. station and hole print
#    "no baseline" (O4's build has no two-train read-back and no tunnel);
#    judge them on their own verdicts. sidewalk's delta is G1 + A1's cost.
node tools/perf/run.mjs --runs 3 --label P2 --ab-ref d23d23a

# 2. Tiers. Low vs High, each at its own ratio, then features only (both at
#    ratio 2); then Mobile as a phone at its own ceiling vs High (GPU p50
#    <= 5 ms on Mobile is the assumed phone proxy, as in M3).
node tools/perf/run.mjs --runs 3 --res 2 --label high --ab "quality=low&res=1"
node tools/perf/run.mjs --runs 3 --res 2 --label high --ab "quality=low"
node tools/perf/run.mjs --runs 3 --device phone --res 2 --label high --ab "quality=mobile&res=1"

# 3. Soak: Auto never steps down on the M3 (exits 1 if it does), 10 minutes
#    of the full-room furball with the scaler live.
node tools/perf/run.mjs --soak 600 --quality auto --res auto

# 4. Flicker: O5's grid, not worse than O5's merge (0371335; P2 changes no
#    render code, so this should read inside the noise everywhere). O5's
#    own grid against 7ebd93a (above) is the batch-wide flicker number.
node tools/perf/flicker.mjs --grid --ref 0371335

# 5. Determinism and first sight: draw calls identical in every pinned
#    segment, the first-sight table 0/0/0 in every window, and "0 in the
#    first 10%" on every spike row.
node tools/perf/run.mjs --runs 3 --samples --strict
```

---

## D6: the Destruction gate — debris, dust, fire, chunked buildings

D6 measures the game after the Destruction batch (D1 bullet impacts, D2
breakable buildings, D3 collapses, D4 crashing wrecks, D5 the director, X1
missiles) on the same GPU-less runner as P2. It can count draws, instances,
liveness, determinism and allocations; **milliseconds are for the M3**
(commands at the end).

### A quiet server, staged destruction

Destruction is server-authoritative and timed on the server's wall clock
(bullets, death blasts, wrecks, missiles, the director's slots, chain
impacts, rebuilds, S4's raids), which no pin reaches. So the harness runs
its server with **`AB_QUIET_CITY=1`** (`server/src/index.ts`): no room's
city ever breaks and no raid starts. It is the same reasoning as the empty
room (`setBots(0)`). The server refuses the switch under
`NODE_ENV=production` and warns loudly whenever it is on. An `--ab-ref`
build from before D6 ignores it, so its arm can carry server destruction;
its segments read `quiet n/a`.

Each destruction segment then **stages** its scene on the client with
`__ab.qaDestruction(spec)` (`client/src/game/qa-destruction.ts`). The
staging runs the server's own steps against the GameSocket's damage and
collapse state, which is what every renderer, the crash check and the
camera arm read: chunks break, each touched building gets `planCollapses`
in index order, each plan becomes a wire whose chunks fall and whose debris
starts. It honours the same caps (DESTROY_CAP, COLLAPSE_CAP), and a felled
tower is D5's `demolitionPlan`. Fire is staged as death blasts through the
D1 `BlastLedger` (burning facades, scorch, dark panes) and a downed plane as
a D4 wreck (`wreckImpact`). Every `t` in a spec is an offset from the
segment's world instant. Building indices are `generateCity(CITY_SEED)`'s,
and every spec states the height or building count it expects, so a
generator change throws instead of quietly staging another scene. One thing
is deliberately left out: `collapseImpacts` chains, which the server lands
later as blasts. `__ab.destruction()` reads back what is on screen and what
it costs the renderer.

### Three new segments

They are appended after `sidewalk`, so the ten older segments keep their
index and measured world instants. Each spot was checked offline against
the **staged** city: damaged solids, D2 rubble, every collapse piece over
its whole fall, and the wreck. The check ran `touchesSolid` every 50 ms from
1 s before the segment's instant to 12 s after it, and came back clear.

| segment | what | how it stays repeatable |
| --- | --- | --- |
| `collapse` | building 343 (215 m) toppling west across the x = 1200 street, 126 pieces in the air, the dust cloud rising; held 236 m south at 110 m | staged **after the settle** at the window's own world instant −1.5 s (the lead beat over), so the tower is mid-fall when the window opens on any machine's clock; the harness asserts it has **not** all landed by the window's end |
| `ruins` | the furball's viewpoint, weather and 11 pilots in a heavily damaged block: 18 buildings 30 % shot away, 21 collapses starting from 14 s before the instant to 6 s after it (landed rubble, dust, more coming down), burning facades (four blasts, two land on a facade), a wreck's fire | the staged scene is pinned; the pilots fly on their wall clock as in `furball`, so its total draws float, but its **destruction-only draws** (`stagedDraws`: damaged mesh, debris, dust, falling wrecks, scorch, scaffolding) are asserted identical. `ruins` − `furball` is what the destruction costs that fight |
| `rubble` | a glide at 20 m down the x = 1200 street, both sides of which toppled into it 56–62 s before the instant (6 collapses, 386 chunks down) | every piece has been at rest for 44 s, asserted (`settled = collapses`); a glide in wall time, like `hole` |

The warm-up lap stages the same scenes at its own instants, and every
segment clears what it staged at its end.

### Budgets and verdicts

`printDestruction` adds a row per segment under the O3 verdicts:

```
destruction (D6): draws collapse <= core + 15, rubble <= core + 15 · damaged slots + debris pieces <= 1082, debris never past its boot size · 0 server destruction messages
segment   chunks  quiet  scene  +core  damaged slots/cap  debris pieces/cap  collapses  dust  impacts  staged draws
```

- **draws**: `core` ≤ 120 as before. `collapse` and `rubble` may cost at most
  **core + 15** draws in the same pass (`BUDGETS.drawCallsOverCore`).
  Destruction is drawn by a fixed set of objects (one damaged mesh, one
  debris mesh, one dust Points, the D1 particle pool, two wreck meshes, one
  scaffold mesh), so a heavier scene costs instances, not draws.
- **chunks**: damaged-mesh slots + debris pieces ≤ `BUDGETS.chunkInstances`
  (1 082: the runner's `ruins`, 316 + 667, plus 10 %).
  The debris mesh must also never grow past its **boot size**, which is the
  derived bound: every chunk COLLAPSE_CAP lets fall, +25 % for hole-split
  pieces, +64 (`city.ts attachCollapses`, 16 740 on the seed city).
  Growing would be a buffer reallocation mid-game.
- **quiet**: the server sent no destruction during the segment
  (`serverEvents`), so everything on screen was staged.
- **scene**: the segment staged its scene, and its collapse is still falling
  at the window's end (`collapse`) or entirely at rest (`rubble`).
- **determinism**: draw calls identical per pinned segment as before, and
  `stagedDraws` identical in every staging segment, `ruins` included.

### No per-frame allocations: the allocation table

`tools/destruction-bench.ts` is O5's table for the destruction modules. It
covers every per-frame entry point of D1–D5 on the staged `ruins` scene
with a viewer gliding through it, and is measured with V8's sampling heap
profiler. Objects a later GC collected are included, and a builtin's
allocation is charged to its caller. `--where` names the sites, and
`--digest` hashes everything each entry point wrote, so a fix can be shown
to change no output.

```sh
node --import tsx tools/destruction-bench.ts            # the table; exits 1 over budget
node --import tsx tools/destruction-bench.ts --where    # ... and the top allocation sites
```

Bytes allocated per frame, ruins scene, median of five runs of 3 000 frames:

| entry point | before D6 | D6 |
| --- | ---: | ---: |
| `city.update` (damaged mesh) — the intact city's own: ~50–230 | 200 | 48 |
| `city.updateDebris` | 7 587 | 615 |
| `dust.update` | 3 014 | 270 |
| `dustHaze` | 500 | 48 |
| collapse shake | 198 | 99 |
| crash check (`touchesSolid`, mostly trains/cranes/river) | 279 | 54 |
| wrecks update + touching | 324 | 0 |
| impacts burn + update | 1 908 | 585 |
| director fx | 549 | 103 |
| scaffold | 1 350 | 29 |
| **judged, all together** | **~15 900** | **1 851** |
| X1 missiles (not judged: the trail is the shared pre-D `smoke.ts`) | 2 700 | 2 515 |

Rows move run to run by up to ~150 B as V8 re-optimises; an earlier run of
the same build read ~2 700 in all.

Every `--digest` matched the build before the fixes byte for byte. The
"before" column is this bench run on the commit before them. What changed:

- `collapse.ts piecePose`: a lerp closure per squashing piece, and a helper
  call V8 did not inline (each result boxed), written out; `flight`'s time
  goes through a scratch object (a non-inlined double argument was boxed
  per falling piece).
- `dust.ts`: each cloud is worked out once per collapse instead of once per
  puff per frame (an object and a `Math.hypot` each); the haze rejects on
  distance squared before its `hypot`.
- `city.ts` debris and damaged flushes: no closure, name list or merged
  range array per frame; update ranges come from a per-attribute pool
  (`render/update-range.ts`, also behind `wrapPlacement`'s `uploadPrefix`).
- `impacts.ts`: particles written straight into the typed arrays, index
  loops, no array destructuring, a prebuilt upload list. `wrecks.ts`,
  `director-fx.ts`, `scaffold.ts`: index loops, no per-particle
  `canonicalize` objects, scaffold boxes cached per building. `camera.ts`:
  `collapseShakeOffsetInto`.

**Budget**: 0 is the target. The bench passes at ≤ 1 KB a frame per entry
point and ≤ 4 KB all together. What remains is V8 boxing doubles handed to
calls it declines to inline (three's Matrix4/Quaternion setters per falling
piece, the particle pool's `spawn`), and three's update-range list
reallocating its backing store each time it is cleared. In the densest
staged scene that is about one young-generation GC a minute at 60 fps.

### The stall this gate found

The D1 facade-damage atlas uploaded each dirty slot with
`renderer.copyTextureToTexture`. three saves and restores five pixel-store
parameters there with `gl.getParameter`, and each call is a synchronous
round trip to the GPU process that waits for every queued command. It ran
per dirty slot, so on every frame a bullet marked a facade. On the runner,
`ruins` (pilots firing into a damaged block) stalled 5–22 s a frame on it,
long enough for the server's liveness check to drop the page; a CPU profile
put 83 s of a run in `getParameter`. `DamageTexture.flush` now calls
`texSubImage2D` from the CPU atlas with the pixel store **set**: three sets
flip-Y, premultiply and alignment before each of its own uploads and never
sets row length or skips, so those go back to 0. On the M3 this was a
hitch, not a freeze, but it was a sync point in the middle of the busiest
frames.

The gate also found the damaged mesh still drawing its hidden slots after
the last broken building came back (a D5 rebuild, a reset): +1 draw in
every later view. It now starts over when nothing is damaged.

### Quality tiers

Every Destruction module already has a `setQuality` hook and a row in
`FEATURE_TIERS`: `destructionDetail` (D2 broken-edge detail), `collapseDust`
(D3), `impacts` (D1), `wreckFire` (D4), `directorFx` and `scaffold` (D5),
`missileDebris` (X1). The solid parts are identical on every tier (the
damaged solids, debris, wrecks, the dust haze that blocks sight). D6 adds
no row, and the Mobile pass below found nothing to retune.

### What the runner measured (D6)

GPU-less Linux box, SwiftShader (Vulkan), `--res 0.75`, load average
37–75 (other tickets' harnesses sharing the box). SwiftShader's GPU and wall
times are the CPU rasterising, so the `60fps` and `hitch` verdicts all read
FAIL here and say nothing about the M3. `--strict` exits 1 on the GPU-time
half of the determinism tolerance (44–124 % spread, which the harness flags
as a busy machine); only the GPU-independent rows below are claims.

**High, `--runs 3`** (`core,collapse,rubble` and `core,furball,ruins`, two
invocations):

| segment | draws (3 passes) | budget | staged draws | chunks (slots + pieces) | scene | quiet | alive, resumes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| core | 89 / 89 / 89 | 120 | 0 | 0 + 0 | — | ok | yes, 0 |
| collapse | 92 / 92 / 92 | core + 15 → **+3** | 4 / 4 / 4 | 7 + 126 | falling (0/1 at rest) | ok | yes, 0 |
| rubble | 92 / 92 / 92 | core + 15 → **+3** | 3 / 3 / 3 | 186 + 272 | 6/6 at rest | ok | yes, 0 |
| furball (not asserted) | 260 / 255 / 201 | — | 0 | 0 + 0 | — | ok | yes, 12 planes |
| ruins (total not asserted) | 263 / 262 / 251 | — | **4 / 4 / 4** | 316 + 667 | 8/21 at rest | ok | yes, 12 planes |

Determinism **PASS on draws**: draw calls are identical per pinned segment
and the staged tally is identical everywhere. What destruction adds to the
furball is **4 draws**: the damaged mesh, the debris, the dust and the
scaffolding. The wreck's fire and the burning facades ride the D1 pool's
existing draw. The medians read +8, but both totals float by tens with the
pilots' tracers. Destruction costs instances, not draws, and the
heaviest scene holds 983 of them against a debris mesh sized for 16 740
from boot (it never grew). No page errors, no deaths, no resumes, and every
room emptied after its pilots left (12–52 s of this box's time).

**Mobile, one pass**: core 83, collapse 86 (+3), rubble 86 (+3) draws, each
6 under High. Dust: 8 puffs against High's 24 in `collapse`, 50 against
182 in `ruins` (the 0.3 `collapseDust` share, sprites grown to cover the
same air). The D1 pool held 16 impact particles against High's 342 in
`ruins`, which had its full 12-plane room in a second Mobile pass (256
draws against High's 263; the first pass at load 70 lost its pilots).
Chunks and the staged tally are identical to High, since solids never
thin. Mobile stays lighter on every count, so `quality.ts` is unchanged.

### Commands for the M3 (D6)

Run on main after this merges, with the machine otherwise idle.
`8a11472` is main just before D1, the last state without destruction. A
build that old cannot stage `collapse`, `ruins` or `rubble`, so those print
**no baseline**; read them on their own verdicts, and read `ruins − furball`
in the same run as the destruction's cost to that fight.

```sh
npm run perf:setup   # once

# 1. The gate: all 13 segments, three passes. Read the 60fps / hitch / draws
#    verdicts, the D6 destruction table (chunks / quiet / scene / +core) and
#    the determinism line: draws identical, staged draws identical, GPU p50
#    within 10 % or 1 ms.
node tools/perf/run.mjs --runs 3 --samples --strict --label D6

# 2. What the Destruction batch costs the views that existed before it,
#    paired against main before D1 (an empty, quiet city on both arms).
node tools/perf/run.mjs --runs 3 --label D6 --ab-ref 8a11472

# 3. Tiers on the destruction views: Mobile as a phone at its own ceiling
#    vs High at ratio 2 (GPU p50 <= 5 ms on Mobile is the assumed phone
#    proxy, as in M3), then Low.
node tools/perf/run.mjs --runs 3 --device phone --res 2 --label high \
  --ab "quality=mobile&res=1" --segments core,collapse,ruins,rubble
node tools/perf/run.mjs --runs 3 --res 2 --label high \
  --ab "quality=low&res=1" --segments core,collapse,ruins,rubble

# 4. Where the spikes land in the destruction views: every spike row must
#    read "GL wait" or "outside JS", none "gc".
node tools/perf/run.mjs --runs 3 --samples --trace /tmp/d6-traces \
  --segments collapse,ruins,rubble

# 5. Auto never steps down on the M3 (exits 1 if it does): 10 minutes of the
#    full-room furball with the scaler live.
node tools/perf/run.mjs --soak 600 --quality auto --res auto

# 6. The allocation table (CPU only; any machine): exits 1 over budget.
node --import tsx tools/destruction-bench.ts
```

---

## S8: the Spectacle batch gate — the boss fight, a ring course, a glass close-up

S8 measures the game after the Spectacle batch (S1 jumbotrons and headlines,
S2 the dynamic score, S3 ring courses and ghosts, S4 the sky boss, S5
atmosphere, S6 glass reflections, S7 streaks and medals) on the same kind of
GPU-less runner as O3–P2. It can count draws, staging, liveness, GL
allocations and JS allocations; **milliseconds are for the M3** (commands at
the end). Nothing here changes what a plain visit gets.

### Three new segments

Appended after D6's `rubble`, so the thirteen older segments keep their
index and their measured world instants (the warm-up lap's instants shift,
as in P2). The server runs D6's quiet city, so no real raid ever starts in
the harness's room; the staged one does not depend on that, though.
Each spot was checked offline against the shared collision (`touchesSolid`:
ground, buildings, trees, viaducts and every mover over 15 min of world time
around `WORLD_EPOCH_MS`), and `boss` against the staged hull too
(`collideBoss` over warm-up, settle and window): clear.

| segment | what | how it stays repeatable |
| --- | --- | --- |
| `boss` | 12 planes weaving 70–230 m ahead at 262–317 m, the war zeppelin crossing the view 520 m out, its flak bursting among them | held at (1000, 285, 1000). The raid is **staged** on the client (`__ab.qaBoss`, `client/src/game/qa-spectacle.ts`): on station for a minute, its centre crossing the view at mid-window — the pose is the shared `bossPoseAt`, a pure function of the pinned world clock. The flak is a fixed schedule on the same clock (one shell per turret per 1.8 s, aimed by an integer hash into the pilots' corridor) that starts 3 s before the segment's instant, so 5–6 shells are always in the air and the shell draw never toggles. The staged raid is re-applied every frame and any shell the server sends is dropped and counted. The 11 fake pilots (`pilots.mjs`, the furball's weave on a higher, shorter band) stay inside the plane LOD's near band and hold their fire: a tracer is a draw call on the pilots' own wall clock |
| `rings` | S3's Canyon Run down the x = 1400 street: rings in race colours, the record ghost racing ahead | a wall-clock glide at 60 m/s from 25 m before the start ring (crossed inside the settle), so the page's **own** client run starts and plays a **staged** ghost (`__ab.qaCourseGhost`: 72 m/s through the ring centres, on the wall clock like the glide). The glide stops six rings in, ~700 m short of the finish: no run ever finishes, so the server never records a time or a ghost a later pass would see |
| `glass` | a close-up on the glass landmark (building 127, 250 m): the probe's neon skyline in its curtain wall at a grazing angle | held 85 m off its north-west corner at 120 m |

The `spectacle` verdict checks, at **both ends** of the window, that the
staging held: the hull drawn, shells in the air, no server shell, every
pilot inside the LOD band (≤ 255 m from the plane); the run on the staged
course with its ghost playing (drawn on every tier but Mobile, which drops
the replay). On a slow renderer the window waits, at most 10 s past the
settle, for the staged scene to be on screen, and says how long it waited. A `FAIL` there exits 1 with or without
`--strict` — it measured an emptier scene than it claims. An `--ab-ref`
build from before S8 has no staging hooks: those segments print **no
baseline** for it.

### Two things the batch changed about measuring

- **The S6 probe moves the draw count.** It renders one cube face a frame
  inside the counted draws, and a face's count depends on which way it
  looks; a short runner window lands anywhere in the six-face cycle. The
  frame meter now records the probe's share per frame (`__ab.drawSplit()`):
  the table prints `draws = scene + probe`, the **determinism check compares
  the scene's draws**, and the budgets still judge the total. On every view
  measured here the probe's median is 7 draws.
- **A dropped session poisoned every later segment.** On a runner this
  loaded (load average 40–110, frames of 1–8 s) the page lost its session
  mid-pass (W2) and rejoined a fresh room with the default five bots, which
  then flew through every segment after it (`bot:room-3:6` … in the drain
  after `boss`). Two things dropped it: the client's 3 s watchdog, which at
  1–2 s a frame could read silence off a healthy socket — the harness now
  passes a QA `?silence=60000` (net/socket.ts; it only ever raises the
  bound) — and the server's 4 s liveness bound once one frame took longer,
  which D6's harness raises to 30 s. Every segment also re-asserts the empty
  room before it starts, and the table names a window with planes it did not
  ask for or a room change inside it.

### What the runner measured (S8)

GPU-less Linux box, SwiftShader (Vulkan), `--res 0.75` (the panel's floor at
device ratio 2), High, `--runs 3`, `core,station,hole,sidewalk,boss,rings,glass`,
on this branch merged with main after D6, C2, U4 and F9 (quiet city, D6's
liveness bound, the `?silence=` knob). **The box was badly oversubscribed** —
other tickets' harnesses beside it, load average 90–100 on 16 cores — so
frames took 1–8 s and a 5 s window held 1–7 of them. SwiftShader's GPU and
wall times are the CPU rasterising: every `60fps` and `hitch` verdict reads
FAIL here and says nothing about the M3.

| segment | draws = scene + probe (median pass) | scene draws, 3 passes | budget | spect. | first sight (window) |
| --- | --- | --- | --- | --- | --- |
| core | 103 = 96 + 7 | **96 / 96 / 96** | 120 | — | 0p 0t 0b |
| station | 101 = 94 + 7 | **94 / 94 / 94** | 111 (was 90) | — | 0p 0t 0b |
| hole | 117 = 96 + 21 (a 1-frame window that caught a probe refill) | **96 / 96 / 96** | 113 (was 92) | — | 0p 0t 0b |
| sidewalk | 103 = 96 + 7 | **96 / 96 / 96** | 113 (was 90) | — | 0p 0t 0b |
| boss | 279 = 272 + 7 | **272 / 272 / 272** (not asserted: live pilots) | 307 | ok: hull drawn (16 armour boxes), 5–6 shells, 0 server shells, 12 planes, every pilot ≤ 255 m | 0p 0t 0b |
| rings | 101 = 94 + 7 | 94 / 94 / 97 | 114 | ok: the run on Canyon Run, the ghost drawn, at both ends | 0p 0t 0b |
| glass | 116 = 95 + 21 (a 1-frame window that caught a probe refill) | **95 / 95 / 95** | 112 | — | 0p 0t 0b |

- **core: 103 draws against its 120** (96 scene + 7 probe), with every batch
  since P2 included. Nothing breached `core`, so nothing was cut.
- **Draws identical across passes in six of the seven segments**, `boss`
  among them, at 1–7 frames a window. **`rings` read 94 / 94 / 97**: its
  glide runs on the wall clock (so it covers the same canyon on any
  machine), and on this box one pass waited 4.5 s past the settle for the
  run to start, then drew its 3 frames further down the street. On the M3
  the run starts inside the settle and a window holds hundreds of frames;
  **`--runs 3 --strict` there is the identity check** (command 1 below).
  `boss` is measured but not asserted, like `furball` and `ruins`: its
  pilots are drawn at the synced server time, which the world pin does not
  reach (here they agreed anyway). Its staged part, the hull and the shells,
  is pinned, and the `spect.` verdict checks it.
- **P2's three tripwires are re-based**, by P2's own rule (measured +
  ~10 %). Their scene draws are 94–96 now, where P2 measured 82–83: the
  Spectacle batch's one-draw systems (jumbotrons, rings, fog banks, litter,
  the shafts pass), the Destruction, C2 and U4 batches' meshes and lights,
  and the S6 probe's 7 a frame on top. (Before the merge with D6's quiet
  city, raids, missiles and collapses landing on the wall clock had also
  moved these counts between passes; they no longer can.)
- **First sight**: 0 programs, 0 textures and 0 buffers inside every window.
- **Mobile** (`--quality mobile`, `core`, `boss`, `rings`, `glass`, 3
  passes, measured before the merge with D6, so on a server that was not
  quiet): every segment alive, 0p 0t first sight in every window, the probe
  draws no face (`probe 0`), and every view is lighter than High: core 81–85
  (High 102 in that run), boss 260–261 (278), rings 83–91 (102), glass 86–91
  (99). The ghost plays but is not drawn, as the tier says. That run
  predates the fix to the `rings` check (which demanded a drawn ghost, and
  Mobile never shows one) and saw a session drop in its last pass, so its
  rings and glass carry five bots. The phone itself is for the M3 (command 4).

### No per-frame allocations: the table (`tools/spectacle-bench.ts`)

O5's table, D6's method, for every per-frame entry point of S1–S7 on the
harness's own spectacle scenes (the staged boss and its flak, the Canyon Run
glide with its ghost, twelve planes on kill streaks), in Node under V8's
sampling heap profiler: bytes allocated per frame by the module's own code,
1200 warm frames then the median of five 3000-frame runs.

```sh
node --import tsx tools/spectacle-bench.ts [--where] [--json] [--only=S5]
```

| entry point | before S8 | after | |
| --- | --- | --- | --- |
| S1 jumbotrons.update | 62 B | 45–62 B | ok |
| S3 rings.setRun + update | 0 | 0 | ok |
| S3 ghost.update | 0 | 0 | ok |
| S4 boss.update (zeppelin + flak) | 544 B | 315–317 B | ok |
| S7 streak smoke (12 planes) | **63 057 B** | 0 | ok |
| S5 atmosphere.update (fog banks, litter, shimmer, shafts) | **20 881 B** | 864–877 B | ok |
| S6 reflections.update (the probe's schedule) | 240 B | 223–237 B | ok |
| S2 music.update (state machine; no WebAudio here) | 62 B | 35–73 B | reported |
| **judged, all together** | **~85 KB** | **~1.5 KB** | **PASS** |

"Before" is the batch as merged. The boss row leaves out the D1 particle
pool's own update (D1's code, and D6's to fix); the bursts' spawn into it
stays in. What the table found and fixed — every rewritten module's output
byte-identical to before (seeded digests of every buffer and uniform it
writes):

- **`SmokeTrail`** (S7's streak smoke rides on the wounded-plane model):
  every puff re-based into a new object and two filtered arrays, every
  frame, per trail. Now re-based in place, aged out by compaction, dead puffs
  reused, the trails walked by a pre-bound callback.
- **S5 fog banks**: the churn angle was recomputed per puff with the world
  clock (a double) handed to a call per puff, and `Math.hypot` per puff. Now
  once a frame, with a squared range test. **Litter**: the clock rides in an
  object (one boxed double a scrap, ~8 KB a frame at street level), a
  prebuilt upload list, index loops. **Heat shimmer**: the 4 Hz pick built
  filtered, mapped and sorted copies (`pickShimmerVentsInto` makes the same
  picks in the same order from scratch arrays); slot vectors written field
  by field. **Wind**: index loops instead of `for…of` with destructuring.
- **S4 flak**: the `Map` of shells walked by a pre-bound callback (an
  iterator and an entry array per shell, every frame).
- `uploadPrefix` takes D6's pooled update ranges verbatim
  (`render/update-range.ts`), so the two branches merge clean either way.

**The bar, and what is left.** "No per-frame allocations" means nothing is
*built* per frame: no object, array, closure or iterator. What remains is
boxing, and it cannot be written away: in this V8 a plain object's number
fields are tagged (`%DebugPrint` of a `Vec3` scratch or a shimmer slot shows
`@ Any`), so every computed double stored into one is a 16 B HeapNumber, as
is a double handed to a call V8 does not inline — the same residue O5's
collision table carried. The bar is D6's: ≤ 1 KB a frame an entry, ≤ 4 KB in
all, about one young-generation GC a minute at 60 fps. Reported beside it
and not in it: three's update-range list (~900 B a frame on the atmosphere
row) — three's renderer empties each attribute's `updateRanges` with
`length = 0` after an upload, which frees the array's store, so the next
frame's push grows a new one; D6's table carries the same.

`run.mjs --heap` is the in-page complement for the glue the bench cannot
see (the frame loop in `main.ts`, the DOM HUDs, the socket): a sampling heap
profile over each segment's settle and window, divided by the frames the
page drew in it, with the top sites (the bundle is minified: map a site's
`file:line:column` through the build's source map). On the runner it works
and says nothing: at 1 s a frame it divides ~6 s of everything — 20 Hz
snapshot decoding included — by 5 or 6 frames (1–2.7 MB "a frame"). It is
for the M3, where a window holds hundreds of frames.

### Quality tiers

Every Spectacle feature has a row in `FEATURE_TIERS` and the tier table
above (S8 added the five that have no render cost and so had none: the S1
kill feed and headlines, the S2 score, the S3 course HUD, the S4 boss HUD and
radio, the S7 medals and announcer). `tools/spectacle-bench.ts` checks it:
every S1–S7 prefix has a row, and every row is in the README word for word.
On Mobile the probe renders no face (`reflections` 0), the ghost and the LAST
KILL pass are off, the shafts, shimmer and glare are off, and the flak,
litter and streak dressing are thinned; the hull, its weak points, its
shells, the rings and the fog banks are the same on every tier (solid, the
telegraph, guidance, visibility parity).


### Commands for the M3 (S8)

Run on main after this merges, with the machine otherwise idle. Refs:
`1b19154` is the last commit before the Spectacle batch (S2 was its first
merge; note that the Destruction batch D1–D5 merged in between too), and
`5d29b26` is S6's merge, the last state before this gate.

```sh
npm run perf:setup   # once

# 0. The repo gates and the allocation table (alloc PASS, tiers PASS, exit 0).
npm run typecheck && npx biome check client common server && npm test
node --import tsx tools/spectacle-bench.ts

# 1. The gate: every segment, 3 passes, determinism enforced. Read the
#    60fps / hitch / draws / room / spect. verdicts: boss and rings must
#    read "ok" under spect., no "uninvited planes" or "changed rooms" line
#    may appear, and draw calls must be identical per segment (boss,
#    furball and ruins exempt: live pilots; D6's destruction table and its
#    staged draws as D6 says). GPU p50 <= 14 ms is 60 fps at ratio 2.
node tools/perf/run.mjs --runs 3 --samples --strict --label S8

# 2. What the batch cost: paired against the commit before it (boss and
#    rings print "no baseline" there: that build cannot stage them; judge
#    them on their own verdicts), and against S6's merge for continuity.
node tools/perf/run.mjs --runs 3 --label S8 --ab-ref 1b19154
node tools/perf/run.mjs --runs 3 --label S8 --ab-ref 5d29b26

# 3. The probe's own cost where it matters most: refl on vs off, paired.
node tools/perf/run.mjs --runs 3 --segments core,rings,glass --label refl --ab "refl=0"

# 4. Tiers. Low vs High at their own ratios; then Mobile as a phone at its
#    ceiling vs High (GPU p50 <= 5 ms on Mobile is the assumed phone proxy,
#    as in M3/P2).
node tools/perf/run.mjs --runs 3 --res 2 --segments core,boss,rings,glass --label high --ab "quality=low&res=1"
node tools/perf/run.mjs --runs 3 --device phone --res 2 --segments core,boss,rings,glass --label high --ab "quality=mobile&res=1"

# 5. In-page allocations per segment (bytes per frame and the top sites):
#    boss, rings and glass within +256 B/frame of core on the same run.
node tools/perf/run.mjs --heap --segments core,boss,rings,glass

# 6. Soak: Auto never steps down on the M3 (exits 1 if it does).
node tools/perf/run.mjs --soak 600 --quality auto --res auto

# 7. Flicker: O5's grid, not worse than S6's merge.
node tools/perf/flicker.mjs --grid --ref 5d29b26
```

---

## O6: the frozen-view flicker — two harness bugs, two vehicles, and two shimmers a frozen camera cannot see

The planner's Metal grid read two views far over O5's 0.041 frozen ceiling
on main: `intersection` 1.40 (jitter 6.6 %) and `pose-19` 0.78–0.85. The
runner reproduces both within a few percent (1.46 and 0.84 under
SwiftShader), so everything below was measured there; scores are relative,
but a view this far over moves the same way on any rasteriser.

### Two harness defects, fixed first

Neither changes what the game draws; both changed what the tool measured.

- **The camera zoomed during a "frozen" capture.** The FOV widens with
  airspeed (`speedFov`), and the held plane was re-teleported every frame
  at whatever speed it had, so a view captured while the plane was still
  spooling up toward cruise zoomed a hair wider every frame (70.06 →
  70.68 m/s over one capture). That re-rolled the facade speckle below on
  every frame: with the WORLD pinned as well, `still` read 1.26 where it
  should read ~0, and the same view's frozen score swung 1.46 → 4.6
  between runs with how far the spool-up had got. The pin now
  sets one airspeed (`PIN_SPEED`, MAX_SPEED) on the flight state every
  frame — on the state, not through `teleport`, so a `--ref` build from
  before O6 is held exactly the same way.
- **One step in 24 rendered two frames.** Playwright's fake clock fires
  `requestAnimationFrame` on a 16 ms grid; a 1000/60 ms step crosses two
  grid lines once every 24 steps, so that step's world moved twice as far
  and a third of all captures carried one step ~1.6× its neighbours
  (pose-19: 0.75 → 1.24 → 0.75, on a different step every run). The step
  is now 16 ms.

With both fixed, a capture is **byte-identical run to run** (three
repeats: every per-step delta equal), where the same view used to vary
by ±0.05 — larger than the effects being looked for.

### Attribution: `--ablate` and `--hide`

`__ab.qaSystems()` names the scene's systems (every top-level scene
object of note, the S5 fog banks and litter, the city split finer as
`city:main` — its base mesh alone — and `city:<i>`, each child mesh, plus
four post effects: `post:shimmer`, `post:shafts`, `post:glare`,
`post:reflections`); anything unnamed is listed as `other:<index>` (the
lights and the HUD sprite). `__ab.qaHide(names)` takes those systems off every camera layer
(restoring each object's own mask afterwards — S6 tags reflection layers)
or holds the post effect off every frame.

`flicker.mjs --grid --ablate [all|a,b]` re-shoots each view's frozen
capture at the same world instant once with nothing hidden, once per
system with only that system hidden, and once with every named system
hidden ("everything else" — what no named system accounts for). A
system's **share** is how far the score falls without it. Shares are not
additive and can be negative: hiding an opaque mesh or a light reveals or
relights what is behind it. `--hide a,b` keeps systems out of every
capture (and every ablation row) — a view's score without, say, the
train that crosses it. `--breathe` (below) works with both.

### What each view's score is

Frozen camera, world advancing; share = score drop with the system hidden
(runner, deterministic to ~0.002; every row below 0.003 omitted):

| view (instant) | frozen | share | system |
| --- | --- | --- | --- |
| `intersection` (main, `5d29b26`) | 1.399 | **1.280** | `train` — the T2 elevated train crossing the top of the frame |
| | | 0.015 | `signage` — the vertical glyph ticker scrolling (L7) |
| | | 0.003 | `facadeDetail` |
| | | ≤ 0 | everything else; "everything else" row 0.000 |
| `pose-19` (the planner's instant, `031713f`) | 0.725 | **0.590** | `traffic` — a bus driving at the camera |
| | | 0.033 | `signage` — a storefront LED ticker crawling (L7), video billboard pan |
| | | 0.024 | `headlightPools` — the bus's own pool on the road |
| | | 0.011 | `headlightCones`, `cityLife` (riders, taxis) |
| | | 0.005 | `pedestrians` |

Every listed suspect was in the run (`--ablate all`: L6 signals and
headlight cones/pools, L7 signage and broken neon, L3 living windows/TV
(the `city` mesh), D1 impacts and damage (`impacts`, `city`), L1
reactions, S1 jumbotrons, streetlights, L4 rain, A1 pedestrians and
city life, S5 fog banks, litter, shimmer, shafts and glare, S6
reflections): none of them moves either view by more than the rows above.

**The frozen scores are motion, not flicker.** The train and the bus are
the world's own motion: the train slides ~5 px a frame past a ~30 px
window pitch near the camera (both shrink together with distance, so ~6
frames per window everywhere — far from the wagon-wheel limit of 2), and
a lit window strip crossing a pixel brightens and darkens it every few
frames, which is exactly what `jitter` counts. With the train hidden,
intersection's jitter falls from 6.76 % to 0.11 % and its frozen score to
0.117, of which `signage` is 0.070 (the glyph ticker, and the signs the
train had been covering — a mipmapped `textureGrad` scroll, one stack
height per 6–10 s) and `moverLights` 0.035 (the train's own running
lights, still sliding past); nothing else reaches 0.003. The signage
shares are slow, filtered scrolls (signage-only captures: jitter 0.05 %
and 0.00 %).

`pose-19`'s instant moved when S6 added gallery views (each view's
instant follows its index in the list): on main it is captured 195.5 s
later, with no bus in frame, and reads 0.047 (jitter 0.003 %).

### The flicker that was real: interpolation that was not exact

The harness's accidental zoom was the clue. A 0.005° FOV step a frame
moves the frame edge ~0.015 px, which changes a filtered image by almost
nothing — yet it moved the train-hidden intersection from 0.117 to
**4.97** (jitter 28.5 %), and `--ablate` put **4.25** of that on the
city's base mesh alone (`city:main`; D2's damaged and debris meshes
nothing). Read pixel by pixel, a facade pixel was not drifting but
snapping between discrete colours — wall, wall-in-window-surround, an
unlit pane — a per-pixel random pick of window *decisions*, static while
the camera is perfectly still and re-rolled by any change of projection.

The cause: every per-window decision in the building shader (lit or not,
blinds, tone, temperature, TV, crew, shopfront goods) hashes
`abHash(winCell, vBSeed * k)` — `fract(sin(dot(…)) * 43758.5453)` with a
`sin()` argument of 1e4–1e6 — and `vBSeed`, a per-building constant, was
an ordinary *interpolated* varying. Interpolating a constant is not
bit-exact (the barycentric weights do not sum to exactly 1), so at some
pixels it arrives one ulp off, which inside that `sin()` is a different
window. L13 had already met this for `vPitchSeed` and made it `flat`;
`vBSeed` is now `flat` too. The T2 train had the same bug twice in its
passenger hash — `vTrainId = float(gl_InstanceID)` interpolated, and the
interpolated normal's z as the side — so seats sparkled under any camera
move: `vTrainId` is `flat` and the side is an exact ±1.

Neither change alters the intended look (at every pixel where the old
value happened to arrive exact, the new one is the same); both remove a
speckle that sparkled on every facade in view through every frame of
real flight, where the camera never holds still.

**And the street paint swam.** Breathing, the ground was most of what
was left — `ground` 1.007 of pose-19's 1.154, in pops (5.2, then ~2.0 every
few steps, 0.2 between) where the whole road's markings shifted a pixel
against buildings that did not move. The ground was two triangles
1.8 km across, re-centred under the chase camera every frame: `vWorldXZ`
interpolated over triangles that size, hard-clipped by the near plane,
is not exact, so each re-centre (here a millimetre, from the airspeed
moving the held plane; in flight, every frame) shifted the paint's world
mapping by a fraction of a pixel and its edges popped. The plane is now a
64×64 grid (~28 m cells, still one draw); the paint is the same paint.

`--breathe` makes the harness's accident deliberate: the held airspeed
ramps 70 → 70.6 m/s through every capture (~0.005° of FOV a frame, and
the plane — so the ground — a millimetre further each frame), identical
in every arm, so a camera that is otherwise frozen can see what re-rolls
or swims when the view changes. HEAD against main (`5d29b26`), both arms
breathing:

| view | breathing, main → O6 | jitter main → O6 |
| --- | --- | --- |
| `intersection` (train in frame) | 4.369 → **1.488** | 25.15 % → 6.45 % |
| `pose-00` | 0.738 → **0.158** | 9.19 % → 0.34 % |
| `pose-09` | 0.586 → **0.078** | 7.98 % → 0.13 % |
| `pose-19` | 4.738 → **0.206** | 29.93 % → 0.63 % |

The verdict column `--breathe` prints is O5's frozen rule and does not
apply to a camera that moves on purpose; read the before/after. The
intersection's breathing 1.488 is its train (frozen, 1.399) plus 0.09.
With the train hidden it breathes at 0.263 (4.97 before either fix,
0.600 with the facades fixed and the ground not): `signage` 0.123 (the
glyph ticker scrolling, and sign edges under the zoom), the train's
lights 0.033, `ground` 0.013, nothing else over 0.005; jitter 0.45 %.

Audited the same way and clean: every other `fract(sin(…))` hash in the
client takes a genuinely varying input (world or surface position, then
`floor`ed), or a varying that only feeds thresholds (`vKind`, `vArch`,
signage's `vAnim`, which is floored or rounded). One more of the same
pattern is outside both views: hole decor's `vDecor.x` (kind + seed)
feeds its `abH` hash; the decor only draws inside tunnels.

**Static audit for M3-only causes:** every shader runs `highp` (three.js
default; FinalPass's raw shader inherits OutputShader's `precision highp
float`); no shader declares `mediump` or `lowp`; the time-driven uniforms
are wrapped (`SIGN_LOOP_S`, `LIVE.period`, the shimmer clock). The M3
read the same numbers as SwiftShader to within ~5 %, which a precision
or derivative difference would not.

### Commands for the M3 (O6)

Run on main after this merges, with the machine otherwise idle.
`d206dd2` is main just before O6 (the numbers above were measured against
`5d29b26`, main when O6 branched; C2, U4, F9, B3, D6, S8 and R3 landed
between). Both arms run on O6's harness (one airspeed, 16 ms steps), so
the comparison is fair to the older build.

```sh
# 1. The frozen grid against main: per-view table and verdict. Every view
#    must read "not worse". intersection still reads ~1.4 — the train
#    crossing it (see above), which no fix should remove.
node tools/perf/flicker.mjs --grid --ref d206dd2 --shots /tmp/o6-shots

# 2. The speckle fix, on Metal: the same views with the camera breathing.
#    Every view should fall several-fold against main (the table above).
node tools/perf/flicker.mjs --grid --breathe --ref d206dd2 --shots /tmp/o6-breathe

# 3. The attribution, on Metal: per-system shares for both views.
node tools/perf/flicker.mjs --grid --only intersection,pose-19 --ablate all

# 4. The intersection without its train: the number O5's 0.041 ceiling is
#    meant for in this view (runner: 0.117 — signage 0.070, the train's
#    lights 0.035).
node tools/perf/flicker.mjs --grid --only intersection --hide train --ablate all
```
