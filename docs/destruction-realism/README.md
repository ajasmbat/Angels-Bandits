# DS2: destruction realism

DS1 made collapses physical; DS2 makes them look it up close: irregular
fractured pieces, aggregate concrete with rebar, twisted steel, crumbling
brick, raining glass, rooms behind the broken facades, cracks before
failure, a dust flow that settles on the streets, and heaps of mixed debris.
Nothing here changes what collides: every piece is still drawn inside the
box it collides as (draw == collide), and the dressing is cosmetic.

## The fracture library (`client/src/render/fracture-library.ts`)

Baked once at boot (≈ 13 ms, seeded, so every client bakes the same one):

- **Per material class** — concrete slab, masonry, glass, steel — **8
  variants**, plus the intact box (33 rows).
- Each variant is a **Voronoi-style cell**: the unit box clipped by 2–6
  seeded planes, a convex polytope inside the box. Each class seeds its
  planes its own way: a slab's cuts are torn edges round its outline with
  rebar bars out of them, masonry is cut chunky every way, a glass pane
  splits into slivers, steel is torn off at a slant at both ends.
- **Budget: 144 vertices a piece** (budget 160): 12 polygon slots of 8 (a
  fan; a missing face collapses to a point) and 6 rebar bars of 8.
- One float texture holds every variant. The debris mesh is still **one
  draw**: every variant shares the index buffer, and the vertex shader reads
  its piece's variant by `gl_VertexID`, rotating the canonical cell onto the
  piece's own thin (plate) or long (steel) axis.
- On the piece: a cut face paints as the material's fresh break (grey
  cement and its aggregate stones; brick courses in mortar; dark green glass
  edge), the surviving facade keeps the building's finish, rebar ribbons are
  a metric 5 cm wide and stick out at most 1.4 m. Steel is thinned to 55 %,
  twisted up to ±0.6 rad end to end and bowed, inside its box. Once a piece
  rests, its cuts fill back 55 % toward its box (a pile of crushed slabs
  cut deep was all dark slits).
- Tested: `client/test/fracture-library.test.ts` (budget, determinism,
  every cell inside the box at a sane volume share, no two variants alike,
  each class breaking its own way) and `client/test/collapse-d10.test.ts`
  (the shader's vertex in JS stays inside the box for every size, axis,
  cell, steel bend and rest; the GLSL carries the same constants).

## The rest of the look

| what | where | draws |
| --- | --- | ---: |
| Exposed interiors: the room behind a broken facade is interior-mapped — ceiling tile grid and light panels, desks / cabinets in silhouette against the core wall, torn cables hanging, fire on the floor — with office lights flickering (dying lights on by default, 0.3). The mean far away (G7) and off where window interiors are (Mobile) | `broken-shading.ts` | 0 |
| Facade cracks: hairline cracks run out from hit cells (holes, shattered panes), as far as the hits × `crackGrowth`, dark in the wall, pale in the glass | `damage-map.ts` | 0 |
| Glass rain: a collapsing tower's glass sheds glittering shards that blow out, flutter down and lie in the street for 45 s, catching the fire and the searchlights (≤ 0.66 linear). A glass tower sheds the most, masonry its windows' share. Posed in the vertex shader from (collapse, shard, age): nothing on the wire, no per-shard CPU | `glass-rain.ts` | +1 |
| Pyroclastic surge: a big collapse's ground surge rolls up to 2.6× further down the avenues in bigger puffs (the sight-blocking haze follows it) | `dust.ts`, `surge.ts` | 0 |
| Settled dust: once the cloud settles, pale dust lies round the lot as far as the surge rolled — on the street (one ground layer) and on the parked cars, props and traffic (their materials read the same field) — for 5 minutes | `dust-deposit.ts` | +1 |
| Mixed-debris heaps: slab concrete, the facade's finish, rebar and settled dust in the heap's colours, glass glitter twinkling as you move; bent rebar and slab edges sticking out of every heap | `rubble-heap.ts` | +1 |
| Ruins: smoke columns linger 150 s, small fires burn in the rubble for most of two minutes, cut cables spark off the stump's broken top for 45 s | `ruins.ts` | 0 |
| Masonry crumbles: a brick tower sheds 1.6× the gravel | `collapse-fx.ts` | 0 |

**Draws: +3 at most** (each only while there is something to draw), inside
the ticket's +6. The pool particles (sparks, embers, smoke) are the D1 pool's.

**Artefacts fixed:** the rubble's 0.77 m finish squares and the 2.2 m soot
squares (the "black boxes" on every ruin) are smooth value noise now; a
gutted tower's soot hash ran in diagonal bands (and streaked on a face where
x or z is fixed) and the burning rubble's ember hash striped every steep face
— both now in the face's own plane; long rebar bars in big slabs drew as
black streaks across the pile (capped at 1.4 m).

## The lab knobs (DL1)

New look fields (`common/src/destruction-tuning.ts`): **Glass shard rain**
(×), **Rebar** (share of bars drawn), **Crack growth** (×), **Dust settling**
(×), alongside the existing **Dust density** and **Glass shards** (the burst).
The Performance (phone) preset halves the shard rain.

## HDR ladder

New emissives stay under the bloom threshold (0.72): glass glints clamp at
0.66, heap glitter peaks at 0.5 over a ≤ 0.2 heap, a lit room's ceiling
panels at 0.58, cut-face embers on falling pieces as before (D11's 0.58).
`client/test/fracture-library.test.ts` holds the first three to it.

## Evidence (SwiftShader)

Each sheet is BEFORE (main) | AFTER (DS2), same tower and camera. The lab
shots (physics) were taken with `node tools/perf/ds1-gallery.mjs`: the
"before" of `collapse-topple-impact`, `ruin-detail` and `rubble-heap` is
DS1's committed shot (`docs/physical-destruction/`, main's look), the lean
sheets a fresh baseline run of main. The closed-form views (multiplayer's
collapses, the same renderer) were taken with `node tools/perf/gallery.mjs`
on main's build and this one. SwiftShader starves the sim worker, so a
physical collapse never plays out quite the same twice: the after frames
catch the same scene at a slightly different state.

| file | what it shows |
| --- | --- |
| `collapse-lean-hinge.jpg`, `collapse-lean-hinge-t14.jpg` | 9 s and 14 s into the Lean: the floors break into irregular cells with torn outlines instead of glowing rectangles; the blocky black soot squares are gone; the dust wells up through the canyon |
| `collapse-topple-impact.jpg` | the topple's plates pouring down the canyon, jagged, no black squares |
| `ruin-detail.jpg` | the settled pancake at street level: here a slab came to rest right in front of the camera; glass glitter and rebar on the heap behind it, the pink blow-out gone |
| `rubble-heap.jpg` | the heap from 48 m: settled dust over the pile and the street, glass glitter, rebar and slab edges out of it, small fires; the pile no longer a blown-out pink wall |
| `collapse-dust-street.jpg` | the closed-form pile from the street: the rubble's checkerboard squares and the black rebar streaks gone, torn slab edges |
| `interior-exposed.jpg` | NEW view: rooms behind a shot-out facade — ceiling panels and depth instead of flat lit tiles, smooth soot instead of squares |
| `destruction-glass.jpg` | the glass cascade off a chewed curtain wall (D9's shower, now with cracks round the hits on the facade) |

**Draw calls** (`__ab.perf()`, the gallery's count): interior-exposed 98 →
98, collapse-dust-street 103 → 98, destruction-glass 110 → 104; the lab
strip reads 125–132 → 108–110 on the lean. The counts move with whatever
else is in view (fires, smoke columns, the frame's other systems); the DS2
look's own draws are the three listed above, each drawn only while it has
something to draw.

The M3 numbers (60 fps on these views, no black or streaky artefacts) are
the planner's: this box has no GPU.

## Not done (and why)

- Steel can only bend as far as its collision box allows (draw == collide):
  a 1 m column bows ≈ 11 cm. A visibly folded beam needs a bigger box than
  the physics collides.
- Dust settles on the ground layer, parked cars, props and traffic; not on
  the building facades or the debris pieces themselves.
