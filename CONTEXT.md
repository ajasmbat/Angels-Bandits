# Angels & Bandits — Project Context

Multiplayer browser dogfight game: TypeScript + Three.js client, Node + ws
server, set in a procedurally generated downtown skyscraper arena.

**Signature feature:** the 2 km × 2 km map is a seamless torus — fly off the
north edge and you arrive from the south with full visual continuity.

**The single source of truth for all design decisions is [`PLAN.md`](PLAN.md).**
Every ticket in this repo assumes you have read it. The two load-bearing rules:

1. `common/` is shared verbatim between client and server (torus math, city
   generation, constants, protocol types) — both sides must agree exactly.
2. All inter-entity distance/direction math goes through the torus API
   (`wrapDelta` and friends) in `common/src/world/`. Raw position subtraction
   between entities is banned everywhere else.
