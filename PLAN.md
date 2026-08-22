# Angels & Bandits — Design Plan

Multiplayer browser dogfight game set in a downtown skyscraper arena. Signature
feature: the map is a seamless torus — fly off the north edge and you arrive
from the south, with full visual continuity across the seam.

All decisions below were grilled and locked on 2026-08-21. No open branches.

## Locked decisions

### Platform & stack
- **Browser game.** TypeScript + Three.js client, Node + TypeScript server.
- **Monorepo with a shared `common/` package** — torus math, flight-model
  constants, message types, and city generation are the same source on client
  and server. This is load-bearing: both sides must agree exactly on where
  buildings are and how distances work.

### Game shape
- **Full 3D flight**, chase camera. Pitch/roll/yaw, flying between and over
  skyscrapers.
- **Flight model: arcade-plus (energy lite).** Always moving forward, throttle
  between min/max speed, capped turn rates, no stalls (at min speed you mush,
  never fall). Diving gains speed, climbing and hard turns bleed it — altitude
  is tactical.
- **Controls: mouse-aim steering** (plane banks/pitches toward cursor),
  W/S throttle, A/D roll/rudder assist.
- **Session model: persistent drop-in FFA arena.** No lobby, no matches. Join
  via link, pick a name, spawn, fight, respawn. Kill-based scoreboard.
  **12 players per room**, rooms auto-spawn when full. Teams/matches are v2.

### Networking
- **Authority split:** client-authoritative movement, server-authoritative
  combat. Client simulates its own plane locally (instant feel, no
  reconciliation code); server clamps impossibilities (speed caps, teleports)
  and owns all health/damage/kill/respawn decisions. The server runs no
  flight sim **except for bots** (B1): backfill bot planes are flown
  server-side with the same shared `stepFlight` at snapshot cadence, and
  their fire is resolved directly by the server (no hit-claim path).
- **Hit detection on the shooter's client** (favor the shooter); server
  sanity-checks range, fire rate, and plausibility.
- **Wire format: JSON over plain `ws`** for now. All message shapes live in one
  shared TS file so a binary encoder is a later drop-in swap. Do not optimize
  bandwidth before the game is fun.
- **Rates:** client sim at render rate; inputs/state up at 20 Hz; server
  snapshots down at 15 Hz; remote planes rendered ~100 ms in the past via
  interpolation (torus-aware).
- **Hosting:** one Node process serves the static client and hosts WebSocket
  rooms, on a single small instance (Fly.io/Railway). Several rooms per
  process is fine.

### The torus (signature feature)
- **Nearest-image rendering.** World stored once in canonical coords `[0, S)`.
  Each frame, every object — and every *chunk* of static city geometry — is
  drawn at its torus-image nearest the camera: per axis, if farther than S/2,
  shift by ±S. One copy of everything, normal render cost.
- **Hard rule: view/fog distance < S/2** so two images of one object are never
  visible. With S = 2000 m, fog at ~800 m — reads as city haze.
- **Non-negotiable invariant:** every distance/direction computation in the
  game goes through `wrapDelta(a, b)` (shortest vector on the torus) — aiming,
  hit checks, markers, minimap, audio panning, server range validation,
  interpolation across the seam, spawn selection. Raw position subtraction is
  banned. Enforced by making torus math the only exported vector API of the
  `common/world` module.

### Map
- **2 km × 2 km square** (S = 2000). ~25–35 s to cross at combat speed.
- **Procedural seeded city**, identical on client and server from a shared
  seed. Manhattan-style grid whose block pitch divides S evenly, so streets
  tile across the seam automatically. Buildings are extruded boxes with varied
  footprints/heights; a few hand-placed landmark supertalls and plazas for
  orientation.
- Building heights mostly 40–180 m, rare 250 m landmarks.
- **Soft altitude ceiling ~600 m**: engine power fades in thin air and you
  mush back down. No invisible walls. Ground/building contact = instant death.

### Combat
- **Guns only for MVP.** Projectile bullets (~400 m/s, tracers, ~350 m
  effective range), heat/cooldown instead of ammo. Torus-aware lead indicator
  on current target. Missiles + flares are v2.
- **100 HP, 6–8 damage per bullet** → ~1.5–2 s sustained fire to kill. Health
  regens after ~8 s out of combat.
- **Death → ~2.5 s kill-cam → airborne respawn** at a torus-aware
  farthest-from-enemies point, mid altitude, combat speed. Never a runway.
- **~4 s spawn protection**, canceled the moment you fire.
- Kill credit: last damager (including crashes while damaged).
- **No plane-vs-plane collision** (near-miss whoosh instead) — ramming physics
  on client-auth movement is an argument generator.

### Presentation & UI
- **Dusk/night neon city:** dark boxy towers with emissive window grids,
  colored fog, tracer glow. Flatters cheap geometry; fog hides draw distance.
- Low-poly stylized planes (~1–2k tris).
- **Minimap: square, centered on the player, wrapping the map around them** —
  a torus has no edge, so the minimap never shows one.
- Offscreen enemy edge markers, kill feed, Tab scoreboard, name tags —
  all via `wrapDelta`.

## Milestones

- **M0 — Foundation.** Monorepo scaffold (client/server/common), `wrapDelta` +
  canonicalization + torus interpolation in `common/world` **with unit tests**
  (the whole game leans on this math), seeded city generator producing
  identical output in Node and browser.
- **M1 — Solo flight & the illusion.** Procedural city rendered in chunks,
  arcade-plus flight model, mouse-aim + chase cam, fog, building/ground
  collision death. Exit criterion: fly across the seam and *not be able to
  tell where it is*.
- **M2 — Multiplayer presence.** Node ws server, drop-in rooms, name entry,
  other planes visible and smoothly interpolated — including across the seam.
- **M3 — Combat loop.** Guns, heat, shooter-side hits with server validation,
  damage/death/respawn/spawn protection, kill feed, scoreboard.
- **M4 — Polish & ship.** Minimap, lead indicator, sound (engine, guns,
  near-miss whoosh), night-city art pass, health regen tuning, deploy to
  Fly.io/Railway behind a shareable URL.

## Deliberately deferred (v2+)
Teams, match modes, missiles/flares, binary wire protocol, movement
anti-cheat hardening, destructible buildings, plane customization.
