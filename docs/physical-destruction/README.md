# DS1: physical destruction

Buildings no longer come down as blocks posed by a formula. In the solo game
(the default since SOLO) every nearby collapse is simulated with rigid-body
physics (Rapier, in the sim worker), and the pieces it moves are what the
page draws and what the plane hits.

## The structure (`common/src/city/structure.ts`)

Every building is a frame keyed to the D2 bay grid, so a chunk id still
names one bay and the damage wire is unchanged:

- **floor slabs**, one per storey (≈ 4 m) of each bay;
- **facade panels**, one per storey on each outline face, 2 m deep, of the
  building's facade material (glass curtain wall, masonry, strip-window
  office; `common/src/city/archetype.ts`);
- **columns**, one per floor band at every bay-grid intersection.

Slabs and panels partition the generated solids exactly, so the standing
building is drawn and collided as it always was
(`common/test/structure.test.ts`, over the whole seed city).

**Load.** A column stands while at least half the bays it is embedded in
stand. A floor whose standing columns fall under `columnStrength` (0.6) of
its columns fails. Where they failed decides how it comes down: survivors
off to one side lean the section toward the failed side, centred survivors
pancake it (`failingFloor`, `leanDir`, `hingeLine`). A physics room plans
with this rule; multiplayer keeps D3's band rule (the parity test still
holds the closed form bit for bit).

**Damage acts on structure.** Shots and blasts still break bays. P1's
momentum sweep now pays what each bay's frame resists
(`bayResistance`: glass gives, brick and column steel resist, ≈ 1 on the
average bay; `SWEEP_MODEL_VERSION` 2).

## The physics (`server/src/debris-physics.ts`)

One Rapier world per room, built by the sim worker and injected into the
GameHost (`GameHostOptions.debrisPhysics`). The Node shell never builds one,
and the host imports only the types in `server/src/physics-port.ts`. Each
collapse's pieces (D10's storey slabs, facade sheets and columns) ride a
hierarchy of compound bodies that break down as it falls:

    section → floor bands → bays → pieces

- **Pancake.** The block above the failed floor and the failed floor let go
  together. Every floor under them is held by its columns until struck
  harder than they carry (3 × the static load). When it gives, the falling
  column and the floor share their momentum (less what breaking the columns
  took), so floors go one after another, faster as the mass grows. The
  floor that gave is crushed flat (`rubbleRatio`, re-stacked from its base),
  and its facade sheets peel off into the street. Then the block crushes
  itself bottom-up on the pile.
- **Lean.** The section hinges on the line of its last standing columns
  (a revolute joint at the failed floor). When it stalls on what is under
  its falling side, its own stump or a neighbour it has leant onto, it
  bears down there: impacts the room lands as blasts, so those floors give
  and come down as collapses of their own. Past its break angle the hinge
  snaps and the floors fly. A hinge torn before it could turn crumbles the
  section where it is.
- **Fracture and crush** are judged on each group's shock: the speed it
  lost over a tick beyond gravity. A floor slammed is crushed; anything
  struck harder than `physFracture` (6 m/s) breaks one level down.
- **Chain impacts come from contacts.** Debris striking another building
  becomes a D5 chain impact (energy-scaled, coalesced, depth-limited), so
  C1's dominoes are physical.
- **Freezing.** A body still for 1.2 s becomes static rubble, and the next
  collapse piles onto it. When nothing of a collapse moves, it settles. Its
  smallest pieces merge into a **rubble heap**: a heightfield of fine rubble
  over the lot, never over 6 m, drawn as exactly the triangles it collides
  as (`client/src/render/rubble-heap.ts`), and a heightfield in the physics
  world too. Ruins smoke off it.
- **Budget and LOD.** A tier's moving-body budget is 400 / 250 / 150 / 80
  (high / medium / low / mobile, × the lab's `physBudget`). A break-up that
  would pass it breaks coarser or waits. A collapse past 650 m from the
  camera, or one that would start over budget, stays closed-form. The page
  sends its camera and tier to the worker a few times a second.
- **The step.** One fixed 1/20 s step a host tick. A governor holds it to
  4 ms: over budget, the moving-body budget shrinks below the tier's (the
  slowest, nearly-still bodies freeze early); well under, it grows back.
  Break-ups make at most 48 bodies a tick.

## Draw == collide (`common/src/city/physpose.ts`)

Each host tick the world writes one frame: every piece of every moving
collapse as its centre, quaternion, state and squash, in one Float32Array.
The room's registry ingests it (the bots collide with that), then the
worker transfers the same buffer to the page (`client/src/sim/poses.ts`).
Each known Collapse gets `phys`, and `poseNow` / `collideCollapses` read it
first. The renderer and the crash check interpolate the same frames at the
same render clock, so what you see falling is what kills you. See
`concepts/invariants/physics-debris-poses.md`.

The ruins no longer streak. The debris shader projected world-anchored
patterns by the object normal, which smeared on any rotated piece; debris
patterns now ride the piece (`vPatPos` / `vPatY`).

## The Destruction Lab

`?destructlab` drives all of it: the triggers go through the real host, so
its collapses are physical. A **Physics** group of sliders (column strength,
debris mass, friction, fracture threshold, body budget) tunes the planner
and the world live. The lab keeps every frame, so its scrub and time-lapse
sheet replay what happened. The telemetry strip adds BODIES (moving /
budget) and PHYSICS (step last / p99, warning over 4 ms).

## Benches

- `node --import tsx tools/physics-bench.ts`: per tier, the worker's step
  per tick (gate p99 ≤ 4 ms) and the page's pose upload (gate p99 ≤ 1 ms),
  the median of three runs.
- `node --import tsx tools/destruction-bench.ts`: bytes allocated per frame.
  The physics row poses the `ruins` scene from frames.

Results are in the PR. The worker numbers depend on the machine: this box
(a power-capped Ryzen 7 8700GE, shared, load 10–18) is not the M3.

## Multiplayer

`?mp=1` is unchanged: the Node shell builds no physics, every collapse is
D3/D10's closed form, and `COLLAPSE_MODEL` still reloads a stale tab. Only
the solo page skips that reload (its host is its own build).
