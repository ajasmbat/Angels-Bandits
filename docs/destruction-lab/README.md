# DL1: the Destruction Lab

`https://angels-bandits.fly.dev/?destructlab` (or the second icon on the join
card, next to the Flight Lab): a private lab room where you set a building
off, watch it come down, scrub it, and tune it. **Copy settings** puts the
tuning on the clipboard for the follow-up that turns it into the game's
defaults.

**One code path.** The lab is a mode of the real game, never a fork:

- The triggers go to the room's server. `server/src/destruct-lab.ts` runs
  each one through the real pipeline: bullet rays, the missile director's
  strikes, D5 demolition plans, and D2 chunk damage the planner brings down.
- The debris comes back as ordinary collapse wires, built by the shared
  model (`common/src/city/collapse.ts`).
- The game's own renderers draw it. The lab only feeds them its look
  (`client/src/render/destruct-look.ts`) and its clock.

## The tuning

`common/src/destruction-tuning.ts` holds `DestructionTuning` and
`DEFAULT_DESTRUCTION_TUNING`. Every default is built from the constant it
mirrors, and every multiplier defaults to exactly 1. Each field has one of
three scopes:

| scope | read by | fields |
| --- | --- | --- |
| build | the debris builder, client **and** server, from the wire | gravity, crush front, lead, creep, topple swing / break-up / throw, slab size and size-by-height, facade peel, steel share and lean, rubble height and slump, settle time, falling tilt |
| server | the room's planner and chain blasts | floor strength, pancake-vs-topple, impact damage / radius / energy, hits per neighbour / collapse, chain length |
| look | the client's dressing | dust density / opacity / rise / roll-out / size / hang time / **screen-coverage cap**; gravel, dust and glass bursts; steel sparks; floor fire; fire and flash chances; dying lights; fragment persistence; detail range (the dressing's LOD), detailed collapses, particle budget, dust clouds |

How the lab tuning stays inside the lab:

- A Destruction Lab room stamps the *build* fields that differ from the
  default on every collapse wire it makes (`CollapseWire.dt`).
- Only a lab `CollapseField` builds from the stamp. So the server, the lab
  client and a late joiner all build the same debris, and draw == collide
  holds inside the lab.
- A normal room never stamps a wire. A normal field ignores a stamp if one
  ever arrives. `Room.applyLab` refuses destruction tuning outside a
  Destruction Lab.

**The game is bit-identical on the defaults.** Two pieces of evidence:

- `common/test/destruction-parity.test.ts` builds pancakes, topples in all
  four directions, plans off chewed buildings and crane falls through a
  frozen copy of the pre-DL1 model (`common/test/fixtures/collapse-legacy.ts`)
  and through the live one. The tuning is omitted, the frozen defaults, or a
  fresh copy. It demands `Object.is` on every field of every piece, plus the
  same floor events, chain impacts, poses and plans.
- `tools/destruction-bench.ts --digest` hashes everything each renderer wrote
  over a seeded pass. Every row matches the base commit.

## Watching and tuning

| | |
| --- | --- |
| camera | free orbit (drag), pan (right-drag / shift), zoom (wheel), fly (WASD, Q/E). Picking an arena or a tower frames it from the direction and elevation that sees most of its height past the other towers |
| clock | pause (Space), slow motion 0.1×–1×, frame step (`,` / `.`), Live (L), and a **scrub timeline** over the biggest collapse since the last trigger. Debris and dust are pure functions of time, so a scrub draws exactly what the live view drew (`client/test/destruct-lab.test.ts`). The particle dressing is a pool, so after a scrub it restarts from the new time |
| time-lapse | "Time-lapse sheet" captures the collapse at before, 1.5, 3, 4.5, 6.5, 9 and 14 s into one labelled image, the layout of D11's `collapse-timelapse.mjs` |
| panel | the six groups, each slider with a plain-English hint and a reset. Presets: Current default, Cinematic, Realistic, Performance (phone). A/B/C slots (1/2/3, Shift to save). Copy settings (versioned, only what differs), a share link (`?destructlab=<code>`), and paste-to-import |
| telemetry | fps, frame ms, draw calls, debris pieces still moving, particles, collision boxes, the server's destruction tick (last / p99) and heaviest build, and a budget warning (frame over 60 fps, server p99 over 1 ms, particle pool full) |
| arenas | real blocks of the seed city with 3–5 towers: the most masonry, the most glass, and the supertall core. "Drop into city" aims at any tower anywhere. "Reset arena" rebuilds every building and crane and restores every prop |

## Optimized

**Client hot path** (`node --import tsx tools/destruction-bench.ts`, the
`ruins` scene: 16 buildings, 28 collapses, bytes allocated per frame, the
median of five runs). The base column is `d94bfcc` with this bench file.

| entry | base | DL1 |
| --- | ---: | ---: |
| dust.update | 78 849 | 462 |
| collapseDetail.update | 1 403 | 761 |
| ruinSmoke.update | 1 225 | 43 |
| city.updateDebris | 573 | 572 |
| all judged entries | 83 577 (OVER the 4 096 budget) | 3 360 (ok) |

Every row's output digest is identical to the base. Three fixes did it:

- The dust's per-puff closures are gone (one allocation per puff per frame),
  and so are its boxed clock arguments.
- The collapse detail sprays through a reused record instead of a
  13-argument call per particle.
- The ruin smoke keeps its emission debt in place: a double stored into a
  `Map` was a fresh number every frame.

`client/test/destruct-alloc.test.ts` is the committed guard: posing, the
collision probe and the dust update on lab-tuned and default debris must stay
under 1 KB a frame. A single closure put back in the plume path fails it.

**Server** (`node --import tsx tools/collapse-tick-bench.ts`). Three towers
are felled at once, through the director's path, in a room with its props:
#343 at 312 m, #157 at 294 m and #244 at 268 m. Then 40 s of 20 Hz ticks
with 12 bot probes against the falling debris.

| | |
| --- | --- |
| steady tick p50 / p99 / max | 0.006 / 0.198 / 1.07 ms (gate: p99 ≤ 1 ms) |
| ticks that built a chained collapse | 9 (p50 0.42 ms) |
| staging the three felled towers (one-off) | ≈ 37 ms |

The live lab shows the rest. A 319 m topple into the dense core sets off
about 20–25 chained collapses, and their builds push the lab's server p99
to ≈ 7 ms while they land. The telemetry flags it.

**Normal play, A/B against main**
(`run.mjs --runs 3 --segments collapse,ruins,chaos --ab-ref origin/main`,
SwiftShader, with the evidence runs sharing the box). JS p50, ref → DL1:

| segment | JS p50 |
| --- | --- |
| collapse | 18.0 → 13.1 ms |
| ruins | 54.3 → 24.7 ms |
| chaos | 20.1 → 15.0 ms |

Draw calls: `collapse` is unchanged at 110. `ruins` moved between passes, so
it can't be compared. The harness exited 1. Its own pinning checks failed in
both arms under this load, as D11 found: the fake-pilot rooms never emptied,
the staged chaos did not hold, and the determinism check failed. Its GPU and
wall numbers say nothing about a GPU here, and "within budget" (60 fps)
can't be judged on a software rasteriser. **Measure it on the M3.**

**Solid pieces are identical on every tier.** Only the dressing scales: the
tier's dust and particle shares, plus the Performance preset's look fields.
A test holds the phone preset to look-only fields.

## Evidence

Shot on this GPU-less Linux box (SwiftShader), with
`node tools/perf/destruct-lab.mjs <out> [--device phone]`, the server quiet.
The frame rates in the strip are SwiftShader's (1–2 fps). They say nothing
about a GPU.

| file | what it shows |
| --- | --- |
| `topple-timelapse.jpg` | "Drop into city": tower 157 (294 m) toppled across the view, taken with the lab's own time-lapse export. Standing, tipping at 3 s, breaking up at 4.5 s, then the dust curtain and plumes, and the rubble with smoke at 14 s |
| `topple-mid-desktop.jpg` | The same run mid-collapse, with the panel and the telemetry strip (pieces, boxes, particles, the server tick, the budget warning) |
| `shear-timelapse.jpg` | "Shear a corner" in the glass-tower arena: the wing's fractured slabs peel off and fall into the street (3–9 s) |
| `pancake-street-timelapse.jpg` | The masonry arena's pancake from a street-canyon eye. The surge rolls down the street, with fire on the failing floors |
| `pancake-timelapse-phone.jpg` | The phone profile (844×390, touch, the Performance preset): the masonry tower sinks floor by floor, the surge crosses the street, and the pile smokes |
| `panel-desktop.jpg`, `panel-phone.jpg` | The panel: arena, triggers, watching tools and presets (the slider groups are below). On a phone it is a drawer |
| `topple-mid-phone.jpg` | A topple on the phone profile, debris in the air |

Two things to know when reading the sheets:

- Only the collapses replay on the lab clock. The rest of the city follows
  the live clock: the L7 burn level and its fires, scorch, and chunks shot
  away. So a sheet's "before" frame already shows the fires the collapse
  went on to light.
- The two runs before a sheet's run leave their fires behind. "Reset arena"
  rebuilds the buildings, but the room's burn level decays on its own.

## Not done (and why)

- **Configurable towers** (height, style, footprint). The arenas are real
  blocks of the seed city. Custom towers need a second city generator, on
  both client and server.
- **Detail.** DL1 makes the D10/D11 detail tunable and adds dying lights and
  size-by-height. These are still to come: partial walls standing in the
  rubble, twisted (rather than leaning) steel, and debris that turns into
  particles past ~200 m and impostors further out.
- **60 fps on the phone profile** with the Performance preset, and normal
  play inside its frame budgets, are not measured. There is no GPU here (see
  the A/B above).
