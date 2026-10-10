# A3 Carrier War release gate

The last check on the Carrier War batch (W1–W4, D9, D9b, DT1, DT2, A1, A2,
J1, U7) merged together: does it run, hold together and play. Each section
gives the command, what it found, and what was fixed. The before arm
everywhere is **97883bd** (F10), the last main commit before the batch's
first merge (DT1, aee6d49). W1's own parent, daa30b6, already carries DT1, A2,
D9 and U7.

The runner is a shared 16-core Linux box with **no GPU**. Chromium falls
back to SwiftShader, so frames take 0.5–12 s and every GPU column is a
SwiftShader number. Load averaged 14–29 while other agents' work ran. Read the
browser rows for draws, budgets, determinism, first sight and errors, never
for milliseconds. The [M3 commands](#commands-for-the-m3) at the end settle
the GPU questions.

## Verdicts

| check | command | result |
| --- | --- | --- |
| Repo gates | typecheck, biome, `npm test`, client build | PENDING |
| Gameplay sanity | `node --import tsx tools/carrier-sanity.ts --runs 3` | **PASS, 3/3** |
| Roof seams | `node --import tsx tools/roof-seams.ts` | **PASS**: 0 clashes |
| HUD seams | `node tools/perf/polish.mjs --overlap` | **PASS**: 0 overlaps after the fixes (before: 4, and the WAVE banner off centre) |
| Allocation benches | `tools/{chaos,spectacle,destruction}-bench.ts` | chaos **PASS** after the fixes (was over budget); destruction **PASS**; spectacle **FAIL** on `boss.update`, which is pre-existing and equally over on 97883bd |
| Perf, desktop | `run.mjs --runs 3 --res 1 --ab-ref 97883bd` | every draw budget ok once the runner's probe artefact is accounted for; 0 late compiles; 0 page errors |
| Perf, phone | `run.mjs --runs 3 --device phone --quality mobile --ab-ref 97883bd` | exit 0; every draw budget ok (chaos 90 / 90); 0 late compiles |
| Flicker | `flicker.mjs --grid --repeat 3 --ref 97883bd` | PENDING |
| Black boxes | `blackbox.mjs --device desktop,phone --repeat 3` | PENDING |
| Soak | `polish.mjs --soak 30 --peers 1 --phone --lab --parity` | 0 errors / 0 page errors / 0 server exceptions; lab and parity clean; exit 1 on client heap only (+17.5 % / +15.2 % / +14.6 %, flat after warm-up: written exception below) |

## What the gate fixed

### HUD seams (W1 × W4 × J1 × the radio)

`polish.mjs --overlap` probed idle and medal moments only, so it never saw
the Carrier War HUD. It now has a third state, **war**: W4's objective
line with the EASY chip, the WAVE banner, the bombing warning, the carrier
bar, and J1's combo banner, streak and score popup, all forced on at once
with animations frozen at their resting style. It also gained a short-phone
profile (740×320, the `max-height: 340px` layout). On merged main, 97883bd
read 0 overlaps and the batch read 4:

| profile | overlap | fix |
| --- | --- | --- |
| desktop 1280×720 | `#comms` × `#medal-toast`: a long radio line ran under the centre column | `#comms` wraps inside the right column (`max-width: 50vw − gutter − 186px`) |
| phone 844×390 | `#comms` × `#boss-bar` | the phone's comms column stops short of the centre strip (`min(30%, 50vw − gutter − 224px)`) and ellipsizes |
| phone 844×390 | `#bomb-warn` × `#wave-banner` | the banner sits under the warning |
| phone 844×390 | `#juice-combo` × `#juice-streak` | the streak sits 34 px under the combo |
| phone 740×320 | `#comms` × `#wave-hud`, `#wave-banner` × `#medal-toast` | comms drops under the objective line; the banner is hidden this short, since the objective line already reads "WAVE n" |

The live probe also caught the **WAVE banner hanging off centre**. W1 gave
it `medal-pop`, whose `transform: scale()` replaced the banner's
`translateX(-50%)` for the whole time it showed, so its left edge sat on
the screen's middle. It now has its own pop on the independent `scale`
property, like every J1 animation. All four profiles now read 0 overlaps in
the idle, medal and war states.

### Bombs over the river (W2 × L11)

`common/bombs.ts` `bombSurfaceY` returned 0 (the street) wherever no
building stood. Over the river's open channel, off the bridge decks, that
is 22 m above the water, so a bomb whose fall ended there burst in mid-air.
It now returns `RIVER_WATER_Y` off the decks (one per north–south street
line, `BRIDGE_HALF_WIDTH` either side). The drop planner, the bots' dive
release envelope and the AA-nest bomb targets all read it, so what clients
draw is still what lands. The first sanity trial's three carpet bombs over
the channel at x ≈ 1006 were on the x = 1000 bridge deck, which was correct.
The fix covers open water off the decks.

### Per-frame allocations (DT1, J1 → three's colour management)

| bench entry | 97883bd | merged main | after the fix |
| --- | ---: | ---: | ---: |
| chaos `P4 fleet.commit + tags (12 planes)` | 0.0 | **2546.6 (over the 1 KB budget)** | 391.2 |
| chaos, everything judged | 1302.5 | **4465.8 (over the 4 KB budget)** | 2317.3 |
| spectacle `S7 streak smoke (12 planes)` | 0.0 | 784.2 | 0.0 |

The fleet calls `Color.setHex` for every plane's livery every frame, and the
streak smoke for every trail's tint. Run alone, each still reads 0 B. Next
to the batch's new FX code, three's colour conversion (`SRGBToLinear`)
turns polymorphic and boxes its doubles. Each hex is now converted once
and cached; the set is bounded by the livery palette and the streak tiers.
The colours are value-identical.

`tools/chaos-bench.ts` had crashed before measuring anything since U6, on
97883bd too: its stub socket lacked the cave-ins and boss launches that
`pruneChaos` reads. With the stub completed, the bench found the fleet
regression above.

## Gameplay sanity (`tools/carrier-sanity.ts`)

The tool boots the real server with production tunings (no `AB_*_FAST`; the
carrier comes 4–6 s in) and flies one scripted **novice** ws pilot. The
pilot flies Easy twice over: W4's own Easy flag and the room's EASY
intensity. It has no flight model and no aim help. It holds a 250 m orbit
over the AA nests' anchor at 62 m/s and 140 m, and turns toward the nearest
enemy at ≤ 45°/s. It fires real rounds only inside a 12° cone within
300 m, and claims a hit on one round in four (seeded). After wave 1 it
strafes the carrier's weak points at MIN_SPEED. Each claim is a line the
server re-runs against the hull, and the pilot makes it only when the pure
hull model puts a live weak point first on that line.

| run (seed) | wave 1 live → cleared | pilot deaths in wave 1 | AA kills | bombs (roof / street / bridge) | nearest bomb to a spawn point | carrier down | next carrier |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| 1 | 9.1 → 39.5 s (30.4 s) | 0 | 27 | 3 / 0 / 0 | 618 m | 156.6 s | +20.0 s |
| 2 | 9.1 → 51.3 s (42.2 s) | 0 | 11 | 0 / 3 / 1 | 759 m | 168.0 s | +20.0 s |
| 3 | 9.1 → 67.5 s (58.4 s) | 0 | 22 | 0 / 4 / 0 | 998 m | 184.0 s | +20.0 s |

Pass lines: wave 1 cleared within 240 s, no pilot death during it, ≥ 1 AA
kill, ≥ 1 bomb with every bomb on the city's surface (never above the
intact surface by more than 3 m, never below the floor) and ≥ 150 m from
every spawn point at any time, the carrier down within 600 s, and the next
raid within `NEXT_CARRIER_MS` + 10 s.

**Worth knowing:** on Easy, with a pilot circling over the AA belt, the
rooftop guns take most of the kills. A 15-minute trial run had 34 AA kills
against the pilot's 0, and the gate runs 11–27 against 2–15. W3's balance
target is 15–25 % AA kills for a NORMAL war. This is an Easy room flown
over the densest nests, not that measurement, but it is the number to
check if Easy feels like the guns play for you.

## Roof seams (`tools/roof-seams.ts`)

Each of the seed city's 40 AA nests (4 heavy) is checked on its building
against what is drawn there: 1292 roof parts (R2 structure bodies and
dressing, HVAC, DT2 details) by their drawn boxes, every `roofKeepOuts`
rect (rooftop life, detail claims), and every other D9 prop on that roof
(water towers, masts, billboards). Every nest also stands wholly on its top
roof. Result: **0 clashes, 0 tall parts inside a barrel's sweep**. The
positive control `--inflate=3` finds 52 clashes, so the check is not blind.

## Perf

### Desktop, paired against 97883bd

Command: `node tools/perf/run.mjs --runs 3 --res 1 --label A3 --ab-ref 97883bd`,
with every segment flown and the arms interleaved. `--res 1` is because the
runner could not get through ratio 2 in reasonable time.

- **Draws.** Every city segment gains **+5 to +8 scene draws**: core 83 → 89,
  chaos 99 → 107, boss 86 → 93, tunnel 84 → 90. That is the size of what the
  batch adds: DT1's two fleet draws, W3's AA-nest draws, and DT2's detail.
  The live-pilot segments `furball` and `ruins` read ±0, because their pass
  spread swamps it. Per-system attribution needs `--ledger` (an M3 command
  below).
- **Budgets.** Every draw budget holds. Two verdicts failed in this run,
  `rubble` (114 against core + 15) and `cavein` (106 against 100). Both are
  the runner, not the batch: their scene draws are 93 and 85, and the rest
  was the reflection probe drawing **21** (3 faces, a refill) instead of 7.
  On SwiftShader a 2–12 s frame moves the camera more than `REFILL_JUMP`
  (150 m) between frames, so the probe refills over and over. 97883bd's
  `hole` shows the same thing (83 + 21). Re-flown at `--res 0.5` (faster
  frames), the probe reads 7 in all four and every verdict is ok (exit 0):
  core 96, rubble 100 (≤ 111), cavein 99 (≤ 100), hole 96.
- **Tight budgets to watch on the M3:** boss 100 against 101, and cavein
  99 against 100. On this branch cavein's scene draws vary 85–92 between
  passes. 97883bd holds 84 on desktop, but varies on the phone too
  (72–75).
- **First sight:** 0 late compiles in all 3 passes, and the first-sight
  table is `0p 0t 0b` in every settle and window. No page errors in
  either arm.
- **Time:** every GPU and wall column is SwiftShader (GPU p50 0.6–1.4 s a
  frame). The overall paired GPU p50 delta is +0.2 %, and every per-segment
  move (−22 % to +41 %) is inside the run's own 92 % pass-to-pass spread.
  None of it is quoted as a regression or a win. The determinism line FAILs,
  as it does on 97883bd (wall-clock glides and the probe refills above).

### Phone

Command: `node tools/perf/run.mjs --runs 3 --res 1 --device phone --quality mobile --label A3-phone --ab-ref 97883bd`,
every segment. It exits **0**.

- **Draws** are +3 to +6 a segment, with no probe on Mobile: core 73 → 77,
  chaos 86 → **90**. Chaos is **exactly at its Mobile budget (≤ 90)**, the
  tightest number in this gate.
- 0 late compiles, 0 page errors, and every draw verdict ok in both arms.
- furball, ruins and cavein vary between passes in both arms (live pilots,
  staged debris); rings and chaos vary on 97883bd only.

### Allocation benches

| bench | 97883bd | merged main | this branch |
| --- | --- | --- | --- |
| `tools/destruction-bench.ts` | — | PASS | **PASS** (2055 B/frame judged, budget 4096) |
| `tools/chaos-bench.ts` | crashed (stub; 1302 B/frame once patched) | crashed; 4466 B/frame once patched, **FAIL** | **PASS** (2317) |
| `tools/spectacle-bench.ts` | FAIL: `S4 boss.update` 1243 | FAIL: `boss.update` 1248, streak smoke 784 | FAIL: `boss.update` 1250 only (pre-existing, follow-up) |

Two increases are still within budget and were left alone. `U4
tunnels.update` went 0 → 444 B/frame: U7's `blendedPalette` and the common
`tunnelFrameInto`, both boxing doubles. Hoisting `blendedPalette`'s
literal weights array measured no change, so it was not kept. `P4
explosions + sparks` went 104 → 223, from J1's `fx.ts`.

## Flicker and black boxes

PENDING-FLICKER

## Soak

Command: `node tools/perf/polish.mjs --out <dir> --label A3 --soak 30 --peers 1 --phone --lab --parity`.
It ran on this branch's final code (c5a13ae; later commits are docs only),
with three headless clients (desktop 1280×720, a 640×360 peer flying the
scripted spectacle, a DPR-3 touch phone) against the real server: constant
chaos, carrier waves, forced crashes and settings cycles. The box was at
load 24–79, and the clients drew 0.5–1.8 fps.

| | desktop | peer | phone | server |
| --- | --- | --- | --- | --- |
| console errors / page errors / unallowed warnings | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | stderr empty, alive |
| heap vs minute 5 (forced GC) | **+17.5 %** | **+15.2 %** | +14.6 % | +9.6 % (limit 20 %) |
| heap, minute 21 → 29 | 50.41 → 50.79 MB | 51.13 → 51.38 MB | 50.22 → 50.38 MB | RSS median step 0.11 MB/min |
| DOM / programs / geometries / textures | flat | flat | flat | — |
| stuck UI | none | none | none | — |

Flight Lab visits at minutes 10 and 20 came back clean (0 leftover rooms,
0 errors). Late-joiner parity at minutes 11 and 21 had 0 desyncs.

**The verdict is exit 1, on the client-heap heuristic alone**: desktop and
peer finished just over its 15 %. This is the **written exception** the plan
allows, because the growth is warm-up, not a leak:

- It decelerates from about 0.6 MB/min over minutes 1–10 to about
  0.05 MB/min over minutes 21–29. That is +0.4 MB in the last 8 minutes for
  desktop, +0.25 for the peer and +0.16 for the phone.
- It has the same size and shape as A2's soaks of the pre-batch code: run
  E read +16.0 / +16.8 / +16.2 %, and A2's single-client plateau measured
  +0.12 MB over minutes 20–35. A2 attributed it to the per-building caches
  filling as a client reaches more of the city, bounded by the city.
- Renderer resources (geometries 118, textures 47–51, programs 111–112)
  and DOM nodes did not move after minute 1.

The batch added no growth that A2's soak did not already show. On a quiet
machine the clients warm up inside the first 5 minutes, so the M3 soak
(command 9) is expected to pass outright.

## Follow-ups (not fixed here)

- **`S4 boss.update` is over its 1 KB allocation budget**: 1243–1250
  B/frame in `spectacle-bench`, the same on 97883bd, so it predates the
  batch (S9's carrier). Not taken here.
- **Tight draw budgets.** Chaos on Mobile is at 90 of 90, boss on desktop
  at 100 of 101, and cavein at 99 of 100 with its scene draws varying
  85–92 between passes. The next draw any of those views gains needs a
  budget decision or a draw back.
- **A fallen bridge span.** `bombSurfaceY` has no prop state, so a bomb
  whose fall ends over a D9 span that has collapsed into the river still
  bursts at deck height. That needs a fallen span and a bomb on its 40 m
  at once, and the fix needs the room's gap mask threaded into the bomb
  planner.
- **Easy and the AA.** Over the AA belt on Easy the rooftop guns take most
  of the kills (see the sanity section). This is a balance call, not a
  defect.
- **The harness.** `run.mjs` reads `rubble`/`cavein` draw verdicts off a
  median frame that can be a probe refill on a software rasteriser. A
  verdict on scene draws plus the tier's probe faces would stop that
  false FAIL. `run.mjs` and `server-tick.mjs` still send `setBots`, which
  is a no-op since W1 and kept for the pre-W1 ref arm.

## Commands for the M3

Run on the M3 with the machine otherwise idle. Each command says what it
expects.

```sh
# 0. Repo gates, the allocation tables, the seams and the war (any machine).
npm run typecheck && npx biome check client common server && npm test && \
  npm run build -w client
node --import tsx tools/chaos-bench.ts          # alloc PASS, exit 0
node --import tsx tools/destruction-bench.ts    # alloc PASS, exit 0
node --import tsx tools/spectacle-bench.ts      # only S4 boss.update over (follow-up)
node --import tsx tools/roof-seams.ts           # PASS: 0 clashes, exit 0
node --import tsx tools/carrier-sanity.ts --runs 3 --out /tmp/a3-sanity.json  # 3/3, exit 0

# 1. The gate: every segment against the commit before the batch, at the
#    shipped ratio. Read the 60fps (GPU p50 <= 14 ms) / hitch / draws / room
#    / spect. / chaos verdicts and the delta table. Draws should be +5..8
#    per segment against 97883bd; the probe must read 7 (a 21 there means
#    the frames are slow enough to refill it). 0 late compiles.
node tools/perf/run.mjs --runs 3 --label A3 --ab-ref 97883bd

# 2. The phone tier: Mobile as a phone at its own ceiling. GPU p50 <= 5 ms
#    is the assumed phone proxy (M3/P2/S8); chaos <= 90 draws (it reads 90).
node tools/perf/run.mjs --runs 3 --device phone --res 1 --quality mobile \
  --label A3-phone --ab-ref 97883bd

# 3. Where the batch's draws went, per system (High and Mobile): the +5..8.
node tools/perf/run.mjs --ledger --segments core,chaos,boss,cavein
node tools/perf/run.mjs --ledger --quality mobile --segments chaos

# 4. First sight on Metal: 0 late compiles, no early-window wall spikes.
node tools/perf/run.mjs --runs 3 --samples --segments chaos,boss,ruins,cavein,exit

# 5. Auto never steps down: 10 minutes of the full room (exit 1 if it does).
node tools/perf/run.mjs --soak 600 --quality auto --res auto

# 6. Flicker not worse than before the batch (the tool's verdict, every view).
node tools/perf/flicker.mjs --grid --repeat 3 --ref 97883bd

# 7. Black boxes: every path, three profiles, both skies. Expect positive
#    controls failed 0, black boxes 0, non-finite frames 0, PASS (exit 0).
node tools/perf/blackbox.mjs --device all --repeat 3 --attribute --shots /tmp/a3-shots

# 8. The HUD with the whole war up: "war 0 / 0" on all four profiles.
node tools/perf/polish.mjs --out /tmp/a3-polish --overlap

# 9. The soak: 2 clients + a phone, Flight Lab visits, late-joiner parity.
node tools/perf/polish.mjs --out /tmp/a3-soak --label A3 --soak 30 --peers 1 \
  --phone --lab --parity        # exit 0
```
