# A solo snapshot is reused, not handed over

**The edit that looks right:** in a `socket.events.onSnapshot` handler (or
anything it calls), keep a reference to what the snapshot carries — push
`p.pose` into a list, store `snap.players` or an entry for later, compare
against "last snapshot's" object.

**Why it is wrong:** since G9 the solo game's snapshots come down PACKED
(the sim worker posts one transferred Float64Array, `common/src/net.ts`
`packSnapshot`) and `GameSocket.packed` decodes each one into the SAME
`SnapshotMsg`, `players` array and entry objects it used for the last one
(`decodePackedEntry`): no text, no JSON, no garbage per tick on the main
thread. A kept reference is overwritten 50 ms later. Multiplayer (`?mp=1`)
still decodes fresh objects from JSON, so the bug only shows in solo — the
default game.

**Do instead:** copy what you keep. `InterpolationBuffer.push`
(`client/src/net/interp.ts`) copies the pose into a recycled sample;
`ReactionDirector.observeSnapshot` copies the position. `tools/sim-message-bench.ts`
measures what the page allocates per message (packed ≈ 17 B, JSON ≈ 34 KB
for 61 planes) — a consumer that starts allocating per entry shows there.
