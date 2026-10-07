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

**Two segments are honest exceptions, and both for the same reason** — the
harness pins the seed and the path, but it cannot pin the *server clock*
without a server change:

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

All read-only except the two that exist for QA, all on `window.__ab`:

| hook                             | used for                                    |
| -------------------------------- | ------------------------------------------- |
| `teleport(x, z, y, yaw)`         | the scripted path                           |
| `perfReset()` / `perfStats()`    | one segment's frame-time window             |
| `perfSamples()`                  | raw per-frame times, for histograms         |
| `gpuStats()` / `gpuSamples()`    | the same window on the GPU clock            |
| `render()`                       | AA mode, pixel ratio, drawing-buffer size   |
| `setPixelRatio(r \| "auto")`     | pin or release the scaler at runtime        |
| `setBots(0)`                     | empty the room so the scene is reproducible |
| `storm()` / `net()` / `combat()` | strike timing, clock, alive check           |

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
| pixel-ratio ceiling for the scaler | 2 | 1.5 | 1 | 1.25 (1.0 / 0.75 at thermal levels 1 / 2) |
| L1 alarms, lit windows, responders | full | full | full | full |
| L1 smoke columns | full | full | half the puffs | a third of the puffs |
| L1 pedestrians | full | 70 % | 40 % | 30 %, one block out |
| L1 steam, signals, sparks | full | full | full (already altitude-gated) | one block out; half the steam |
| L2 soundscape | full | full | full (audio) | full |
| L3 living windows | full | full | off (static grid) | off |
| L4 rain streaks | full | 50 % | 35 % (haze unchanged) | 25 % |
| L4 wet streets, puddles | full | full | full (uniforms) | full |
| L5 train + viaduct | full | full | full (solid) | full |
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
| bloom | full | full | full | half-res chain (cheaper via the ceiling); off at thermal level 1 |
| final grade | full | full | full | off |
| window interiors (parallax rooms) | full | full | full | off: the room's mean light (uniform guard) |

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
  - **Level 1** drops bloom and caps the scaler at 1.0.
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
# at its own ceiling, as a landscape phone, JS throttled 4x, core view only.
# Read the "cost:" block: fragment proxy and draws × pixels ratios, JS p50.
AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader" \
  node tools/perf/run.mjs --device phone --cpu-throttle 4 --segments core \
  --res 2 --label high --ab "quality=mobile&res=1.25"

# On the M3 (real GPU), machine otherwise idle: Mobile at ratio 1 as a phone.
# GPU p50 <= 5 ms is the target: an ASSUMED proxy for a phone GPU ~4x
# slower than the M3, not a measurement of one.
node tools/perf/run.mjs --runs 3 --device phone --quality mobile --res 1 --label mobile
# The same, paired against High at its own ratio, for the GPU ratio.
node tools/perf/run.mjs --runs 3 --device phone --res 2 --label high --ab "quality=mobile&res=1.25"
```
