# Physics debris is posed from frames, on both sides

Since DS1 a solo collapse is simulated, not computed. The sim worker's
GameHost gives each room a Rapier world (`server/src/debris-physics.ts`,
`DebrisPhysics`, built through `GameHostOptions.debrisPhysics`). Its poses
are no longer a pure function of the wire and time, so they travel: once
per host tick the world writes one frame (`common/src/city/physpose.ts`
records, `PIECE_STRIDE` floats a piece). Draw == collide holds only because
every reader poses from the same frame bytes.

**The sites that must agree:**

- **The frame writer and readers.** `DebrisPhysics.takeFrame` (writer),
  `PhysRegistry.ingest` and `PhysPoses.pose` (readers). The record layout
  (`RECORD_HEAD`, `PIECE_STRIDE`, `REC_SETTLED`, the piece states and the
  squash) is shared by all three. Change one and the page draws something
  other than what the bots collide with.
- **The two registries.** The room's own (`DebrisPhysics.registry`) is
  attached to the host's CollapseField. The page's (`client/src/sim/poses.ts`
  `pagePhysics`) is attached to the GameSocket's field. Both ingest the same
  Float32Array: the host ingests before the worker transfers the buffer.
  A transfer detaches it, so ingest must come first.
- **Every pose and collision read** goes through `poseNow` / `posePieceNow`
  / `piecePose` and `collideCollapses`, which check `Collapse.phys` first.
  The renderer (`client/src/render/city.ts` `updateDebris`, `debris.ts`
  `pieceMatrixAt` with the quaternion) and the crash check read at the same
  render clock. A new reader that goes straight to the closed-form arrays
  (`c.rx`, `c.land`, `c.endMs`) sees the analytic collapse, not the
  physical one. Use `collapseSettledAt(c)` for "when it lies still".
- **The rubble heap.** `RubbleHeap` heights are drawn by
  `client/src/render/rubble-heap.ts` as two triangles per square, split on
  the (0,0)–(1,1) diagonal. `heapHeight` collides with exactly those
  triangles. Change the split in one and the plane hits air or flies
  through the mound.

**What stays analytic:** multiplayer (the Node shell never builds a
physics world), cranes, collapses past `PHYS_LOD_M` from the camera, and
collapses that would start past the moving-body budget. Their `phys` is
null and nothing above changes for them.

**Never on the host's path:** Rapier itself. `host.ts` and
`destruction.ts` import only the types in `server/src/physics-port.ts`. The
worker imports `debris-physics.ts` and injects it. A static import of
`@dimforge/rapier3d-compat` from the host would load the WASM in every Node
server (see host-runs-in-the-browser).
